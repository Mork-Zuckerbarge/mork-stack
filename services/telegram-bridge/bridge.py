import os
import time
import tempfile
import subprocess
import random
import requests
from collections import defaultdict, deque
from dotenv import load_dotenv

load_dotenv()


def normalize_bot_token(raw_token: str) -> str:
    token = (raw_token or "").strip()
    if token.lower().startswith("https://api.telegram.org/bot"):
        token = token.split("/bot", 1)[1].split("/", 1)[0].strip()
    if token.lower().startswith("bot"):
        token = token[3:].strip()
    return token


BOT_TOKEN = normalize_bot_token(os.getenv("TELEGRAM_BOT_TOKEN", ""))
CORE_URL = os.getenv("MORK_CORE_URL", "http://127.0.0.1:8790").strip().rstrip("/")
APP_URL = os.getenv("MORK_APP_URL", "http://127.0.0.1:3000").strip().rstrip("/")
CHAT_ENDPOINT = os.getenv("MORK_CHAT_ENDPOINT", "/chat/respond").strip() or "/chat/respond"
REPLY_MODE = os.getenv("REPLY_MODE", "mentions").strip().lower()  # mentions | all | dm
if REPLY_MODE not in ("mentions", "all", "dm"):
    REPLY_MODE = "mentions"
COOLDOWN = int(os.getenv("COOLDOWN_SECONDS", "20"))
MAX_PER_10 = int(os.getenv("MAX_PER_10_MIN", "12"))
CHAT_TIMEOUT_SECONDS = int(os.getenv("CHAT_TIMEOUT_SECONDS", "120"))
TELEGRAM_MAX_CHARS = int(os.getenv("TELEGRAM_MAX_CHARS", "700"))
TELEGRAM_MEMORY_ENABLED_DEFAULT = os.getenv("TELEGRAM_MEMORY_ENABLED", "1").strip().lower() in ("1", "true", "yes", "on")
TELEGRAM_MEMORY_MAX = max(1, int(os.getenv("TELEGRAM_MEMORY_MAX", "10")))

# ElevenLabs (optional)
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "").strip()
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip()
VOICE_DEFAULT_ON = os.getenv("VOICE_DEFAULT_ON", "0").strip().lower() in ("1", "true", "yes", "on")
VOICE_MAX_CHARS = int(os.getenv("VOICE_MAX_CHARS", "700"))
VOICE_REPLY_PROBABILITY = min(1.0, max(0.0, float(os.getenv("VOICE_REPLY_PROBABILITY", "0.2"))))

if not BOT_TOKEN:
    raise SystemExit("Missing TELEGRAM_BOT_TOKEN in .env")

API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# Simple spam controls
last_reply_ts = defaultdict(lambda: 0.0)  # per-user cooldown
recent_hits = defaultdict(lambda: deque(maxlen=120))  # per-user rate window

# Optional per-user voice toggle (in-memory; resets on restart)
voice_enabled = defaultdict(lambda: VOICE_DEFAULT_ON)
# Optional per-user short memory toggle + ring buffer (in-memory; resets on restart)
memory_enabled = defaultdict(lambda: TELEGRAM_MEMORY_ENABLED_DEFAULT)
conversation_memory = defaultdict(list)


def message_importance(text: str, msg: dict) -> int:
    score = 0
    t = (text or "").strip()
    if not t:
        return score
    if "?" in t:
        score += 2
    if len(t) >= 140:
        score += 1
    if t.lower().startswith(("help", "how", "why", "what", "when", "where", "can you", "please")):
        score += 1
    if msg.get("reply_to_message"):
        score += 2
    return score


def prune_conversation_memory(user_id: int):
    items = conversation_memory[user_id]
    while len(items) > TELEGRAM_MEMORY_MAX:
        drop_idx = min(range(len(items)), key=lambda idx: (items[idx]["importance"], items[idx]["ts"]))
        items.pop(drop_idx)


def remember_message(user_id: int, role: str, text: str, msg: dict):
    if not memory_enabled[user_id]:
        return
    content = (text or "").strip()
    if not content:
        return
    conversation_memory[user_id].append(
        {
            "role": role,
            "text": content,
            "ts": time.time(),
            "importance": message_importance(content, msg),
        }
    )
    prune_conversation_memory(user_id)


def build_context(user_id: int, latest_user_message: str) -> str:
    if not memory_enabled[user_id]:
        return latest_user_message
    history = conversation_memory[user_id][-TELEGRAM_MEMORY_MAX:]
    if not history:
        return latest_user_message
    lines = []
    for item in history:
        tag = "User" if item["role"] == "user" else "Assistant"
        lines.append(f"{tag}: {item['text']}")
    lines.append(f"User: {latest_user_message}")
    return "Recent Telegram context (oldest -> newest):\n" + "\n".join(lines)


def within_rate_limit(user_id: int) -> bool:
    now = time.time()
    dq = recent_hits[user_id]
    dq.append(now)
    ten_min_ago = now - 600
    while dq and dq[0] < ten_min_ago:
        dq.popleft()
    return len(dq) <= MAX_PER_10


def should_send_voice_reply(user_id: int) -> bool:
    if not voice_enabled[user_id]:
        return False
    if not (ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID):
        return False
    if VOICE_REPLY_PROBABILITY >= 1.0:
        return True
    return random.random() < VOICE_REPLY_PROBABILITY


def is_reply_to_bot(msg: dict, bot_id: int) -> bool:
    rt = msg.get("reply_to_message") or {}
    frm = rt.get("from") or {}
    return bool(frm) and frm.get("is_bot") and frm.get("id") == bot_id


def should_reply(msg: dict, bot_username: str, bot_id: int) -> bool:
    chat = msg.get("chat", {})
    chat_type = chat.get("type", "")

    text = (msg.get("text") or "").strip()
    if not text:
        return False

    if REPLY_MODE == "dm":
        return chat_type == "private"

    if REPLY_MODE == "all":
        return True

    # mentions mode:
    # - DMs always
    # - @mention
    # - OR replying to one of the bot's messages (no tag needed)
    if chat_type == "private":
        return True

    if is_reply_to_bot(msg, bot_id):
        return True

    if bot_username:
        return f"@{bot_username.lower()}" in text.lower()

    return False


def post_to_chat_endpoint(base_url: str, path: str, payload: dict) -> dict:
    url = f"{base_url}{path}"
    response = requests.post(url, json=payload, timeout=CHAT_TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.json()


def build_candidate_targets() -> list[tuple[str, str]]:
    normalized = CHAT_ENDPOINT if CHAT_ENDPOINT.startswith("/") else f"/{CHAT_ENDPOINT}"
    targets: list[tuple[str, str]] = []

    def add_target(base_url: str, path: str):
        target = (base_url, path)
        if target not in targets:
            targets.append(target)

    # Prefer mork-core for /chat/respond.
    if normalized:
        add_target(CORE_URL, normalized)
    add_target(CORE_URL, "/chat/respond")

    # Fallback to app API surface if core is unavailable.
    if normalized.startswith("/api/"):
        add_target(APP_URL, normalized)
    add_target(APP_URL, "/api/chat/respond")

    # As a final fallback, try app base with /chat/respond in case of custom rewrites.
    add_target(APP_URL, "/chat/respond")
    return targets


def core_reply(handle: str, message: str, user_id: int) -> dict:
    prompt = build_context(user_id, message)
    payload = {
        "channel": "telegram",
        "handle": handle,
        "message": prompt,
        "maxChars": TELEGRAM_MAX_CHARS,
    }

    candidate_targets = build_candidate_targets()

    errors: list[str] = []
    j = None
    for base_url, path in candidate_targets:
        url = f"{base_url}{path}"
        try:
            j = post_to_chat_endpoint(base_url, path, payload)
            break
        except Exception as err:
            errors.append(f"{url}: {repr(err)}")
            continue

    if j is None:
        raise RuntimeError(f"chat upstream failed after targets={candidate_targets}: {' | '.join(errors)}")

    if not j.get("ok"):
        return {"text": "My thoughts failed to compile. Try again in a moment.", "media": None}
    text = (j.get("reply") or j.get("response") or "").strip() or "…"
    media = j.get("media") if isinstance(j.get("media"), dict) else None
    return {"text": text, "media": media}


def send_message(chat_id: int, text: str, reply_to: int | None = None):
    data = {"chat_id": chat_id, "text": text}
    if reply_to:
        data["reply_to_message_id"] = reply_to
        data["allow_sending_without_reply"] = True
    requests.post(f"{API}/sendMessage", data=data, timeout=20)


def send_generated_media(chat_id: int, media: dict, caption: str = "", reply_to: int | None = None):
    url = (media.get("downloadUrl") or media.get("url") or "").strip()
    kind = (media.get("kind") or "").strip().lower()
    if not url or kind not in ("image", "video"):
        return False

    if url.startswith("/"):
        url = f"{CORE_URL}{url}"
    elif not url.startswith("http://") and not url.startswith("https://"):
        url = f"{CORE_URL}/{url.lstrip('/')}"

    file_res = requests.get(url, timeout=60)
    file_res.raise_for_status()
    file_bytes = file_res.content

    data = {"chat_id": chat_id}
    if reply_to:
        data["reply_to_message_id"] = reply_to
        data["allow_sending_without_reply"] = True
    if caption:
        data["caption"] = caption[:1024]

    if kind == "video":
        files = {"video": ("mork.mp4", file_bytes, "video/mp4")}
        requests.post(f"{API}/sendVideo", data=data, files=files, timeout=90).raise_for_status()
    else:
        files = {"photo": ("mork.png", file_bytes, "image/png")}
        requests.post(f"{API}/sendPhoto", data=data, files=files, timeout=90).raise_for_status()
    return True


def elevenlabs_tts_mp3_bytes(text: str) -> bytes:
    if not (ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID):
        raise RuntimeError("ElevenLabs not configured (missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID).")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "accept": "audio/mpeg",
        "content-type": "application/json",
    }
    body = {
        "model_id": ELEVENLABS_MODEL_ID,
        "text": text,
        "voice_settings": {
            "stability": 0.35,
            "similarity_boost": 0.85,
            "style": 0.25,
            "use_speaker_boost": True,
        },
    }
    r = requests.post(url, headers=headers, json=body, timeout=30)
    r.raise_for_status()
    return r.content


def ffmpeg_available() -> bool:
    try:
        p = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        return p.returncode == 0
    except Exception:
        return False


def mp3_to_ogg_opus(mp3_path: str, ogg_path: str):
    # Telegram voice notes are happiest as OGG/OPUS
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        mp3_path,
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-vbr",
        "on",
        "-compression_level",
        "10",
        ogg_path,
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {p.stderr[-400:]}")


def send_voice(chat_id: int, text: str, reply_to: int | None = None):
    # Keep voice short-ish so it doesn't become a 2 minute monologue
    text = (text or "").strip()
    if not text:
        return
    if len(text) > VOICE_MAX_CHARS:
        text = text[:VOICE_MAX_CHARS].rstrip() + "…"

    mp3_bytes = elevenlabs_tts_mp3_bytes(text)

    with tempfile.TemporaryDirectory() as td:
        mp3_path = os.path.join(td, "mork.mp3")
        with open(mp3_path, "wb") as f:
            f.write(mp3_bytes)

        if ffmpeg_available():
            ogg_path = os.path.join(td, "mork.ogg")
            mp3_to_ogg_opus(mp3_path, ogg_path)

            data = {"chat_id": chat_id}
            if reply_to:
                data["reply_to_message_id"] = reply_to
                data["allow_sending_without_reply"] = True
            with open(ogg_path, "rb") as vf:
                files = {"voice": vf}
                requests.post(f"{API}/sendVoice", data=data, files=files, timeout=40)
        else:
            # Fallback: send as audio/mp3 if ffmpeg not present
            data = {"chat_id": chat_id, "title": "Mork"}
            if reply_to:
                data["reply_to_message_id"] = reply_to
                data["allow_sending_without_reply"] = True
            with open(mp3_path, "rb") as af:
                files = {"audio": af}
                requests.post(f"{API}/sendAudio", data=data, files=files, timeout=40)


def get_me():
    r = requests.get(f"{API}/getMe", timeout=20)
    if r.status_code == 404:
        preview = f"{BOT_TOKEN[:8]}..." if BOT_TOKEN else "<empty>"
        raise RuntimeError(
            "Telegram getMe returned 404. TELEGRAM_BOT_TOKEN appears invalid "
            f"(value starts with: {preview}). "
            "Use the HTTP API bot token from @BotFather (format like 123456:ABC...). "
            "Do not use a chat id."
        )
    r.raise_for_status()
    return r.json()["result"]


def main():
    me = None
    while me is None:
        try:
            me = get_me()
        except Exception as e:
            print("[bridge] telegram auth/init error:", repr(e))
            time.sleep(5)

    bot_username = me.get("username", "") or ""
    bot_id = int(me.get("id"))
    print(
        f"[bridge] bot=@{bot_username} id={bot_id} core={CORE_URL} endpoint={CHAT_ENDPOINT} mode={REPLY_MODE}"
    )
    print(f"[bridge] chat endpoint candidates={build_candidate_targets()}")
    if ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID:
        pct = int(VOICE_REPLY_PROBABILITY * 100)
        print(f"[bridge] ElevenLabs: enabled (voice replies available; random chance {pct}%)")
    else:
        print("[bridge] ElevenLabs: not configured (text only)")

    offset = 0
    try:
        while True:
            try:
                r = requests.get(f"{API}/getUpdates", params={"timeout": 30, "offset": offset}, timeout=35)
                r.raise_for_status()
                updates = r.json().get("result", [])

                for upd in updates:
                    offset = max(offset, upd.get("update_id", 0) + 1)

                    msg = upd.get("message") or upd.get("edited_message")
                    if not msg:
                        continue

                    chat = msg.get("chat", {})
                    chat_id = chat.get("id")
                    from_user = msg.get("from", {})
                    user_id = int(from_user.get("id") or 0)
                    username = (from_user.get("username") or "").strip()
                    first_name = (from_user.get("first_name") or "").strip()
                    last_name = (from_user.get("last_name") or "").strip()
                    display_name = " ".join(part for part in [first_name, last_name] if part).strip()
                    handle = username or (f"tg-user-{user_id}" if user_id else "user")

                    # Ignore bot messages (including ourselves)
                    if from_user.get("is_bot"):
                        continue

                    text = (msg.get("text") or "").strip()
                    if not text:
                        continue

                    # Commands: toggle voice per-user
                    if text.lower().startswith("/voice"):
                        parts = text.lower().split()
                        if len(parts) >= 2 and parts[1] in ("on", "off"):
                            voice_enabled[user_id] = parts[1] == "on"
                            send_message(chat_id, f"Voice replies: {'ON' if voice_enabled[user_id] else 'OFF'}", reply_to=msg.get("message_id"))
                        else:
                            send_message(chat_id, "Usage: /voice on  or  /voice off", reply_to=msg.get("message_id"))
                        continue
                    if text.lower().startswith("/memory"):
                        parts = text.lower().split()
                        if len(parts) >= 2 and parts[1] in ("on", "off"):
                            memory_enabled[user_id] = parts[1] == "on"
                            send_message(chat_id, f"Memory: {'ON' if memory_enabled[user_id] else 'OFF'}", reply_to=msg.get("message_id"))
                        elif len(parts) >= 2 and parts[1] == "clear":
                            conversation_memory[user_id].clear()
                            send_message(chat_id, "Memory cleared.", reply_to=msg.get("message_id"))
                        else:
                            send_message(chat_id, "Usage: /memory on | /memory off | /memory clear", reply_to=msg.get("message_id"))
                        continue

                    if not should_reply(msg, bot_username, bot_id):
                        continue

                    # Cooldown + rate limit
                    now = time.time()
                    if now - last_reply_ts[user_id] < COOLDOWN:
                        continue
                    if not within_rate_limit(user_id):
                        continue

                    # Strip the @mention from message so Mork doesn't parrot it
                    if bot_username:
                        text = text.replace(f"@{bot_username}", "").replace(f"@{bot_username.lower()}", "").strip()
                    try:
                        contextual_text = text
                        if display_name:
                            contextual_text = f"[speaker_name={display_name}] {text}"
                        chat_result = core_reply(handle=handle, message=contextual_text, user_id=user_id)
                        reply = (chat_result.get("text") or "").strip() or "…"
                        media = chat_result.get("media")
                        remember_message(user_id, "user", text, msg)
                        remember_message(user_id, "assistant", reply, msg)

                        media_sent = False
                        if isinstance(media, dict):
                            try:
                                media_sent = send_generated_media(
                                    chat_id,
                                    media,
                                    caption=reply if reply and reply != "…" else "",
                                    reply_to=msg.get("message_id"),
                                )
                            except Exception as me:
                                print("[bridge] media send error:", repr(me))
                                media_sent = False

                        if not media_sent:
                            # Voice OR text, not both
                            if should_send_voice_reply(user_id):
                                try:
                                    send_voice(chat_id, reply, reply_to=msg.get("message_id"))
                                except Exception as ve:
                                    print("[bridge] voice error:", repr(ve))
                                    send_message(chat_id, reply, reply_to=msg.get("message_id"))
                            else:
                                send_message(chat_id, reply, reply_to=msg.get("message_id"))

                        last_reply_ts[user_id] = now
                    except Exception as re:
                        print("[bridge] reply error:", repr(re))
            except Exception as e:
                print("[bridge] error:", repr(e))
                time.sleep(2)
    except KeyboardInterrupt:
        print("[bridge] KeyboardInterrupt received, shutting down cleanly.")


if __name__ == "__main__":
    main()
