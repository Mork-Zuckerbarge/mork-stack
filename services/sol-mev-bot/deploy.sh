#!/usr/bin/env bash
# deploy.sh — set up and launch the MEV agent on a fresh Linux server
# Tested on Ubuntu 22.04 / Debian 12
set -euo pipefail

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Solana MEV Agent — Deployment Script"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Prerequisites ─────────────────────────────────────────────────────────────

if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v rustup &>/dev/null; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

rustup override set stable

# ── Build ─────────────────────────────────────────────────────────────────────

echo ""
echo "Building Node.js agent..."
npm install
npm run build

echo ""
echo "Building Rust engine..."
(cd rust-engine && cargo build --release)
echo "Rust build complete: rust-engine/target/release/mev-engine"

# ── Config check ──────────────────────────────────────────────────────────────

if [[ ! -f .env ]]; then
  echo ""
  echo "ERROR: .env file not found."
  echo "Run: cp config/.env.example .env && nano .env"
  exit 1
fi

source .env

if [[ -z "${WALLET_PRIVATE_KEY:-}" ]]; then
  echo "ERROR: WALLET_PRIVATE_KEY not set in .env"
  exit 1
fi

if [[ -z "${HELIUS_API_KEY:-}" ]]; then
  echo "ERROR: HELIUS_API_KEY not set in .env"
  exit 1
fi

# ── Dry run test ──────────────────────────────────────────────────────────────

echo ""
echo "Running 30-second dry-run validation..."
DRY_RUN=true timeout 30 npm start || true
echo "Dry-run complete — check logs/agent.log for output."

# ── systemd service (optional) ────────────────────────────────────────────────

read -rp "Install as systemd service? [y/N] " INSTALL_SERVICE
if [[ "${INSTALL_SERVICE,,}" == "y" ]]; then
  AGENT_DIR="$(pwd)"
  AGENT_USER="$(whoami)"

  sudo tee /etc/systemd/system/solana-mev-agent.service > /dev/null <<EOF
[Unit]
Description=Solana MEV Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${AGENT_USER}
WorkingDirectory=${AGENT_DIR}
EnvironmentFile=${AGENT_DIR}/.env
ExecStart=/usr/bin/node ${AGENT_DIR}/dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:${AGENT_DIR}/logs/stdout.log
StandardError=append:${AGENT_DIR}/logs/stderr.log

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable solana-mev-agent
  echo ""
  echo "Service installed. Commands:"
  echo "  sudo systemctl start solana-mev-agent    # start"
  echo "  sudo systemctl status solana-mev-agent   # status"
  echo "  sudo journalctl -u solana-mev-agent -f   # live logs"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete. To run:"
echo ""
echo "  Dry run:  npm run dry-run"
echo "  Live:     DRY_RUN=false npm start"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
