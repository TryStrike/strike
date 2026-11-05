#!/usr/bin/env bash
# Everything that touches the ledger file on the VM. Installed there as
# /opt/strike/bin/strike-data; oracle.sh calls it and operators use it directly.
# Run as root, except filter-env, which also runs on the deploying machine, and
# replicate, which the strike-litestream unit runs as the service user.
#
#   strike-data prepare                  user, directories, permissions
#   strike-data install-litestream       pinned release, checksum verified
#   strike-data init <schema.sql>        create the DB, only if there is none
#   strike-data backup                   online backup, verified, keeps the last 7
#   strike-data drain                    wait for withdrawals mid-transfer to finish
#   strike-data restore [file | litestream restore flags]
#   strike-data filter-env               stdin to stdout: drop deploy-owned keys
#   strike-data install-env <env-file>   write the root-only env files
#   strike-data health <url> [tries]     fail unless the backend says it is up
#   strike-data replicate                run Litestream, or warn if unconfigured
#
# See docs/OPERATIONS.md.
set -euo pipefail
umask 077

DATA_DIR=${STRIKE_DATA_DIR:-/var/lib/strike}
ETC_DIR=${STRIKE_ETC_DIR:-/etc/strike}
SERVICE_USER=${STRIKE_SERVICE_USER:-strike}
DB=$DATA_DIR/strike.sqlite
BACKUP_DIR=$DATA_DIR/backups
LITESTREAM_ENV=$ETC_DIR/litestream.env
LITESTREAM_VERSION=0.5.17
KEEP_BACKUPS=7
# Two transfers (fee and net) at up to 180s of confirmations each, plus margin.
DRAIN_SECS=400

die() { echo "✗ $*" >&2; exit 1; }
as_service() { runuser -u "$SERVICE_USER" -- "$@"; }

# Scratch files live beside the DB so the final rename is atomic.
SCRATCH=
drop_scratch() { [ -z "$SCRATCH" ] || rm -f "$SCRATCH" "$SCRATCH-wal" "$SCRATCH-shm"; }
trap drop_scratch EXIT

check_integrity() {
  [ "$(as_service sqlite3 "$1" 'PRAGMA integrity_check;')" = ok ] || die "integrity check failed: $1"
}

# Not sourced: a replica URL may hold & and ? that a shell would act on.
load_replica_env() {
  local line value
  [ -r "$LITESTREAM_ENV" ] || return 0
  while IFS= read -r line; do
    case $line in
      LITESTREAM_*=* | AWS_*=*) ;;
      *) continue ;;
    esac
    value=${line#*=}
    case $value in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    export "${line%%=*}=$value"
  done <"$LITESTREAM_ENV"
}

cmd_prepare() {
  id -u "$SERVICE_USER" >/dev/null 2>&1 \
    || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$DATA_DIR" "$BACKUP_DIR"
  install -d -o root -g root -m 755 "$ETC_DIR"
  # Repairs a -wal left root-owned by a manual sqlite3 run; contents are untouched.
  chown -R --no-dereference "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  chmod -R u=rwX,go= "$DATA_DIR"
}

cmd_install_litestream() {
  local arch sum tmp
  case $(uname -m) in
    x86_64) arch=x86_64 sum=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d ;;
    aarch64 | arm64) arch=arm64 sum=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 ;;
    *) die "no Litestream build for $(uname -m)" ;;
  esac
  if [ "$(litestream version 2>/dev/null || true)" = "$LITESTREAM_VERSION" ]; then return 0; fi
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/litestream.tar.gz" \
    "https://github.com/benbjohnson/litestream/releases/download/v$LITESTREAM_VERSION/litestream-$LITESTREAM_VERSION-linux-$arch.tar.gz"
  echo "$sum  $tmp/litestream.tar.gz" | sha256sum -c --quiet -
  tar -xzf "$tmp/litestream.tar.gz" -C "$tmp" litestream
  install -m 755 "$tmp/litestream" /usr/local/bin/litestream
  rm -rf "$tmp"
}

# A missing file on a machine that has backups means the ledger was lost, not
# that this is a first deploy. An empty ledger would boot, report healthy and
# show every balance as zero, so that case stops here and needs a human.
refuse_if_ledger_was_lost() {
  local probe=$DATA_DIR/.replica-probe.$$.sqlite
  [ "${STRIKE_ALLOW_NEW_DB:-}" != 1 ] || return 0
  [ ! -e "$DB-wal" ] || die "$DB is missing but its -wal exists. Restore; do not create a new ledger."
  if compgen -G "$BACKUP_DIR/strike-*.sqlite" >/dev/null; then
    die "$DB is missing but $BACKUP_DIR has backups. Run: strike-data restore <file>. To start empty on purpose: STRIKE_ALLOW_NEW_DB=1"
  fi
  load_replica_env
  [ -n "${LITESTREAM_REPLICA_URL:-}" ] || return 0
  SCRATCH=$probe
  as_service litestream restore -if-replica-exists -o "$probe" "$LITESTREAM_REPLICA_URL"
  if [ -e "$probe" ]; then
    die "$DB is missing but the replica has data. Run: strike-data restore. To start empty on purpose: STRIKE_ALLOW_NEW_DB=1"
  fi
}

cmd_init() {
  local schema=${1:?usage: init <schema.sql>}
  if [ -e "$DB" ]; then
    echo "→ $DB exists; schema not applied"
    return 0
  fi
  refuse_if_ledger_was_lost
  # node:sqlite, not the sqlite3 CLI: the schema needs unixepoch('subsec') from
  # SQLite 3.42 and Ubuntu 22.04's CLI is 3.37. Node 22 is a deploy requirement.
  SCRATCH=$DATA_DIR/.init.$$.sqlite
  # shellcheck disable=SC2016 # JavaScript, not shell.
  as_service node --experimental-sqlite --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(require("node:fs").readFileSync(0, "utf8"));
    db.close();
  ' "$SCRATCH" <"$schema"
  check_integrity "$SCRATCH"
  mv -n "$SCRATCH" "$DB"
  [ ! -e "$SCRATCH" ] || die "$DB appeared during init; left untouched"
  echo "→ created $DB"
}

cmd_backup() {
  local name
  name=strike-$(date -u +%Y%m%dT%H%M%SZ).sqlite
  if [ ! -e "$DB" ]; then
    echo "→ no database yet; nothing to back up"
    return 0
  fi
  SCRATCH=$BACKUP_DIR/.$name.tmp
  # ponytail: .backup restarts if a write lands mid-copy, so a huge file under
  # constant writes may hit this timeout and fail the deploy, safely. Switch to
  # VACUUM INTO (one read transaction) if that ever happens.
  timeout 900 runuser -u "$SERVICE_USER" -- \
    sqlite3 -cmd '.timeout 30000' "$DB" ".backup '$SCRATCH'" \
    || die "online backup failed; nothing was replaced"
  check_integrity "$SCRATCH"
  mv "$SCRATCH" "$BACKUP_DIR/$name"
  find "$BACKUP_DIR" -maxdepth 1 -name 'strike-*.sqlite' | sort | head -n "-$KEEP_BACKUPS" | xargs -r rm -f --
  echo "→ backed up to $BACKUP_DIR/$name"
}

# A restart must not land between a payout and the write of its tx hash. The
# accept handler can wait minutes on-chain, and open SSE streams make any stop
# long, so the unit's stop timeout cannot cover both: wait here instead. Only
# recent rows count, so a row that is really stuck cannot block a deploy.
cmd_drain() {
  local busy
  [ -e "$DB" ] || return 0
  while :; do
    busy=$(as_service sqlite3 -cmd '.timeout 30000' "$DB" "SELECT count(*) FROM withdrawal_requests
      WHERE status = 'accepted' AND tx_hash IS NULL
        AND decided_at > (CAST(strftime('%s', 'now') AS INTEGER) - $DRAIN_SECS) * 1000000;")
    [ "$busy" = 0 ] && return 0
    echo "→ waiting for $busy withdrawal(s) mid-transfer"
    sleep 5
  done
}

cmd_restore() {
  local stamp aside unit
  for unit in strike-backend strike-litestream; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      die "stop first: sudo systemctl stop strike-backend strike-litestream"
    fi
  done
  SCRATCH=$DATA_DIR/.restore.$$.sqlite
  if [ -f "${1:-}" ]; then
    install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 600 "$1" "$SCRATCH"
  else
    load_replica_env
    [ -n "${LITESTREAM_REPLICA_URL:-}" ] || die "LITESTREAM_REPLICA_URL is not set in $LITESTREAM_ENV"
    as_service litestream restore "$@" -o "$SCRATCH" "$LITESTREAM_REPLICA_URL"
    [ -e "$SCRATCH" ] || die "the replica returned nothing"
  fi
  check_integrity "$SCRATCH"

  # The old ledger is set aside, never deleted. Its -wal may hold commits.
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  aside=$BACKUP_DIR/pre-restore-$stamp-$$
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$aside"
  for f in "$DB" "$DB-wal" "$DB-shm"; do
    if [ -e "$f" ]; then mv "$f" "$aside/"; fi
  done
  # Litestream's position belongs to the file just moved away.
  rm -rf "$DATA_DIR/.$(basename "$DB")-litestream"
  mv "$SCRATCH" "$DB"
  echo "→ restored; replaced files are in $aside"
  echo "→ balances: $(as_service sqlite3 "$DB" 'SELECT count(*) FROM user_balances;') rows. Reconcile withdrawals before reopening: docs/OPERATIONS.md"
}

# Keys the deploy owns. systemd lets EnvironmentFile override Environment=, so a
# laptop value of any of these would silently beat the unit.
cmd_filter_env() {
  sed -E 's/^export[[:space:]]+//' \
    | { grep -vE '^(BACKEND_URL|DATABASE_URL|PGPOOL_MAX|SQLITE_PATH|NODE_ENV|BIND_ADDR)=' || true; }
}

cmd_install_env() {
  local src=${1:?usage: install-env <env-file>} replica_keys='^(LITESTREAM_|AWS_)'
  local app=$ETC_DIR/backend.env ticks=$DATA_DIR/ticks.db
  { grep -vE "$replica_keys" "$src" || true; } >"$app.new"
  # The unit can only write under DATA_DIR, so a path elsewhere could never work.
  if ! grep -q "^TICKS_SQLITE_PATH=$DATA_DIR/" "$app.new"; then
    sed -i '/^TICKS_SQLITE_PATH=/d' "$app.new"
    echo "TICKS_SQLITE_PATH=$ticks" >>"$app.new"
  fi
  chown root:root "$app.new"
  chmod 600 "$app.new"
  mv "$app.new" "$app"

  # A deploy from a machine without these keys must not erase working credentials.
  if grep -qE "$replica_keys" "$src"; then
    grep -E "$replica_keys" "$src" >"$LITESTREAM_ENV.new"
    chown root:root "$LITESTREAM_ENV.new"
    chmod 600 "$LITESTREAM_ENV.new"
    mv "$LITESTREAM_ENV.new" "$LITESTREAM_ENV"
  elif [ ! -e "$LITESTREAM_ENV" ]; then
    install -o root -g root -m 600 /dev/null "$LITESTREAM_ENV"
  fi
  # Next never needs these. Same inode, so the deploying user keeps ownership.
  local kept
  kept=$(grep -vE "$replica_keys" "$src" || true)
  printf '%s\n' "$kept" >"$src"

  if ! grep -qE '^LITESTREAM_REPLICA_URL=.' "$LITESTREAM_ENV"; then
    echo "⚠ WARNING: LITESTREAM_REPLICA_URL is not set. The ledger has NO off-machine backup." >&2
  fi
}

cmd_health() {
  local url=${1:?usage: health <url> [tries]} tries=${2:-30} body='' want
  for ((i = 0; i < tries; i++)); do
    body=$(curl -sS --max-time 5 "$url" 2>&1 || true)
    # /api/health answers 200 with "ok":false when the DB is down, so the status
    # code proves nothing. The service field proves Next proxied to Rust.
    for want in '"ok":true' '"service":"strike-backend"' '"database":"up"'; do
      [[ $body == *"$want"* ]] || { sleep 1; continue 2; }
    done
    echo "→ healthy: $url"
    return 0
  done
  die "health check failed: $url answered: $body"
}

cmd_replicate() {
  if [ -z "${LITESTREAM_REPLICA_URL:-}" ]; then
    echo "WARNING: LITESTREAM_REPLICA_URL is not set in $LITESTREAM_ENV. The ledger has NO off-machine backup." >&2
    exit 0
  fi
  export SQLITE_PATH=$DB
  exec litestream replicate -config "${LITESTREAM_CONFIG:-$ETC_DIR/litestream.yml}"
}

command=${1:-}
[ $# -eq 0 ] || shift
case $command in
  prepare) cmd_prepare ;;
  install-litestream) cmd_install_litestream ;;
  init) cmd_init "$@" ;;
  backup) cmd_backup ;;
  drain) cmd_drain ;;
  restore) cmd_restore "$@" ;;
  filter-env) cmd_filter_env ;;
  install-env) cmd_install_env "$@" ;;
  health) cmd_health "$@" ;;
  replicate) cmd_replicate ;;
  *) sed -n '2,18p' "$0" >&2; exit 2 ;;
esac
