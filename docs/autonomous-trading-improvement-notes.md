# Autonomous Trading Improvement Notes (based on external repo review)

Date: 2026-05-15

## Scope and limitation
I reviewed public metadata/readmes for:
- https://github.com/AintSmurf/Automated-Solana-Sniper-Bot
- https://github.com/Mohamed-mufleh/ai-trading-bot

Direct `git clone` from this environment to GitHub returned HTTP 403, so recommendations below are derived from accessible repository pages and raw file snapshots, then mapped to this codebase with minimal-risk integration ideas.

## What looked useful

### 1) Lifecycle ownership and restart recovery
From the Solana sniper bot README (v4.3.9), two practices stand out:
- explicit trade lifecycle ownership boundaries
- DB-backed run sessions for restart recovery

**How to apply here (minimal change path):**
- Add an explicit `runId` for autonomous planner ticks in your existing execution/memory records.
- Persist state transitions (`detected` -> `candidate` -> `submitted` -> `confirmed` -> `closed`/`aborted`) so restart logic resumes deterministically.
- Keep this inside the monolith (existing app/core modules), not as a new service.

### 2) Websocket reliability + stale connection recovery
The same repo calls out stale-connection detection and automated recovery.

**How to apply here:**
- Add heartbeat timestamps for all market/feed websocket clients.
- If `lastMessageAt` exceeds threshold, mark feed as degraded in orchestrator health and reconnect with bounded backoff.
- Surface this in the current UI health panel so users keep control and visibility.

### 3) SIM vs REAL execution mode hygiene
The sniper bot explicitly supports SIM mode with real quotes and no chain execution.

**How to apply here:**
- Strengthen current risk gate UX by making simulation mode first-class in autonomous tick flows.
- Record both *counterfactual* (simulated) and *actual* outcomes for the same signal where possible.
- Use those deltas to tune strategy thresholds before enabling real mode for that strategy.

### 4) Explicit exit rule stack and reason codes
External project emphasizes TP/SL/TSL/timeout exits and cleaner lifecycle services.

**How to apply here:**
- Ensure every autonomous non-HOLD decision stores a machine-readable exit-plan payload (TP/SL/timeout/trailing config).
- Ensure every no-trade/HOLD result includes a reason code (`cooldown`, `risk_limit`, `low_confidence`, `spread_too_wide`, etc.) for later analytics.

### 5) Model pipeline discipline (from ai-trading-bot)
The ai-trading-bot code highlights:
- train/val/test splitting
- class weighting for imbalance
- backtesting script and F1/confusion metrics

**How to apply here:**
- For autonomous decision models/signals, require a baseline offline evaluation artifact before promotion (at least confusion matrix + precision/recall by class).
- Track class imbalance and regime imbalance (trending/chop/high-vol) so HOLD doesn’t dominate silently.
- Add regression checks that block parameter pushes when offline metrics degrade beyond threshold.

### 6) Per-run analytics and attribution
Solana sniper repo mentions SQL persistence for token/trade/signature/safety snapshots.

**How to apply here:**
- Continue using existing persistence, but attach richer attribution metadata per decision:
  - signal source(s)
  - risk checks passed/failed
  - expected edge estimate
  - slippage at quote and at fill
- This gives you actionable post-mortems without changing architecture.

## Prioritized implementation order (high confidence)
1. Add autonomous tick reason codes + runId tagging.
2. Add websocket heartbeat/reconnect health signaling.
3. Add SIM-vs-REAL comparative logging in planner ticks.
4. Add structured exit-plan payload persistence.
5. Add offline metric gate for any model/strategy parameter promotion.

## Env vars assumed / touched
No new env vars required for this note.
Potential future vars if implemented:
- `AUTONOMOUS_FEED_STALE_MS`
- `AUTONOMOUS_FEED_RECONNECT_MAX_BACKOFF_MS`
- `AUTONOMOUS_SIM_COMPARE_ENABLED`

## Safety reminders
- Keep `emergency_stop` and existing risk/wallet checks intact.
- Default new autonomous enhancements to observability first, execution changes second.
- Never log secrets or full private credentials.
