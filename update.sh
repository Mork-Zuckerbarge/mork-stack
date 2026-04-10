#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf "\n[%s] %s\n" "update" "$1"; }
err() { printf "\n[%s] %s\n" "error" "$1"; exit 1; }
warn() { printf "\n[%s] %s\n" "warn" "$1"; }

if [[ ! -d "$ROOT_DIR/.git" ]]; then
  err "No git repository found at $ROOT_DIR"
fi

current_branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
if [[ -z "$current_branch" || "$current_branch" == "HEAD" ]]; then
  err "Unable to determine current branch."
fi

STASHED=0
STASH_NAME=""
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
  STASH_NAME="update.sh-auto-stash-$(date +%s)"
  log "Detected local changes; stashing them as '$STASH_NAME'"
  git -C "$ROOT_DIR" stash push -u -m "$STASH_NAME" >/dev/null
  STASHED=1
fi

log "Fetching latest changes from origin"
git -C "$ROOT_DIR" fetch --prune origin

log "Fast-forwarding $current_branch from origin/$current_branch"
git -C "$ROOT_DIR" pull --ff-only origin "$current_branch"

if [[ "$STASHED" -eq 1 ]]; then
  log "Restoring stashed local changes"
  if ! git -C "$ROOT_DIR" stash pop --index >/dev/null; then
    warn "Could not auto-apply stashed changes cleanly."
    warn "Resolve conflicts, then run: git stash list"
  fi
fi

log "Starting stack with preserved local credentials/env"
"$ROOT_DIR/start.sh"