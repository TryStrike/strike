#!/usr/bin/env bash
# Deploy Strike to a fresh Oracle Cloud Ubuntu VM (Always Free, x86 or Ampere ARM).
#
# Run from the repo root on your machine:
#   scripts/deploy/oracle.sh ubuntu@<public-ip> [~/.ssh/oracle_strike]
#
# Copies the repo (git archive of HEAD) and .env.local to the VM, builds with
# Node 22, runs it under systemd on :3000 and puts Caddy in front with an
# automatic HTTPS cert for <ip>.sslip.io (wallets need a secure origin).
# Re-run to redeploy. Open TCP 80/443 in the VCN security list first.
set -euo pipefail

HOST="${1:?usage: oracle.sh ubuntu@<ip> [ssh-key]}"
KEY="${2:-$HOME/.ssh/oracle_strike}"
IP="${HOST#*@}"
DOMAIN="${DOMAIN:-$IP.sslip.io}"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST")

[ -f .env.local ] || { echo ".env.local missing"; exit 1; }

echo "→ shipping code to $HOST"
git archive --format=tar.gz HEAD | "${SSH[@]}" 'rm -rf ~/strike.new && mkdir -p ~/strike.new && tar -xzf - -C ~/strike.new'
sed "s#^NEXT_PUBLIC_APP_URL=.*#NEXT_PUBLIC_APP_URL=https://$DOMAIN#" .env.local \
  | "${SSH[@]}" 'cat > ~/strike.new/.env.local && chmod 600 ~/strike.new/.env.local'

echo "→ provisioning + building on the VM"
"${SSH[@]}" DOMAIN="$DOMAIN" bash -s <<'REMOTE'
set -euo pipefail
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
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

# Small VMs run out of memory during `next build`; add swap once.
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

cd ~/strike.new
npm ci --no-audit --no-fund
npm run build
rm -rf ~/strike && mv ~/strike.new ~/strike

sudo tee /etc/systemd/system/strike.service >/dev/null <<UNIT
[Unit]
Description=Strike
After=network.target
[Service]
User=$USER
WorkingDirectory=$HOME/strike
Environment=NODE_ENV=production PORT=3000
ExecStart=$(command -v npm) start
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
echo "$DOMAIN {
  reverse_proxy localhost:3000
}" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now strike
sudo systemctl restart strike caddy
REMOTE

echo "→ live at https://$DOMAIN"
