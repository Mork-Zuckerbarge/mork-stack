# Mork App

## Quick start (one-command bootstrap)

From the repo root:

```bash
./setup.sh
cd mork-app
npm run dev
```

The setup command will:
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

If preflight shows `Ollama not reachable at http://127.0.0.1:11434`:

1. Start Ollama:
   - local install: `ollama serve`
   - Docker: `docker compose up -d ollama`
2. Verify from the same shell where `npm run dev` is running:
   - `curl http://127.0.0.1:11434/api/tags`

3. If you are running `mork-app` inside WSL but Ollama on Windows:
   - set `OLLAMA_HOST` in `mork-app/.env.local` to the Windows host IP (not `127.0.0.1`), then restart `npm run dev`,
   - the app also auto-probes common alternatives (`localhost`, `host.docker.internal`, and WSL nameserver IP) as a fallback.
4. Pull the selected model once reachability is fixed:
   - `OLLAMA_HOST=<your-host> ollama pull llama3.2:3b`

## Sherpa bootstrap troubleshooting

Sherpa is the X/Twitter bot module (posting + replies) and uses RSS feeds, meme/media inputs, Ollama writing, plus arb reflections and memory modules.

If setup logs show Python venv errors and preflight reports `Sherpa (X bot) bootstrap missing (.venv not found)`:

1. Install the Python venv package for your distro (Debian/Ubuntu example: `sudo apt install python3-venv` or `python3.12-venv`).
2. Re-run setup from repo root: `./setup.sh`
3. Restart app: `cd mork-app && npm run dev`

If you intentionally don't run Sherpa locally, set `MORK_SETUP_SKIP_SHERPA=1` before setup.
=======
3. If you are running `mork-app` inside WSL but Ollama on Windows, set `OLLAMA_HOST` in `mork-app/.env.local` to the Windows host IP (not `127.0.0.1`), then restart `npm run dev`.
4. Pull the selected model once reachability is fixed:
   - `OLLAMA_HOST=<your-host> ollama pull llama3.2:3b`
