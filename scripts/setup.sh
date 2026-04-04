#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/mork-app"
ENV_FILE="$APP_DIR/.env.local"
ENV_TEMPLATE="$APP_DIR/env.example"

log() { printf "\n[%s] %s\n" "setup" "$1"; }
warn() { printf "\n[%s] %s\n" "warn" "$1"; }
err() { printf "\n[%s] %s\n" "error" "$1"; exit 1; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
  fi
}

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=\"${value}\"|" "$ENV_FILE"
  else
    printf '%s="%s"\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

create_wallet_if_missing() {
  if grep -qE '^MORK_WALLET=".+"' "$ENV_FILE" || grep -qE '^MORK_WALLET_SECRET_KEY="\[[0-9, ]+\]"' "$ENV_FILE"; then
    log "Wallet already configured in $ENV_FILE"
    return
  fi

  local wallet_mode="${MORK_SETUP_WALLET_MODE:-auto}"
  local default_import_path=""
  if [[ -n "${HOME:-}" ]]; then
    default_import_path="$HOME/.config/solana/id.json"
  fi
  local import_path="${MORK_WALLET_IMPORT_PATH:-$default_import_path}"

  if [[ "$wallet_mode" == "import" || "$wallet_mode" == "auto" ]]; then
    if [[ -n "$import_path" && -f "$import_path" ]]; then
      log "No wallet configured. Importing Solana keypair from $import_path."
      local imported_key_json
      imported_key_json=$(cat "$import_path")
      local imported_address
      imported_address=$(
        cd "$APP_DIR"
        node -e "const { Keypair } = require('@solana/web3.js'); const secret = Uint8Array.from(JSON.parse(process.argv[1])); process.stdout.write(Keypair.fromSecretKey(secret).publicKey.toBase58());" "$imported_key_json"
      )
      upsert_env "MORK_WALLET_SECRET_KEY" "$imported_key_json"
      log "Imported wallet ${imported_address}. Secret key was written to mork-app/.env.local (local-only)."
      return
    fi

    if [[ "$wallet_mode" == "import" ]]; then
      err "MORK_SETUP_WALLET_MODE=import was set but no wallet file was found at ${import_path:-<empty path>}"
    fi
  fi

  log "No wallet configured. Creating a new local Solana keypair for development."

  local key_json
  key_json=$(
    cd "$APP_DIR"
    node -e "const { Keypair } = require('@solana/web3.js'); const kp = Keypair.generate(); process.stdout.write(JSON.stringify(Array.from(kp.secretKey)));"
  )
  local address
  address=$(
    cd "$APP_DIR"
    node -e "const { Keypair } = require('@solana/web3.js'); const secret = Uint8Array.from(JSON.parse(process.argv[1])); process.stdout.write(Keypair.fromSecretKey(secret).publicKey.toBase58());" "$key_json"
  )

  upsert_env "MORK_WALLET_SECRET_KEY" "$key_json"
  log "Created wallet ${address}. Secret key was written to mork-app/.env.local (local-only)."
}

pull_model() {
  local host="$1"
  local model="$2"

  if command -v ollama >/dev/null 2>&1; then
    OLLAMA_HOST="$host" ollama pull "$model"
    return
  fi

  curl --fail --silent --show-error "$host/api/pull" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$model\",\"stream\":false}" >/dev/null
}

verify_ollama() {
  local host="$1"
  local model="$2"

  if ! curl --silent --fail "$host/api/tags" >/dev/null; then
    warn "Ollama is not reachable at $host."
    warn "Start Ollama and re-run setup. If using Docker: docker compose up -d ollama"
    return 1
  fi

  log "Ollama reachable at $host. Pulling model $model"
  pull_model "$host" "$model"
  log "Model ensured: $model"
}

setup_sherpa() {
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found; skipping Sherpa dependency bootstrap"
    return
  fi

  if [[ "${MORK_SETUP_SKIP_SHERPA:-}" == "1" ]]; then
    warn "Skipping Sherpa dependency bootstrap (MORK_SETUP_SKIP_SHERPA=1)"
    return
  fi

  log "Setting up Sherpa Python virtualenv"
  if ! python3 -m venv "$ROOT_DIR/services/sherpa/.venv"; then
    warn "Failed to create Sherpa virtualenv; continuing setup without Sherpa bootstrap"
    return
  fi

  if ! "$ROOT_DIR/services/sherpa/.venv/bin/pip" install --upgrade pip >/dev/null; then
    warn "Failed to upgrade pip for Sherpa virtualenv; continuing setup"
    return
  fi

  if ! "$ROOT_DIR/services/sherpa/.venv/bin/pip" install -r "$ROOT_DIR/services/sherpa/requirements.txt" >/dev/null; then
    warn "Failed to install Sherpa requirements (likely network/proxy); continuing setup"
    return
  fi

  log "Sherpa dependencies installed in services/sherpa/.venv"
}

main() {
  require_cmd node
  require_cmd npm
  require_cmd curl

  if [[ ! -f "$ENV_TEMPLATE" ]]; then
    err "Missing env template: $ENV_TEMPLATE"
  fi

  log "Installing npm dependencies for mork-app"
  npm --prefix "$APP_DIR" install

  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$ENV_TEMPLATE" "$ENV_FILE"
    log "Created $ENV_FILE from template"
  else
    log "Using existing $ENV_FILE"
  fi

  create_wallet_if_missing

  log "Running Prisma generate + db push"
  (
    cd "$APP_DIR"
    npm exec prisma generate
    npm exec prisma db push
  )

  local ollama_host
  ollama_host=$(awk -F'=' '/^OLLAMA_HOST=/{gsub(/"/,"",$2); print $2}' "$ENV_FILE")
  local ollama_model
  ollama_model=$(awk -F'=' '/^OLLAMA_MODEL=/{gsub(/"/,"",$2); print $2}' "$ENV_FILE")
  ollama_host=${ollama_host:-http://127.0.0.1:11434}
  ollama_model=${ollama_model:-llama3.2:3b}

  verify_ollama "$ollama_host" "$ollama_model" || true
  setup_sherpa

  cat <<MSG

Setup complete.
Next steps:
  1) Review mork-app/.env.local
  2) Start app: cd mork-app && npm run dev
  3) Optional full stack: docker compose up
MSG
}

main "$@"
