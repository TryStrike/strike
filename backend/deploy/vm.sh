#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?usage: vm.sh ubuntu@<ip> [ssh-key]}"
KEY="${2:-$HOME/.ssh/strike_vm}"
IP="${HOST#*@}"
DOMAIN="${DOMAIN:-$IP.sslip.io}"
BACKEND_URL="http://127.0.0.1:8080"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST")

ENV_FILE="${ENV_FILE:-.env.local}"
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE missing"; exit 1; }

echo "→ shipping code to $HOST"
git -c core.autocrlf=false archive --format=tar.gz HEAD | "${SSH[@]}" 'rm -rf ~/strike.new && mkdir -p ~/strike.new && tar -xzf - -C ~/strike.new'
backend/deploy/data.sh filter-env < "$ENV_FILE" \
  | sed "s#^NEXT_PUBLIC_APP_URL=.*#NEXT_PUBLIC_APP_URL=https://$DOMAIN#" \
  | "${SSH[@]}" 'cat > ~/strike.new/.env.local && chmod 600 ~/strike.new/.env.local'

echo "→ provisioning + building on the VM"
"${SSH[@]}" DOMAIN="$DOMAIN" BACKEND_URL="$BACKEND_URL" bash -s <<'REMOTE'
set -euo pipefail

if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  echo "→ installing Rust toolchain"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile default
fi
. "$HOME/.cargo/env"
command -v cargo >/dev/null || { echo "✗ rustup did not provide cargo"; exit 1; }

if ! dpkg -s build-essential sqlite3 >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y build-essential sqlite3
fi

if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update && sudo apt-get install -y caddy
fi
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport $p -j ACCEPT
done
sudo netfilter-persistent save 2>/dev/null || true

if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

cd ~/strike.new/frontend
npm ci --no-audit --no-fund

export BACKEND_URL
npm run build
cd ~/strike.new

echo "→ building the Rust backend (release)"
# Outside ~/strike.new, so dependencies stay compiled between deploys.
export CARGO_TARGET_DIR="$HOME/.cache/strike-target"
cargo build --release --locked --manifest-path backend/Cargo.toml -p server
[ -x "$CARGO_TARGET_DIR/release/strike-backend" ] \
  || { echo "✗ cargo build produced no strike-backend binary"; exit 1; }

DATA=/opt/strike/bin/strike-data
BIN=/opt/strike/bin/strike-backend
sudo install -D -m 755 backend/deploy/data.sh "$DATA"
sudo ln -sf "$DATA" /usr/local/bin/strike-data
sudo "$DATA" prepare
sudo "$DATA" install-litestream
sudo "$DATA" install-env .env.local
sudo "$DATA" init backend/schema.sql
sudo "$DATA" backup

sudo install -m 644 backend/deploy/strike-backend.service backend/deploy/strike-litestream.service /etc/systemd/system/
sudo install -m 644 backend/deploy/litestream.yml /etc/strike/litestream.yml
if [ -x "$BIN" ]; then sudo cp -p "$BIN" "$BIN.prev"; fi
sudo install -m 755 "$CARGO_TARGET_DIR/release/strike-backend" "$BIN"
# The cache only grows (old dependency versions stay behind), so past 4 GB it
# starts over. The binary is already installed; the next deploy rebuilds it.
if [ "$(du -sm "$CARGO_TARGET_DIR" | cut -f1)" -gt 4096 ]; then rm -rf "$CARGO_TARGET_DIR"; fi

cd ~
rm -rf ~/strike && mv ~/strike.new ~/strike

sudo tee /etc/systemd/system/strike.service >/dev/null <<UNIT
[Unit]
Description=Strike
After=network.target strike-backend.service
Wants=strike-backend.service

[Service]
User=$USER
WorkingDirectory=$HOME/strike/frontend
Environment=NODE_ENV=production PORT=3000
Environment=BACKEND_URL=http://127.0.0.1:8080
ExecStart=$(command -v npm) start -- -H 127.0.0.1
Restart=always

[Install]
WantedBy=multi-user.target
UNIT

echo "$DOMAIN {
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
import /etc/caddy/sites/*.caddy" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo mkdir -p /etc/caddy/sites

healthy() {
  url="$1"; unit="$2"
  sudo "$DATA" health "$url" && return 0
  sudo systemctl status "$unit" --no-pager >&2 || true
  sudo journalctl -u "$unit" -n 50 --no-pager >&2 || true
  echo "✗ deploy failed. To roll the binary back: docs/OPERATIONS.md" >&2
  return 1
}

sudo systemctl daemon-reload
sudo systemctl enable strike-backend strike-litestream strike >/dev/null
sudo "$DATA" drain
sudo systemctl restart strike-backend
healthy http://127.0.0.1:8080/api/health strike-backend
sudo systemctl restart strike-litestream
sudo systemctl restart strike
healthy http://127.0.0.1:3000/api/health strike
sudo systemctl restart caddy
systemctl is-active --quiet strike-backend strike \
  || { echo "✗ strike-backend/strike are not both active"; exit 1; }
REMOTE

echo "→ live at https://$DOMAIN (API → $BACKEND_URL)"
