# Agent & Module Hardening Plan

## Current structure (as implemented)

### 1) `mork-app` is the control plane + primary runtime surface
- API routes in `mork-app/src/app/api/**` expose one UI-driven surface for chat, trading, settings, wallet, and agent controls.
- `src/lib/core/orchestrator.ts` is the runtime coordinator for startup, module lifecycle (`arb`, `sherpa`), runtime flags, persona, strategy engines, and health registry updates.
- `src/lib/core/chat.ts` applies channel-aware guardrails and response policy enforcement before generating responses.
- `src/lib/core/plannerAutopilot.ts` schedules planner ticks in-process when autonomous mode is enabled.

### 2) `services/mork-core` contains legacy backend-brain patterns
- `services/mork-core/src/server.ts` runs an Express service with endpoints for health, memory ingest, and arb policy/event processing.
- It includes its own Ollama integration and market-sense/arb policy logic.
- This duplicates capability now also present in the app-side runtime and keeps localhost-style service boundaries alive.

### 3) Specialized service modules exist for execution and channels
- `services/arb` handles arbitrage logic/reporting/wallet sense helpers.
- `services/sol-mev-bot` provides strategy engines, listeners, fee/jito clients, and some Rust transaction/bundle components.
- `services/sherpa` handles memes/content/reply automation.
- `services/telegram-bridge` is a channel bridge.

### 4) Architecture intent already documented
- `architecture.md` explicitly states a move toward a modular monolith with one user-controlled app surface and less internal localhost HTTP glue.

## Hardening priorities to unify actions + intelligence across modules

## A) Establish one authoritative "Action Envelope" for all agent actions
Define and enforce one shared internal type/schema for every action-producing module (planner, chat, arb, sherpa, bridge), including:
- `action_id`, `origin_module`, `intent_type`, `proposed_effect`, `risk_level`, `requires_user_confirmation`, `policy_version`, `created_at`.
- `preconditions`: wallet state snapshot hash, allowlist check status, risk-check status, cooldown status.
- `execution_state`: `proposed | approved | rejected | executed | failed`.

Why:
- Prevents ambiguous action flows and makes all modules speak the same decision protocol.
- Makes auditing and replay deterministic.

## B) Centralize policy and safety gating in one internal core module
Move all execution authority checks, per-channel disclosure rules, wallet limits, mint allowlist checks, and cooldown checks behind one importable internal function set (not service HTTP).

Why:
- Eliminates drift between chat/planner/arb behavior.
- Reduces risk of one module bypassing checks.

## C) Replace internal localhost HTTP with direct module calls where co-deployed
For features already in one app runtime, route `memory ingest`, `policy update`, and `planner/arb decision support` via direct imports/shared packages.
Use HTTP only for truly external or independently deployed boundaries.

Why:
- Lower latency/failure surface.
- Better type safety and testability.

## D) Add a unified "Decision Ledger" table for explainability + recovery
Persist every action proposal and transition with:
- input context checksum,
- selected policy snapshot,
- reason codes,
- downstream execution receipt/error.

Why:
- Gives one source of truth for "why no trade happened" and "who did what, when".
- Enables robust post-mortems and automated suppression of repeated bad routes.

## E) Standardize module health into one finite-state model
Current health statuses exist in orchestrator; extend to all modules with common semantics:
- `unknown | starting | healthy | degraded | blocked | stopped`.
- Include blocker reason codes (`wallet_unfunded`, `allowlist_empty`, `cooldown_active`, `route_blacklisted`, etc.).

Why:
- Eliminates vague "HOLD"/"not running" confusion.
- Lets UI and channel outputs stay consistent.

## F) Introduce deterministic "policy packs" with versioning
Group control knobs (persona, execution authority, strategy params, response policy) into versioned policy packs.
Every autonomous tick and manual action references the active `policy_pack_id`.

Why:
- Reproducible behavior and safe rollback.
- Easier A/B safety tuning without hidden drift.

## G) Strengthen prompt/output sanitization and domain-bound reasoning
Keep existing poisoned-output and off-domain checks, but move them into reusable validators callable from all text-producing paths (app, telegram, x, sherpa).
Add structured post-generation checks for:
- forbidden claims (e.g., "trade executed" without receipt),
- private context leakage to public channels,
- unsafe wallet assertions.

## H) Build shared strategy interface adapters
Unify strategy modules (`poolImbalance`, `crossDexArb`, `momentumRunner`, future engines) behind one interface:
- `scan(context) -> opportunities[]`
- `score(opportunity, policy) -> decision`
- `proposeAction(decision) -> actionEnvelope`

Why:
- Consistent action quality and easier cross-strategy comparison.
- Allows centralized throttling and risk gates.

## I) Add contract tests for cross-module invariants
Critical invariant tests:
1. No action can become `executed` without passing central safety checks.
2. Public-channel responses cannot include private runtime context.
3. "No-trade" decisions always emit explicit blocker or "normal HOLD" reason.
4. All modules emit traceable `action_id` and `policy_version`.

## J) Operational hardening defaults
- Fail-closed for execution when policy state is missing/corrupt.
- Idempotency keys for execution calls to prevent duplicate trades.
- Strict secret redaction in logs/events.
- Timeboxed retries with jitter for external RPC/LLM calls.

## Suggested incremental implementation sequence
1. Create shared `core/agentActionSchema` + validators.
2. Move safety gates to `core/policyEngine` and make planner/chat/arb depend on it.
3. Add decision ledger persistence and UI visibility.
4. Migrate `mork-core` HTTP-only internals into importable modules used by app runtime.
5. Retire redundant localhost paths once parity tests pass.

## Env vars to explicitly govern during hardening
- `MORK_AUTONOMOUS_TRADING_ENABLED`
- `MORK_PLANNER_AUTORUN`
- `MORK_PLANNER_TICK_INTERVAL_MS`
- `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TEMP`, `OLLAMA_CTX`

Guardrail recommendation:
- treat missing/invalid critical execution vars as `blocked` runtime state instead of silently degrading.
