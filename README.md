# mork-stack

## Fresh Ubuntu quickstart (one command)

Use this single command on a fresh Ubuntu machine to install dependencies, clone the repo, bootstrap, build, and launch:

```bash
bash -lc '\nset -euo pipefail; \
sudo apt-get update; \
sudo apt-get install -y git curl ca-certificates nodejs npm python3 python3-venv; \
REPO_DIR="$HOME/mork-stack"; \
if [ ! -d "$REPO_DIR/.git" ]; then git clone https://github.com/mork-ai/mork-stack.git "$REPO_DIR"; fi; \
cd "$REPO_DIR"; \
./setup.sh; \
(cd mork-app && npm run build); \
./start.sh\n'
```

> `./start.sh` runs in the foreground to keep services alive.

## Updating without deleting local state

Do **not** remove/re-clone the repo for normal updates. Use:

```bash
cd ~/mork-stack
./update.sh
```

`./update.sh` does a fast-forward `git pull` on your current branch, then runs `./start.sh`.
This keeps local runtime files in place and works with the persistent credential sync in `start.sh`.
If local changes exist, `./update.sh` auto-stashes them before pulling and then restores them after update.

## Repo guide

- App/runtime docs: [`mork-app/README.md`](mork-app/README.md)
- Sherpa module docs: [`services/sherpa/README.md`](services/sherpa/README.md)
