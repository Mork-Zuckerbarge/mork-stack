# Mork Stack Architecture

Goal: one fluid app that gives the user total control of wallet, agent behavior, tone, trading strategy.

Current major parts:
- mork-app: user-facing app/UI
- services/mork-core: backend brain, memory, planner, wallet logic
- services/arb: arbitrage engine
- services/sherpa: RSS, memes, scheduled posting, replies
- services/telegram-bridge: outbound messaging bridge

Desired direction:
- modular monolith
- avoid localhost microservice-style internal HTTP where not necessary
- user controls all modules from one app surface
- arb, sherpa, wallet, memory, planner should be app-managed features

Current architectural pain:
- legacy localhost HTTP glue between internal modules
- duplicate or transitional structures may still exist
- startup/orchestration is not unified enough
