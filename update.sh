#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf "\n[%s] %s\n" "update" "$1"; }
err() { printf "\n[%s] %s\n" "error" "$1"; exit 1; }

if [[ ! -d "$ROOT_DIR/.git" ]]; then
  err "No git repository found at $ROOT_DIR"
fi

if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
  err "Uncommitted local changes detected. Commit/stash them before running update.sh."
fi

current_branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
if [[ -z "$current_branch" || "$current_branch" == "HEAD" ]]; then
  err "Unable to determine current branch."
fi

log "Fetching latest changes from origin"
git -C "$ROOT_DIR" fetch --prune origin

log "Fast-forwarding $current_branch from origin/$current_branch"
git -C "$ROOT_DIR" pull --ff-only origin "$current_branch"

log "Starting stack with preserved local credentials/env"
"$ROOT_DIR/start.sh"
