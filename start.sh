#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/mork-app"
ARB_DIR="$ROOT_DIR/services/arb"
SHERPA_DIR="$ROOT_DIR/services/sherpa"
SOL_MEV_BOT_DIR="$ROOT_DIR/services/sol-mev-bot"
TELEGRAM_BRIDGE_DIR="$ROOT_DIR/services/telegram-bridge"
LOG_DIR="$ROOT_DIR/.logs"
PERSIST_DIR="${MORK_PERSIST_DIR:-${HOME:-$ROOT_DIR}/.mork-stack}"
PERSIST_ENV_FILE="$PERSIST_DIR/mork-app/.env.local"
PERSIST_SHERPA_CREDS_FILE="$PERSIST_DIR/services/sherpa/encrypted_credentials.bin"

ARB_PID=""
SHERPA_PID=""
SOL_MEV_BOT_PID=""
TELEGRAM_PID=""

log() { printf "\n[%s] %s\n" "start" "$1"; }
warn() { printf "\n[%s] %s\n" "warn" "$1"; }

is_valid_telegram_bot_token() {
  local token="${1:-}"
  token="${token#bot}"
  [[ "$token" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{20,}$ ]]
}

restore_persistent_state() {
  if [[ -f "$PERSIST_ENV_FILE" && ! -f "$APP_DIR/.env.local" ]]; then
    mkdir -p "$APP_DIR"
    cp "$PERSIST_ENV_FILE" "$APP_DIR/.env.local"
    log "Restored mork-app/.env.local from persistent state ($PERSIST_DIR)"
  fi

  if [[ -f "$PERSIST_SHERPA_CREDS_FILE" && ! -f "$SHERPA_DIR/encrypted_credentials.bin" ]]; then
    mkdir -p "$SHERPA_DIR"
    cp "$PERSIST_SHERPA_CREDS_FILE" "$SHERPA_DIR/encrypted_credentials.bin"
    log "Restored Sherpa encrypted credentials from persistent state ($PERSIST_DIR)"
  fi
}

sync_persistent_state() {
  mkdir -p "$PERSIST_DIR/mork-app" "$PERSIST_DIR/services/sherpa"

  if [[ -f "$APP_DIR/.env.local" ]]; then
    cp "$APP_DIR/.env.local" "$PERSIST_ENV_FILE"
  fi

  if [[ -f "$SHERPA_DIR/encrypted_credentials.bin" ]]; then
    cp "$SHERPA_DIR/encrypted_credentials.bin" "$PERSIST_SHERPA_CREDS_FILE"
  fi
}

cleanup() {
  sync_persistent_state

  if [[ -n "$ARB_PID" ]] && kill -0 "$ARB_PID" >/dev/null 2>&1; then
    log "Stopping arb service (pid=$ARB_PID)"
    kill "$ARB_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SHERPA_PID" ]] && kill -0 "$SHERPA_PID" >/dev/null 2>&1; then
    log "Stopping sherpa service (pid=$SHERPA_PID)"
    kill "$SHERPA_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SOL_MEV_BOT_PID" ]] && kill -0 "$SOL_MEV_BOT_PID" >/dev/null 2>&1; then
    log "Stopping sol-mev-bot service (pid=$SOL_MEV_BOT_PID)"
    kill "$SOL_MEV_BOT_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TELEGRAM_PID" ]] && kill -0 "$TELEGRAM_PID" >/dev/null 2>&1; then
    log "Stopping telegram bridge (pid=$TELEGRAM_PID)"
    kill "$TELEGRAM_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if [[ ! -d "$APP_DIR" ]]; then
  echo "[error] Unable to locate mork-app at $APP_DIR" >&2
  exit 1
fi

restore_persistent_state

log "Bootstrapping local dependencies"
"$ROOT_DIR/setup.sh"
mkdir -p "$LOG_DIR"
sync_persistent_state

if [[ -f "$APP_DIR/.env.local" ]]; then
  log "Loading environment from mork-app/.env.local"
  set -a
  # shellcheck disable=SC1090
  source "$APP_DIR/.env.local"
  set +a
else
  log "No mork-app/.env.local found; continuing with current environment"
fi

export MORK_CORE_URL="${MORK_CORE_URL:-http://127.0.0.1:3000}"
log "Using MORK_CORE_URL=$MORK_CORE_URL"

if [[ -d "$ARB_DIR" ]]; then
  if [[ ! -d "$ARB_DIR/node_modules" ]]; then
    log "Installing arb dependencies"
    npm --prefix "$ARB_DIR" install
  fi

  log "Starting arb service"
  (
    cd "$ARB_DIR"
    node index.js >>"$LOG_DIR/arb.log" 2>&1
  ) & 
  ARB_PID=$!
  sleep 1
  if ! kill -0 "$ARB_PID" >/dev/null 2>&1; then
    warn "Arb exited immediately. Check $LOG_DIR/arb.log"
  fi
else
  log "Skipping arb service startup (missing $ARB_DIR)"
fi

if [[ -d "$SOL_MEV_BOT_DIR" ]]; then
  if [[ ! -d "$SOL_MEV_BOT_DIR/node_modules" ]]; then
    log "Installing sol-mev-bot dependencies"
    npm --prefix "$SOL_MEV_BOT_DIR" install
  fi

  SOL_MEV_CMD="npm run start"
  if [[ ! -f "$SOL_MEV_BOT_DIR/dist/index.js" ]]; then
    warn "sol-mev-bot dist/index.js missing; using ts-node transpile-only fallback"
    SOL_MEV_CMD="node -r ts-node/register/transpile-only index.ts"
  fi

  log "Starting sol-mev-bot service"
  (
    cd "$SOL_MEV_BOT_DIR"
    bash -lc "$SOL_MEV_CMD" >>"$LOG_DIR/sol-mev-bot.log" 2>&1
  ) &
  SOL_MEV_BOT_PID=$!
  sleep 1
  if ! kill -0 "$SOL_MEV_BOT_PID" >/dev/null 2>&1; then
    warn "Sol-mev-bot exited immediately. Check $LOG_DIR/sol-mev-bot.log"
    if [[ "$SOL_MEV_CMD" == "npm run start" ]]; then
      warn "Retrying sol-mev-bot with ts-node transpile-only fallback"
      (
        cd "$SOL_MEV_BOT_DIR"
        node -r ts-node/register/transpile-only index.ts >>"$LOG_DIR/sol-mev-bot.log" 2>&1
      ) &
      SOL_MEV_BOT_PID=$!
      sleep 1
      if ! kill -0 "$SOL_MEV_BOT_PID" >/dev/null 2>&1; then
        warn "Sol-mev-bot fallback also exited. Check $LOG_DIR/sol-mev-bot.log"
      fi
    fi
  fi
else
  log "Skipping sol-mev-bot service startup (missing $SOL_MEV_BOT_DIR)"
fi

if [[ -x "$SHERPA_DIR/.venv/bin/python" ]]; then
  log "Starting sherpa service"
  (
    cd "$SHERPA_DIR"
    "$SHERPA_DIR/.venv/bin/python" sherpa_bot.py >>"$LOG_DIR/sherpa.log" 2>&1
  ) &
  SHERPA_PID=$!
  sleep 1
  if ! kill -0 "$SHERPA_PID" >/dev/null 2>&1; then
    warn "Sherpa exited immediately. Check $LOG_DIR/sherpa.log"
  fi
else
  log "Skipping sherpa service startup (.venv python not found at $SHERPA_DIR/.venv/bin/python)"
fi

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  if ! is_valid_telegram_bot_token "$TELEGRAM_BOT_TOKEN"; then
    warn "Skipping telegram bridge startup (invalid TELEGRAM_BOT_TOKEN format; expected BotFather token like 123456:ABC...)"
  elif [[ -f "$TELEGRAM_BRIDGE_DIR/bridge.py" ]]; then
    TELEGRAM_PYTHON=""
    if [[ -x "$SHERPA_DIR/.venv/bin/python" ]]; then
      TELEGRAM_PYTHON="$SHERPA_DIR/.venv/bin/python"
    elif command -v python3 >/dev/null 2>&1; then
      TELEGRAM_PYTHON="$(command -v python3)"
    fi

    if [[ -n "$TELEGRAM_PYTHON" ]]; then
      log "Starting telegram bridge (MORK_CORE_URL=$MORK_CORE_URL)"
      (
        cd "$TELEGRAM_BRIDGE_DIR"
        "$TELEGRAM_PYTHON" bridge.py >>"$LOG_DIR/telegram-bridge.log" 2>&1
      ) &
      TELEGRAM_PID=$!
      sleep 1
      if ! kill -0 "$TELEGRAM_PID" >/dev/null 2>&1; then
        warn "Telegram bridge exited immediately. Check $LOG_DIR/telegram-bridge.log"
      fi
    else
      log "Skipping telegram bridge startup (python interpreter not found)"
    fi
  else
    log "Skipping telegram bridge startup (missing $TELEGRAM_BRIDGE_DIR/bridge.py)"
  fi
else
  log "Skipping telegram bridge startup (TELEGRAM_BOT_TOKEN is not set in mork-app/.env.local)"
fi

log "Starting unified app surface (Next.js + embedded control panels)"
cd "$APP_DIR"
npm run dev
