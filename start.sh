#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/mork-app"
ARB_DIR="$ROOT_DIR/services/arb"
SHERPA_DIR="$ROOT_DIR/services/sherpa"

ARB_PID=""
SHERPA_PID=""

log() { printf "\n[%s] %s\n" "start" "$1"; }

cleanup() {
  if [[ -n "$ARB_PID" ]] && kill -0 "$ARB_PID" >/dev/null 2>&1; then
    log "Stopping arb service (pid=$ARB_PID)"
    kill "$ARB_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SHERPA_PID" ]] && kill -0 "$SHERPA_PID" >/dev/null 2>&1; then
    log "Stopping sherpa service (pid=$SHERPA_PID)"
    kill "$SHERPA_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if [[ ! -d "$APP_DIR" ]]; then
  echo "[error] Unable to locate mork-app at $APP_DIR" >&2
  exit 1
fi

log "Bootstrapping local dependencies"
"$ROOT_DIR/setup.sh"

if [[ -f "$APP_DIR/.env.local" ]]; then
  log "Loading environment from mork-app/.env.local"
  set -a
  # shellcheck disable=SC1090
  source "$APP_DIR/.env.local"
  set +a
else
  log "No mork-app/.env.local found; continuing with current environment"
fi

if [[ -d "$ARB_DIR" ]]; then
  if [[ ! -d "$ARB_DIR/node_modules" ]]; then
    log "Installing arb dependencies"
    npm --prefix "$ARB_DIR" install
  fi

  log "Starting arb service"
  (
    cd "$ARB_DIR"
    node index.js
  ) &
  ARB_PID=$!
else
  log "Skipping arb service startup (missing $ARB_DIR)"
fi

if [[ -x "$SHERPA_DIR/.venv/bin/python" ]]; then
  log "Starting sherpa service"
  (
    cd "$SHERPA_DIR"
    "$SHERPA_DIR/.venv/bin/python" sherpa_bot.py
  ) &
  SHERPA_PID=$!
else
  log "Skipping sherpa service startup (.venv python not found at $SHERPA_DIR/.venv/bin/python)"
fi

log "Starting unified app surface (Next.js + embedded control panels)"
cd "$APP_DIR"
npm run dev
