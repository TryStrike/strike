#!/usr/bin/env bash
# Harness for concurrency.mjs: a release backend on a throwaway ledger, with the
# stub (stub.mjs) as its chain and its market. Secrets are random and local.
# Usage: servers.sh setup|reset|start|stop|stop-all
#
# It runs from $WORK, outside the repo, so no env file can reach it. Ports 3000 and
# 3001 are never touched, and only pids this script recorded are killed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export BENCH_WORK="${BENCH_WORK:-${TMPDIR:-/tmp}/strike-bench}"
WORK="$BENCH_WORK"
ENV_FILE="$HERE/.env.bench"
API_PORT=4400 STUB_PORT=4300
mkdir -p "$WORK/logs" "$WORK/pids"

load_env() { set -a; . "$ENV_FILE"; set +a; }

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_http() {
  local url="$1" i
  for i in $(seq 1 3000); do
    curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null && return 0
    sleep 0.02
  done
  echo "timeout waiting for $url" >&2; return 1
}

gen_env() {
  [ -f "$ENV_FILE" ] && return 0
  # Throwaway only: this key has never held funds and is regenerated per checkout.
  local key treasury fee
  key="0x$(openssl rand -hex 32)"
  treasury="$(cd "$ROOT" && node -e "console.log(new (require('ethers').Wallet)('$key').address)")"
  fee="0x$(openssl rand -hex 20)"
  cat > "$ENV_FILE" <<EOF
BALANCE_INTERNAL_SECRET=$(openssl rand -hex 32)
BALANCE_SETTLEMENT_SECRET=$(openssl rand -hex 32)
DASHBOARD_PASSWORD=$(openssl rand -hex 16)
ARC_TREASURY_SECRET_KEY=$key
NEXT_PUBLIC_TREASURY_ADDRESS=$treasury
NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC=$fee
NEXT_PUBLIC_ARC_CHAIN_ID=5042
NEXT_PUBLIC_ARC_RPC_ENDPOINT=http://127.0.0.1:$STUB_PORT/rpc
NEXT_PUBLIC_ARC_EXPLORER=http://127.0.0.1:$STUB_PORT/explorer
NEXT_PUBLIC_ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
NODE_ENV=production
STUB_PORT=$STUB_PORT
EOF
  chmod 600 "$ENV_FILE"
}

build() { (cd "$ROOT/backend" && cargo build --release --locked -p server); }

reset() {
  rm -f "$WORK/bench.sqlite" "$WORK/bench.sqlite-wal" "$WORK/bench.sqlite-shm"
}

start_stub() {
  load_env
  [ -f "$WORK/pids/stub" ] && kill -0 "$(cat "$WORK/pids/stub")" 2>/dev/null && return 0
  port_free "$STUB_PORT" || { echo "port $STUB_PORT busy" >&2; exit 1; }
  (cd "$ROOT" && exec node "$HERE/stub.mjs") > "$WORK/logs/stub.log" 2>&1 < /dev/null &
  echo $! > "$WORK/pids/stub"
  wait_http "http://127.0.0.1:$STUB_PORT/__stats"
}

start() {
  load_env; start_stub
  port_free "$API_PORT" || { echo "port $API_PORT busy" >&2; exit 1; }
  # Outbound HTTPS hits the stub's CONNECT counter, which must stay at zero.
  local proxy="http://127.0.0.1:$STUB_PORT"
  (cd "$WORK" && exec env SQLITE_PATH="$WORK/bench.sqlite" SQLITE_READ_POOL="${SQLITE_READ_POOL:-8}" \
    TICKS_SQLITE_PATH="$WORK/bench-ticks.sqlite" BIND_ADDR="127.0.0.1:$API_PORT" \
    BINANCE_ENDPOINT="http://127.0.0.1:$STUB_PORT/api/v3/ticker/price" \
    YAHOO_SPARK_ENDPOINT="http://127.0.0.1:$STUB_PORT/v7/finance/spark" \
    HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" NO_PROXY="127.0.0.1,localhost" \
    "$ROOT/backend/target/release/strike-backend") > "$WORK/logs/api.log" 2>&1 < /dev/null &
  echo $! > "$WORK/pids/api"
  wait_http "http://127.0.0.1:$API_PORT/api/health"
}

stop_one() {
  local f="$WORK/pids/$1"
  [ -f "$f" ] || return 0
  local p; p="$(cat "$f")"
  kill -TERM "$p" 2>/dev/null || true
  for _ in $(seq 1 100); do kill -0 "$p" 2>/dev/null || break; sleep 0.05; done
  kill -KILL "$p" 2>/dev/null || true
  rm -f "$f"
}

case "${1:-}" in
  setup) gen_env; build ;;
  reset) reset ;;
  start) start ;;
  stop) stop_one api ;;
  stop-all) stop_one api; stop_one stub ;;
  *) echo "usage: $0 setup|reset|start|stop|stop-all" >&2; exit 2 ;;
esac
