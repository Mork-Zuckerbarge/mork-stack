#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf "\n[%s] %s\n" "update" "$1"; }
err() { printf "\n[%s] %s\n" "error" "$1"; exit 1; }
warn() { printf "\n[%s] %s\n" "warn" "$1"; }

print_change_summary() {
  local from_ref="$1"
  local to_ref="$2"

  log "Incoming changes"
  git -C "$ROOT_DIR" log --oneline --decorate "$from_ref".."$to_ref" || true

  log "Changed files"
  git -C "$ROOT_DIR" diff --stat "$from_ref".."$to_ref" -- || true
}

print_auth_help() {
  local remote_url
  remote_url="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
  warn "Git auth failed while fetching/pulling from origin."
  if [[ "$remote_url" == https://github.com/* ]]; then
    warn "Current origin: $remote_url"
    warn "Use a GitHub PAT with your credential helper, switch origin to SSH, or run gh auth login."
  fi
}

start_stack_if_available() {
  if [[ -x "$ROOT_DIR/start.sh" ]]; then
    log "Starting stack with preserved local credentials/env"
    "$ROOT_DIR/start.sh"
  else
    log "Update complete. No executable start.sh found; skipping startup."
  fi
}

if [[ ! -d "$ROOT_DIR/.git" ]]; then
  err "No git repository found at $ROOT_DIR"
fi

current_branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
if [[ -z "$current_branch" || "$current_branch" == "HEAD" ]]; then
  err "Unable to determine current branch."
fi

target_branch="${1:-$current_branch}"
if [[ -z "$target_branch" || "$target_branch" == "HEAD" ]]; then
  err "Invalid update target branch: '$target_branch'"
fi

has_local_changes=0
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
  has_local_changes=1
  warn "Local changes detected; preserving them while updating."
fi

log "Fetching latest changes from origin"
if ! git -C "$ROOT_DIR" fetch --prune origin; then
  print_auth_help
  exit 1
fi

upstream="origin/$target_branch"
if ! git -C "$ROOT_DIR" rev-parse --verify --quiet "$upstream" >/dev/null; then
  err "No remote branch found at $upstream"
fi

read -r local_only remote_only < <(git -C "$ROOT_DIR" rev-list --left-right --count HEAD..."$upstream")

log "Branch status"
printf "Current branch : %s\n" "$current_branch"
printf "Update target  : %s\n" "$upstream"
printf "Local commits  : %s\n" "$local_only"
printf "New commits    : %s\n" "$remote_only"
if [[ "$current_branch" != "$target_branch" ]]; then
  warn "You are on '$current_branch' but updating against '$upstream'."
  warn "This updates the current branch; it does not switch branches."
fi

if [[ "$remote_only" -eq 0 ]]; then
  log "Already up to date with $upstream"
  if [[ "$local_only" -gt 0 ]]; then
    warn "Your current branch has local commits that are not on $upstream. Nothing to pull."
    warn "If you meant to update local main, run: git switch main && ./update.sh main"
  fi
  start_stack_if_available
  exit 0
fi

print_change_summary "HEAD" "$upstream"

if [[ "$local_only" -gt 0 ]]; then
  warn "$current_branch and $upstream have diverged, so this script will not auto-update."
  warn "Local commits:"
  git -C "$ROOT_DIR" log --oneline --decorate "$upstream"..HEAD || true
  warn "Resolve manually later with: git rebase $upstream"
  warn "Starting the current local app without updating."
  start_stack_if_available
  exit 0
fi

log "Fast-forwarding $current_branch from $upstream"
merge_args=(--ff-only)
if [[ "$has_local_changes" -eq 1 ]]; then
  merge_args+=(--autostash)
fi
if ! git -C "$ROOT_DIR" merge "${merge_args[@]}" "$upstream"; then
  warn "Update could not be applied automatically; local files were left alone."
  warn "Starting the current local app without updating."
  start_stack_if_available
  exit 0
fi

start_stack_if_available
