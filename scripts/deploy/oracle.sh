#!/usr/bin/env bash
# Deploy Strike to a fresh Oracle Cloud Ubuntu VM (Always Free, x86 or Ampere ARM).
#
# Run from the repo root on your machine:
#   scripts/deploy/oracle.sh ubuntu@<public-ip> [~/.ssh/oracle_strike]
#
# Copies the repo (git archive of HEAD) and .env.local to the VM, builds the
# Rust backend and the Next frontend with Node 22, runs both under systemd
# (Next on :3000, Rust on 127.0.0.1:8080) and puts Caddy in front of Next with
# an automatic HTTPS cert for <ip>.sslip.io (wallets need a secure origin).
#
# The ledger is SQLite at /var/lib/strike, outside the release tree, so a
# redeploy never touches it. scripts/deploy/data.sh does all work on that file:
# it creates the DB only when there is none and takes an online backup before
# the binary changes. One backend process only: SQLite is local, one writer.
# Litestream replicates off the machine when LITESTREAM_REPLICA_URL is set.
# Operations: docs/OPERATIONS.md.
#
# Caddy only ever talks to Next; Next rewrites /api/* to the Rust service
# because BACKEND_URL is exported before `next build` (the rewrite is baked
# into the routes manifest at build time). The Rust port stays on loopback.
# Re-run to redeploy. Open TCP 80/443 in the VCN security list first.
set -euo pipefail

HOST="${1:?usage: oracle.sh ubuntu@<ip> [ssh-key]}"
KEY="${2:-$HOME/.ssh/oracle_strike}"
IP="${HOST#*@}"
DOMAIN="${DOMAIN:-$IP.sslip.io}"
BACKEND_URL="http://127.0.0.1:8080"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST")

[ -f .env.local ] || { echo ".env.local missing"; exit 1; }

echo "→ shipping code to $HOST"
git archive --format=tar.gz HEAD | "${SSH[@]}" 'rm -rf ~/strike.new && mkdir -p ~/strike.new && tar -xzf - -C ~/strike.new'
# BACKEND_URL is deliberately not written to the shipped .env: the build uses
# the exported value below and the systemd unit sets it explicitly, so a stale
# local value cannot leak into production (or survive a rollback). filter-env
# drops it, DATABASE_URL and every other key the units own.
scripts/deploy/data.sh filter-env < .env.local \
  | sed "s#^NEXT_PUBLIC_APP_URL=.*#NEXT_PUBLIC_APP_URL=https://$DOMAIN#" \
  | "${SSH[@]}" 'cat > ~/strike.new/.env.local && chmod 600 ~/strike.new/.env.local'

echo "→ provisioning + building on the VM"
"${SSH[@]}" DOMAIN="$DOMAIN" BACKEND_URL="$BACKEND_URL" bash -s <<'REMOTE'
set -euo pipefail

# --- toolchains -------------------------------------------------------------
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Rust lives in $HOME/.cargo; checking the binary directly keeps this
# idempotent even though a non-login shell has not sourced the env yet.
if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  echo "→ installing Rust toolchain"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile default
fi
. "$HOME/.cargo/env"
command -v cargo >/dev/null || { echo "✗ rustup did not provide cargo"; exit 1; }

# ring/rustls need a C compiler; minimal OCI images do not always ship one.
# sqlite3 is the online backup and integrity check.
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
# Ubuntu images on OCI ship iptables rules that drop 80/443 even when the VCN allows them.
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport $p -j ACCEPT
done
sudo netfilter-persistent save 2>/dev/null || true

# Small VMs run out of memory during `next build`/`cargo build`; add swap once.
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

cd ~/strike.new
npm ci --no-audit --no-fund

# Next bakes rewrites() into .next/routes-manifest.json at build time, so the
# proxy target must be in the environment for the build, not just at runtime.
export BACKEND_URL
npm run build

echo "→ building the Rust backend (release)"
cargo build --release --locked --manifest-path backend/Cargo.toml -p server
[ -x "$HOME/strike.new/backend/target/release/strike-backend" ] \
  || { echo "✗ cargo build produced no strike-backend binary"; exit 1; }

# Everything above can fail without consequence. From here on the live system
# changes, and the backup comes first: if it fails, nothing is replaced.
DATA=/opt/strike/bin/strike-data
BIN=/opt/strike/bin/strike-backend
sudo install -D -m 755 scripts/deploy/data.sh "$DATA"
sudo ln -sf "$DATA" /usr/local/bin/strike-data
sudo "$DATA" prepare
sudo "$DATA" install-litestream
sudo "$DATA" install-env .env.local
sudo "$DATA" init db/schema.sqlite.sql
sudo "$DATA" backup

sudo install -m 644 scripts/deploy/strike-backend.service scripts/deploy/strike-litestream.service /etc/systemd/system/
sudo install -m 644 scripts/deploy/litestream.yml /etc/strike/litestream.yml
if [ -x "$BIN" ]; then sudo cp -p "$BIN" "$BIN.prev"; fi
sudo install -m 755 backend/target/release/strike-backend "$BIN"

cd ~
rm -rf ~/strike && mv ~/strike.new ~/strike

sudo tee /etc/systemd/system/strike.service >/dev/null <<UNIT
[Unit]
Description=Strike
After=network.target strike-backend.service
Wants=strike-backend.service

[Service]
User=$USER
WorkingDirectory=$HOME/strike
Environment=NODE_ENV=production PORT=3000
Environment=BACKEND_URL=http://127.0.0.1:8080
# Loopback only: a client reaching Next directly could write its own
# x-forwarded-for, and the Rust rate limiter trusts what comes through Next.
ExecStart=$(command -v npm) start -- -H 127.0.0.1
Restart=always

[Install]
WantedBy=multi-user.target
UNIT

# Caddy fronts Next only. The API reaches the browser through Next's rewrite,
# so the Rust port is never exposed. With no trusted_proxies, Caddy replaces any
# x-forwarded-for a client sends, which is the rule the rate limiter relies on.
echo "$DOMAIN {
  reverse_proxy 127.0.0.1:3000 {
    # /api/prices/stream is SSE; never buffer it anywhere in the chain.
    flush_interval -1
  }
}" | sudo tee /etc/caddy/Caddyfile >/dev/null

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
# Backend first: Next answers /api/* by proxying to it.
sudo systemctl restart strike-backend
healthy http://127.0.0.1:8080/api/health strike-backend
sudo systemctl restart strike-litestream
sudo systemctl restart strike
# Through Next, which also proves BACKEND_URL was baked into the build.
healthy http://127.0.0.1:3000/api/health strike
sudo systemctl restart caddy
systemctl is-active --quiet strike-backend strike \
  || { echo "✗ strike-backend/strike are not both active"; exit 1; }
REMOTE

echo "→ live at https://$DOMAIN (API → $BACKEND_URL)"
