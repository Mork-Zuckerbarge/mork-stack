#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/mork-app"

log() { printf "\n[%s] %s\n" "start" "$1"; }

if [[ ! -d "$APP_DIR" ]]; then
  echo "[error] Unable to locate mork-app at $APP_DIR" >&2
  exit 1
fi

log "Bootstrapping local dependencies"
"$ROOT_DIR/setup.sh"

log "Starting unified app surface (Next.js + embedded control panels)"
cd "$APP_DIR"
exec npm run dev
