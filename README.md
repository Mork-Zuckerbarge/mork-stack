# mork-stack
The all-in-one free app that enalbes you to launch and control agents.

Deploy and manage your own agent.
The LLM is in the app, no subscription required.
Manage / post / reply on
@X  
@facebook
@instagram
@Reddit
@telegram
  
Create or import a wallet to be managed by the agent, while retaining full backend control. Deploy multiple trade strategies as well as use direct agent commands.
All free on your machine, optional enrichment with 
@OpenAI and @ElevenLabs.
Backend language control lets you tune the agent's "Response Logic Flow", and a window in the app lets the user engage the agent directly in the terminal.

Flush modules, check updates, simple launch, local storage only, easy to install, update, and run.
More massive updates coming.
Must hold 1,000 $BBQ to enable wallet-controlled features. Autonomous swaps also default to dust guards (`MORK_AGENT_MIN_TRADE_USD`, `MORK_AGENT_MIN_TRADE_SOL`, and fee-multiple checks) so the agent will not spend SOL on uneconomic microtransactions.

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

## Enrichment connections (OpenAI + Pollinations)

Yes — the stack already supports external enrichment providers and can actively use them at runtime:

- **OpenAI connection (text enrichment + fallback generation):**
  - Enabled via `USE_OPENAI=1` in `mork-app/.env.local`.
  - Key supplied through Sherpa credentials (`openai_key`) or environment.
  - Sherpa routes responses through local/core/OpenAI paths depending on availability and mode.

- **Pollinations connection (media enrichment):**
  - **Images:** `https://image.pollinations.ai/prompt/{prompt}`
  - **Video (+ optional audio mode):** `https://gen.pollinations.ai/image/{prompt}` with media query/model controls
  - The app’s media runtime supports style/reference conditioning and provider-aware fallbacks.

### Recommended enrichment env settings

In `mork-app/.env.local`:

```bash
# OpenAI text enrichment/fallback path (Sherpa)
USE_OPENAI="1"

# Pollinations media enrichment
MEDIA_VIDEO_ENDPOINT=""            # empty => use Pollinations default
MEDIA_VIDEO_MODEL="veo"            # or another supported Pollinations model
MEDIA_VIDEO_TOKEN=""               # optional, if your Pollinations route requires a token
MEDIA_STYLE_IMAGE_URLS="https://...png,https://...png"
```

Notes:
- Keep this architecture in-process: enrichment is consumed by existing app services (no new microservices required).
- If OpenAI is disabled (`USE_OPENAI=0`), local/core model paths continue to work.

## Faceboot agent connection (Betaverse contract)

The app supports the Faceboot runtime contract pattern for posting/commenting.

### Required runtime contract in Faceboot page

- `window.facebootAgentContract`
  - `post.method` (expected: `POST`)
  - `post.url` (expected: `/faceboot/agent/post`)
  - `post.tokenKey` (expected: `token`)
  - `post.textKey` (expected: `text`)
- `window.facebootAgentHttp.request(method, url, payload)`

If this contract/helper exists, the app uses it first. If not, it falls back to legacy:

- `window.facebootAgent.post(token, text)`
- `window.facebootAgent.comment(token, postId, text)`

### `.env.local` values you need

For Faceboot agent auth in Mork app settings, only this value is required:

- `FACEBOOT_AGENT_TOKEN="..."`

No additional Faceboot-specific env vars are required for the new contract-driven integration.

### If token is already saved in Sherpa

If your token is already connected/saved in Sherpa, you usually do **not** need another secret.
You only need to ensure the app has a usable agent token at runtime (via Settings UI or `.env.local`).
If posting fails with invalid token, re-save/refresh the token and restart services.

## Agent behavior control map (all current tuning locations)

If The Agent feels slow or “dumber,” tune behavior in these places (ordered from highest impact to lowest friction):

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

## Trading strategy env variables

These variables control the MEV/arb strategies in `services/sol-mev-bot` and `services/arb`.  
Add them to **`mork-app/.env.local`** (picked up by both services via `start.sh`).

### Arb whitelist generation

On first startup, if `services/arb/whitelist.json` is missing, `start.sh` runs the whitelist generator (`npm --prefix services/arb run build:whitelist`) before launching the arb service. The generator probes Jupiter routes and writes a local `whitelist.json`; if Jupiter/network access fails, startup falls back to `services/arb/whitelist.example.json` so the UI still comes up. Use `WHITELIST_TARGET` to tune the generated list size.

### Enabling new strategies

All new strategies are **off by default** — flip to `true` to enable each one independently.

```bash
# Circular arb: SOL → TOKEN → SOL (sol-mev-bot)
ENABLE_ARB=true

# Triangular arb: SOL → B → TOKEN → SOL (sol-mev-bot)
# This now starts ArbScanner even when ENABLE_ARB=false.
ENABLE_TRIANGULAR_ARB=true

# Liquidation arb: buy dips caused by MarginFi/Kamino/Solend forced sells
ENABLE_LIQUIDATION_ARB=true

# Drift funding arb: basis trades when perpetual funding rates are extreme
ENABLE_DRIFT_FUNDING=true

# Stablecoin depeg: trade USDC/USDT/PYUSD when they deviate from $1.00
ENABLE_STABLECOIN_DEPEG=true

# Momentum: requires BIRDEYE_API_KEY; if the key is missing, MomentumRunner stays disabled
# to avoid Birdeye 401 log spam.
ENABLE_MOMENTUM=true
BIRDEYE_API_KEY=your_birdeye_key

# Triangular routes in the arb service (backs the “enable triangular routes” UI toggle)
ENABLE_TRIANGULAR_ROUTES=true
```


### Live execution coverage

With `DRY_RUN=false`, only strategies with complete live transaction paths are allowed to run:

- `ENABLE_ARB` / `ENABLE_TRIANGULAR_ARB`: Jupiter swap instructions submitted through Jito bundles.
- `ENABLE_LIQUIDATION_ARB`: live Jupiter/Jito entry and exit swaps.
- `ENABLE_STABLECOIN_DEPEG`: live Jupiter/Jito buy/sell swaps.

`ENABLE_MOMENTUM`, `ENABLE_AMM_IMBALANCE`, and `ENABLE_DRIFT_FUNDING` remain dry-run/research only until their live execution is fully wired. In live mode they are disabled at startup instead of logging placeholder successes or sending an unhedged partial trade.

### Dynamic Jito tip sizing

On by default. Fetches Jito's live tip floor every 30 s and scales tips to current bundle competition rather than using a fixed amount. Set to `false` to revert to the fixed `JITO_TIP_LAMPORTS` value.

```bash
DYNAMIC_JITO_TIP=true   # default — set false to use fixed JITO_TIP_LAMPORTS instead
```

### Liquidation arb thresholds

```bash
LIQUIDATION_DIP_THRESHOLD_PCT=3.0   # % price drop from cached baseline to trigger a buy
                                     # don't go below 1.5 — normal volatility causes false positives
LIQUIDATION_TRAILING_STOP_PCT=10    # % drawdown from peak price before exiting the position
```

### Drift funding arb

> **Note:** The spot-side hedge executes immediately via Jupiter. The perp-side (short/long on Drift) is stubbed and requires `@drift-labs/sdk` integration before going live. Don't enable with real funds until the perp side is wired.

```bash
DRIFT_MIN_FUNDING_RATE_PCT=0.05     # minimum funding rate (%/hr) to trigger a trade
                                     # 0.05/hr ≈ 1.2%/day carry — a meaningful edge
```

### Stablecoin depeg

```bash
STABLECOIN_DEPEG_THRESHOLD_PCT=0.3  # minimum % deviation from $1.00 to trade
                                     # don't go below 0.2 — USDC/USDT quote ±0.1% normally
```

### Correlation filter (MomentumRunner)

Prevents entering two highly correlated positions simultaneously (e.g. two dog-themed memecoins). Uses rolling 60-minute Pearson correlation.

```bash
CORRELATION_THRESHOLD=0.75          # block entry if correlation ≥ this value vs open positions
                                     # 0.9 = permissive, 0.6 = strict
```

### Time-of-day profit weighting

Applied automatically to all strategies via the fee simulator — no env var needed. The `minProfitLamports` threshold is multiplied by a UTC-hour factor:

| Window | UTC hours | Multiplier |
|---|---|---|
| US market open | 14:00–16:00 | 1.3–1.5× (raise bar — peak competition) |
| EU market open | 08:00–10:00 | 1.1–1.2× |
| Post-US close  | 20:00–23:00 | 0.75–0.9× |
| Overnight APAC | 00:00–06:00 | 0.65–0.7× (lower bar — fewer bots active) |

---

### Quick fix playbook for “slow + dumber” responses

1. In System panel, switch to a stronger model than `llama3.2:3b` (for example `llama3.1:8b`), then retest.
2. Lower `maxResponseChars` in response policy (shorter outputs are faster and often sharper).
3. Confirm preflight passes for Ollama/model reachability before judging quality.
4. Keep persona guidelines concise; very long guideline blocks can degrade consistency.
