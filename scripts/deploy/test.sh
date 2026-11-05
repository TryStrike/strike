#!/usr/bin/env bash
# Exercises data.sh against a throwaway data directory. Touches no real deployment.
# Run as root on Ubuntu with sqlite3, Node 22 and curl. Litestream checks run only
# if `litestream` is on PATH, and are reported as skipped otherwise.
#
#   sudo scripts/deploy/test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
chmod 755 "$WORK"
# The service user must reach these; CI checkouts sit under a private home.
install -m 755 "$ROOT/scripts/deploy/data.sh" "$WORK/data.sh"
install -m 644 "$ROOT/scripts/deploy/litestream.yml" "$WORK/litestream.yml"
DATA=$WORK/data.sh
export STRIKE_DATA_DIR=$WORK/data STRIKE_ETC_DIR=$WORK/etc STRIKE_SERVICE_USER=strike-test
DB=$STRIKE_DATA_DIR/strike.sqlite
WRITER=
cleanup() {
  [ -z "$WRITER" ] || kill "$WRITER" 2>/dev/null || true
  rm -rf "$WORK"
  userdel strike-test 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "ok: $1"; }
q() { runuser -u strike-test -- sqlite3 -cmd '.timeout 10000' "$DB" "$1"; }
mode() { stat -c '%a %U' "$1"; }
refuses() { # name, expected text, command...
  local name=$1 want=$2 out
  shift 2
  if out=$("$@" 2>&1); then fail "$name was not refused"; fi
  [[ $out == *"$want"* ]] || fail "$name refused for the wrong reason: $out"
  pass "$name"
}

# --- prepare ----------------------------------------------------------------
"$DATA" prepare
"$DATA" prepare
[ "$(mode "$STRIKE_DATA_DIR")" = '700 strike-test' ] || fail "data dir mode: $(mode "$STRIKE_DATA_DIR")"
pass "prepare is repeatable and the data dir is private"

# --- init -------------------------------------------------------------------
"$DATA" init "$ROOT/db/schema.sqlite.sql"
[ "$(mode "$DB")" = '600 strike-test' ] || fail "db mode: $(mode "$DB")"
[ "$(q 'PRAGMA journal_mode;')" = wal ] || fail "not WAL"
# The default uses unixepoch('subsec'), which an old CLI could not have evaluated.
[ "$(q 'SELECT count(*) FROM banned_wallets;')" = 1 ] || fail "schema seed row missing"
pass "init creates a WAL ledger owned by the service user"

# Timestamps are explicit: Ubuntu 22.04's CLI cannot run the unixepoch() defaults.
q "INSERT INTO user_balances (user_address, currency, balance, updated_at, created_at) VALUES ('0xkeep', 'USDC', 42, 0, 0)"
before=$(q "SELECT sum(balance), count(*) FROM user_balances")
echo 'DROP TABLE user_balances;' >"$WORK/hostile.sql"
"$DATA" init "$WORK/hostile.sql" >/dev/null
[ "$(q "SELECT sum(balance), count(*) FROM user_balances")" = "$before" ] || fail "init touched existing data"
pass "init never applies anything over an existing file"

# --- backup -----------------------------------------------------------------
# Every transaction moves 1 between two rows, so the sum is a torn-read detector.
q "INSERT INTO user_balances (user_address, currency, balance, updated_at, created_at) VALUES ('0xa', 'USDC', 1000000, 0, 0), ('0xb', 'USDC', 0, 0, 0)"
runuser -u strike-test -- bash -c "
  while :; do
    sqlite3 -cmd '.timeout 10000' '$DB' \"BEGIN IMMEDIATE;
      UPDATE user_balances SET balance = balance - 1 WHERE user_address = '0xa';
      UPDATE user_balances SET balance = balance + 1 WHERE user_address = '0xb';
      COMMIT;\" >/dev/null 2>&1 || true
  done" &
WRITER=$!
sleep 1
for _ in 1 2 3; do "$DATA" backup >/dev/null; sleep 1; done
kill "$WRITER"
WRITER=
latest=$(find "$STRIKE_DATA_DIR/backups" -name 'strike-*.sqlite' | sort | tail -1)
[ -n "$latest" ] || fail "no backup written"
[ "$(mode "$latest")" = '600 strike-test' ] || fail "backup mode: $(mode "$latest")"
sum=$(runuser -u strike-test -- sqlite3 "$latest" "SELECT sum(balance) FROM user_balances WHERE user_address IN ('0xa', '0xb')")
[ "$sum" = 1000000 ] || fail "torn backup: sum $sum"
moved=$(runuser -u strike-test -- sqlite3 "$latest" "SELECT balance FROM user_balances WHERE user_address = '0xb'")
[ "$moved" -gt 0 ] || fail "writer never ran, so the test proved nothing"
pass "backup taken during writes is consistent ($moved transfers captured)"

for n in 1 2 3 4 5 6 7 8 9; do
  install -o strike-test -m 600 "$latest" "$STRIKE_DATA_DIR/backups/strike-19700101T00000${n}Z.sqlite"
done
"$DATA" backup >/dev/null
count=$(find "$STRIKE_DATA_DIR/backups" -name 'strike-*.sqlite' | wc -l)
[ "$count" = 7 ] || fail "kept $count backups"
[ ! -e "$STRIKE_DATA_DIR/backups/strike-19700101T000001Z.sqlite" ] || fail "oldest backup kept"
[ -e "$STRIKE_DATA_DIR/backups/strike-19700101T000009Z.sqlite" ] || fail "pruned the wrong end"
find "$STRIKE_DATA_DIR/backups" -name '.*' | grep -q . && fail "scratch file left behind"
pass "backups rotate, oldest first, and leave no scratch files"

# --- drain ----------------------------------------------------------------------
withdrawal() { # id, seconds ago
  q "INSERT INTO withdrawal_requests (id, user_address, currency, amount, net_amount, status, decided_at, requested_at, created_at)
     VALUES ($1, '0xw', 'USDC', 1, 1, 'accepted', (CAST(strftime('%s', 'now') AS INTEGER) - $2) * 1000000, 0, 0)"
}
withdrawal 1 86400
timeout 3 "$DATA" drain || fail "a really stuck row blocked the deploy"
withdrawal 2 397
started=$SECONDS
timeout 30 "$DATA" drain >/dev/null || fail "drain never finished"
[ $((SECONDS - started)) -ge 3 ] || fail "drain did not wait for a row mid-transfer"
q "DELETE FROM withdrawal_requests"
pass "drain waits for recent payouts and ignores old stuck rows"

# --- a lost ledger is not a first deploy --------------------------------------
latest=$(find "$STRIKE_DATA_DIR/backups" -name 'strike-*.sqlite' | sort | tail -1)
mv "$DB" "$WORK/lost.sqlite"
rm -f "$DB-wal" "$DB-shm"
refuses "init with backups but no ledger" "has backups" "$DATA" init "$ROOT/db/schema.sqlite.sql"

# --- restore from a backup file -----------------------------------------------
cp "$WORK/lost.sqlite" "$DB"
chown strike-test "$DB"
q "UPDATE user_balances SET balance = 7 WHERE user_address = '0xkeep'"
"$DATA" restore "$latest" >/dev/null
[ "$(q "SELECT balance FROM user_balances WHERE user_address = '0xkeep'")" = 42 ] || fail "restore did not take"
aside=$(find "$STRIKE_DATA_DIR/backups" -type d -name 'pre-restore-*')
[ "$(sqlite3 "$aside/strike.sqlite" "SELECT balance FROM user_balances WHERE user_address = '0xkeep'")" = 7 ] \
  || fail "replaced ledger was not kept"
[ "$(mode "$DB")" = '600 strike-test' ] || fail "restored mode: $(mode "$DB")"
pass "restore from a file swaps the ledger and keeps the old one"

head -c 8192 /dev/urandom >"$WORK/garbage.sqlite"
sha=$(sha256sum "$DB")
refuses "restore of a corrupt file" "" "$DATA" restore "$WORK/garbage.sqlite"
[ "$(sha256sum "$DB")" = "$sha" ] || fail "corrupt restore changed the ledger"
pass "a corrupt file never replaces the ledger"

# --- env files ----------------------------------------------------------------
cat >"$WORK/.env.local" <<'EOF'
BACKEND_URL=http://stale
DATABASE_URL=postgres://stale
export SQLITE_PATH=./dev.sqlite
NODE_ENV=development
BIND_ADDR=0.0.0.0:9
PGPOOL_MAX=3
SQLITE_READ_POOL=4
SQLITE_FULLFSYNC=off
TICKS_SQLITE_PATH=./ticks.db
ARC_TREASURY_SECRET_KEY=test-value
LITESTREAM_REPLICA_URL=s3://bucket/path?endpoint=https://x.test&region=auto
AWS_ACCESS_KEY_ID="test-id"
EOF
"$DATA" filter-env <"$WORK/.env.local" >"$WORK/shipped"
grep -qE '^(BACKEND_URL|DATABASE_URL|SQLITE_PATH|NODE_ENV|BIND_ADDR|PGPOOL_MAX)=' "$WORK/shipped" \
  && fail "a deploy-owned key was shipped"
grep -q '^SQLITE_READ_POOL=4$' "$WORK/shipped" || fail "tuning key dropped"
"$DATA" install-env "$WORK/shipped"
"$DATA" install-env "$WORK/shipped" 2>/dev/null
backend=$STRIKE_ETC_DIR/backend.env litestream=$STRIKE_ETC_DIR/litestream.env
[ "$(mode "$backend")" = '600 root' ] || fail "backend.env mode: $(mode "$backend")"
[ "$(mode "$litestream")" = '600 root' ] || fail "litestream.env mode: $(mode "$litestream")"
grep -q AWS_ "$backend" && fail "storage credentials reached the backend env"
grep -q "^TICKS_SQLITE_PATH=$STRIKE_DATA_DIR/ticks.db$" "$backend" || fail "ticks path outside the data dir"
grep -q LITESTREAM_REPLICA_URL "$litestream" || fail "a second deploy erased the replica settings"
pass "env files are root-only, split, and survive a redeploy without replica keys"

# --- replicate with no target ---------------------------------------------------
out=$(env -u LITESTREAM_REPLICA_URL "$DATA" replicate 2>&1) || fail "unset replica failed the service"
[[ $out == *WARNING* ]] || fail "no warning for an unset replica: $out"
pass "an unset replica warns and exits 0"

# --- health ---------------------------------------------------------------------
node -e '
  const http = require("node:http");
  http.createServer((req, res) => res.end(req.url === "/up"
    ? JSON.stringify({ ok: true, service: "strike-backend", database: "up" })
    : JSON.stringify({ ok: false, service: "strike-backend", database: "down" })
  )).listen(18099, "127.0.0.1");
  setTimeout(() => process.exit(), 20000);
' &
FAKE=$!
sleep 1
"$DATA" health http://127.0.0.1:18099/up 1 >/dev/null || fail "healthy answer rejected"
refuses "a 200 that says the DB is down" "health check failed" "$DATA" health http://127.0.0.1:18099/down 1
kill "$FAKE"

# --- Litestream --------------------------------------------------------------------
if ! command -v litestream >/dev/null; then
  echo "SKIPPED: Litestream checks; litestream is not on PATH"
  exit 0
fi
REPLICA=$WORK/replica
install -d -o strike-test -m 700 "$REPLICA"
printf 'LITESTREAM_REPLICA_URL=file://%s\n' "$REPLICA" >"$litestream"
export LITESTREAM_CONFIG=$WORK/litestream.yml LITESTREAM_REPLICA_URL=file://$REPLICA
replicate() { runuser -u strike-test -- "$DATA" replicate >>"$WORK/litestream.log" 2>&1 & }
synced() { # one more commit, then wait until a restore can see it
  local value=$1 i
  q "UPDATE user_balances SET balance = $value WHERE user_address = '0xkeep'"
  for ((i = 0; i < 30; i++)); do
    rm -f "$WORK/probe.sqlite"*
    runuser -u strike-test -- litestream restore -o "$WORK/probe.sqlite" "$LITESTREAM_REPLICA_URL" >/dev/null 2>&1 || true
    if [ -e "$WORK/probe.sqlite" ] \
      && [ "$(sqlite3 "$WORK/probe.sqlite" "SELECT balance FROM user_balances WHERE user_address = '0xkeep'")" = "$value" ]; then
      return 0
    fi
    sleep 1
  done
  fail "commit $value never reached the replica: $(tail -5 "$WORK/litestream.log")"
}
touch "$WORK/litestream.log"
chown strike-test "$WORK/litestream.log"
chmod 777 "$WORK"
replicate
synced 100
pass "Litestream replicates a commit to a file replica"
pkill -u strike-test -x litestream
sleep 1

"$DATA" restore >/dev/null
[ "$(q "SELECT balance FROM user_balances WHERE user_address = '0xkeep'")" = 100 ] || fail "replica restore"
[ ! -e "$STRIKE_DATA_DIR/.strike.sqlite-litestream" ] || fail "stale Litestream state kept"
pass "restore from the replica returns the last commit"

replicate
synced 200
pkill -u strike-test -x litestream
sleep 1
pass "replication resumes on the restored ledger"

rm -f "$DB" "$DB-wal" "$DB-shm"
rm -rf "$STRIKE_DATA_DIR/backups"/strike-*.sqlite
refuses "init when only the replica has the ledger" "replica has data" "$DATA" init "$ROOT/db/schema.sqlite.sql"
[ ! -e "$DB" ] || fail "guard created a ledger"
"$DATA" restore >/dev/null
[ "$(q "SELECT balance FROM user_balances WHERE user_address = '0xkeep'")" = 200 ] || fail "disaster restore"
pass "total loss of the machine's files restores from the replica"

echo "all deploy data checks passed"
