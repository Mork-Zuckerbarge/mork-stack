#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf "\n[%s] %s\n" "update" "$1"; }
err() { printf "\n[%s] %s\n" "error" "$1"; exit 1; }
warn() { printf "\n[%s] %s\n" "warn" "$1"; }

print_auth_help() {
  local remote_url
  remote_url="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
  warn "Git auth failed while pulling from origin."
  warn "GitHub no longer supports password auth for git over HTTPS."
  if [[ "$remote_url" == https://github.com/* ]]; then
    warn "Current origin: $remote_url"
    warn "Use ONE of these fixes:"
    warn "  1) Use PAT over HTTPS: gh auth login (or set credential helper + PAT)."
    warn "  2) Switch origin to SSH: git remote set-url origin git@github.com:<owner>/<repo>.git"
  fi
}

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
if ! git -C "$ROOT_DIR" fetch --prune origin; then
  print_auth_help
  if [[ "$STASHED" -eq 1 ]]; then
    warn "Your work was stashed as '$STASH_NAME'. Restore later with: git stash pop --index"
  fi
  exit 1
fi

log "Fast-forwarding $current_branch from origin/$current_branch"
if ! git -C "$ROOT_DIR" pull --ff-only origin "$current_branch"; then
  print_auth_help
  if [[ "$STASHED" -eq 1 ]]; then
    warn "Your work was stashed as '$STASH_NAME'. Restore later with: git stash pop --index"
  fi
  exit 1
fi

if [[ "$STASHED" -eq 1 ]]; then
  log "Restoring stashed local changes"
  if ! git -C "$ROOT_DIR" stash pop --index >/dev/null; then
    warn "Could not auto-apply stashed changes cleanly."
    warn "Resolve conflicts, then run: git stash list"
  fi
fi

log "Starting stack with preserved local credentials/env"
"$ROOT_DIR/start.sh"
