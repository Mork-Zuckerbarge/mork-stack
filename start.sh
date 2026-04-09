#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/mork-app"
ARB_DIR="$ROOT_DIR/services/arb"
SHERPA_DIR="$ROOT_DIR/services/sherpa"
TELEGRAM_BRIDGE_DIR="$ROOT_DIR/services/telegram-bridge"
LOG_DIR="$ROOT_DIR/.logs"

ARB_PID=""
SHERPA_PID=""
TELEGRAM_PID=""

log() { printf "\n[%s] %s\n" "start" "$1"; }
warn() { printf "\n[%s] %s\n" "warn" "$1"; }

cleanup() {
  if [[ -n "$ARB_PID" ]] && kill -0 "$ARB_PID" >/dev/null 2>&1; then
    log "Stopping arb service (pid=$ARB_PID)"
    kill "$ARB_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SHERPA_PID" ]] && kill -0 "$SHERPA_PID" >/dev/null 2>&1; then
    log "Stopping sherpa service (pid=$SHERPA_PID)"
    kill "$SHERPA_PID" >/dev/null 2>&1 || true
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

log "Bootstrapping local dependencies"
"$ROOT_DIR/setup.sh"
mkdir -p "$LOG_DIR"

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
  if [[ -f "$TELEGRAM_BRIDGE_DIR/bridge.py" ]]; then
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
