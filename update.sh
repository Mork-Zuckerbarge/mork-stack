#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf "\n[%s] %s\n" "update" "$1"; }
err() { printf "\n[%s] %s\n" "error" "$1"; exit 1; }
warn() { printf "\n[%s] %s\n" "warn" "$1"; }

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

if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
  err "Local changes detected. Commit/stash them before running update.sh so the preview diff is accurate."
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
merge_base="$(git -C "$ROOT_DIR" merge-base HEAD "$upstream")"

log "Branch status"
printf "Current branch     : %s\n" "$current_branch"
printf "Update target      : %s\n" "$upstream"
printf "Local-only commits : %s\n" "$local_only"
printf "Remote-only commits: %s\n" "$remote_only"
if [[ "$current_branch" != "$target_branch" ]]; then
  warn "You are on '$current_branch' but updating against '$upstream'."
  warn "This updates/rebases the current branch; it does not switch branches."
fi

if [[ "$remote_only" -eq 0 ]]; then
  log "No incoming commits from $upstream"
  if [[ "$local_only" -gt 0 ]]; then
    warn "Your current branch has local commits that are not on $upstream. Nothing to pull."
    warn "If you meant to update local main, run: git switch main && ./update.sh main"
  fi
  start_stack_if_available
  exit 0
fi

log "Incoming commits from $upstream"
git -C "$ROOT_DIR" log --oneline --decorate HEAD.."$upstream" || true

log "Full incoming patch ($merge_base..$upstream)"
git -C "$ROOT_DIR" diff --patch "$merge_base".."$upstream" --

if [[ "$local_only" -eq 0 ]]; then
  printf "\nApply these changes with a fast-forward update? [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      log "Fast-forwarding $current_branch from $upstream"
      if ! git -C "$ROOT_DIR" merge --ff-only "$upstream"; then
        print_auth_help
        exit 1
      fi
      ;;
    *)
      err "Update cancelled."
      ;;
  esac
else
  warn "$current_branch and $upstream have diverged, so git pull --ff-only cannot work."
  warn "Local commits that would be replayed:"
  git -C "$ROOT_DIR" log --oneline --decorate "$upstream"..HEAD || true
  printf "\nRebase your local commits on top of %s? [y/N] " "$upstream"
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      log "Rebasing $current_branch onto $upstream"
      if ! git -C "$ROOT_DIR" rebase "$upstream"; then
        warn "Rebase stopped due to conflicts. Resolve files, then run: git rebase --continue"
        warn "To abandon the rebase, run: git rebase --abort"
        exit 1
      fi
      ;;
    *)
      warn "Update cancelled because the branch diverged."
      warn "Options: run 'git rebase $upstream', run 'git merge --no-ff $upstream', or inspect with 'git log --oneline --left-right HEAD...$upstream'."
      warn "If you meant to update local main instead, run: git switch main && ./update.sh main"
      exit 1
      ;;
  esac
fi

start_stack_if_available
