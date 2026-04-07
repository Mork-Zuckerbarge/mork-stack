# Mork App

> For fresh-machine Ubuntu bootstrap, use the repo-root guide in [`../README.md`](../README.md).

## Quick start (single app command)

From the repo root:

```bash
./start.sh
```

The start command will:
- run setup/bootstrap first,
- then launch the web app in dev mode,
- auto-start arb (`services/arb/index.js`) in the same launch flow,
- auto-start Sherpa (`services/sherpa/sherpa_bot.py`) when `services/sherpa/.venv` exists.

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
