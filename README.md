# mork-stack

## Fresh Ubuntu quickstart (one command)

Use this single command on a fresh Ubuntu machine to install dependencies, clone the repo, bootstrap, build, and launch:

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

> `./start.sh` runs in the foreground to keep services alive.

## Updating without deleting local state

Do **not** remove/re-clone the repo for normal updates. Use:

```bash
cd ~/mork-stack
./update.sh
```

`./update.sh` does a fast-forward `git pull` on your current branch, then runs `./start.sh`.
This keeps local runtime files in place and works with the persistent credential sync in `start.sh`.
If local changes exist, `./update.sh` auto-stashes them before pulling and then restores them after update.

## Repo guide

- App/runtime docs: [`mork-app/README.md`](mork-app/README.md)
- Sherpa module docs: [`services/sherpa/README.md`](services/sherpa/README.md)

## Agent behavior control map (all current tuning locations)

If Mork feels slow or “dumber,” tune behavior in these places (ordered from highest impact to lowest friction):

### 1) Runtime model + policy controls (main UI)

- **Where:** main app → **System** panel (`mork-app/src/components/AppControlPanel.tsx`).
- **What you can change there:**
  - Ollama model choice (speed/quality tradeoff).
  - Persona mode per channel (`app`, `telegram`, `x`).
  - Persona guideline text per channel.
  - Response policy (`maxResponseChars`, URL/quote allowances, behavior guidelines).
  - Runtime toggles (`memoryEnabled`, `plannerEnabled`, `telegramEnabled`, `xEnabled`, wallet auto-refresh).
  - Execution authority/risk gates (`mode`, max trade USD, mint allowlist, cooldown).
- **Backend action handlers:** `/api/app/control` supports all of the above update actions.  
  (See `controls.set`, `persona.mode.set`, `persona.guidelines.set`, `ollama.model.set`, `execution.authority.set`, `response.params.set`.)  
  File: `mork-app/src/app/api/app/control/route.ts`.

### 2) Persisted default control state (source of truth for behavior defaults)

- **Where:** `mork-app/src/lib/core/appControl.ts`.
- **What this file defines by default:**
  - Startup defaults for runtime toggles.
  - Default persona modes and persona guideline strings.
  - Default response policy (`maxResponseChars`, behavior guardrails).
  - Default execution authority (`user_only`, max trade USD, cooldown, allowlist behavior).
  - Auto-start on boot behavior via `MORK_AUTO_START_ON_BOOT`.
- **Important:** This state is persisted in DB memory facts under `__app_control_state_v1__`; UI changes write back to that persisted record.

### 3) `.env.local` runtime variables (host/model/wallet + swap guardrails)

- **Where:** `mork-app/.env.local` (template: `mork-app/env.example`).
- **Common behavior-impact vars:**
  - `OLLAMA_HOST`, `OLLAMA_MODEL` (speed + quality + availability).
  - `MORK_WALLET`, `MORK_WALLET_SECRET_KEY`, `SOLANA_RPC`.
  - `MORK_AGENT_SWAP_ENABLED`, `MORK_AGENT_SWAP_MAX_SOL`.
  - `SCAN_BATCH_SIZE` + RPC pool entries for scan intensity / latency.
- **Settings UI for some env vars:** `/settings` page edits wallet/RPC/Telegram/Ollama settings and writes to `.env.local`.  
  Files: `mork-app/src/app/settings/page.tsx`, `mork-app/src/app/api/settings/route.ts`.

### 4) Sherpa behavior controls (content personality/cadence/channel posting)

- **Where:** Sherpa Gradio UI (`services/sherpa/sherpa_bot.py`), surfaced in app via `mork-app/src/components/SherpaPanel.tsx`.
- **What you can change there:**
  - Character prompt/personality and selected model per character.
  - Scheduler on/off and subject selection.
  - Manual single-post generation flow.
  - Feed selection per subject.
  - Credential-driven channel outputs (X, Telegram, Reddit, Facebook, Instagram).
- **Stored files affecting behavior:** `encrypted_characters.bin`, `encrypted_credentials.bin`, `feed_config.json` (written by Sherpa flows).

### 5) Mork Core generation runtime settings

- **Where:** `services/mork-core/src/server.ts`.
- **What affects response behavior/speed:**
  - `OLLAMA_URL`, `OLLAMA_MODEL`.
  - Generation options sourced from env (`OLLAMA_TEMP`, `OLLAMA_CTX`).
  - Channel response schema and handling for `/chat/respond`.

### 6) Startup/orchestration path (what actually launches)

- **Where:** `start.sh`, plus `mork-app/README.md` for operational flow.
- **What matters:**
  - Whether Sherpa and telegram bridge are launched and with which env.
  - How bootstrapping sets initial runtime expectations (and preflight checks).

### 7) Safety/trading behavior gates (keep these on unless you intentionally change risk posture)

- **Where:** `mork-app/src/lib/core/appControl.ts` + app control API/UI.
- **Controls:** execution mode, max trade size, mint allowlist, cooldown, response policy guardrails.

---

### Quick fix playbook for “slow + dumber” responses

1. In System panel, switch to a stronger model than `llama3.2:3b` (for example `llama3.1:8b`), then retest.
2. Lower `maxResponseChars` in response policy (shorter outputs are faster and often sharper).
3. Confirm preflight passes for Ollama/model reachability before judging quality.
4. Keep persona guidelines concise; very long guideline blocks can degrade consistency.
