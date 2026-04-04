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
- wallet configuration validity.

Use the **Preflight** card in the control panel to recheck at any time.
