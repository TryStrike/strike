#!/bin/bash
# End-to-end test of the migration tool against a throwaway local Postgres
# database, which is dropped on exit. Needs psql, createdb, dropdb and sqlite3.
# Uses PGHOST/PGPORT or local defaults; never reads an env file.
set -u
cd "$(dirname "$0")/../.."
ROOT=$PWD
PGHOST=${PGHOST:-/tmp}
PGPORT=${PGPORT:-5432}
export PGHOST PGPORT
DB=strike_migrate_test_$$
WORK=$(mktemp -d)
trap 'dropdb --if-exists "$DB"; rm -rf "$WORK"' EXIT

createdb "$DB" || exit 1
for f in supabase/migrations/001_complete_schema.sql supabase/migrations/002_banned_wallets.sql \
  supabase/migrations/003_user_sessions.sql supabase/migrations/007_withdrawal_columns.sql \
  supabase/migrations/008_ledger_integrity.sql supabase/access_system.sql \
  supabase/user_profiles.sql db/arc.sql; do
  psql -q -d "$DB" -f "$f" >/dev/null 2>&1
done

psql -q -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL' || exit 1
INSERT INTO user_balances (user_address, currency, balance, user_tier, status, updated_at) VALUES
  ('0xa', 'USDC', 922337203.6854775807, 'vip', 'frozen', '2026-03-04 05:06:07.123456+00'),
  ('0xb', 'USDC', 0.0000000001, 'free', 'active', '2026-03-04 05:06:07+05:30'),
  ('0xc', 'USDC', 0.00000001, 'standard', 'banned', now());
INSERT INTO balance_audit_log (user_address, currency, operation_type, amount, balance_before,
    balance_after, transaction_hash, bet_id, idempotency_key, settlement_token, max_payout,
    end_time, consumed_at) VALUES
  ('0xa', 'USDC', 'deposit', 123456.7890123456, 0, 123456.7890123456, '0xh1', NULL, NULL, NULL,
    NULL, NULL, NULL),
  ('0xa', 'USDC', 'bet_lock', 1.5, NULL, 2.5, NULL, 'b1', 'r1', 'token', 2.85,
    '2026-01-01 00:00:00.000001+00', now()),
  ('0xé', 'USDC', 'platform_fee', 0.00000001, NULL, NULL, 'fee:0xh1', NULL, NULL, NULL, NULL,
    NULL, NULL);
INSERT INTO withdrawal_requests (user_address, currency, amount, fee_amount, net_amount, signature,
    signed_at, status, decided_at, notes) VALUES
  ('0xa', 'USDC', 3, 0.3, 2.7, '0xsig', 1793533128698, 'paid_needs_reconciliation', now(), 'it''s');
INSERT INTO bet_history (id, wallet_address, asset, direction, amount, multiplier, strike_price,
    end_price, payout, won, mode, network, resolved_at) VALUES
  ('b1', '0xa', 'BTC', 'UP', 5, 1.9123, 65000.12345678, 65001, 9.5, true, 'binomo', 'ARC', now()),
  ('b2', '0xa', 'ETH', 'DOWN', 1, 999999.9999, NULL, NULL, 0, false, 'binomo', 'ARC', NULL);
INSERT INTO user_profiles (user_address, username, access_code) VALUES ('0xa', 'Bøb "x"', NULL);
INSERT INTO user_referrals (user_address, referral_code, referred_by, referral_count) VALUES
  ('0xa', 'CODE', NULL, 2147483647);
INSERT INTO access_codes (code, is_used, used_at, wallet_address) VALUES ('C1', true, now(), '0xa');
INSERT INTO waitlist (email) VALUES ('a@b.c');
INSERT INTO banned_wallets (wallet_address, reason) VALUES ('0xbad', NULL);
INSERT INTO user_sessions (wallet_address, network) VALUES ('0xa', 'ARC');
INSERT INTO deposit_locks (transaction_hash, user_address, currency, amount) VALUES
  ('0xh1', '0xa', 'USDC', 123456.7890123456);
-- A deleted row leaves the sequence ahead of max(id); new ids must not reuse it.
INSERT INTO withdrawal_requests (user_address, currency, amount, net_amount) VALUES ('0xz', 'USDC', 1, 1);
DELETE FROM withdrawal_requests WHERE user_address = '0xz';
SQL

export PG_URL="postgres://localhost:$PGPORT/$DB?host=$PGHOST"
cd backend && cargo build -q -p migrate_pg_to_sqlite || exit 1
TOOL=$ROOT/backend/target/debug/migrate_pg_to_sqlite
cd "$ROOT"

fail() { echo "FAIL: $1"; exit 1; }
expect_abort() { # name, expected text
  local out="$WORK/$1.sqlite"
  local log
  log=$("$TOOL" "$out" 2>&1) && fail "$1 was not aborted"
  echo "$log" | grep -q "$2" || fail "$1 aborted for the wrong reason: $log"
  [ -e "$out" ] && fail "$1 left a file behind"
  echo "aborted as expected: $1: $(echo "$log" | tail -1)"
}

OUT=$WORK/good.sqlite
"$TOOL" "$OUT" || fail "clean migration"
"$TOOL" "$OUT" 2>&1 | grep -q 'refusing to overwrite' || fail "overwrite guard"

# Sample exact values, read straight from the file.
q() { sqlite3 "$OUT" "$1"; }
[ "$(q "SELECT balance FROM user_balances WHERE user_address='0xa'")" = 9223372036854775807 ] || fail max
[ "$(q "SELECT balance FROM user_balances WHERE user_address='0xb'")" = 1 ] || fail min
[ "$(q "SELECT balance FROM user_balances WHERE user_address='0xc'")" = 100 ] || fail 1e-8
[ "$(q "SELECT updated_at FROM user_balances WHERE user_address='0xa'")" = 1772600767123456 ] || fail micros
[ "$(q "SELECT updated_at FROM user_balances WHERE user_address='0xb'")" = 1772580967000000 ] || fail zone
[ "$(q "SELECT multiplier, strike_price, end_price FROM bet_history WHERE id='b1'")" = "19123|6500012345678|6500100000000" ] || fail scales
[ "$(q "SELECT multiplier, strike_price, won FROM bet_history WHERE id='b2'")" = "9999999999||0" ] || fail nulls
[ "$(q "SELECT username FROM user_profiles")" = 'Bøb "x"' ] || fail text
[ "$(q "SELECT referral_count FROM user_referrals")" = 2147483647 ] || fail int4
[ "$(q "SELECT count(*) FROM banned_wallets")" = 2 ] || fail bans
[ "$(q "SELECT count(*) FROM pragma_integrity_check WHERE integrity_check = 'ok'")" = 1 ] || fail integrity
SEQ=$(psql -Atd "$DB" -c "SELECT last_value FROM pg_sequences WHERE sequencename = 'withdrawal_requests_id_seq'")
[ "$(q "SELECT seq FROM sqlite_sequence WHERE name='withdrawal_requests'")" = "$SEQ" ] || fail sequence
echo "exact values ok"

psql -q -d "$DB" -c "INSERT INTO user_balances (user_address, currency, balance) VALUES ('0xneg', 'USDC', 1);
  ALTER TABLE user_balances DROP CONSTRAINT user_balances_balance_check;
  UPDATE user_balances SET balance = -1 WHERE user_address = '0xneg'"
expect_abort negative_balance 'row refused'
psql -q -d "$DB" -c "DELETE FROM user_balances WHERE user_address = '0xneg'"

psql -q -d "$DB" -c "UPDATE user_balances SET balance = 922337203.6854775808 WHERE user_address = '0xa'"
expect_abort over_limit 'numeric field overflow'
psql -q -d "$DB" -c "UPDATE user_balances SET balance = 1 WHERE user_address = '0xa'"

psql -q -d "$DB" -c "DROP INDEX idx_balance_audit_tx_hash_unique;
  INSERT INTO balance_audit_log (user_address, operation_type, amount, transaction_hash)
  VALUES ('0xa', 'deposit', 1, '0xh1')"
expect_abort duplicate_tx_hash 'row refused'
psql -q -d "$DB" -c "DELETE FROM balance_audit_log WHERE amount = 1 AND transaction_hash = '0xh1'"

# Victims of the old replay race: reconcile before migrating.
psql -q -d "$DB" -c "INSERT INTO withdrawal_requests (user_address, currency, amount, net_amount, signed_at)
  VALUES ('0xr', 'USDC', 1, 1, 7), ('0xr', 'USDC', 1, 1, 7)"
expect_abort duplicate_intent 'row refused'
psql -q -d "$DB" -c "DELETE FROM withdrawal_requests WHERE user_address = '0xr'"

psql -q -d "$DB" -c "ALTER TABLE waitlist ADD COLUMN extra text"
expect_abort unknown_column 'not in the SQLite schema'
psql -q -d "$DB" -c "ALTER TABLE waitlist DROP COLUMN extra"

psql -q -d "$DB" -c "ALTER TABLE bet_history ALTER COLUMN multiplier TYPE numeric(20,8)"
expect_abort changed_type 'expected numeric(10,4)'

echo "migration tool: all checks passed"
