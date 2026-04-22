import os
import json
import time
import re
import random
import threading
import queue
from pathlib import Path
from datetime import datetime, timedelta, timezone
from collections import defaultdict
import gradio as gr
from openai import OpenAI
import tweepy
import feedparser
import schedule
import requests
from bs4 import BeautifulSoup
import html2text
import httpx
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

load_dotenv()

MAIN_TWEET_BASE_MIN = 240
MAIN_TWEET_JITTER_MIN = 45
OBS_BASE_MIN = 180
OBS_JITTER_MIN = 30
MIN_GAP_MIN = 30

REPLY_STATE_FILE = "reply_state.json"
MAX_DAILY_REPLIES = 3
MAX_FETCH = 50
MAX_AGE_HOURS = 23
MAX_BACKLOG = 20   # store at most this many tweet IDs for tomorrow

MORK_CORE_URL = os.getenv("MORK_CORE_URL", "http://localhost:8787").rstrip("/")
MEME_CORE_REFLECT_TIMEOUT_SECONDS = float(os.getenv("MEME_CORE_REFLECT_TIMEOUT_SECONDS", "20"))
MEME_CORE_COMPOSE_TIMEOUT_SECONDS = float(os.getenv("MEME_CORE_COMPOSE_TIMEOUT_SECONDS", "12"))
USE_OPENAI = str(os.getenv("USE_OPENAI", "0")).strip().lower() in ("1", "true", "yes", "on")
def _get_core_url():
    u = (os.getenv("MORK_CORE_URL") or "").strip().rstrip("/")
    if not u:
        return "http://localhost:8787"
    if "<" in u or "IP-OF" in u.upper():
        print(f"⚠ MORK_CORE_URL is a placeholder: '{u}'. Please set a real URL.")
        return "http://localhost:8787"
    return u
def _clamp(n, lo, hi):
    return max(lo, min(hi, n))

def compute_next_run(
    base_minutes: int,
    jitter_minutes: int,
    active_start_hour: int = 8,
    active_end_hour: int = 23,
    min_gap_minutes: int = 30,
):
    """
    Returns a datetime for the next run:
    - base cadence (base_minutes)
    - +/- jitter (jitter_minutes)
    - only within active hours window
    - minimum gap enforced
    """
    now = datetime.now()

    jitter = random.randint(-jitter_minutes, jitter_minutes)
    delta = base_minutes + jitter
    delta = _clamp(delta, min_gap_minutes, base_minutes + jitter_minutes)

    nxt = now + timedelta(minutes=delta)

    # If outside active hours, push into next day's window with some randomness
    if nxt.hour < active_start_hour:
        nxt = nxt.replace(hour=active_start_hour, minute=random.randint(0, 20), second=0, microsecond=0)
    elif nxt.hour >= active_end_hour:
        # next day morning
        nxt = (nxt + timedelta(days=1)).replace(hour=active_start_hour, minute=random.randint(0, 35), second=0, microsecond=0)

    return nxt

def seconds_until(dt: datetime) -> float:
    return max(0.0, (dt - datetime.now()).total_seconds())
MORK_CORE_URL = _get_core_url()

def _core_base_url() -> str:
    """
    Returns a safe/usable base URL for Mork Core.
    Fixes common mistakes like literally having '<ip-of-mork-core>' in the env var,
    and strips trailing slashes.
    """
    raw = (MORK_CORE_URL or "").strip().strip('"').strip("'")
    raw = raw.rstrip("/")

    # Common placeholder mistake: "http://<ip-of-mork-core>:8787"
    if "<" in raw or ">" in raw:
        print(f"⚠ MORK_CORE_URL looks like a placeholder: {raw!r}. Falling back to http://localhost:8787")
        return "http://localhost:8787"

    # If user accidentally pasted a URL-encoded placeholder (%3c ... %3e)
    if "%3c" in raw.lower() or "%3e" in raw.lower():
        print(f"⚠ MORK_CORE_URL looks URL-encoded/invalid: {raw!r}. Falling back to http://localhost:8787")
        return "http://localhost:8787"

    if not re.match(r"^https?://", raw):
        print(f"⚠ MORK_CORE_URL missing scheme: {raw!r}. Prepending http://")
        raw = "http://" + raw

    return raw

def core_reflect(timeout=20) -> bool:
    base = _core_base_url()
    try:
        r = requests.post(f"{base}/brain/reflect", json={}, timeout=timeout)
        if r.ok:
            return True
        print(f"⚠ core_reflect bad status {r.status_code}: {r.text[:200]}")
        if base != "http://localhost:8787" and r.status_code == 404 and "<!DOCTYPE html>" in (r.text or ""):
            print("⚠ core_reflect received HTML 404; retrying against local mork-core at http://localhost:8787")
            r2 = requests.post("http://localhost:8787/brain/reflect", json={}, timeout=timeout)
            if r2.ok:
                return True
            print(f"⚠ core_reflect local retry bad status {r2.status_code}: {r2.text[:200]}")
        return False
    except Exception as e:
        print(f"⚠ core_reflect failed: {e}")
        if base != "http://localhost:8787":
            try:
                print("⚠ core_reflect retrying local mork-core after exception")
                r2 = requests.post("http://localhost:8787/brain/reflect", json={}, timeout=timeout)
                if r2.ok:
                    return True
                print(f"⚠ core_reflect local retry bad status {r2.status_code}: {r2.text[:200]}")
            except Exception as e2:
                print(f"⚠ core_reflect local retry failed: {e2}")
        return False

def core_compose_payload(payload: dict, timeout=10) -> str:
    """
    Compose a tweet via Mork Core.

    Supports BOTH styles:
      - NEW: POST /x/compose with JSON payload (recommended)
      - OLD: GET /x/compose?mode=observation|edge|reflection (fallback)

    Adds "memory layers" + voice variance hints:
      - voice: small random style nudges (safe)
      - seed: stable-ish randomness input for variety
      - constraints: shared tweet rules / bans (if Core chooses to honor them)
    """
    import random
    import time

    base = _core_base_url()
    payload = dict(payload or {})
    payload.setdefault("maxChars", 260)

    # -----------------------------
    # Memory layers / voice variance
    # -----------------------------
    def _voice_palette():
        # short nudges that change *how* it speaks, not *what* it says
        return random.choice([
            "Dry wit, understated.",
            "Melancholy but composed.",
            "Terse, executive tone with subtle unease.",
            "Literary, but not purple.",
            "Clinical observation, then one human aside.",
            "Quietly amused, slightly ominous.",
            "Reflective, grounded, no theatrics.",
        ])

    # A seed that changes over time but isn't obviously periodic.
    # Core can use this to randomize sampling or template selection.
    seed = payload.get("seed")
    if seed is None:
        seed = int(time.time()) ^ random.randint(0, 2**16 - 1)

    # Shared constraints (Core may already have its own; these are additive hints)
    # Keep these consistent with your server.ts instruction bans.
    constraints = payload.get("constraints") or {}
    constraints.setdefault("banPhrases", [
        "nanu nanu", "na-nu", "shazbot", "gleeb", "gleek", "ork", "mork and mindy"
    ])
    constraints.setdefault("noHashtags", True)
    constraints.setdefault("noEmojis", True)
    constraints.setdefault("noUrls", True)  # Core can re-allow for feed if you want
    constraints.setdefault("noQuoteUserText", True)

    # Add voice + seed + optional jitter hints
    payload.setdefault("voice", _voice_palette())
    payload.setdefault("seed", seed)
    payload.setdefault("constraints", constraints)

    # Optional: give Core permission to vary its phrasing/structure
    payload.setdefault("variance", {
        "style": random.uniform(0.35, 0.85),   # tone/structure variance
        "novelty": random.uniform(0.25, 0.75), # how different vs recent memory
    })

    # If this is a feed tweet and you WANT url appended by Sherpa later,
    # keep Core "noUrls" true and let Sherpa append (your current behavior).
    # If you ever want Core to append URLs, set constraints.noUrls=False per kind=feed.

    compose_bases = [base]
    if base != "http://localhost:8787":
        compose_bases.append("http://localhost:8787")

    # 1) Try POST (new style)
    for i, compose_base in enumerate(compose_bases):
        try:
            r = requests.post(f"{compose_base}/x/compose", json=payload, timeout=timeout)

            if r.ok:
                # Expect JSON { ok:true, tweet:"..." } but stay defensive
                if "application/json" in (r.headers.get("content-type") or ""):
                    j = r.json() or {}
                    out = (j.get("tweet") or j.get("text") or "").strip()
                else:
                    out = (r.text or "").strip()

                # final cleanups (safe)
                out = out.strip().strip("\u200b")

                # unwrap quotes
                if (out.startswith('"') and out.endswith('"')) or (out.startswith("'") and out.endswith("'")):
                    out = out[1:-1].strip()

                return out[: int(payload.get("maxChars", 260))]

            print(f"⚠ core_compose bad status {r.status_code}: {r.text[:200]}")
            if i + 1 < len(compose_bases):
                print("⚠ core_compose retrying against local mork-core at http://localhost:8787")
        except Exception as e:
            print(f"⚠ core_compose POST failed: {e}")
            if i + 1 < len(compose_bases):
                print("⚠ core_compose retrying local mork-core after exception")

    # 2) Fallback to GET (old style)
    for i, compose_base in enumerate(compose_bases):
        try:
            mode = (payload.get("mode") or payload.get("kind") or "observation")
            r = requests.get(
                f"{compose_base}/x/compose",
                params={"mode": mode},
                timeout=min(5, timeout),
            )
            if not r.ok:
                print(f"⚠ core_compose GET bad status {r.status_code}: {r.text[:200]}")
                if i + 1 < len(compose_bases):
                    print("⚠ core_compose GET retrying against local mork-core at http://localhost:8787")
                continue

            if "application/json" in (r.headers.get("content-type") or ""):
                j = r.json() or {}
                out = (j.get("tweet") or j.get("text") or "").strip()
            else:
                out = (r.text or "").strip()

            # unwrap quotes
            if (out.startswith('"') and out.endswith('"')) or (out.startswith("'") and out.endswith("'")):
                out = out[1:-1].strip()

            return out[: int(payload.get("maxChars", 260))]

        except Exception as e:
            print(f"⚠ core_compose GET failed: {e}")
            if i + 1 < len(compose_bases):
                print("⚠ core_compose GET retrying local mork-core after exception")
    return ""

def _wrap_280(s: str, max_len: int = 260) -> str:
    # Preserve newlines for tweet formatting, but collapse repeated spaces
    s = (s or "").strip()
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s if len(s) <= max_len else (s[: max_len - 1].rstrip() + "…")

def morkcore_edge_line() -> str:
    """
    OPTIONAL helper. Only used if you explicitly want to pull raw edge lines.
    If you're routing all tone through Core, you usually don't need this.
    """
    try:
        base = _core_base_url()
        r = requests.get(
            f"{base}/memory/query",
            params={"q": "edge=", "limit": 10},
            timeout=3,
        )
        if not r.ok:
            return ""
        data = r.json()
        items = data.get("items", []) if isinstance(data, dict) else []
        for it in items:
            c = (it or {}).get("content", "")
            if isinstance(c, str) and "| edge=" in c:
                return c.strip()
    except Exception:
        pass
    return ""

def compose_observation_from_core(max_len: int = 260) -> str:
    """
    Ask Mork Core to compose an observation tweet.
    All voice/tone comes from Core (and its prime directive).
    Never throws.
    """
    try:
        out = core_compose_payload({"kind": "observation", "maxChars": max_len}, timeout=8)
        if out:
            return _wrap_280(out, max_len)
    except Exception:
        pass

    # Hard fallback (should be rare): keep neutral, avoid the repetitive "edge/vibes" stuff here.
    return _wrap_280("System check: my thoughts are quiet right now. Give me a moment to warm the coals.", max_len)


# ----------------------------------------
# Relationship memory (local file) — keep
# ----------------------------------------

def _load_relationships():
    if os.path.exists(REL_FILE):
        try:
            with open(REL_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def _save_relationships(rel):
    try:
        with open(REL_FILE, "w", encoding="utf-8") as f:
            json.dump(rel, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

def _extract_topics(text: str, max_topics=5):
    t = re.sub(r"http\S+", "", (text or "").lower())
    words = re.findall(r"[a-z0-9']{3,}", t)

    stop = {
        "this","that","with","have","just","like","your","youre","about","from","they","them","what",
        "when","then","been","were","there","here","will","would","could","into","over","under","than",
        "more","some","much","very","really","also","because","while","where","their","them","these",
        "those","cant","dont","didnt","doesnt","isnt","arent","you","and","the","for"
    }

    freq = defaultdict(int)
    for w in words:
        if w in stop:
            continue
        freq[w] += 1

    ranked = sorted(freq.items(), key=lambda x: x[1], reverse=True)
    return [w for w, _ in ranked[:max_topics]]

def update_relationship(author_id: str, username: str, text: str, engagement_score: float = 0.0):
    rel = _load_relationships()
    key = author_id or username or "unknown"
    now = datetime.now(timezone.utc).isoformat()

    entry = rel.get(key, {
        "author_id": author_id,
        "username": username,
        "trust": 0.0,
        "topics": [],
        "last_interaction": None,
        "interactions": 0,
    })

    entry["author_id"] = author_id or entry.get("author_id")
    entry["username"] = username or entry.get("username")
    entry["last_interaction"] = now
    entry["interactions"] = int(entry.get("interactions", 0)) + 1

    bump = 0.05 + min(0.05, float(engagement_score) / 100.0)
    entry["trust"] = max(-1.0, min(1.0, float(entry.get("trust", 0.0)) + bump))

    new_topics = _extract_topics(text)
    topics = list(entry.get("topics", []))
    for t in new_topics:
        if t not in topics:
            topics.insert(0, t)
    entry["topics"] = topics[:15]

    rel[key] = entry
    _save_relationships(rel)
    return entry

def _load_reply_state():
    if os.path.exists(REPLY_STATE_FILE):
        with open(REPLY_STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"last_post_day": None, "replied_today": 0, "since_id": None, "backlog": []}

def _save_reply_state(s):
    with open(REPLY_STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)

def _parse_iso_z(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))

def _age_hours(created_at: str) -> float:
    return (datetime.now(timezone.utc) - _parse_iso_z(created_at)).total_seconds() / 3600.0

def _score(public_metrics: dict) -> float:
    likes = public_metrics.get("like_count", 0)
    replies = public_metrics.get("reply_count", 0)
    rts = public_metrics.get("retweet_count", 0)
    return likes + 2 * replies + 0.5 * rts

def _prune_backlog(backlog: list) -> list:
    seen = set()
    kept = []
    for item in backlog:
        tid = item.get("tweet_id")
        ts = item.get("created_at")
        if not tid or not ts or tid in seen:
            continue
        if _age_hours(ts) < MAX_AGE_HOURS:
            seen.add(tid)
            kept.append(item)
    return kept[:MAX_BACKLOG]

# Constants
ENCRYPTION_KEY_FILE = "encryption.key"
CREDENTIALS_FILE = "encrypted_credentials.bin"
CROSS_SERVICE_ENV_PATH = Path(__file__).resolve().parents[2] / "mork-app" / ".env.local"
CHARACTERS_FILE = "encrypted_characters.bin"
FEED_CONFIG_FILE = "encrypted_feed_config.bin"  # New file for feed selection
MAX_TWEETS_PER_MONTH = 500
TWEET_INTERVAL_HOURS = 1.5
FEED_TIMEOUT = 10  # seconds
FEED_ERROR_THRESHOLD = 5  # max consecutive errors before skipping feed
MIN_STORIES_PER_FEED = 2  # minimum stories to get from each feed
PRIMARY_FEED_WEIGHT = 2.0  # Weight multiplier for primary sources

# Constants for meme handling
SUPPORTED_MEME_FORMATS = ('.jpg', '.jpeg', '.png', '.gif')
USED_MEMES_HISTORY = 10  # How many recently used memes to remember

# Twitter API Rate Limits
TWITTER_RATE_LIMITS = {
    "tweets": {
        "endpoint": "statuses/update",
        "window_hours": 3,
        "max_tweets": 300,  # Combined limit for tweets and retweets
        "current_count": 0,
        "window_start": None,
        "reset_time": None,
        "backoff_until": None
    }
}

# Twitter API retry settings
TWITTER_RETRY_CONFIG = {
    "initial_backoff": 60,  # Start with 1 minute
    "max_backoff": 3600,    # Max 1 hour
    "backoff_factor": 2,    # Double each time
    "max_retries": 5
}

# Default headers for feed requests
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

# OpenAI Models with limits
OPENAI_MODELS = {
    "gpt-3.5-turbo (Most affordable)": {
        "name": "gpt-3.5-turbo",
        "tpm": "10M tokens/min",
        "rpm": "10K requests/min"
    },
    "gpt-4o": {
        "name": "gpt-4o",
        "tpm": "2M tokens/min",
        "rpm": "10K requests/min"
    },
    "gpt-4o-mini": {
        "name": "gpt-4o-mini",
        "tpm": "10M tokens/min",
        "rpm": "10K requests/min"
    },
    "gpt-4": {
        "name": "gpt-4",
        "tpm": "300K tokens/min",
        "rpm": "10K requests/min"
    },
    "gpt-4-turbo": {
        "name": "gpt-4-turbo",
        "tpm": "800K tokens/min",
        "rpm": "10K requests/min"
    }
}

# RSS Feed Categories
RSS_FEEDS = {
    "crypto": {
        "primary": [
            {"url": "https://www.theblock.co/rss.xml", "name": "The Block"},
            {"url": "https://blog.kraken.com/feed", "name": "Kraken Blog"},
            {"url": "https://messari.io/rss", "name": "Messari"},
            {"url": "https://blockworks.co/feed", "name": "Blockworks"}
        ],
        "secondary": [
            {"url": "https://cointelegraph.com/rss", "name": "CoinTelegraph"},
            {"url": "https://cryptonews.com/news/feed/", "name": "CryptoNews"},
            {"url": "https://decrypt.co/feed", "name": "Decrypt"},
            {"url": "https://news.bitcoin.com/feed/", "name": "Bitcoin.com"},
            {"url": "https://coindesk.com/arc/outboundfeeds/rss/", "name": "CoinDesk"},
            {"url": "https://bitcoinmagazine.com/.rss/full/", "name": "Bitcoin Magazine"},
            {"url": "https://cryptopotato.com/feed/", "name": "CryptoPotato"},
            {"url": "https://ambcrypto.com/feed/", "name": "AMBCrypto"},
            {"url": "https://newsbtc.com/feed/", "name": "NewsBTC"},
            {"url": "https://cryptoslate.com/feed/", "name": "CryptoSlate"},
            {"url": "https://beincrypto.com/feed/", "name": "BeInCrypto"},
            {"url": "https://bitcoinist.com/feed/", "name": "Bitcoinist"},
            {"url": "https://dailyhodl.com/feed/", "name": "The Daily Hodl"}
        ]
    },
    "ai": {
        "primary": [
            {"url": "http://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=lastUpdatedDate&sortOrder=descending&max_results=10", "name": "arXiv - Artificial Intelligence"},
            {"url": "http://export.arxiv.org/api/query?search_query=cat:cs.LG&sortBy=lastUpdatedDate&sortOrder=descending&max_results=10", "name": "arXiv - Machine Learning"},
            {"url": "http://export.arxiv.org/api/query?search_query=cat:cs.CL&sortBy=lastUpdatedDate&sortOrder=descending&max_results=10", "name": "arXiv - Computation and Language"},
            {"url": "http://export.arxiv.org/api/query?search_query=cat:cs.CV&sortBy=lastUpdatedDate&sortOrder=descending&max_results=10", "name": "arXiv - Computer Vision"},
            {"url": "http://export.arxiv.org/api/query?search_query=cat:cs.NE&sortBy=lastUpdatedDate&sortOrder=descending&max_results=10", "name": "arXiv - Neural and Evolutionary Computing"}
        ],
        "secondary": [
            {"url": "https://blog.research.google/feeds/posts/default", "name": "Google Research Blog"},
            {"url": "https://openai.com/news/rss.xml", "name": "OpenAI Blog"},
            {"url": "https://aws.amazon.com/blogs/machine-learning/feed/", "name": "AWS ML Blog"},
            {"url": "https://techcommunity.microsoft.com/t5/ai-machine-learning-blog/rss", "name": "Microsoft AI Blog"},
            {"url": "https://engineering.fb.com/feed/", "name": "Meta Engineering Blog"}
        ]
    },
    "tech": {
        "primary": [
            {"name": "TechCrunch", "url": "https://techcrunch.com/feed/"},
            {"name": "The Verge", "url": "https://www.theverge.com/rss/index.xml"},
            {"name": "Ars Technica", "url": "https://feeds.arstechnica.com/arstechnica/index"},
            {"name": "WIRED", "url": "https://www.wired.com/feed/rss"},
            {"name": "Engadget", "url": "https://www.engadget.com/rss.xml"},
            {"name": "MIT Technology Review", "url": "https://www.technologyreview.com/feed/"},
        ],
        "secondary": [
            {"name": "Tom's Hardware", "url": "https://www.tomshardware.com/feeds/all"},
            {"name": "The Next Web", "url": "https://thenextweb.com/feed"},
        ]
},

}
def get_random_story_from(categories=None):
    """
    Returns a string like:
      "Title — link  (source: Feed Name)"
    Supports your RSS_FEEDS structure:
      RSS_FEEDS["crypto"]["primary"] = [{"url": "...", "name": "..."}]
    categories: list[str] or None => all categories
    """
    cats = []
    if not categories:
        cats = list(RSS_FEEDS.keys())
    else:
        cats = [str(c).strip().lower() for c in categories if str(c).strip()]

    pool = []
    for c in cats:
        bucket = RSS_FEEDS.get(c)
        if not isinstance(bucket, dict):
            continue
        for tier in ("primary", "secondary"):
            lst = bucket.get(tier, [])
            if isinstance(lst, list):
                for f in lst:
                    if isinstance(f, dict) and f.get("url"):
                        pool.append(f)

    if not pool:
        return None

    for _ in range(6):
        f = random.choice(pool)
        url = f.get("url", "")
        name = f.get("name", "RSS")

        try:
            feed = feedparser.parse(url)
            entries = getattr(feed, "entries", None) or []
            if entries:
                entry = random.choice(entries[:10])
                title = getattr(entry, "title", "(untitled)")
                link = getattr(entry, "link", "") or getattr(entry, "id", "") or ""
                return f"{title} — {link}\n(source: {name})"
        except Exception:
            continue

    return None

class EncryptionManager:
    def __init__(self):
        self.key = None
        self.cipher = None
        print("Initializing EncryptionManager...")

        if os.path.exists(ENCRYPTION_KEY_FILE):
            try:
                with open(ENCRYPTION_KEY_FILE, "rb") as f:
                    self.key = f.read()
                print(f"Loaded encryption key, length: {len(self.key)} bytes")
                self.cipher = Fernet(self.key)
                print("Successfully created Fernet cipher")
            except Exception as e:
                print(f"Error loading encryption key: {e}")
                traceback.print_exc()
                self.key = None
                self.cipher = None

        if self.key and self.cipher:
            self.validate_key()

        if not self.key or not self.cipher:
            print("Generating new encryption key...")
            self.key = Fernet.generate_key()
            try:
                with open(ENCRYPTION_KEY_FILE, "wb") as f:
                    f.write(self.key)
                self.cipher = Fernet(self.key)
                print("Successfully generated and saved new key")
            except Exception as e:
                print(f"Error saving new encryption key: {e}")
                self.key = None
                self.cipher = None

    def validate_key(self):
        try:
            test_cipher = Fernet(self.key)
            test_message = b"Test message for encryption validation"
            encrypted_message = test_cipher.encrypt(test_message)
            decrypted_message = test_cipher.decrypt(encrypted_message)
            assert test_message == decrypted_message, "Decrypted message does not match original"
            print("Encryption key validation passed.")
        except Exception as validation_error:
            print(f"Encryption key validation failed: {validation_error}")
            traceback.print_exc()

    def encrypt(self, data):
        if not self.cipher:
            print("Error encrypting data: cipher not initialized")
            return None
        try:
            json_data = json.dumps(data)
            encrypted = self.cipher.encrypt(json_data.encode())
            return encrypted
        except Exception as e:
            print(f"Error encrypting data: {e}")
            return None

    def decrypt(self, encrypted_data):
        if not self.cipher:
            print("Error decrypting data: cipher not initialized")
            return {}
        try:
            decrypted = self.cipher.decrypt(encrypted_data)
            return json.loads(decrypted.decode())
        except Exception as e:
            print(f"Error decrypting data: {e}")
            traceback.print_exc()
            return {}


class CryptoArticle:
    def __init__(self, title, preview, full_text, link, published_date):
        self.title = title
        self.preview = preview
        self.full_text = full_text
        self.link = link
        self.published_date = published_date

    def get_topic_text(self):
        return f"{self.title}\n\n{self.preview}"


class TwitterBot:

    def __init__(self):
        print("\n=== Initializing TwitterBot ===")
        self.encryption_manager = EncryptionManager()

        self.credentials = {}
        self.characters = {}
        self.feed_config = {}

        # Scheduler state
        self.scheduler_running = False
        self.scheduler_character = None
        self.scheduler_subject = "crypto"
        self.reply_bank = []
        self.last_daily_reply_date = None

        # Tweet cadence state
        self.tweet_queue = queue.Queue()
        self.last_successful_tweet = None
        self.last_observation_time = None
        self.backoff_until = None

        # Feed/memory state
        self.current_topic = ""
        self.feed_index = 0
        self.used_stories = set()
        self.recent_topics = []
        self.MAX_RECENT_TOPICS = 50
        self.feed_errors = defaultdict(int)
        self.feed_last_used = {}

        # Clients
        self.twitter_client = None
        self.client = None  # OpenAI client (optional)

        # Meme system
        self.use_memes = False
        self.meme_counter = 0
        self.meme_frequency = 5
        self.used_memes = set()

        if not os.path.exists("memes"):
            os.makedirs("memes")

        # Rate limit tracking
        self.rate_limits = TWITTER_RATE_LIMITS.copy()

        print("\n=== Loading Initial Data ===")
        self.credentials = self.load_credentials()
        print(f"[init] Credentials keys: {list(self.credentials.keys())}")

        self.characters = self.load_characters()
        print(f"[init] Characters: {sorted(list(self.characters.keys()))}")

        self.feed_config = self.load_feed_config()
        print(f"[init] Characters: {sorted(list(self.characters.keys()))}")

        # Initialize OpenAI client ONLY if enabled
        if USE_OPENAI and self.credentials.get("openai_key"):
            self.client = OpenAI(
                api_key=self.credentials["openai_key"],
                http_client=httpx.Client(
                    base_url="https://api.openai.com/v1",
                    follow_redirects=True,
                    timeout=60.0,
                ),
            )
            print("OpenAI client initialized (USE_OPENAI enabled).")
        else:
            if self.credentials.get("openai_key") and not USE_OPENAI:
                print("OpenAI key present, but USE_OPENAI is disabled — skipping OpenAI client init.")
            else:
                print("OpenAI client disabled or missing key.")

        # Initialize Twitter client if credentials present
        if all(k in self.credentials for k in [
            "twitter_api_key",
            "twitter_api_secret",
            "twitter_access_token",
            "twitter_access_token_secret",
        ]):
            self.twitter_client = tweepy.Client(
                consumer_key=self.credentials["twitter_api_key"],
                consumer_secret=self.credentials["twitter_api_secret"],
                access_token=self.credentials["twitter_access_token"],
                access_token_secret=self.credentials["twitter_access_token_secret"],
            )
            print("Twitter client initialized.")
        else:
            print("Twitter client NOT initialized (missing X credentials).")
            
    def load_credentials(self) -> dict:
        """
        Loads and decrypts credentials from disk.
        Safe logs only (never prints values).
        """
        if not hasattr(self, "encryption_manager") or self.encryption_manager is None:
            self.encryption_manager = EncryptionManager()

        if not os.path.exists(CREDENTIALS_FILE):
            print("[creds] No credentials file found.")
            return {}

        try:
            with open(CREDENTIALS_FILE, "rb") as f:
                blob = f.read()

            if not blob:
                print("[creds] Credentials file is empty.")
                return {}

            data = self.encryption_manager.decrypt(blob) or {}
            if not isinstance(data, dict):
                print("[creds] Decrypt returned non-dict; ignoring.")
                return {}

            # SAFE: only keys, never values
            print(f"[creds] Loaded keys: {sorted(list(data.keys()))}")
            return data

        except Exception as e:
            print(f"[creds] Error loading credentials: {e}")
            return {}

    # Inside class TwitterBot
    def _normalize_story(self, story, subject=None):
        """
        Ensure the story is a dict with keys: title, preview, url.
        Accepts strings or partial dicts and normalizes them.
        """
        if isinstance(story, str):
            return {
                "title": (subject or "Update").title(),
                "preview": story,
                "url": "#",
            }

        if isinstance(story, dict):
            return {
                "title": (story.get("title") or (subject or "Update").title()).strip(),
                "preview": (story.get("preview") or story.get("summary") or story.get("text") or "").strip(),
                "url": (story.get("url") or story.get("link") or "#").strip(),
            }

        return {"title": (subject or "Update").title(), "preview": "", "url": "#"}

    def _normalize_subject(self, subj):
        if not subj:
            return "news"

        s = str(subj).strip()
        if s.lower() in {"surprise_all", "surprise-all", "random", "any", "*"}:
            pool = list(getattr(self, "feed_config", {}).keys()) or list(RSS_FEEDS.keys())
            pool = [k for k in pool if k.lower() not in {"surprise_all", "surprise-all", "random"}]
            return random.choice(pool) if pool else "news"

        return s

    def get_random_story_all(self, subject=None):
        """
        Unified story getter used by the scheduler/queue.
        Tries a few likely single/bulk fetchers if they exist.
        If nothing is available, returns a small synthetic story so cadence never stalls.
        """
        # ✅ normalize subject so "surprise_all" actually fans out
        subject = self._normalize_subject(subject or getattr(self, "scheduler_subject", None) or "news")
        return self._durable_get_random_story_all(subject)
        def norm(st):
            return self._normalize_story(st, subject=subject)

        # 1) Try single-story fetchers (if you’ve implemented any)
        single_candidates = [
            "get_news_story",
            "get_new_story_from_feeds",
            "fetch_next_story",
            "fetch_story",
            "get_story_from_rss",
            "get_random_story_from",   # ✅ include the helper below if you keep it
        ]
        for name in single_candidates:
            if hasattr(self, name):
                try:
                    s = getattr(self, name)(subject)
                    if s:
                        ns = norm(s)
                        if ns["title"] or ns["preview"]:
                            print(f"[get_random_story_all] Using {name}()")
                            return ns
                except Exception as e:
                    print(f"[get_random_story_all] {name}() failed: {e}")

        # 2) Try bulk fetchers (pick one at random)
        bulk_candidates = [
            "fetch_news_stories",
            "get_stories_for_topic",
        ]
        for name in bulk_candidates:
            if hasattr(self, name):
                try:
                    stories = getattr(self, name)(subject) or []
                    if stories:
                        ns = norm(random.choice(stories))
                        print(f"[get_random_story_all] Using random from {name}()")
                        return ns
                except Exception as e:
                    print(f"[get_random_story_all] {name}() failed: {e}")

        # 3) Synthetic fallback so the queue is never empty
        ts = datetime.now().strftime("%b %d, %Y %I:%M %p")
        print("[get_random_story_all] No concrete source found; returning fallback story.")
        return {
            "title": f"{subject.title()} update — {ts}",
            "preview": f"Quick thought on {subject}. (auto-generated fallback)",
            "url": "#",
        }
    def get_random_story_from(self, categories=None):
        """
        Returns a normalized dict: {title, preview, url}
        categories: list[str] or None => all categories
        """
        cats = []
        if not categories:
            cats = list(RSS_FEEDS.keys())
        else:
            cats = [str(c).strip().lower() for c in categories if str(c).strip()]

        feeds = []
        for c in cats:
            bucket = RSS_FEEDS.get(c)
            if not isinstance(bucket, dict):
                continue
            for tier in ("primary", "secondary"):
                lst = bucket.get(tier, [])
                if isinstance(lst, list):
                    for f in lst:
                        if isinstance(f, dict) and f.get("url"):
                            feeds.append(f)

        if not feeds:
            return None

        for _ in range(6):
            f = random.choice(feeds)
            url = f.get("url", "")
            name = f.get("name", "RSS")

            try:
                feed = feedparser.parse(url)
                if getattr(feed, "entries", None):
                    entry = random.choice(feed.entries[:10])
                    title = getattr(entry, "title", "(untitled)")
                    link = getattr(entry, "link", "") or getattr(entry, "id", "") or ""
                    preview = getattr(entry, "summary", "") or getattr(entry, "description", "") or ""
                    story = {
                        "title": f"{title} ({name})",
                        "preview": preview.strip(),
                        "url": link.strip() or url,
                    }
                    return self._normalize_story(story, subject=(cats[0] if cats else "news"))
            except Exception as e:
                print(f"[get_random_story_from] parse failed ({name}): {e}")

        return None
        
    def _normalize_subject(self, subject):
        """
        Map placeholders like 'Surprise_All'/'random' to a real subject from feed_config or RSS_FEEDS.
        Returns the canonical key (preserve original keys when possible).
        """
        s_raw = (str(subject).strip() if subject else "")
        s = s_raw.lower()

        if not s or s in {"surprise_all", "__surprise_all__", "surprise-all", "random", "any", "all", "*"}:
            pool = list(getattr(self, "feed_config", {}).keys())
            if not pool:
                pool = list(RSS_FEEDS.keys())

            pool = [k for k in pool if k and str(k).lower() not in {
                "surprise_all", "__surprise_all__", "surprise-all", "random", "any", "all", "*"
            }]
            return random.choice(pool) if pool else "news"

        # If user gave "AI" but keys are "ai", normalize to existing key
        if "RSS_FEEDS" in globals():
            for k in RSS_FEEDS.keys():
                if str(k).lower() == s:
                    return k

        if hasattr(self, "feed_config") and isinstance(self.feed_config, dict):
            for k in self.feed_config.keys():
                if str(k).lower() == s:
                    return k

        return s_raw or "news"
    def load_characters(self) -> dict:
        if not os.path.exists(CHARACTERS_FILE):
            print("[chars] No characters file found.")
            return {}
        try:
            with open(CHARACTERS_FILE, "rb") as f:
                blob = f.read()
            if not blob:
                print("[chars] Characters file is empty.")
                return {}
            data = self.encryption_manager.decrypt(blob) or {}
            if not isinstance(data, dict):
                print("[chars] Decrypt returned non-dict; ignoring.")
                return {}
            print(f"[chars] Loaded: {sorted(list(data.keys()))}")
            return data
        except Exception as e:
            print(f"[chars] Error loading characters: {e}")
            return {}

    def save_characters(self, characters: dict) -> bool:
        try:
            encrypted = self.encryption_manager.encrypt(characters)
            if not encrypted:
                print("[chars] Failed to encrypt.")
                return False
            with open(CHARACTERS_FILE, "wb") as f:
                f.write(encrypted)
            self.characters = characters or {}
            print(f"[chars] Saved: {sorted(list(self.characters.keys()))}")
            return True
        except Exception as e:
            print(f"[chars] Error saving: {e}")
            return False
    def scheduler_worker(self):
        print("\n🛠️ Starting scheduler worker (jittered)...")

        ACTIVE_START_HOUR = int(getattr(self, "ACTIVE_START_HOUR", 8))
        ACTIVE_END_HOUR = int(getattr(self, "ACTIVE_END_HOUR", 23))
        min_gap_min = int(getattr(self, "MIN_GAP_MIN", 35))
        main_base_min = int(getattr(self, "MAIN_BASE_MIN", 240))
        main_jitter_min = int(getattr(self, "MAIN_JITTER_MIN", 70))
        obs_base_min = int(getattr(self, "OBS_BASE_MIN", 180))
        obs_jitter_min = int(getattr(self, "OBS_JITTER_MIN", 60))
        mention_base_min = int(getattr(self, "MENTION_BASE_MIN", 12))
        mention_jitter_min = int(getattr(self, "MENTION_JITTER_MIN", 4))
        mention_sweep_mode = str(getattr(self, "MENTION_SWEEP_MODE", "jitter")).strip().lower()
        mention_sweep_hour = int(getattr(self, "MENTION_SWEEP_HOUR", 10))
        mention_sweep_minute = int(getattr(self, "MENTION_SWEEP_MINUTE", 0))
        daily_mention_cap = int(getattr(self, "DAILY_MENTION_CAP", 2))

        self.scheduler_character = getattr(self, "scheduler_character", None)
        self.scheduler_subject = getattr(self, "scheduler_subject", "crypto")
        self.reply_bank = getattr(self, "reply_bank", [])
        self.last_daily_reply_date = getattr(self, "last_daily_reply_date", None)
        self.last_mention_sweep_date = getattr(self, "last_mention_sweep_date", None)
        self.daily_replies_sent = getattr(self, "daily_replies_sent", 0)
        self.last_observation_time = getattr(self, "last_observation_time", None)

        if not getattr(self, "last_successful_tweet", None):
            print("🚀 No previous tweet timestamp found. Setting last_successful_tweet to now.")
            self.last_successful_tweet = datetime.now()
        if self.last_observation_time is None:
            self.last_observation_time = datetime.now()

        def within_active_hours(dt: datetime) -> bool:
            return ACTIVE_START_HOUR <= dt.hour < ACTIVE_END_HOUR

        def push_into_active_window(dt: datetime) -> datetime:
            if within_active_hours(dt):
                return dt
            if dt.hour < ACTIVE_START_HOUR:
                return dt.replace(
                    hour=ACTIVE_START_HOUR,
                    minute=random.randint(0, 35),
                    second=random.randint(0, 20),
                    microsecond=0,
                )
            nxt = dt + timedelta(days=1)
            return nxt.replace(
                hour=ACTIVE_START_HOUR,
                minute=random.randint(0, 45),
                second=random.randint(0, 25),
                microsecond=0,
            )

        def schedule_next(base_min: int, jitter_min: int, min_gap: int) -> datetime:
            now = datetime.now()
            jitter = random.randint(-jitter_min, jitter_min)
            delta = max(min_gap, min(base_min + jitter, base_min + jitter_min))
            return push_into_active_window(now + timedelta(minutes=delta))

        def next_daily_mention_sweep(after_dt: datetime) -> datetime:
            candidate = after_dt.replace(
                hour=mention_sweep_hour,
                minute=mention_sweep_minute,
                second=0,
                microsecond=0,
            )
            if candidate <= after_dt:
                candidate = candidate + timedelta(days=1)
            return candidate

        next_main_at = schedule_next(base_min=45, jitter_min=20, min_gap=min_gap_min)
        next_obs_at = schedule_next(base_min=60, jitter_min=25, min_gap=min_gap_min)
        now_boot = datetime.now()
        if mention_sweep_mode == "daily":
            already_ran_today = (
                isinstance(self.last_mention_sweep_date, str)
                and self.last_mention_sweep_date == now_boot.date().isoformat()
            )
            if (not already_ran_today) and (
                (now_boot.hour > mention_sweep_hour)
                or (now_boot.hour == mention_sweep_hour and now_boot.minute >= mention_sweep_minute)
            ):
                next_mentions_at = now_boot
            else:
                next_mentions_at = next_daily_mention_sweep(now_boot)
        else:
            next_mentions_at = schedule_next(base_min=mention_base_min, jitter_min=mention_jitter_min, min_gap=3)

        print(f"⏱ Next MAIN tweet    : {next_main_at}")
        print(f"⏱ Next OBS tweet     : {next_obs_at}")
        print(f"⏱ Next mention sweep : {next_mentions_at}")
        if mention_sweep_mode == "daily":
            print(f"📬 Mention sweep mode: daily @ {mention_sweep_hour:02d}:{mention_sweep_minute:02d}")
        else:
            print(f"📬 Mention sweep mode: jittered every ~{mention_base_min}m (±{mention_jitter_min}m)")
        print(f"🕒 Active hours      : {ACTIVE_START_HOUR:02d}:00–{ACTIVE_END_HOUR:02d}:00")
        print(f"🧾 Daily mention cap  : {daily_mention_cap}")

        while self.scheduler_running:
            try:
                now = datetime.now()

                # Reset daily counter when day changes
                if self.last_daily_reply_date != now.date():
                    self.last_daily_reply_date = now.date()
                    self.daily_replies_sent = 0

                # Respect backoff
                if getattr(self, "backoff_until", None) and now < self.backoff_until:
                    wait_seconds = (self.backoff_until - now).total_seconds()
                    print(f"⏳ Backoff active until {self.backoff_until}. Sleeping {wait_seconds/60:.1f} minutes...")
                    time.sleep(min(60, max(1, wait_seconds)))
                    continue

                # -------------------------
                # (A) Mentions sweep (reply only to mentions; bank overflow)
                # -------------------------
                if now >= next_mentions_at:
                    if mention_sweep_mode == "daily":
                        self.last_mention_sweep_date = now.date().isoformat()
                        next_mentions_at = next_daily_mention_sweep(now)
                    else:
                        next_mentions_at = schedule_next(base_min=mention_base_min, jitter_min=mention_jitter_min, min_gap=3)

                    if self.daily_replies_sent >= daily_mention_cap:
                        print(f"🧾 Mention sweep: daily cap reached ({self.daily_replies_sent}/{daily_mention_cap}). Banking only.")
                    else:
                        print(f"\n📬 Mention sweep @ {now.strftime('%H:%M:%S')} (daily {self.daily_replies_sent}/{daily_mention_cap})")

                    pending = []

                    # Use bank first
                    if self.reply_bank:
                        print(f"↪ Using {len(self.reply_bank)} banked mentions first.")
                        pending.extend(self.reply_bank)
                        self.reply_bank = []

                    # Fetch new mentions if none banked
                    if not pending:
                        try:
                            if hasattr(self, "collect_unreplied_mentions"):
                                pending = self.collect_unreplied_mentions() or []
                            elif hasattr(self, "fetch_recent_mentions"):
                                pending = self.fetch_recent_mentions() or []
                            elif hasattr(self, "monitor_and_reply_to_mentions"):
                                print("⚠ Using monitor_and_reply_to_mentions fallback.")
                                self.monitor_and_reply_to_mentions()
                                pending = []
                            else:
                                print("⚠ No mention-collection method found.")
                                pending = []
                        except Exception as e:
                            print(f"❌ Error fetching mentions: {e}")
                            pending = []

                    handled = 0
                    for m in pending:
                        if self.daily_replies_sent >= daily_mention_cap:
                            self.reply_bank.append(m)
                            continue

                        try:
                            if hasattr(self, "reply_to_mention"):
                                self.reply_to_mention(m)
                                handled += 1
                                self.daily_replies_sent += 1
                            elif hasattr(self, "reply_to_engagement"):
                                self.reply_to_engagement(m)
                                handled += 1
                                self.daily_replies_sent += 1
                            else:
                                self.reply_bank.append(m)

                            time.sleep(random.uniform(6, 18))
                        except Exception as e:
                            print(f"❌ Failed replying to a mention: {e}")
                            self.reply_bank.append(m)

                    print(f"✅ Mention sweep done. Sent {handled}. Banked {len(self.reply_bank)}. Daily {self.daily_replies_sent}/{daily_mention_cap}.")

                # -------------------------
                # (B) Observation tweet (Mork Core) (jittered)
                # -------------------------
                now = datetime.now()
                if now >= next_obs_at:
                    next_obs_at = schedule_next(obs_base_min, obs_jitter_min, min_gap=min_gap_min)

                    if not within_active_hours(now):
                        print("🌙 Observation skipped (outside active hours).")
                    else:
                        try:
                            try:
                                did_reflect = core_reflect(timeout=6)
                            except Exception as e:
                                did_reflect = False
                                print(f"⚠ core_reflect failed: {e}")
                            print(f"🧠 core_reflect: {did_reflect}")

                            obs = ""
                            try:
                                obs = core_compose_payload({"kind": "reflection", "maxChars": 260}, timeout=10) or ""
                                if not obs:
                                    obs = core_compose_payload({"kind": "arb", "maxChars": 260}, timeout=10) or ""
                                if not obs:
                                    obs = core_compose_payload({"kind": "observation", "maxChars": 260}, timeout=10) or ""
                            except Exception as e:
                                print(f"⚠ core compose failed: {e}")
                                obs = ""

                            if obs:
                                print("🧠 Posting Mork Core observation…")
                                ok = self.send_tweet(obs)
                                if ok:
                                    self.last_observation_time = datetime.now()
                                    time.sleep(random.uniform(5, 14))
                                else:
                                    print("⚠ Observation tweet failed (send_tweet returned false).")
                            else:
                                print("⚠ Core returned empty observation.")
                        except Exception as e:
                            print(f"⚠ Observation block failed: {e}")

                # -------------------------
                # (C) Main tweet (queue/news) (jittered)
                # -------------------------
                now = datetime.now()
                if now >= next_main_at:
                    next_main_at = schedule_next(main_base_min, main_jitter_min, min_gap=min_gap_min)

                    if not within_active_hours(now):
                        print("🌙 Main tweet skipped (outside active hours).")
                    else:
                        print("\n⏰ Main tweet window — sending next tweet...")

                        if not self.tweet_queue.empty():
                            character, story_text, subject = self.tweet_queue.get()
                            tweet_text = self.generate_tweet(character, story_text)

                            if tweet_text and self.send_tweet(tweet_text):
                                print("✅ Tweet from queue sent.")
                                self.last_successful_tweet = datetime.now()
                                time.sleep(random.uniform(6, 16))
                            else:
                                print("❌ Failed to send tweet from queue.")
                        else:
                            print("📭 Tweet queue empty — refilling from RSS...")
                            seeded = 0
                            for _ in range(3):
                                s = self.get_new_story(self.scheduler_subject)
                                if not s:
                                    break
                                txt = (
                                    f"{s['title']}\n\n"
                                    f"{s.get('preview','')}\n\n"
                                    f"Read more: {s['url']}"
                                )
                                self.tweet_queue.put((self.scheduler_character, txt, self.scheduler_subject))
                                seeded += 1
                            print(f"📥 Refilled with {seeded} story(ies).")

                time.sleep(5)

            except Exception as e:
                print(f"❌ Error in scheduler worker: {e}")
                time.sleep(20)
                
    def get_stories_from_feed(self, url, limit: int = 10):
        """
        Fetch RSS/Atom items and return a list of dicts with: title, preview, url.
        Tries feedparser; falls back to requests + XML.
        """
        items = []

        # 1) feedparser path
        try:
            import feedparser
            d = feedparser.parse(url)
            for e in (d.entries or [])[:limit]:
                title = (e.get("title") or "").strip()
                link = (e.get("link") or "#").strip()
                summary = (e.get("summary") or e.get("description") or "").strip()
                if title or summary:
                    items.append({"title": title, "preview": summary, "url": link})
            if items:
                return items
        except Exception as e:
            print(f"[get_stories_from_feed] feedparser error for {url}: {e}")

        # 2) fallback XML path
        try:
            import re, html, requests, xml.etree.ElementTree as ET
            r = requests.get(url, timeout=10, headers=DEFAULT_HEADERS if "DEFAULT_HEADERS" in globals() else None)
            r.raise_for_status()

            root = ET.fromstring(r.content)

            # RSS
            for it in root.findall(".//item")[:limit]:
                title = (it.findtext("title") or "").strip()
                link = (it.findtext("link") or "#").strip()
                desc = (it.findtext("description") or "").strip()
                desc = html.unescape(re.sub(r"<[^>]+>", "", desc))
                if title or desc:
                    items.append({"title": title, "preview": desc, "url": link})

            if items:
                return items

            # Atom
            ns = {"a": "http://www.w3.org/2005/Atom"}
            for it in root.findall(".//a:entry", ns)[:limit]:
                title = (it.findtext("a:title", default="", namespaces=ns) or "").strip()
                link_el = it.find("a:link", ns)
                link = link_el.get("href", "#").strip() if link_el is not None else "#"
                desc = (it.findtext("a:summary", default="", namespaces=ns) or "").strip()
                if title or desc:
                    items.append({"title": title, "preview": desc, "url": link})

        except Exception as e:
            print(f"[get_stories_from_feed] fallback error for {url}: {e}")

        return items

    def load_credentials(self):
        print("\nLoading credentials...")
        if not os.path.exists(CREDENTIALS_FILE):
            print("No credentials file found")
            return {}
        try:
            with open(CREDENTIALS_FILE, "rb") as f:
                data = f.read()
            print(f"Read credentials file, size: {len(data)} bytes")
            if not data:
                print("Empty credentials file")
                return {}

            print("Attempting to decrypt credentials...")
            decrypted = self.encryption_manager.decrypt(data) or {}
            if not isinstance(decrypted, dict) or not decrypted:
                print("Failed to decrypt credentials")
                return {}

            print(f"Successfully loaded credentials with keys: {list(decrypted.keys())}")
            return decrypted
        except Exception as e:
            print(f"Error loading credentials: {e}")
            import traceback
            traceback.print_exc()
            return {}

    def save_credentials(self, credentials):
        print("\nSaving credentials to file...")
        print(f"Credentials to save: {list(credentials.keys())}")
        try:
            print("Encrypting credentials...")
            encrypted_data = self.encryption_manager.encrypt(credentials)
            if not encrypted_data:
                print("Failed to encrypt credentials")
                return False

            print(f"Encrypted data length: {len(encrypted_data)} bytes")
            with open(CREDENTIALS_FILE, "wb") as f:
                f.write(encrypted_data)

            self.credentials = credentials
            print("Updated bot credentials in memory")

            # OpenAI client ONLY if enabled
            if USE_OPENAI and credentials.get("openai_key"):
                print("Initializing OpenAI client...")
                self.client = OpenAI(
                    api_key=credentials["openai_key"],
                    http_client=httpx.Client(
                        base_url="https://api.openai.com/v1",
                        follow_redirects=True,
                        timeout=60.0,
                    ),
                )
                print("OpenAI client initialized")
            else:
                self.client = None
                if credentials.get("openai_key") and not USE_OPENAI:
                    print("OpenAI key saved, but USE_OPENAI is disabled — client not initialized.")

            # Twitter client if all credentials provided
            needed = {"twitter_api_key", "twitter_api_secret", "twitter_access_token", "twitter_access_token_secret"}
            if needed.issubset(set(credentials.keys())):
                print("Initializing Twitter client...")
                self.twitter_client = tweepy.Client(
                    consumer_key=credentials["twitter_api_key"],
                    consumer_secret=credentials["twitter_api_secret"],
                    access_token=credentials["twitter_access_token"],
                    access_token_secret=credentials["twitter_access_token_secret"],
                )
                print("Twitter client initialized")
            else:
                # keep existing client if you want; or set to None to be strict
                print("Twitter client not re-initialized (missing one or more X keys).")

            self.sync_telegram_env(credentials)
            return True

        except Exception as e:
            print(f"Error saving credentials: {e}")
            import traceback
            traceback.print_exc()
            return False

    def sync_telegram_env(self, credentials):
        token = (credentials.get("telegram_bot_token") or "").strip()
        chat_id = (credentials.get("telegram_chat_id") or "").strip()
        if not token and not chat_id:
            return

        def normalize_bot_token(raw):
            t = (raw or "").strip()
            if t.lower().startswith("https://api.telegram.org/bot"):
                t = t.split("/bot", 1)[1].split("/", 1)[0].strip()
            if t.lower().startswith("bot"):
                t = t[3:].strip()
            return t

        def is_chat_id(value):
            v = (value or "").strip()
            return bool(re.match(r"^-?\d{6,}$", v))

        def is_bot_token(value):
            v = normalize_bot_token(value)
            return bool(re.match(r"^\d{6,}:[A-Za-z0-9_-]{20,}$", v))

        normalized_token = normalize_bot_token(token)
        if normalized_token and not is_bot_token(normalized_token):
            if is_chat_id(normalized_token) and not chat_id:
                chat_id = normalized_token
            print(
                "[creds] Telegram bot token looks invalid. "
                "Expected BotFather token format like 123456:ABC... "
                "Will not overwrite TELEGRAM_BOT_TOKEN until corrected."
            )
            normalized_token = ""

        env_path = CROSS_SERVICE_ENV_PATH
        try:
            lines = []
            if env_path.exists():
                lines = env_path.read_text(encoding="utf-8").splitlines()

            def upsert(lines_in, key, value):
                new_line = f'{key}="{value}"'
                for idx, line in enumerate(lines_in):
                    if line.strip().startswith(f"{key}="):
                        lines_in[idx] = new_line
                        return
                lines_in.append(new_line)

            if normalized_token:
                upsert(lines, "TELEGRAM_BOT_TOKEN", normalized_token)
            if chat_id:
                upsert(lines, "TELEGRAM_CHAT_ID", chat_id)

            env_path.parent.mkdir(parents=True, exist_ok=True)
            env_path.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8")
            print(f"[creds] Updated telegram values in {env_path}")
        except Exception as e:
            print(f"[creds] Failed to sync telegram env file: {e}")
    
        
    def get_article_content(self, url):
        try:
            headers = DEFAULT_HEADERS if "DEFAULT_HEADERS" in globals() else None
            response = requests.get(url, headers=headers, timeout=10)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            for script in soup(["script", "style"]):
                script.decompose()
            return soup.get_text(separator="\n", strip=True)
        except Exception:
            return ""

    def extract_keywords(self, text):
        """Extract important keywords from text to track topic diversity."""
        common_terms = {
            "crypto","blockchain","bitcoin","ethereum","btc","eth",
            "cryptocurrency","cryptocurrencies","token","tokens","defi",
            "market","markets","trading","price","prices"
        }
        words = re.findall(r"\b\w+\b", (text or "").lower())
        keywords = {
            w for w in words
            if w not in common_terms and len(w) > 3 and not w.isdigit()
        }
        return keywords

    def is_similar_to_recent(self, title, preview):
        """Check if a story is too similar to recently posted ones."""
        new_keywords = self.extract_keywords(f"{title} {preview}")
        if not new_keywords:
            return False

        for recent_keywords in getattr(self, "recent_topics", []) or []:
            if not recent_keywords:
                continue
            denom = len(new_keywords | recent_keywords)
            if denom == 0:
                continue
            overlap = len(new_keywords & recent_keywords) / denom
            if overlap > 0.4:
                return True
        return False

    def get_arxiv_paper_details(self, url):
        """Get detailed information about an arXiv paper including abstract and authors."""
        try:
            paper_id = url.split("/")[-1]
            if "arxiv.org/abs/" in url:
                paper_id = url.split("arxiv.org/abs/")[-1]
            elif "arxiv.org/pdf/" in url:
                paper_id = url.split("arxiv.org/pdf/")[-1].replace(".pdf", "")

            api_url = f"http://export.arxiv.org/api/query?id_list={paper_id}"
            response = requests.get(api_url, timeout=FEED_TIMEOUT)
            response.raise_for_status()

            from xml.etree import ElementTree
            root = ElementTree.fromstring(response.content)

            ns = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
            entry = root.find(".//atom:entry", ns)
            if entry is None:
                return None

            abstract = (entry.find("atom:summary", ns).text or "").strip()
            authors = [a.find("atom:name", ns).text for a in entry.findall("atom:author", ns)]
            categories = [cat.get("term") for cat in entry.findall("atom:category", ns)]

            links = entry.findall("atom:link", ns)
            html_url = next((lnk.get("href") for lnk in links if lnk.get("type") == "text/html"), None) \
                    or f"https://arxiv.org/abs/{paper_id}"

            return {
                "abstract": abstract,
                "authors": authors,
                "categories": categories,
                "html_url": html_url,
                "paper_id": paper_id,
            }

        except Exception as e:
            print(f"Error fetching arXiv paper details: {e}")
            return None

    def load_feed_config(self):
        """
        Load feed configuration.
        NOTE: Your constants define FEED_CONFIG_FILE as encrypted, but your code uses JSON.
        We'll support BOTH:
        - encrypted FEED_CONFIG_FILE (preferred if present)
        - feed_config.json fallback (legacy)
        """
        # 1) preferred: encrypted file
        try:
            if "FEED_CONFIG_FILE" in globals() and os.path.exists(FEED_CONFIG_FILE):
                with open(FEED_CONFIG_FILE, "rb") as f:
                    blob = f.read()
                cfg = self.encryption_manager.decrypt(blob) or {}
                if isinstance(cfg, dict):
                    return cfg
        except Exception as e:
            print(f"Error loading encrypted feed config: {e}")

        # 2) legacy json
        try:
            if os.path.exists("feed_config.json"):
                with open("feed_config.json", "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as e:
            print(f"Error loading feed configuration: {e}")

        return {}

    def save_feed_config(self, config):
        """
        Save feed configuration.
        Writes encrypted FEED_CONFIG_FILE if defined; also updates in-memory self.feed_config.
        """
        self.feed_config = config

        # 1) preferred: encrypted
        try:
            if "FEED_CONFIG_FILE" in globals():
                encrypted = self.encryption_manager.encrypt(config)
                if encrypted:
                    with open(FEED_CONFIG_FILE, "wb") as f:
                        f.write(encrypted)
                    return True
        except Exception as e:
            print(f"Error saving encrypted feed configuration: {e}")

        # 2) legacy json fallback
        try:
            with open("feed_config.json", "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            print(f"Error saving feed configuration: {e}")
            return False

    def get_new_story(self, subject=None):
        """
        Pull the next unused story for a subject from configured RSS_FEEDS/feed_config.
        Falls back to get_random_story_all(subject) to keep cadence alive.
        """
        import random
        subject = subject or getattr(self, "scheduler_subject", None) or "news"

        # Figure out feed list
        feeds = None
        if getattr(self, "feed_config", None):
            feeds = self.feed_config.get(subject)
        if feeds is None and "RSS_FEEDS" in globals():
            feeds = RSS_FEEDS.get(subject)

        # Build normalized list of URL strings
        if isinstance(feeds, dict):
            raws = list(feeds.get("primary", [])) + list(feeds.get("secondary", []))
        elif isinstance(feeds, (list, tuple)):
            raws = list(feeds)
        else:
            raws = []

        urls = []
        for item in raws:
            if isinstance(item, dict):
                u = item.get("url")
            else:
                u = item
            if u:
                urls.append(u)

        random.shuffle(urls)

        # Try feeds
        for url in urls:
            try:
                stories = self.get_stories_from_feed(url, limit=10) or []
                for s in stories:
                    u = (s.get("url") or s.get("link") or "#").strip()
                    if u in self.used_stories:
                        continue

                    title = (s.get("title") or "").strip()
                    preview = (s.get("preview") or s.get("summary") or "").strip()
                    if not (title or preview):
                        continue

                    # similarity filter
                    if getattr(self, "recent_topics", None) and self.is_similar_to_recent(title, preview):
                        continue

                    story = {"title": title or subject.title(), "preview": preview, "url": u}
                    self.used_stories.add(u)

                    # record keyword-set for diversity tracking
                    kw = self.extract_keywords(f"{story['title']} {story['preview']}")
                    if kw:
                        self.recent_topics.append(kw)
                        if len(self.recent_topics) > getattr(self, "MAX_RECENT_TOPICS", 50):
                            self.recent_topics = self.recent_topics[-self.MAX_RECENT_TOPICS:]

                    return story

            except Exception as e:
                print(f"Error fetching from feed {url}: {e}")

        # Last resort: use your all-sources selector (which has a synthetic fallback)
        return self.get_random_story_all(subject)

    def _parse_story_block(self, topic):

        """
        Your Sherpa story_text format is typically:
        Title

        Preview...

        Read more: https://...
        Returns (title, text, url)
        """
        topic = (topic or "").strip()
        if not topic:
            return ("", "", "")

        # Extract URL from "Read more:"
        url_match = re.search(r"Read more:\s*(https?://\S+)", topic)
        article_url = url_match.group(1).strip() if url_match else ""

        # Remove the Read more line from the body
        clean = re.sub(r"\n*\s*Read more:\s*https?://\S+\s*", "", topic).strip()

        # Title = first non-empty line
        lines = [ln.strip() for ln in clean.splitlines()]
        lines = [ln for ln in lines if ln]
        if not lines:
            return ("", clean, article_url)

        title = lines[0]
        text = "\n".join(lines[1:]).strip()
        return (title, text, article_url)


    def generate_tweet(self, character_name, topic):
        """
        Primary tweet generator.
        - If USE_OPENAI is off (or client missing), we route to Mork Core composer with payloads.
        - If USE_OPENAI is on, we use your existing OpenAI logic (kept, but cleaned/guarded).
        """

        # --- Safety: ensure required state exists (Gradio / reload / partial init can skip __init__) ---
        if not hasattr(self, "tweet_count"):
            self.tweet_count = 0
        if not hasattr(self, "last_tweet_time"):
            self.last_tweet_time = None
        if not hasattr(self, "used_stories"):
            self.used_stories = set()
        if not hasattr(self, "recent_topics"):
            self.recent_topics = []
        if not hasattr(self, "rate_limits"):
            try:
                self.rate_limits = TWITTER_RATE_LIMITS.copy()
            except Exception:
                self.rate_limits = {}
        if not hasattr(self, "backoff_until"):
            self.backoff_until = None
        # --------------------------------------------------------------------------------------------

        character = self.characters.get(character_name)
        if not character:
            return None

        try:
            # Monthly cap (kept)
            if self.tweet_count >= MAX_TWEETS_PER_MONTH:
                current_time = datetime.now()
                if not self.last_tweet_time or (current_time - self.last_tweet_time).days >= 30:
                    self.tweet_count = 0
                else:
                    return "Monthly tweet limit reached. Please wait for the next cycle."

            # Parse story payload if present
            title, text, article_url = self._parse_story_block(topic or "")

            # Calculate content limit (if URL gets appended)
            TWITTER_SHORT_URL_LENGTH = 24
            max_content_length = 280 - TWITTER_SHORT_URL_LENGTH if article_url else 280
            max_chars_for_core = min(260, max_content_length)  # keep your usual 260 internal target

            # ----------------------------
            # NO-OPENAI MODE: use Mork Core
            # ----------------------------
            if (not USE_OPENAI) or (not getattr(self, "client", None)):
                payload = None

                # If this looks like a feed story (we have a URL or a title+text block), compose as "feed"
                if article_url or (title and text):
                    payload = {
                        "kind": "feed",
                        "title": title or "Update",
                        "text": (text or "").strip(),
                        "url": article_url or "",
                        "maxChars": max_chars_for_core,
                    }
                else:
                    # Otherwise treat as an observation prompt (mention replies often come in here too)
                    payload = {
                        "kind": "observation",
                        "text": (topic or "").strip(),
                        "maxChars": max_chars_for_core,
                    }

                tweet_text = core_compose_payload(payload, timeout=10) or ""

                # If core returns nothing, last-resort fallback so we don't crash your scheduler
                if not tweet_text:
                    tweet_text = _wrap_280((topic or "…").strip() or "…", max_chars_for_core)

                # Append article URL at end if needed (and not already included)
                if article_url and article_url not in tweet_text:
                    tweet_text = _wrap_280(f"{tweet_text} {article_url}", 280)

                self.tweet_count += 1
                self.last_tweet_time = datetime.now()
                return tweet_text

            # ----------------------------
            # OPENAI MODE (kept, tightened)
            # ----------------------------

            clean_topic = (topic or "").strip()
            if article_url:
                clean_topic = re.sub(r"\n*\s*Read more:\s*https?://\S+\s*", "", clean_topic).strip()

            prompt_variants = [
                "Speak as if you're writing a soliloquy for a tragic sauce-themed play.",
                "Add a sprinkle of literary irony, but make it savory.",
                "Pretend to be distracted.",
                "Imagine you're writing from exile in a forgotten condiment aisle.",
                "Use language that suggests you're the last philosopher alive.",
                "Add an unexpected culinary metaphor, ideally involving vinegar or smoke.",
                "Maintain melancholy but make it tastefully funny.",
                "Respond as if the conversation was with a long lost friend.",
                "End with an awkward outro.",
            ]
            hour = datetime.now().hour
            if hour < 12:
                prompt_variants.append("Start with morning gloom, like breakfast with no sauce.")
            elif hour > 20:
                prompt_variants.append("Make it sound like a sauce-stained midnight confession.")

            variation = random.choice(prompt_variants)

            messages = [
                {"role": "system", "content": character["prompt"]},
                {
                    "role": "user",
                    "content": (
                        f"{variation}\n\n"
                        f"Create a tweet about this topic that is {max_content_length} characters or less. "
                        f"Make it engaging and maintain character voice. NO hashtags, emojis, or URLs.\n\n"
                        f"Topic:\n{clean_topic}"
                    ),
                },
            ]

            try:
                response = self.client.chat.completions.create(
                    model=character["model"],
                    messages=messages,
                    max_tokens=200,
                    temperature=1.0,
                    presence_penalty=0.6,
                    frequency_penalty=0.6,
                )
            except Exception as e:
                print(f"⚠ OpenAI compose failed ({type(e).__name__}); falling back to Mork Core/local.")
                payload = {
                    "kind": "observation",
                    "text": (topic or "").strip(),
                    "maxChars": max_chars_for_core,
                }
                fallback = core_compose_payload(payload, timeout=8) or _wrap_280((topic or "…").strip() or "…", max_chars_for_core)
                if article_url and article_url not in fallback:
                    fallback = _wrap_280(f"{fallback} {article_url}", 280)
                self.tweet_count += 1
                self.last_tweet_time = datetime.now()
                return fallback

            tweet_text = (response.choices[0].message.content or "").strip()

            # Strip surrounding quotes
            if len(tweet_text) >= 2 and (
                (tweet_text[0] == '"' and tweet_text[-1] == '"') or
                (tweet_text[0] == "'" and tweet_text[-1] == "'")
            ):
                tweet_text = tweet_text[1:-1].strip()

            # Hard truncate by sentence boundary
            if len(tweet_text) > max_content_length:
                sentences = re.split(r"(?<=[.!?])\s+", tweet_text)
                out = ""
                for s in sentences:
                    cand = (out + (" " if out else "") + s).strip()
                    if len(cand) <= max_content_length:
                        out = cand
                    else:
                        break
                tweet_text = out.strip() or tweet_text[:max_content_length].rstrip() + "…"

            if article_url:
                tweet_text = _wrap_280(f"{tweet_text} {article_url}", 280)

            self.tweet_count += 1
            self.last_tweet_time = datetime.now()
            return tweet_text

        except Exception:
            import traceback
            print("❌ Error generating tweet:")
            traceback.print_exc()
            return None

    def check_rate_limit(self):
        """Check if we're within rate limits for tweeting"""
        current_time = datetime.now()

        if self.rate_limits["tweets"]["backoff_until"]:
            if current_time < self.rate_limits["tweets"]["backoff_until"]:
                wait_seconds = (self.rate_limits["tweets"]["backoff_until"] - current_time).total_seconds()
                print(f"\nIn backoff period. Waiting {wait_seconds/60:.1f} minutes")
                return False
            else:
                print("\nBackoff period ended, resetting rate limits")
                self.rate_limits["tweets"]["backoff_until"] = None
                self.rate_limits["tweets"]["current_count"] = 0
                self.rate_limits["tweets"]["window_start"] = current_time
                return True

        if not self.rate_limits["tweets"]["window_start"]:
            self.rate_limits["tweets"]["window_start"] = current_time
            self.rate_limits["tweets"]["current_count"] = 0
            return True

        window_hours = self.rate_limits["tweets"]["window_hours"]
        window_start = self.rate_limits["tweets"]["window_start"]
        if (current_time - window_start).total_seconds() > window_hours * 3600:
            # Reset window
            self.rate_limits["tweets"]["window_start"] = current_time
            self.rate_limits["tweets"]["current_count"] = 0
            print("\nRate limit window reset")
            return True

        if self.rate_limits["tweets"]["current_count"] < self.rate_limits["tweets"]["max_tweets"]:
            remaining = self.rate_limits["tweets"]["max_tweets"] - self.rate_limits["tweets"]["current_count"]
            print(f"\nRate limit status:")
            print(f"  Remaining: {remaining}")
            print(f"  Window started: {window_start}")
            print(f"  Window ends: {window_start + timedelta(hours=window_hours)}")
            return True
        
        reset_time = window_start + timedelta(hours=window_hours)
        wait_seconds = (reset_time - current_time).total_seconds()
        print(f"\nRate limit reached. Window resets in {wait_seconds/3600:.1f} hours")
        print(f"Current count: {self.rate_limits['tweets']['current_count']}")
        print(f"Window started: {window_start}")
        print(f"Window ends: {reset_time}")
        return False

    def handle_rate_limit_error(self, e):
        """Handle rate limit error with exponential backoff"""
        current_time = datetime.now()

        if hasattr(e, 'response') and e.response is not None:
            reset_time = e.response.headers.get('x-rate-limit-reset')
            if reset_time:
                reset_datetime = datetime.fromtimestamp(int(reset_time))
                wait_seconds = (reset_datetime - current_time).total_seconds()
            else:
                # If no reset time in headers, use exponential backoff
                current_backoff = self.rate_limits["tweets"].get("current_backoff", TWITTER_RETRY_CONFIG["initial_backoff"])
                wait_seconds = min(current_backoff * TWITTER_RETRY_CONFIG["backoff_factor"], 
                                 TWITTER_RETRY_CONFIG["max_backoff"])
                self.rate_limits["tweets"]["current_backoff"] = wait_seconds
        else:
            # No response headers, use exponential backoff
            current_backoff = self.rate_limits["tweets"].get("current_backoff", TWITTER_RETRY_CONFIG["initial_backoff"])
            wait_seconds = min(current_backoff * TWITTER_RETRY_CONFIG["backoff_factor"], 
                             TWITTER_RETRY_CONFIG["max_backoff"])
            self.rate_limits["tweets"]["current_backoff"] = wait_seconds
        
        backoff_until = current_time + timedelta(seconds=wait_seconds)
        self.rate_limits["tweets"]["backoff_until"] = backoff_until
        
        print(f"\nRate limit exceeded. Implementing backoff:")
        print(f"  Wait time: {wait_seconds/60:.1f} minutes")
        print(f"  Resume at: {backoff_until}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"  Response status: {e.response.status_code}")
            print(f"  Headers: {dict(e.response.headers)}")
        
        return wait_seconds

    def update_rate_limit(self):
        """Update rate limit counters after successful tweet"""
        self.rate_limits["tweets"]["current_count"] += 1
        print(f"\nUpdated rate limit count: {self.rate_limits['tweets']['current_count']}")
        print(f"Remaining in window: {self.rate_limits['tweets']['max_tweets'] - self.rate_limits['tweets']['current_count']}")

    def send_tweet(self, tweet_or_character, topic=None):
        """
        Send a tweet using the configured X client.
        Supports both call styles:
          - send_tweet(tweet_text)
          - send_tweet(character_name, topic)  # generates text first
        """
        try:
            if not self.twitter_client:
                print("❌ Twitter client not initialized.")
                return False

            if not self.check_rate_limit():
                return False

            if topic is None:
                tweet_text = (tweet_or_character or "").strip()
            else:
                tweet_text = self.generate_tweet(tweet_or_character, topic) or ""
                tweet_text = tweet_text.strip()

            if not tweet_text:
                print("⚠ Empty tweet text; skipping send.")
                return False

            response = self.twitter_client.create_tweet(text=tweet_text)
            if not response or not response.data:
                print("⚠ Tweet send returned no data.")
                return False

            tweet_id = response.data.get("id")
            self.last_successful_tweet = datetime.now()
            self.update_rate_limit()

            if tweet_id:
                username = (self.credentials.get("twitter_username") or "").lstrip("@")
                tweet_url = None
                if username:
                    tweet_url = f"https://x.com/{username}/status/{tweet_id}"
                    self.send_to_telegram(tweet_url)

                # Optional cross-posting targets (best effort; never fail the X post)
                self.send_to_reddit(tweet_text, source_url=tweet_url)
                self.send_to_facebook(tweet_text, source_url=tweet_url)
                self.send_to_instagram(tweet_text)

            print(f"✅ Tweet sent successfully: {tweet_id}")
            return True
        except tweepy.TooManyRequests as e:
            self.handle_rate_limit_error(e)
            return False
        except Exception as e:
            print(f"Error sending tweet: {e}")
            return False

    def send_main_tweet(self):
        """Send a main scheduled tweet."""
        new_story = self.get_new_story("crypto")  # or "ai", depending on your subject
        if new_story:
            story_text = f"{new_story['title']}\n\n{new_story['preview']}\n\nRead more: {new_story['url']}"
            tweet_text = self.generate_tweet("mork zuckerbarge", story_text)
            if tweet_text:
                if self.send_tweet(tweet_text):
                    self.last_successful_tweet = datetime.now()
                    print("✅ Main tweet sent successfully.")
                else:
                    print("❌ Failed to send main tweet.")

    def reply_to_mentions_and_replies(self):
        if self.backoff_until and datetime.now() < self.backoff_until:
            print(f"⏳ Backoff active until {self.backoff_until}. Skipping mention/reply checking.")
            return

        print("🔍 Checking mentions and replies...")

        replies_sent = 0
        max_replies = 1  # bump later if you want
        now = datetime.now()

        # You need your username for searches; store it once in creds or config.
        username = self.credentials.get("twitter_username", "zuckerbarge").lstrip("@")

        # Tweepy Client (v2)
        client = tweepy.Client(
            bearer_token=self.credentials.get("bearer_token"),
            consumer_key=self.credentials["twitter_api_key"],
            consumer_secret=self.credentials["twitter_api_secret"],
            access_token=self.credentials["twitter_access_token"],
            access_token_secret=self.credentials["twitter_access_token_secret"],
            wait_on_rate_limit=True,
        )

        # Collect candidates (mentions + replies)
        candidates = []
        seen_ids = set()

        try:
            # ---- A) Mentions (tweets that @mention you)
            mentions = client.get_users_mentions(self.mork_id, max_results=10, tweet_fields=["author_id", "created_at"])
            if mentions and mentions.data:
                for t in mentions.data:
                    if str(t.id) in seen_ids:
                        continue
                    if str(getattr(t, "author_id", "")) == str(self.mork_id):
                        continue
                    seen_ids.add(str(t.id))
                    candidates.append(("mention", t))

            # ---- B) Replies to your recent tweets (even without @tag)
            my_recent = client.get_users_tweets(self.mork_id, max_results=5)
            if my_recent and my_recent.data:
                for my_tweet in my_recent.data:
                    q = f"conversation_id:{my_tweet.id} is:reply -from:{username}"
                    replies = client.search_recent_tweets(
                        query=q,
                        max_results=10,
                        tweet_fields=["author_id", "conversation_id", "created_at", "in_reply_to_user_id"],
                    )
                    if replies and replies.data:
                        for r in replies.data:
                            if str(r.id) in seen_ids:
                                continue
                            if str(getattr(r, "author_id", "")) == str(self.mork_id):
                                continue
                            seen_ids.add(str(r.id))
                            candidates.append(("reply", r))

        except tweepy.TooManyRequests as e:
            print("🚫 Rate limited! Setting global backoff...")
            reset_timestamp = None
            try:
                if hasattr(e, "response") and e.response is not None:
                    reset_timestamp = e.response.headers.get("x-rate-limit-reset")
            except Exception:
                reset_timestamp = None

            if reset_timestamp:
                reset_time = datetime.fromtimestamp(int(reset_timestamp))
                self.backoff_until = reset_time
                wait_seconds = (reset_time - datetime.now()).total_seconds()
                print(f"😴 Global backoff active until {self.backoff_until} (~{wait_seconds/60:.1f} min)")
                time.sleep(min(300, max(1, wait_seconds)))
            else:
                self.backoff_until = datetime.now() + timedelta(minutes=5)
                time.sleep(300)
            return

        except Exception as e:
            print(f"❌ Error fetching mentions/replies: {e}")
            return

        if not candidates:
            print("ℹ️ No new mentions/replies found.")
            return

        # Sort oldest -> newest so you don't reply backwards
        def _created_at(t):
            return getattr(t, "created_at", None) or now

        candidates.sort(key=lambda x: _created_at(x[1]))

        for kind, tweet in candidates:
            if replies_sent >= max_replies:
                break

            try:
                inbound_text = getattr(tweet, "text", "") or ""

                prompt = (
                    "You are replying to a user on X.\n"
                    "You MUST NOT quote, copy, or restate the user's tweet text.\n"
                    "Do NOT include the user's tweet text in your reply.\n"
                    "Respond naturally and helpfully in 1–4 sentences.\n"
                    "No hashtags, no emojis, no URLs.\n"
                    "If you refer to what they said, paraphrase at a high level without reusing phrases.\n\n"
                    f"INCOMING (for context only; DO NOT quote):\n{inbound_text}\n"
                )

                reply = self.generate_tweet("mork zuckerbarge", prompt)

                if reply:
                    client.create_tweet(text=reply, in_reply_to_tweet_id=tweet.id)
                    print(f"💬 Replied to {kind} {tweet.id}")
                    replies_sent += 1

            except tweepy.TooManyRequests:
                print("🚫 Rate limited while replying; setting backoff.")
                self.backoff_until = datetime.now() + timedelta(minutes=5)
                return

            except Exception as e:
                print(f"❌ Failed replying to {tweet.id}: {e}")

        print(f"✅ Sent {replies_sent}/{max_replies} reply(ies).")


    def get_random_meme(self, character_name):
        """Pick a meme file and get tweet text from Mork Core using the filename as context."""
        try:
            meme_files = [f for f in os.listdir("memes") if f.lower().endswith(tuple(SUPPORTED_MEME_FORMATS))]
            if not meme_files:
                return None, None

            available = [m for m in meme_files if m not in self.used_memes]
            if not available:
                self.used_memes.clear()
                available = meme_files

            selected = random.choice(available)
            meme_path = os.path.join("memes", selected)

            # Track used memes
            self.used_memes.add(selected)
            if len(self.used_memes) > USED_MEMES_HISTORY:
                # NOTE: set.pop() is arbitrary; this is fine, but "history" isn't truly ordered.
                self.used_memes.pop()

            base = selected.rsplit(".", 1)[0]
            context = re.sub(r"[_\-]+", " ", base).strip()

            # 1) Try Mork Core compose (best)
            tweet_text = ""
            try:
                core_reflect(timeout=MEME_CORE_REFLECT_TIMEOUT_SECONDS)
                tweet_text = core_compose_payload(
                    {"kind": "meme", "memeName": selected, "title": context, "maxChars": 260},
                    timeout=MEME_CORE_COMPOSE_TIMEOUT_SECONDS,
                ) or ""
            except Exception as e:
                print(
                    "⚠ core meme compose failed "
                    f"(reflect_timeout={MEME_CORE_REFLECT_TIMEOUT_SECONDS}s, "
                    f"compose_timeout={MEME_CORE_COMPOSE_TIMEOUT_SECONDS}s): {e}"
                )
                tweet_text = ""

            if tweet_text:
                return _wrap_280(tweet_text, 260), meme_path

            # 2) Local fallback if Core is unreachable.
            # Keep this human-readable so we never tweet just a raw filename.
            options = [
                f"Filed under bunker cinema: {context}.",
                f"Tonight's transmission: {context}.",
                f"Archive pull: {context}.",
                f"Unscheduled meme dispatch: {context}.",
            ]
            fallback = random.choice(options) if context else "Unscheduled meme dispatch."
            return _wrap_280(fallback, 260), meme_path

        except Exception as e:
            print(f"Error getting random meme: {e}")
            return None, None

    def send_tweet_with_media(self, tweet_text, media_path):
        """Send a tweet with media attached"""
        try:
            # Create Twitter API v1.1 instance for media upload
            auth = tweepy.OAuth1UserHandler(
                self.credentials['twitter_api_key'],
                self.credentials['twitter_api_secret'],
                self.credentials['twitter_access_token'],
                self.credentials['twitter_access_token_secret']
            )
            api = tweepy.API(auth)
            
            # Upload media
            media = api.media_upload(filename=media_path)
            
            # Create tweet with media using v2 client
            response = self.twitter_client.create_tweet(
                text=tweet_text,
                media_ids=[media.media_id]
            )
            
            if response.data:
                self.last_successful_tweet = datetime.now()
                print("\nTweet with media sent successfully")
                print(f"Tweet ID: {response.data['id']}")
                
                # Update rate limit tracking
                self.update_rate_limit()
                return True
            
            return False
            
        except Exception as e:
            print(f"Error sending tweet with media: {e}")
            return False
            
    def send_to_telegram(self, tweet_url):
        bot_token = self.credentials.get("telegram_bot_token")
        chat_id = self.credentials.get("telegram_chat_id")

        if not bot_token or not chat_id:
            print("⚠️ Telegram credentials missing")
            return

        text = f"Mork has tweeted:\n{tweet_url}"
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML"
        }

        try:
            response = requests.post(url, data=payload)
            print("📨 Telegram status:", response.status_code, response.text)
        except Exception as e:
            print(f"❌ Telegram send failed: {e}")

    def _short_post_title(self, text, fallback="Mork update", max_len=250):
        base = (text or "").strip()
        if not base:
            return fallback
        first = base.split("\n")[0].strip()
        out = first if first else base
        return out[:max_len]

    def send_to_reddit(self, text, source_url=None):
        subreddit = (self.credentials.get("reddit_subreddit") or "").strip().lstrip("r/").strip("/")
        client_id = (self.credentials.get("reddit_client_id") or "").strip()
        client_secret = (self.credentials.get("reddit_client_secret") or "").strip()
        username = (self.credentials.get("reddit_username") or "").strip()
        password = (self.credentials.get("reddit_password") or "").strip()
        user_agent = (self.credentials.get("reddit_user_agent") or "mork-sherpa/1.0").strip()

        if not (subreddit and client_id and client_secret and username and password):
            return

        try:
            token_res = requests.post(
                "https://www.reddit.com/api/v1/access_token",
                auth=(client_id, client_secret),
                data={"grant_type": "password", "username": username, "password": password},
                headers={"User-Agent": user_agent},
                timeout=20,
            )
            token_res.raise_for_status()
            access_token = token_res.json().get("access_token")
            if not access_token:
                print("⚠️ Reddit token missing in auth response.")
                return

            title = self._short_post_title(text)
            post_data = {"sr": subreddit, "title": title}
            if source_url:
                post_data.update({"kind": "link", "url": source_url})
            else:
                post_data.update({"kind": "self", "text": (text or "")[:40000]})

            submit_res = requests.post(
                "https://oauth.reddit.com/api/submit",
                headers={"Authorization": f"bearer {access_token}", "User-Agent": user_agent},
                data=post_data,
                timeout=20,
            )
            print("📨 Reddit status:", submit_res.status_code, submit_res.text[:220])
        except Exception as e:
            print(f"❌ Reddit post failed: {e}")

    def send_to_facebook(self, text, source_url=None):
        page_id = (self.credentials.get("facebook_page_id") or "").strip()
        page_token = (self.credentials.get("facebook_page_access_token") or "").strip()
        if not page_id or not page_token:
            return

        payload = {"message": (text or "").strip()[:5000], "access_token": page_token}
        if source_url:
            payload["link"] = source_url

        try:
            res = requests.post(f"https://graph.facebook.com/v22.0/{page_id}/feed", data=payload, timeout=20)
            print("📨 Facebook status:", res.status_code, res.text[:220])
        except Exception as e:
            print(f"❌ Facebook post failed: {e}")

    def send_to_instagram(self, caption):
        ig_user_id = (self.credentials.get("instagram_user_id") or "").strip()
        ig_token = (self.credentials.get("instagram_access_token") or "").strip()
        image_url = (self.credentials.get("instagram_image_url") or "").strip()
        if not ig_user_id or not ig_token:
            return
        if not image_url:
            print("⚠️ Instagram skipped: set instagram_image_url to publish.")
            return

        try:
            create_res = requests.post(
                f"https://graph.facebook.com/v22.0/{ig_user_id}/media",
                data={
                    "image_url": image_url,
                    "caption": (caption or "").strip()[:2200],
                    "access_token": ig_token,
                },
                timeout=20,
            )
            create_json = create_res.json() if create_res.content else {}
            creation_id = (create_json or {}).get("id")
            if not creation_id:
                print("⚠️ Instagram media create failed:", create_res.status_code, create_res.text[:220])
                return

            publish_res = requests.post(
                f"https://graph.facebook.com/v22.0/{ig_user_id}/media_publish",
                data={"creation_id": creation_id, "access_token": ig_token},
                timeout=20,
            )
            print("📨 Instagram status:", publish_res.status_code, publish_res.text[:220])
        except Exception as e:
            print(f"❌ Instagram post failed: {e}")

    def monitor_and_reply_to_mentions(self):
        """Daily: fetch new mentions, pick best <=2 <23h old, reply; try backlog first."""
        try:
            print("\n🔍 Daily mention sweep starting...")

            bearer_token = self.credentials.get('bearer_token')
            if not bearer_token:
                print("❌ Bearer token missing. Cannot check mentions.")
                return

            # Need Twitter client to reply
            if not self.twitter_client:
                print("❌ Twitter client not initialized. Cannot reply to mentions.")
                return

            state = _load_reply_state()
            today = datetime.now(timezone.utc).date().isoformat()

            # Daily counter/reset
            if state.get("last_post_day") != today:
                state["last_post_day"] = today
                state["replied_today"] = 0

            remaining = MAX_DAILY_REPLIES - state["replied_today"]
            if remaining <= 0:
                print("✅ Daily reply cap already reached.")
                _save_reply_state(state)
                return

            headers = {"Authorization": f"Bearer {bearer_token}"}
            me = self.twitter_client.get_me().data
            me_id = str(me.id)

            def _local_reply(text: str) -> str:
                tw = (text or "").strip()
                tw = re.sub(r"\s+", " ", tw)
                tw = tw[:220]

                prompt = (
                    "Compose a direct reply tweet in character.\n"
                    "Rules: do not quote, copy, or restate the user's words.\n"
                    "No hashtags, no emojis, no URLs, no canned opener/closer.\n"
                    "Write 1-3 natural sentences that move the conversation forward.\n"
                    "Reference ideas at a high level only.\n\n"
                    f"Context (do not quote): {tw}"
                )

                out = core_compose_payload(
                    {
                        "kind": "reply",
                        "text": prompt,
                        "maxChars": 260,
                        "constraints": {
                            "noQuoteUserText": True,
                            "noHashtags": True,
                            "noEmojis": True,
                            "noUrls": True,
                        },
                    },
                    timeout=9,
                ) or ""
                return _wrap_280(out, 260) if out else ""

            def _strip_source_echo(reply_text: str, source_text: str) -> str:
                out = (reply_text or "").strip()
                src = (source_text or "").strip()
                if not out or not src:
                    return out

                # remove quoted snippets outright
                out = re.sub(r"[\"“”']([^\"“”']{4,})[\"“”']", "", out).strip()

                src_words = set(re.findall(r"[a-z0-9']{4,}", src.lower()))
                if not src_words:
                    return _wrap_280(out, 260)

                kept_sentences = []
                for s in re.split(r"(?<=[.!?])\s+", out):
                    s_words = set(re.findall(r"[a-z0-9']{4,}", s.lower()))
                    if not s_words:
                        continue
                    overlap = len(src_words.intersection(s_words)) / max(1, len(s_words))
                    if overlap < 0.55:
                        kept_sentences.append(s.strip())

                cleaned = " ".join([s for s in kept_sentences if s]).strip() or out
                return _wrap_280(cleaned, 260)

            def _ai_reply(text: str) -> str:
                """OpenAI reply generator (ONLY used if enabled + client exists)."""
                # Hard guard
                if (not USE_OPENAI) or (not getattr(self, "client", None)):
                    return ""

                # Pick first character, if available
                character = next(iter(self.characters.values()), None)
                if not character:
                    return ""

                ai = self.client.chat.completions.create(
                    model=character['model'],
                    messages=[
                        {"role": "system", "content": character['prompt']},
                        {"role": "user", "content": f"Reply in character to this mention: '{text}'"}
                    ],
                    max_tokens=180,
                    temperature=0.9,
                )
                return (ai.choices[0].message.content or "").strip()

            def _compose_reply(text: str) -> str:
                """
                Prefer NO-OpenAI paths.
                1) Local reply (fast, safe)
                2) (Optional) Mork Core edge spice already handled inside _local_reply via morkcore_edge_line()
                3) OpenAI only if explicitly enabled + available
                """
                # Always start from the safe local reply
                base = _local_reply(text)
                if base:
                    base = _strip_source_echo(base, text)

                # Only use OpenAI if explicitly enabled AND initialized
                if USE_OPENAI and getattr(self, "client", None):
                    try:
                        out = _ai_reply(text)
                        if out:
                            return _strip_source_echo(_wrap_280(out, 260), text)
                    except Exception as e:
                        print(f"⚠️ OpenAI reply failed, using local reply: {e}")

                if base:
                    return base

                # Last-resort non-echo fallback (no source text)
                return _wrap_280(
                    "Good point. I see the direction you're pushing this—what outcome are you optimizing for right now?",
                    260,
                )


            # 1) Try backlog first (tweet_ids we saved yesterday), keeping only <23h
            backlog = _prune_backlog(state.get("backlog", []))
            sent = 0
            i = 0
            while i < len(backlog) and sent < remaining:
                draft = backlog[i]
                tid = draft["tweet_id"]

                try:
                    # generate fresh text now (cheaper than storing text that may expire)
                    text = None
                    if hasattr(self, "generate_persona_reply_from_tweet_id"):
                        try:
                            text = self.generate_persona_reply_from_tweet_id(tid)
                        except Exception:
                            text = None

                    if not text:
                        # Fallback: fetch tweet text to reply to
                        tw_resp = requests.get(
                            "https://api.twitter.com/2/tweets",
                            headers=headers,
                            params={"ids": tid, "tweet.fields": "text"},
                            timeout=10
                        )
                        tw_json = tw_resp.json()
                        tw_text = (tw_json.get("data") or [{}])[0].get("text", "")
                        if not tw_text:
                            i += 1
                            continue
                        text = _compose_reply(tw_text)

                    self.twitter_client.create_tweet(text=text, in_reply_to_tweet_id=tid)
                    print(f"✅ Replied from backlog → {tid}")
                    state["replied_today"] += 1
                    sent += 1
                    backlog.pop(i)
                    time.sleep(random.uniform(4, 9))

                except Exception as e:
                    print(f"⚠️ Backlog reply failed for {tid}: {e}")
                    i += 1  # skip this one

            if state["replied_today"] >= MAX_DAILY_REPLIES:
                state["backlog"] = backlog
                _save_reply_state(state)
                print(f"🎯 Done from backlog only. Replied {sent}.")
                return

            # 2) Fetch new mentions once; only what we need
            url = f"https://api.twitter.com/2/users/{me_id}/mentions"
            params = {
                "max_results": min(100, MAX_FETCH),
                "tweet.fields": "author_id,text,created_at,public_metrics,lang",
            }
            # since_id keeps read calls tiny and prevents reprocessing old mentions
            if state.get("since_id"):
                params["since_id"] = state["since_id"]

            resp = requests.get(url, headers=headers, params=params, timeout=15)
            if resp.status_code != 200:
                print(f"❌ Error fetching mentions: {resp.status_code} {resp.text}")
                state["backlog"] = backlog  # keep backlog progress
                _save_reply_state(state)
                return

            data = resp.json().get("data", []) or []
            if data:
                # high-water mark so we never reread older mentions
                state["since_id"] = max(data, key=lambda t: int(t["id"]))["id"]

            # Filter viable: not self, English (if present), <23h, basic effort
            candidates = []
            for tw in data:
                if str(tw.get("author_id")) == me_id:
                    continue
                if tw.get("lang") and tw["lang"].lower() != "en":
                    continue
                if _age_hours(tw["created_at"]) >= MAX_AGE_HOURS:
                    continue
                if len((tw.get("text") or "").strip()) < 8:
                    continue
                candidates.append(tw)

            if not candidates and sent == 0:
                print("ℹ️ No new viable mentions.")
                state["backlog"] = backlog
                _save_reply_state(state)
                return

            # Rank by public engagement
            candidates.sort(key=lambda t: _score(t.get("public_metrics") or {}), reverse=True)

            remaining = MAX_DAILY_REPLIES - state["replied_today"]
            to_post = candidates[:remaining]

            # Bank the rest (IDs only; we'll generate text next run if still fresh)
            for extra in candidates[remaining:]:
                backlog.append({"tweet_id": extra["id"], "created_at": extra["created_at"]})

            # 3) Generate + post replies for top picks
            for tw in to_post:
                try:
                    reply_text = _compose_reply(tw.get("text") or "")

                    self.twitter_client.create_tweet(
                        text=reply_text,
                        in_reply_to_tweet_id=tw["id"]
                    )
                    print(f"✅ Replied to {tw['id']}")
                    state["replied_today"] += 1
                    time.sleep(random.uniform(4, 9))

                except Exception as e:
                    print(f"⚠️ Failed to reply to {tw.get('id')}: {e}")
                    # If posting fails, keep it as a backlog item for next run
                    backlog.append({"tweet_id": tw["id"], "created_at": tw["created_at"]})

            # Finalize state
            state["backlog"] = _prune_backlog(backlog)
            _save_reply_state(state)
            print(f"🎯 Daily sweep complete. Replied {state['replied_today']} today; backlog={len(state['backlog'])}.")

        except Exception as e:
            print(f"❌ Fatal error in mention reply worker: {e}")

    def _durable_get_random_story_all(self, subject=None):
        """
        Always return a valid {title, preview, url} dict.
        Tries any available fetchers; falls back to a synthetic story.
        """
        subject = subject or getattr(self, "scheduler_subject", None) or "news"

        def _norm(st):
            if isinstance(st, str):
                return {"title": subject.title(), "preview": st, "url": "#"}
            if isinstance(st, dict):
                title = (st.get("title") or "").strip() or subject.title()
                preview = (st.get("preview") or st.get("summary") or st.get("text") or "").strip()
                url = (st.get("url") or st.get("link") or "#").strip()
                return {"title": title, "preview": preview, "url": url}
            return {"title": subject.title(), "preview": "", "url": "#"}

        # Try known single-story fetchers if you later add them
        for name in ["get_news_story", "get_new_story_from_feeds", "fetch_next_story", "fetch_story", "get_story_from_rss"]:
            if hasattr(self, name):
                try:
                    s = getattr(self, name)(subject)
                    if s:
                        ns = _norm(s)
                        if ns["title"] or ns["preview"]:
                            print(f"[get_random_story_all] Using {name}()")
                            return ns
                except Exception as e:
                    print(f"[get_random_story_all] {name}() failed: {e}")

        # Try bulk fetchers (choose one at random)
        for name in ["fetch_news_stories", "get_stories_for_topic"]:
            if hasattr(self, name):
                try:
                    stories = getattr(self, name)(subject) or []
                    if stories:
                        ns = _norm(random.choice(stories))
                        print(f"[get_random_story_all] Using random from {name}()")
                        return ns
                except Exception as e:
                    print(f"[get_random_story_all] {name}() failed: {e}")

        # Final fallback: synthetic story (keeps 4h cadence alive)
        ts = datetime.now().strftime("%b %d, %Y %I:%M %p")
        print("[get_random_story_all] Fallback synthetic story.")
        return {
            "title": f"{subject.title()} update — {ts}",
            "preview": f"Quick thought on {subject}. (auto-generated fallback)",
            "url": "#"
        }

    # Override any previous alias
    
    # ----------------------------------------------------------------------------- 

    def save_feed_selection(self, subject, primary_selected, secondary_selected):
        """Save the selected feeds configuration"""
        print(f"\nSaving feed selection for subject: {subject}")
        print(f"Primary selected: {primary_selected}")
        print(f"Secondary selected: {secondary_selected}")

        try:
            config = (self.feed_config or {}).copy()
            if subject not in config:
                config[subject] = {"primary": {}, "secondary": {}}

            # Update primary feeds
            for feed in RSS_FEEDS[subject]["primary"]:
                feed_name = f"{feed['name']} ({feed['url']})"
                config[subject]["primary"][feed["url"]] = (feed_name in (primary_selected or []))

            # Update secondary feeds
            for feed in RSS_FEEDS[subject]["secondary"]:
                feed_name = f"{feed['name']} ({feed['url']})"
                config[subject]["secondary"][feed["url"]] = (feed_name in (secondary_selected or []))

            if self.save_feed_config(config):
                print("Feed configuration saved successfully")
                return "Feed configuration saved successfully"

            return "Failed to save feed configuration"

        except Exception as e:
            import traceback
            print(f"Error saving feed selection: {e}")
            traceback.print_exc()
            return f"Error saving feed configuration: {str(e)}"

    def create_ui(self):
        print("\n=== Creating UI ===")

        # Store initial values
        initial_values = {
            'openai_key': self.credentials.get('openai_key', ''),
            'twitter_api_key': self.credentials.get('twitter_api_key', ''),
            'twitter_api_secret': self.credentials.get('twitter_api_secret', ''),
            'twitter_access_token': self.credentials.get('twitter_access_token', ''),
            'twitter_access_token_secret': self.credentials.get('twitter_access_token_secret', '')
        }
        
        # Get default character prompt
        default_prompt = next(iter(self.characters.values()))['prompt'] if self.characters else ""
        
        with gr.Blocks(theme=gr.themes.Soft(
            primary_hue="green",
            secondary_hue="green",
            neutral_hue="slate",
            text_size="lg",
        )) as interface:
            print("\n=== Creating UI Components ===")
            gr.Markdown("# 💻 AI Twitter Bot Control Center")
            
            with gr.Accordion("🔑 Getting Started", open=True):
                gr.Markdown("""
                1. OpenAI API Key: Get your key from [OpenAI's API Keys page](https://platform.openai.com/api-keys)
                2. X (Twitter) API Credentials:
                    * Go to [X Developer Portal](https://developer.twitter.com/en/portal/dashboard)
                    * Create a new project/app
                    * Enable OAuth 1.0a in app settings
                    * Generate API Key, API Key Secret, Access Token, and Access Token Secret
                """)
                
                print("\nInitializing credential textboxes...")
                
                def load_initial_values():
                    print("\nLoading initial values...")
                    for key, value in initial_values.items():
                        print(f"{key}: {'[SET]' if value else '[EMPTY]'} (length: {len(value) if value else 0})")
                    return [
                        gr.update(value=initial_values['openai_key']),
                        gr.update(value=initial_values['twitter_api_key']),
                        gr.update(value=initial_values['twitter_api_secret']),
                        gr.update(value=initial_values['twitter_access_token']),
                        gr.update(value=initial_values['twitter_access_token_secret'])
                    ]
                with gr.Row():
                    telegram_bot_token = gr.Textbox(
                        label="Telegram Bot Token",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('telegram_bot_token', '')
                    )

                    telegram_chat_id = gr.Textbox(
                        label="Telegram Chat ID",
                        type="text",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('telegram_chat_id', '')
                    )
                
                with gr.Row():
                    openai_key = gr.Textbox(
                        label="OpenAI API Key",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=initial_values['openai_key']
                    )
                    print(f"OpenAI Key textbox initialized")
                
                with gr.Row():
                    twitter_api_key = gr.Textbox(
                        label="Twitter API Key",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=initial_values['twitter_api_key']
                    )
                    print(f"Twitter API Key textbox initialized")
                    
                    twitter_api_secret = gr.Textbox(
                        label="Twitter API Secret",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=initial_values['twitter_api_secret']
                    )
                    print(f"Twitter API Secret textbox initialized")
                
                with gr.Row():
                    twitter_access_token = gr.Textbox(
                        label="Twitter Access Token",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=initial_values['twitter_access_token']
                    )
                    print(f"Twitter Access Token textbox initialized")
                    
                    twitter_access_token_secret = gr.Textbox(
                        label="Twitter Access Token Secret",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=initial_values['twitter_access_token_secret']
                    )
                    print(f"Twitter Access Token Secret textbox initialized")
                with gr.Row():
                    bearer_token = gr.Textbox(
                        label="Twitter Bearer Token",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('bearer_token', '')
                    )
                with gr.Row():
                    reddit_client_id = gr.Textbox(
                        label="Reddit Client ID",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('reddit_client_id', '')
                    )
                    reddit_client_secret = gr.Textbox(
                        label="Reddit Client Secret",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('reddit_client_secret', '')
                    )
                with gr.Row():
                    reddit_username = gr.Textbox(
                        label="Reddit Username",
                        type="text",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('reddit_username', '')
                    )
                    reddit_password = gr.Textbox(
                        label="Reddit Password",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('reddit_password', '')
                    )
                with gr.Row():
                    reddit_subreddit = gr.Textbox(
                        label="Reddit Subreddit",
                        type="text",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('reddit_subreddit', '')
                    )
                    reddit_user_agent = gr.Textbox(
                        label="Reddit User Agent",
                        type="text",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('reddit_user_agent', 'mork-sherpa/1.0')
                    )
                with gr.Row():
                    facebook_page_id = gr.Textbox(
                        label="Facebook Page ID",
                        type="text",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('facebook_page_id', '')
                    )
                    facebook_page_access_token = gr.Textbox(
                        label="Facebook Page Access Token",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('facebook_page_access_token', '')
                    )
                with gr.Row():
                    instagram_user_id = gr.Textbox(
                        label="Instagram User ID",
                        type="text",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('instagram_user_id', '')
                    )
                    instagram_access_token = gr.Textbox(
                        label="Instagram Access Token",
                        type="password",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('instagram_access_token', '')
                    )
                with gr.Row():
                    instagram_image_url = gr.Textbox(
                        label="Instagram Image URL (required by Graph API)",
                        type="text",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=self.credentials.get('instagram_image_url', '')
                    )

                def save_creds(
                    key, api_key, api_secret, access_token, access_secret, telegram_token, telegram_chat, bearer_token,
                    reddit_cid, reddit_csecret, reddit_user, reddit_pass, reddit_sr, reddit_agent,
                    fb_page_id, fb_page_token, ig_user_id, ig_token, ig_image_url
                ):

                    print("\nSaving credentials...")
                    print(f"OpenAI Key length: {len(key) if key else 0}")
                    print(f"API Key length: {len(api_key) if api_key else 0}")
                    print(f"API Secret length: {len(api_secret) if api_secret else 0}")
                    print(f"Access Token length: {len(access_token) if access_token else 0}")
                    print(f"Access Token Secret length: {len(access_secret) if access_secret else 0}")
                    
                    credentials = {
                        'openai_key': key,
                        'twitter_api_key': api_key,
                        'twitter_api_secret': api_secret,
                        'twitter_access_token': access_token,
                        'twitter_access_token_secret': access_secret,
                        'telegram_bot_token': telegram_token,
                        'telegram_chat_id': telegram_chat,
                        'bearer_token': bearer_token,
                        'reddit_client_id': reddit_cid,
                        'reddit_client_secret': reddit_csecret,
                        'reddit_username': reddit_user,
                        'reddit_password': reddit_pass,
                        'reddit_subreddit': reddit_sr,
                        'reddit_user_agent': reddit_agent,
                        'facebook_page_id': fb_page_id,
                        'facebook_page_access_token': fb_page_token,
                        'instagram_user_id': ig_user_id,
                        'instagram_access_token': ig_token,
                        'instagram_image_url': ig_image_url,
                    }
                    
                    if self.save_credentials(credentials):
                        print("Credentials saved successfully")
                        print(f"New credentials: {list(self.credentials.keys())}")
                        # Update initial values for future loads
                        initial_values.update(credentials)
                        return ("Credentials saved successfully", 
                            gr.update(value=key),
                            gr.update(value=api_key),
                            gr.update(value=api_secret),
                            gr.update(value=access_token),
                            gr.update(value=access_secret),
                            gr.update(value=telegram_token),
                            gr.update(value=telegram_chat),
                            gr.update(value=bearer_token),
                            gr.update(value=reddit_cid),
                            gr.update(value=reddit_csecret),
                            gr.update(value=reddit_user),
                            gr.update(value=reddit_pass),
                            gr.update(value=reddit_sr),
                            gr.update(value=reddit_agent),
                            gr.update(value=fb_page_id),
                            gr.update(value=fb_page_token),
                            gr.update(value=ig_user_id),
                            gr.update(value=ig_token),
                            gr.update(value=ig_image_url))

                    else:
                        print("Failed to save credentials")
                        return ("Failed to save credentials",
                            gr.update(value=self.credentials.get('openai_key', '')),
                            gr.update(value=self.credentials.get('twitter_api_key', '')),
                            gr.update(value=self.credentials.get('twitter_api_secret', '')),
                            gr.update(value=self.credentials.get('twitter_access_token', '')),
                            gr.update(value=self.credentials.get('twitter_access_token_secret', '')),
                            gr.update(value=self.credentials.get('telegram_bot_token', '')),
                            gr.update(value=self.credentials.get('telegram_chat_id', '')),
                            gr.update(value=self.credentials.get('bearer_token', '')),
                            gr.update(value=self.credentials.get('reddit_client_id', '')),
                            gr.update(value=self.credentials.get('reddit_client_secret', '')),
                            gr.update(value=self.credentials.get('reddit_username', '')),
                            gr.update(value=self.credentials.get('reddit_password', '')),
                            gr.update(value=self.credentials.get('reddit_subreddit', '')),
                            gr.update(value=self.credentials.get('reddit_user_agent', 'mork-sherpa/1.0')),
                            gr.update(value=self.credentials.get('facebook_page_id', '')),
                            gr.update(value=self.credentials.get('facebook_page_access_token', '')),
                            gr.update(value=self.credentials.get('instagram_user_id', '')),
                            gr.update(value=self.credentials.get('instagram_access_token', '')),
                            gr.update(value=self.credentials.get('instagram_image_url', '')))
                
                with gr.Row():
                    save_button = gr.Button("Save Credentials", variant="primary")
                    save_status = gr.Textbox(label="Status", interactive=False)
                
                save_button.click(
                save_creds,
                inputs=[
                    openai_key, twitter_api_key, twitter_api_secret,
                    twitter_access_token, twitter_access_token_secret,
                    telegram_bot_token, telegram_chat_id, bearer_token,
                    reddit_client_id, reddit_client_secret, reddit_username, reddit_password, reddit_subreddit, reddit_user_agent,
                    facebook_page_id, facebook_page_access_token, instagram_user_id, instagram_access_token, instagram_image_url
                ],
                outputs=[
                    save_status, openai_key, twitter_api_key, twitter_api_secret,
                    twitter_access_token, twitter_access_token_secret,
                    telegram_bot_token, telegram_chat_id, bearer_token,
                    reddit_client_id, reddit_client_secret, reddit_username, reddit_password, reddit_subreddit, reddit_user_agent,
                    facebook_page_id, facebook_page_access_token, instagram_user_id, instagram_access_token, instagram_image_url
                ]
            )

            
            print("\nInitializing character management components...")
            with gr.Accordion("👤 Character Management", open=True):
                gr.Markdown("Create and manage your AI characters")
                
                # Get list of characters and set default
                char_choices = list(self.characters.keys())
                default_char = next(iter(self.characters.keys())) if char_choices else None
                
                control_character = gr.Dropdown(
                    label="Select Character",
                    choices=char_choices,
                    value=default_char,
                    interactive=True
                )
                
                with gr.Row():
                    character_name = gr.Textbox(
                        label="Character Name",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        placeholder="Enter character name..."
                    )
                
                with gr.Row():
                    character_prompt = gr.Textbox(
                        label="Character System Prompt",
                        lines=5,
                        placeholder="Enter the system prompt that defines this character's personality...",
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True,
                        value=default_prompt
                    )
                
                with gr.Row():
                    model_dropdown = gr.Dropdown(
                        label="Select Model",
                        choices=list(OPENAI_MODELS.keys()),
                        value=next((k for k, v in OPENAI_MODELS.items() 
                                  if self.characters and v['name'] == next(iter(self.characters.values()))['model']), 
                                  "gpt-3.5-turbo (Most affordable)"),
                        show_label=True,
                        container=True,
                        scale=1,
                        interactive=True
                    )
                    print(f"Model dropdown initialized with choices: {list(OPENAI_MODELS.keys())}")
                
                def save_character(name, prompt, model_name):
                    print(f"\nSaving character: {name}")
                    print(f"Prompt length: {len(prompt) if prompt else 0}")
                    print(f"Selected model: {model_name}")
                    
                    if not name or not prompt:
                        print("Error: Name and prompt are required")
                        return ("Name and prompt are required", [], None, [], None)
                    
                    characters = self.characters.copy()
                    characters[name] = {
                        'prompt': prompt,
                        'model': OPENAI_MODELS[model_name]['name']
                    }
                    
                    if self.save_characters(characters):
                        print(f"Character saved successfully. Characters: {list(self.characters.keys())}")
                        # Update all character dropdowns
                        new_choices = list(self.characters.keys())
                        return ("Character saved successfully", 
                               new_choices,  # delete_char_dropdown
                               name,         # character_name
                               new_choices,  # control_character
                               name)         # control_character value
                    else:
                        print("Failed to save character")
                        return ("Failed to save character",
                               list(self.characters.keys()),
                               None,
                               list(self.characters.keys()),
                               None)
                
                with gr.Row():
                    save_char_button = gr.Button("Add Character", variant="primary")
                    save_char_status = gr.Textbox(label="Status", interactive=False)
                
                with gr.Row():
                    delete_char_dropdown = gr.Dropdown(
                        label="Select character to delete",
                        choices=char_choices,
                        value=default_char,
                        interactive=True,
                        show_label=True,
                        container=True,
                        scale=1,
                        allow_custom_value=True
                    )
                    print(f"Delete character dropdown initialized with choices: {char_choices}")
                
                def delete_character(name):
                    print(f"\nDeleting character: {name}")
                    if not name:
                        print("Error: No character selected")
                        return "No character selected", [], None, [], None
                    
                    if name in self.characters:
                        characters = self.characters.copy()
                        del characters[name]
                        
                        if self.save_characters(characters):
                            new_choices = list(self.characters.keys())
                            new_default = next(iter(self.characters)) if self.characters else None
                            print(f"Character deleted. Remaining: {new_choices}")
                            print(f"New default character: {new_default}")
                            return ("Character deleted successfully", 
                                   new_choices,  # delete_char_dropdown
                                   new_default,  # delete_char_dropdown value
                                   new_choices,  # control_character
                                   new_default)  # control_character value
                        else:
                            print("Failed to delete character")
                            return ("Failed to delete character",
                                   list(self.characters.keys()),
                                   name,
                                   list(self.characters.keys()),
                                   name)
                    else:
                        print("Character not found")
                        return "Character not found", list(self.characters.keys()), name, list(self.characters.keys()), name
                
                with gr.Row():
                    delete_button = gr.Button("Delete Character", variant="secondary")
                    delete_status = gr.Textbox(label="Delete Status", interactive=False)
                
            # Control Center section
            with gr.Accordion("🎮 Control Center", open=True):
                gr.Markdown("Generate and post tweets using your AI characters")
                
                with gr.Row():
                    character_dropdown = gr.Dropdown(
                    choices=list(self.characters.keys()), 
                    value=None if not self.characters else next(iter(self.characters.keys())), 
                    label="Select Character",
                    interactive=bool(self.characters)  # Disable if no characters
                )

                                    # --- Subject / content controls ---
                    subject_dropdown = gr.Dropdown(
                        choices=[("crypto", "crypto"), ("ai", "ai"), ("tech", "tech"), ("🎲 Surprise me (All)", "__surprise_all__")],
                        value="crypto",
                        label="Select Subject",
                        interactive=True
                    )

                    with gr.Row():
                        use_news = gr.Checkbox(value=True, label="Use News Feed", interactive=True)
                        use_memes = gr.Checkbox(value=self.use_memes, label="Use Memes", interactive=True)
                        meme_frequency = gr.Number(value=self.meme_frequency, label="Post meme every X tweets", minimum=1, maximum=100, step=1)

                    current_topic = gr.Textbox(
                        label="Current Topic/Story",
                        lines=3,
                        interactive=True
                    )

                    with gr.Row():
                        new_story_btn = gr.Button("New Story")
                        tweet_btn = gr.Button("Post Single Tweet")

                    tweet_status = gr.Textbox(label="Tweet Status", interactive=False)

                    scheduler_enabled = gr.Checkbox(label="Enable Scheduler", value=False)
                    scheduler_status = gr.Markdown("Scheduler: NOT RUNNING")

                    # ---------- Helpers ----------
                    import random

                    def get_story_dispatch(subject):
                        if subject == "__surprise_all__":
                            # Try subjects in random order; first successful story wins
                            subjects = list(RSS_FEEDS.keys())  # e.g., ["crypto","ai","tech"]
                            random.shuffle(subjects)
                            for s in subjects:
                                story = self.get_new_story(s)
                                if story:
                                    return f"{story['title']}\n\n{story['preview']}\n\nRead more: {story['url']} (source: {s})"
                            return "No items found right now. Try again in a moment."
                        # Normal per-subject path
                        story = self.get_new_story(subject)
                        if story:
                            return f"{story['title']}\n\n{story['preview']}\n\nRead more: {story['url']}"
                        return f"No items found for '{subject}' right now."

                    # IMPORTANT: Do NOT auto-fetch on selection.
                    # Just update the bot's subject so the scheduler uses it later.
                    def _update_subject(subject):
                        self.subject = subject
                        return gr.update()  # no UI change -> no network calls

                    # Wire subject change ONLY to update the selected subject for the scheduler
                    subject_dropdown.change(_update_subject, inputs=[subject_dropdown], outputs=[])

                    # Button wiring (manual fetch only when you click New Story)
                    new_story_btn.click(get_story_dispatch, inputs=[subject_dropdown], outputs=[current_topic])

                    def send_tweet(character, topic):
                        success = self.send_tweet(character, topic)
                        return "Tweet sent successfully!" if success else "Failed to send tweet. Please try again."

                    tweet_btn.click(send_tweet, inputs=[character_dropdown, current_topic], outputs=[tweet_status])

                def toggle_scheduler(enabled, character, subject):
                    if not character:
                        return "Please select a character first", "Scheduler: NOT RUNNING", current_topic.value

                    # 👇 Normalize the subject before doing anything else
                    try:
                        norm_subject = self._normalize_subject(subject)
                    except Exception:
                        # Fallback if helper isn't defined yet
                        norm_subject = (str(subject).strip() or "news").lower()
                    subject = norm_subject

                    if enabled:
                        self.scheduler_running = True
                        self.scheduler_character = character
                        self.scheduler_subject = subject  # <- store normalized subject

                        # If memes are enabled, start with a meme tweet
                        if self.use_memes:
                            tweet_text, meme_path = self.get_random_meme(character)
                            if tweet_text and meme_path:
                                if self.send_tweet_with_media(tweet_text, meme_path):
                                    # Reset meme counter after successful meme
                                    self.meme_counter = 0

                                    # Queue up news stories for next tweets (seed 2–3 items)
                                    seeded = 0
                                    for _ in range(3):
                                        new_story = self.get_new_story(subject)
                                        if not new_story:
                                            break
                                        story_text = f"{new_story['title']}\n\n{new_story.get('preview','')}\n\nRead more: {new_story['url']}"
                                        self.tweet_queue.put((character, story_text, subject))
                                        seeded += 1
                                    print(f"Seeded {seeded} story(ies) after meme.")

                                    # Start the worker thread
                                    threading.Thread(target=self.scheduler_worker, daemon=True).start()
                                    return f"Scheduler started with meme tweet: {tweet_text}", "Scheduler: RUNNING", current_topic.value

                            # Only proceed to news if memes are disabled or meme tweet completely failed
                            print("Meme tweet failed, falling back to news")

                        # If no memes or meme tweet failed, start with news
                        new_story = self.get_new_story(subject)
                        if not new_story:
                            self.scheduler_running = False
                            return "Failed to fetch news story", "Scheduler: NOT RUNNING", current_topic.value

                        story_text = f"{new_story['title']}\n\n{new_story.get('preview','')}\n\nRead more: {new_story['url']}"

                        # Send first tweet
                        tweet_text = self.generate_tweet(character, story_text)
                        if tweet_text and self.send_tweet(tweet_text):
                            # Queue up next stories before starting worker (seed 2–3 items)
                            seeded = 0
                            for _ in range(3):
                                next_story = self.get_new_story(subject)
                                if not next_story:
                                    break
                                next_story_text = f"{next_story['title']}\n\n{next_story.get('preview','')}\n\nRead more: {next_story['url']}"
                                self.tweet_queue.put((character, next_story_text, subject))
                                seeded += 1
                            print(f"Seeded {seeded} story(ies) after first tweet.")

                            # Start the worker thread
                            threading.Thread(target=self.scheduler_worker, daemon=True).start()
                            return f"Scheduler started and first tweet sent: {tweet_text}", "Scheduler: RUNNING", story_text
                        else:
                            self.scheduler_running = False
                            return "Failed to send first tweet", "Scheduler: NOT RUNNING", current_topic.value
                    else:
                        self.scheduler_running = False
                        return "Scheduler stopped", "Scheduler: NOT RUNNING", current_topic.value

                scheduler_enabled.change(
                    toggle_scheduler,
                    inputs=[scheduler_enabled, character_dropdown, subject_dropdown],
                    outputs=[tweet_status, scheduler_status, current_topic]
                )
            
                def manual_tweet(character, topic):
                    if not character:
                        return "Please select a character first"
                    if not topic:
                        return "Please enter a topic or get a news story first"
                        
                    tweet_text = self.generate_tweet(character, topic)
                    if tweet_text:
                        if self.send_tweet(tweet_text):
                            if use_news.value:
                                new_story = self.get_new_story(subject_dropdown.value)
                                if new_story:
                                    current_topic.value = f"{new_story['title']}\n\n{new_story['preview']}\n\nRead more: {new_story['url']}"
                            return f"Tweet sent: {tweet_text}"
                        else:
                            return "Failed to send tweet. Please check your credentials."
                    return "Failed to generate tweet. Please try again."
                
                tweet_btn.click(
                    manual_tweet,
                    inputs=[character_dropdown, current_topic],
                    outputs=[tweet_status]
                )
            
            # Register character management event handlers
            save_char_button.click(
                save_character,
                inputs=[character_name, character_prompt, model_dropdown],
                outputs=[save_char_status, delete_char_dropdown, character_name, 
                        control_character, character_dropdown]
            )
            
            delete_button.click(
                delete_character,
                inputs=[delete_char_dropdown],
                outputs=[delete_status, delete_char_dropdown, delete_char_dropdown,
                        control_character, character_dropdown]
            )
            
            # Feed Configuration section
            with gr.Accordion("📰 Feed Configuration", open=True):
                gr.Markdown("Configure which RSS feeds to use for each subject")

                # --- Subject picker now includes whatever is in RSS_FEEDS (e.g., crypto, ai, tech) ---
                with gr.Row():
                    feed_subject = gr.Dropdown(
                        label="Subject",
                        choices=list(RSS_FEEDS.keys()),
                        value="crypto",
                        interactive=True,
                        show_label=True,
                        container=True,
                        scale=1
                    )

                # --- Helpers to refresh the checkbox groups for the selected subject ---
                def update_feed_checkboxes(subject):
                    print(f"\nUpdating feed checkboxes for subject: {subject}")
                    feed_config = self.feed_config.get(subject, {})
                    primary_feeds = RSS_FEEDS[subject]["primary"]
                    secondary_feeds = RSS_FEEDS[subject]["secondary"]

                    primary_choices = [f"{feed['name']} ({feed['url']})" for feed in primary_feeds]
                    primary_values = [feed_config.get("primary", {}).get(feed["url"], True) for feed in primary_feeds]
                    secondary_choices = [f"{feed['name']} ({feed['url']})" for feed in secondary_feeds]
                    secondary_values = [feed_config.get("secondary", {}).get(feed["url"], True) for feed in secondary_feeds]

                    print(f"Primary feeds: {len(primary_choices)} choices, {len(primary_values)} values")
                    print(f"Secondary feeds: {len(secondary_choices)} choices, {len(secondary_values)} values")

                    return [
                        gr.update(choices=primary_choices, value=[choice for i, choice in enumerate(primary_choices) if primary_values[i]]),
                        gr.update(choices=secondary_choices, value=[choice for i, choice in enumerate(secondary_choices) if secondary_values[i]])
                    ]

                with gr.Column():
                    gr.Markdown("### Primary Sources")
                    primary_feeds = gr.CheckboxGroup(
                        label="Primary Sources",
                        choices=[f"{feed['name']} ({feed['url']})" for feed in RSS_FEEDS["crypto"]["primary"]],
                        value=[f"{feed['name']} ({feed['url']})" for feed in RSS_FEEDS["crypto"]["primary"]],
                        interactive=True
                    )

                    gr.Markdown("### Secondary Sources")
                    secondary_feeds = gr.CheckboxGroup(
                        label="Secondary Sources",
                        choices=[f"{feed['name']} ({feed['url']})" for feed in RSS_FEEDS["crypto"]["secondary"]],
                        value=[f"{feed['name']} ({feed['url']})" for feed in RSS_FEEDS["crypto"]["secondary"]],
                        interactive=True
                    )

                with gr.Row():
                    save_feeds_btn = gr.Button("Save Feed Configuration", variant="primary")
                    # New: random-any-category button
                    surprise_all_btn = gr.Button("🎲 Surprise me (All Feeds)")
                    save_feeds_status = gr.Textbox(label="Status", interactive=False)

                # Wire subject dropdown to checkbox refresh
                feed_subject.change(
                    update_feed_checkboxes,
                    inputs=[feed_subject],
                    outputs=[primary_feeds, secondary_feeds]
                )

                save_feeds_btn.click(
                    self.save_feed_selection,
                    inputs=[feed_subject, primary_feeds, secondary_feeds],
                    outputs=[save_feeds_status]
                )

                # Initialize feed checkboxes for default subject
                feed_subject.value = "crypto"
                update_feed_checkboxes("crypto")

            # Simple helpers that already existed
            def get_story(subject):
                story = self.get_new_story(subject)
                if story:
                    return f"{story['title']}\n\n{story['preview']}\n\nRead more: {story['url']}"
                return "Failed to fetch new story. Please try again."

            def send_tweet(character, topic):
                success = self.send_tweet(character, topic)
                return "Tweet sent successfully!" if success else "Failed to send tweet. Please try again."

            # Connect button handlers
            new_story_btn.click(get_story, inputs=[subject_dropdown], outputs=[current_topic])
            tweet_btn.click(send_tweet, inputs=[character_dropdown, current_topic], outputs=[tweet_status])

            # NEW: connect the Surprise me (All Feeds) button to fill current_topic
            surprise_all_btn.click(lambda: get_random_story_all(), outputs=[current_topic])

            # Connect checkbox handlers
            def update_news_feed(value):
                self.use_news = value
                return value

            def update_memes(value):
                self.use_memes = value
                return value

            def update_meme_frequency(value):
                self.meme_frequency = int(value) if value else 5
                return value

            use_news.change(update_news_feed, inputs=[use_news], outputs=[use_news])
            use_memes.change(update_memes, inputs=[use_memes], outputs=[use_memes])
            meme_frequency.change(update_meme_frequency, inputs=[meme_frequency], outputs=[meme_frequency])

            return interface

    def start_bot(self):
        self.subject = subject_dropdown.value
        self.character_name = character_dropdown.value
        self.tweet_interval = tweet_interval.value
        self.story_age_hours = story_age.value
        self.use_news = use_news.value
        self.use_memes = use_memes.value
        self.meme_frequency = meme_frequency.value
        
        if not self.scheduler_running:
            self.start_scheduler()
            
        return {
            status: update_status(),
            next_tweet: update_next_tweet(),
            last_tweet: update_last_tweet()
        }

    def fetch_prompt_from_github(self, repo_url="https://raw.githubusercontent.com/Mork-Zuckerbarge/prime-directive/main/directive"):
        try:
            response = requests.get(repo_url, timeout=10)
            response.raise_for_status()
            print("✅ Prompt fetched from GitHub successfully.")
            return response.text.strip()
        except Exception as e:
            print(f"❌ Failed to fetch prompt from GitHub: {e}")
            return None

def main():
    bot = TwitterBot()

    prompt_text = bot.fetch_prompt_from_github()
    if prompt_text:
        bot.save_characters({
               "mork zuckerbarge": {"prompt": prompt_text, "model": "gpt-4o"}
         })
        print("✅ Mork has been rewritten using GitHub prompt.")
    else:
        print("⚠️ GitHub prompt fetch failed; keeping existing character prompt.")

    interface = bot.create_ui()
    threading.Thread(target=bot.scheduler_worker, daemon=True).start()
    interface.launch()


if __name__ == "__main__":
    main()
