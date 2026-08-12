# Obsidian Trading Logic Structure

Use this as an Obsidian vault map for strengthening Mork's trading decisions without adding another service. Keep the notes close to the app's existing planner, wallet, arb policy, and UI controls.

## Suggested vault folders

- `00 Dashboard/`
  - `Trading Control Surface.md`: links to current app controls, active env gates, and latest planner status.
  - `Safety Gates.md`: documents required wallet, authority, cooldown, allowlist, and swap limits.
- `10 Signals/`
  - `Arb Policy Signals.md`: explain `arbPolicy` score, ok/fail counts, and temporary blacklists.
  - `Narrative Feeds.md`: capture Sherpa/feed context that can influence trade confidence.
  - `Execution Quality.md`: track slippage, price impact, route hop count, and quote failures.
- `20 Decisions/`
  - `Entry Checklist.md`: positive signal, tradable route, acceptable impact, minimum economic size.
  - `Rotation Checklist.md`: only rotate profitable holdings, preserve BBQ requirement, require positive target signal.
  - `Hold Reasons.md`: normalize why the planner held, skipped, or errored.
- `30 Positions/`
  - `Cost Basis.md`: cost-basis rules and where planner facts are stored.
  - `Exit Plan.md`: take-profit, trailing stop, hard stop, and maximum hold-time ideas.
- `40 Experiments/`
  - `Scoring Changes.md`: record proposed formula changes before implementing them.
  - `Post-Trade Reviews.md`: compare expected decision metadata to actual outcomes.

## Current decision loop

1. Confirm autonomous trading, planner, execution authority, cooldown, allowlist, wallet, and minimum-size gates.
2. Build context from recent arb/trade memories, feeds, wallet state, strategy settings, planner state, and policy rows.
3. Ask the local model for `TRADE $<amount>` or `HOLD`.
4. If the model holds but policy signals are positive, use a bounded fallback trade instead of doing nothing.
5. Size the SOL spend from USD while respecting wallet balance, fee economics, and `MORK_AGENT_SWAP_MAX_SOL`.
6. Probe a limited set of ranked allowlist mints and choose the strongest executable route using policy score, ok/fail reliability, quote output, price impact, and route complexity.
7. Execute through the existing internal swap route so existing wallet and risk checks remain in force.
8. Store cost basis for buys and clear old basis only after profitable rotations.

## Strengthening ideas

- Add a daily review note that summarizes every `decisionMeta.reasonCode` and the selected candidate's execution score.
- Promote repeated `quote_failed` or high-impact routes into temporary policy penalties.
- Track a watchlist note per mint with backlinks to signals, route quality, and post-trade reviews.
- Require two independent signal types for larger sizes while allowing one strong signal for minimum-size probes.
- Keep live execution gated by the app controls and env vars; use notes to plan changes, not bypass safety gates.

## Env vars to document

- `MORK_AUTONOMOUS_TRADING_ENABLED`: master autonomous trading gate.
- `MORK_AGENT_SWAP_ENABLED`: swap execution gate enforced by the swap route.
- `MORK_AGENT_SWAP_MAX_SOL`: maximum SOL spend per agent-initiated swap.
- `MORK_AGENT_MIN_TRADE_USD`: minimum autonomous trade size.
- `MORK_PLANNER_CANDIDATE_PROBE_LIMIT`: number of top-ranked mints the planner quotes before selecting a target.
- `MORK_SELL_PROFIT_THRESHOLD_PCT`: minimum profit required before rotating a held token.
- `MORK_AGENT_TRANSFER_ENABLED`: opt-in gate for explicit chat wallet transfers (`1` enables them).
- `MORK_AGENT_TRANSFER_MAX_SOL`: maximum SOL allowed in one explicit transfer (default `0.25`).

## Explicit wallet transfers

Transfers are operator commands, not autonomous planner actions. In chat, use `send <amount> <symbol-or-mint> to <wallet>` or `send all <symbol-or-mint> to <wallet>`, for example `send 0.05 SOL to <wallet>`. The runtime validates the recipient, estimates USD notional against execution-authority limits, respects emergency stop and cooldown controls, retains SOL for fees, and preserves the configured BBQ minimum. SPL transfers create the recipient's associated token account when necessary. For `send all`, the runtime resolves the configured wallet's transferable balance before applying the same authority checks; BBQ sends keep the required reserve and SOL sends keep the fee reserve.
