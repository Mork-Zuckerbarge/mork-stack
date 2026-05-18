## GitHub access

The `gh` CLI is installed and authenticated. Use it for all GitHub operations:

- `gh pr list` — open PRs
- `gh pr view <num> --comments` — read a PR including review comments
- `gh pr diff <num>` — see the diff
- `gh pr checkout <num>` — check out a PR locally
- `gh pr create` — open a new PR (use after pushing a branch)
- `gh issue list` — open issues
- `gh issue view <num>` — read an issue
- `gh repo view --web` — show the repo URL
- `gh api` — anything not covered by the above (e.g., `gh api repos/Mork-Zuckerbarge/mork-stack/branches`)

Always check `gh auth status` if any gh command fails.

When opening a PR, use a descriptive branch name, a clear title, and a body that
explains the why, not just the what. Reference issues with "Closes #N" when relevant.
