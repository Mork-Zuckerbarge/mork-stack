# Mork App

## Fresh Ubuntu one-liner (locate + deps + build + launch)

For a brand-new Ubuntu machine, this single command installs system deps, clones the repo, bootstraps the app, builds it, and launches the unified app surface:

```bash
bash -lc '\nset -euo pipefail; \
sudo apt-get update; \
sudo apt-get install -y git curl ca-certificates nodejs npm python3 python3-venv; \
REPO_DIR="$HOME/mork-stack"; \
if [ ! -d "$REPO_DIR/.git" ]; then git clone https://github.com/mork-ai/mork-stack.git "$REPO_DIR"; fi; \
cd "$REPO_DIR"; \
./setup.sh; \
(cd mork-app && npm run build); \
./start.sh\n'
```

> Note: `./start.sh` runs in the foreground to keep services alive.

## Quick start (single app command)

From the repo root:

```bash
./start.sh
```

The start command will:
- run setup/bootstrap first,
- then launch the web app in dev mode,
- auto-start arb (`services/arb/index.js`) in the same launch flow,
- auto-start Sherpa (`services/sherpa/sherpa_bot.py`) when `services/sherpa/.venv` exists,
- auto-start Telegram bridge (`services/telegram-bridge/bridge.py`) when `TELEGRAM_BOT_TOKEN` is set.

Telegram bridge notes for local `./start.sh`:
- `MORK_CORE_URL` defaults to `http://127.0.0.1:3000` for local runs (so both arb reporter + telegram bridge can call `mork-app` APIs locally),
- set `MORK_CORE_URL` explicitly in `mork-app/.env.local` if your API endpoint runs elsewhere.
- Background process logs are written to `.logs/arb.log`, `.logs/sherpa.log`, and `.logs/telegram-bridge.log`.

Bootstrap includes:
- install app dependencies,
- create `mork-app/.env.local` from `mork-app/env.example` if missing,
- import a wallet from `~/.config/solana/id.json` when available (or from `MORK_WALLET_IMPORT_PATH`),
- otherwise auto-create a local development wallet when no wallet is configured,
- run `prisma generate` and `prisma db push`,
- verify Ollama reachability and ensure the default model is pulled,
- install Sherpa dependencies into `services/sherpa/.venv` when Python is available.

Wallet setup mode can be controlled with:
- `MORK_SETUP_WALLET_MODE=auto` (default): import if file exists, otherwise create.
- `MORK_SETUP_WALLET_MODE=import`: require importing from `MORK_WALLET_IMPORT_PATH` (or `~/.config/solana/id.json`).
- `MORK_SETUP_WALLET_MODE=create`: always create a new local dev keypair.
- `MORK_SETUP_SKIP_SHERPA=1`: skip Sherpa Python dependency bootstrap.

Important wallet env note:
- Runtime reads `mork-app/.env.local`.
- `mork-app/env.example` is only used as a template when `.env.local` is first created.
- If `.env.local` already exists, edit `MORK_WALLET` or `MORK_WALLET_SECRET_KEY` in `.env.local` directly, then restart the app.

## Local RPC + secret update map

Update these in `mork-app/.env.local` (not `env.example`) on your local machine:

- Solana RPC for wallet and direct swap routes:
  - `SOLANA_RPC_URL` (primary),
  - `SOLANA_RPC` and/or `RPC_URL` (fallback compatibility for older paths/services),
  - `SOLANA_RPC_URLS` (optional comma-separated pool used by arb failover rotation).
- Jupiter routing/token APIs (free):
  - `JUP_BASE_URL` (single preferred endpoint),
  - `JUP_BASE_URLS` (optional comma-separated fallback list; recommended: `https://api.jup.ag,https://lite-api.jup.ag`),
  - `JUP_TIMEOUT_MS` (request timeout for token lookup + quote/swap API calls).
- Wallet credentials:
  - `MORK_WALLET` (public address only), and/or
  - `MORK_WALLET_SECRET_KEY` (JSON byte array, required for server-side signing features like direct swaps).
- Telegram posting via chat command route:
  - `TELEGRAM_BOT_TOKEN`,
  - `TELEGRAM_CHAT_ID`.
- Ollama responsiveness:
  - `OLLAMA_HOST`,
  - `OLLAMA_MODEL`,
  - `OLLAMA_CTX` (lower = faster generation, less long-context recall),
  - `OLLAMA_TIMEOUT_MS` (increase if responses time out).
- Prime directive override (optional):
  - `MORK_PRIME_DIRECTIVE` (defaults internally to `Prime directives: accuracy, honesty, and profit.` when unset).
- Telegram ElevenLabs voice cadence:
  - `VOICE_REPLY_PROBABILITY` (0.0-1.0, defaults to `0.2` so voice triggers ~1/5 replies when voice is enabled).
- Chat media generation:
  - Images default to Pollinations (no extra setup in this repo).
  - Videos default to Pollinations `gen.pollinations.ai/image/{prompt}` with a video model when `MEDIA_VIDEO_ENDPOINT` is empty.
  - `MEDIA_VIDEO_TOKEN` can be set to a Pollinations key if your account/rate limits require auth (the app sends this as both `Authorization: Bearer ...` and `?key=...` for compatibility with Pollinations auth modes).
  - Style conditioning references can be supplied through `MEDIA_STYLE_IMAGE_URLS` (comma-separated public URLs) and are applied to both image/video generation as Pollinations `image=` references.
  - The first-time setup now accepts 7 public style image URLs and persists them via `/api/app/style-pack` for automatic Pollinations conditioning.
  - `./start.sh` also snapshots/restores `mork-app/data/style-pack.json` (and uploaded `public/style-pack/*` files) into `${MORK_PERSIST_DIR:-~/.mork-stack}` so the style pack survives repo updates.
  - Optional overrides: `MEDIA_VIDEO_MODEL`, `MEDIA_VIDEO_MODEL_DEFAULT`, `MEDIA_VIDEO_SEED`, `MEDIA_VIDEO_DURATION`, `MEDIA_VIDEO_ASPECT_RATIO`, `MEDIA_VIDEO_AUDIO`.
  - Use `MEDIA_VIDEO_ENDPOINT` only when you intentionally want a custom provider.
  - `MEDIA_VIDEO_METHOD` applies to custom endpoint mode only (Pollinations default uses `GET`).

After editing env values, restart `./start.sh` (or restart `npm run dev`) so running processes pick up changes.

## Docker Compose bootstrap

For a reproducible containerized setup:

```bash
docker compose up --build
```

This starts:
- `mork-app` on `http://localhost:3000`,
- `ollama` on `http://localhost:11434`,
- `mork-core` and `telegram-bridge` for backend channels.

## Runtime preflight checks

On app startup, the UI now reports clear actionable status for:
- Ollama reachability,
- selected model availability,
- wallet configuration validity,
- Sherpa (X bot) bootstrap readiness (`services/sherpa/.venv` present).

Runtime defaults:
- Arb + Sherpa are auto-started on first app boot/load.
- First-time setup is auto-marked complete on boot.
- Set `MORK_AUTO_START_ON_BOOT=0` to disable this behavior.
- Agent `/api/agent/state` reports `active` only when preflight checks pass.

Use the **Preflight** card in the control panel to recheck at any time.

## Ollama reachability troubleshooting

`npm run dev` now runs an Ollama bootstrap step before Next.js starts. It will:
- probe `OLLAMA_HOST` plus common local fallbacks,
- auto-install `ollama` on Linux (via `https://ollama.com/install.sh`) when missing,
- try launching local `ollama serve` when Ollama is unreachable,
- auto-start `docker compose up -d ollama` (or `docker-compose up -d ollama`) as a fallback when available,
- auto-pull the selected model (`OLLAMA_MODEL`, default `llama3.2:3b`) if missing.

If bootstrap still fails:

1. Start Ollama manually:
   - local install: `ollama serve`
   - Docker: `docker compose up -d ollama`
2. Verify from the same shell where `npm run dev` is running:
   - `curl http://127.0.0.1:11434/api/tags`
3. If running `mork-app` inside WSL but Ollama on Windows:
   - set `OLLAMA_HOST` in `mork-app/.env.local` to the Windows host IP (not `127.0.0.1`), then restart `npm run dev`.
4. To disable auto-install attempts, set `MORK_SKIP_OLLAMA_INSTALL=1` before `npm run dev`.
5. By default, `npm run dev` now continues even if Ollama is unavailable so the app can load and show guided remediation in the Preflight panel. To make Ollama a hard requirement, set `MORK_OLLAMA_STRICT=1`.

## Sherpa bootstrap troubleshooting

Sherpa is the X/Twitter bot module (posting + replies) and uses RSS feeds, meme/media inputs, Ollama writing, plus arb reflections and memory modules.

If setup logs show Python venv errors and preflight reports `Sherpa (X bot) bootstrap missing (.venv not found)`:

1. Install the Python venv package for your distro (Debian/Ubuntu example: `sudo apt install python3-venv` or `python3.12-venv`).
2. Re-run setup from repo root: `./setup.sh`
3. Restart app from repo root: `./start.sh`

If you intentionally don't run Sherpa locally, set `MORK_SETUP_SKIP_SHERPA=1` before setup.
