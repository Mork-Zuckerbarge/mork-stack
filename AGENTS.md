# AGENTS.md

## Project intent
This repo is moving toward a modular monolith. Do not introduce unnecessary new services.

## Priorities
1. Keep the app user-controlled from one UI/app surface.
2. Prefer direct internal function/module calls over localhost HTTP between internal components.
3. Preserve existing behavior unless the task explicitly changes behavior.
4. Make minimal, high-confidence edits.
5. Keep secrets out of code and logs.

## When changing code
- Explain affected files clearly.
- Call out any env vars assumed.
- Prefer simple imports and shared modules over service boundaries.
- Do not remove safety gates like wallet/risk checks unless explicitly asked.

## Review guidelines
- Watch for secrets, auth mistakes, unsafe defaults, and accidental live-trading behavior.
- Flag missing tests or risky refactors.
