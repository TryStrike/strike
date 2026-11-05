-- Strike SQLite schema, version 1: the baseline every database starts from.
-- strike_core::db runs this once and tracks progress in `PRAGMA user_version`, so
-- it is frozen now: later changes go in `MIGRATIONS` there. Statements stay
-- idempotent because a file from before versioning runs the part above the seed.
-- It mirrors the Postgres schema it was ported from, column order included,
-- because `RETURNING *` shapes reach the API.
--
-- Storage conventions (crate::money and crate::schema own the conversions):
--   NUMERIC(p,s)  INTEGER holding value * 10^s, so the Postgres scale is kept:
--                   money      NUMERIC(30,10)  scale 10  max  922,337,203.6854775807
--                   prices     NUMERIC(20,8)   scale 8   max  92,233,720,368.54775807
--                   multiplier NUMERIC(10,4)   scale 4   max  999,999.9999 (Postgres' own cap)
--                 Writes past those limits fail with "numeric field overflow".
--                 Never add a REAL column for money.
--   TIMESTAMPTZ   INTEGER microseconds since the Unix epoch, UTC.
--   BOOLEAN       INTEGER 0/1 with a CHECK.
--   UUID          TEXT, lower-case hyphenated.
--
-- Backups: not configured here. Litestream replicates this file by tailing the
-- WAL; if it is added, run it as a sidecar against SQLITE_PATH and keep the
-- server's busy_timeout, because Litestream takes short write locks to
-- checkpoint. A restored file must pass `PRAGMA integrity_check` before use.

CREATE TABLE IF NOT EXISTS user_balances (
  user_address TEXT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'BOT',
  balance      INTEGER NOT NULL DEFAULT 0,
  user_tier    TEXT NOT NULL DEFAULT 'free',
  status       TEXT NOT NULL DEFAULT 'active',
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  PRIMARY KEY (user_address, currency),
  CONSTRAINT user_balances_balance_check CHECK (balance >= 0),
  CONSTRAINT user_balances_status_check CHECK (status IN ('active', 'frozen', 'banned')),
  CONSTRAINT user_balances_user_tier_check CHECK (user_tier IN ('free', 'standard', 'vip'))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_ub_currency ON user_balances(currency);
CREATE INDEX IF NOT EXISTS idx_ub_status   ON user_balances(status);

CREATE TABLE IF NOT EXISTS balance_audit_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_address     TEXT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'BOT',
  operation_type   TEXT NOT NULL,
  amount           INTEGER NOT NULL,
  balance_before   INTEGER,
  balance_after    INTEGER,
  transaction_hash TEXT,
  bet_id           TEXT,
  created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  idempotency_key  TEXT,
  settlement_token TEXT,
  max_payout       INTEGER,
  end_time         INTEGER,
  consumed_at      INTEGER,
  CONSTRAINT balance_audit_log_operation_type_check CHECK (operation_type IN (
    'deposit', 'withdrawal', 'bet_placed', 'bet_won', 'bet_lost', 'bet_lock',
    'payout_lock', 'payout', 'platform_fee', 'refund', 'reconciliation',
    'admin_balance_wipe'
  ))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_al_user_address ON balance_audit_log(user_address);
CREATE INDEX IF NOT EXISTS idx_al_user_currency ON balance_audit_log(user_address, currency);
CREATE INDEX IF NOT EXISTS idx_al_created_at ON balance_audit_log(created_at DESC);
-- Admin totals and the withdrawal cap filter on the operation.
CREATE INDEX IF NOT EXISTS idx_al_operation ON balance_audit_log(operation_type, user_address);
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_audit_settlement_lock
  ON balance_audit_log(bet_id, operation_type)
  WHERE bet_id IS NOT NULL AND operation_type IN ('payout_lock', 'bet_won', 'bet_lost');
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_audit_idempotency
  ON balance_audit_log(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_audit_tx_hash_unique
  ON balance_audit_log(transaction_hash)
  WHERE transaction_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_balance_audit_bet_id
  ON balance_audit_log(bet_id)
  WHERE bet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_balance_audit_open_bets
  ON balance_audit_log(bet_id)
  WHERE operation_type = 'bet_lock' AND consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_address TEXT NOT NULL,
  currency     TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  fee_amount   INTEGER NOT NULL DEFAULT 0,
  net_amount   INTEGER NOT NULL,
  signature    TEXT,
  signed_at    INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending',
  tx_hash      TEXT,
  fee_tx_hash  TEXT,
  decided_by   TEXT,
  decided_at   INTEGER,
  requested_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  notes        TEXT,
  account_type TEXT,
  CONSTRAINT withdrawal_requests_amount_check CHECK (amount > 0),
  CONSTRAINT withdrawal_requests_fee_amount_check CHECK (fee_amount >= 0),
  CONSTRAINT withdrawal_requests_net_amount_check CHECK (net_amount >= 0),
  CONSTRAINT withdrawal_requests_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'paid_needs_reconciliation'))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_wr_user_address ON withdrawal_requests(user_address, status);
CREATE INDEX IF NOT EXISTS idx_wr_status ON withdrawal_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_wr_requested_at ON withdrawal_requests(requested_at DESC);
-- One row per signed intent. New on SQLite: Postgres had no such key, so a replay
-- could queue again. Keyed on what was signed, not on the signature's spelling.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wr_signed_intent
  ON withdrawal_requests(user_address, currency, signed_at)
  WHERE signed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS bet_history (
  id             TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  asset          TEXT NOT NULL DEFAULT 'BTC',
  direction      TEXT NOT NULL DEFAULT 'UP',
  amount         INTEGER NOT NULL DEFAULT 0,
  multiplier     INTEGER NOT NULL DEFAULT 19000,
  strike_price   INTEGER,
  end_price      INTEGER,
  payout         INTEGER NOT NULL DEFAULT 0,
  won            INTEGER NOT NULL DEFAULT 0 CHECK (won IN (0, 1)),
  mode           TEXT NOT NULL DEFAULT 'binomo',
  network        TEXT NOT NULL DEFAULT 'BOT',
  resolved_at    INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  CONSTRAINT bet_history_direction_check CHECK (direction IN ('UP', 'DOWN', 'DRAW'))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_bh_wallet_address ON bet_history(wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bh_resolved_at ON bet_history(resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_bh_network ON bet_history(network);
CREATE INDEX IF NOT EXISTS idx_bh_won_payout ON bet_history(won, payout DESC);
-- The recent-wins feed and the leaderboard page newest-first.
CREATE INDEX IF NOT EXISTS idx_bh_created_at ON bet_history(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_bh_won_created ON bet_history(won, created_at DESC);

-- One row per real bet, written in the transaction that takes the stake. The
-- terms above the blank line are frozen then; settlement fills the rest once, and
-- that record is permanent: it is what a later on-chain proof is built from.
-- `bet_history` gets a row at settlement for the readers that want finished bets.
-- New on SQLite: Postgres has no such table, so a migrated file starts it empty
-- and bets from before it are never swept.
CREATE TABLE IF NOT EXISTS bet_rounds (
  bet_id        TEXT PRIMARY KEY,
  user_address  TEXT NOT NULL,
  currency      TEXT NOT NULL,
  asset         TEXT NOT NULL,
  mode          TEXT NOT NULL,
  direction     TEXT NOT NULL,
  stake         INTEGER NOT NULL,
  multiplier    INTEGER NOT NULL,
  strike_price  INTEGER NOT NULL,
  strike_at     INTEGER NOT NULL,
  strike_source TEXT NOT NULL,
  price_top     INTEGER,
  price_bottom  INTEGER,
  end_time      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),

  end_price     INTEGER,
  end_price_at  INTEGER,
  end_source    TEXT,
  outcome       TEXT,
  payout        INTEGER,
  settled_by    TEXT,
  settled_at    INTEGER,
  CONSTRAINT bet_rounds_mode_check CHECK (mode IN ('binomo', 'box', 'draw')),
  CONSTRAINT bet_rounds_direction_check CHECK (direction IN ('UP', 'DOWN')),
  CONSTRAINT bet_rounds_band_check CHECK (
    (mode = 'binomo' AND price_top IS NULL AND price_bottom IS NULL)
    OR (mode <> 'binomo' AND price_top > price_bottom)
  ),
  CONSTRAINT bet_rounds_outcome_check CHECK (
    outcome IN ('win', 'loss', 'tie', 'refund_no_price', 'withheld')
  ),
  CONSTRAINT bet_rounds_settled_check CHECK (
    (outcome IS NULL) = (payout IS NULL) AND (outcome IS NULL) = (settled_at IS NULL)
  )
) STRICT;
-- The sweep's one question: what is open and past its end?
CREATE INDEX IF NOT EXISTS idx_bet_rounds_open ON bet_rounds(end_time) WHERE outcome IS NULL;
CREATE TRIGGER IF NOT EXISTS bet_rounds_settled_is_final
BEFORE UPDATE ON bet_rounds
WHEN OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a settled round is permanent');
END;
CREATE TRIGGER IF NOT EXISTS bet_rounds_are_never_deleted
BEFORE DELETE ON bet_rounds
BEGIN
  SELECT RAISE(ABORT, 'a round is permanent');
END;

CREATE TABLE IF NOT EXISTS user_profiles (
  user_address TEXT PRIMARY KEY,
  username     TEXT UNIQUE,
  access_code  TEXT,
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
) STRICT;

-- Postgres ran this BEFORE UPDATE and assigned NEW.updated_at. SQLite cannot
-- assign NEW; recursive_triggers is off, so this inner UPDATE does not re-fire.
CREATE TRIGGER IF NOT EXISTS update_user_profiles_updated_at
AFTER UPDATE ON user_profiles
FOR EACH ROW
BEGIN
  UPDATE user_profiles
     SET updated_at = CAST(unixepoch('subsec') * 1000000 AS INTEGER)
   WHERE user_address = NEW.user_address;
END;

CREATE TABLE IF NOT EXISTS user_referrals (
  user_address   TEXT PRIMARY KEY,
  referral_code  TEXT UNIQUE NOT NULL,
  referred_by    TEXT,
  referral_count INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_ur_referral_count ON user_referrals(referral_count DESC);

-- wallet_address is not UNIQUE: 001 created this table first, so the UNIQUE in
-- access_system.sql never took effect on Postgres either.
CREATE TABLE IF NOT EXISTS access_codes (
  id             TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random() % 4) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  code           TEXT UNIQUE NOT NULL,
  is_used        INTEGER NOT NULL DEFAULT 0 CHECK (is_used IN (0, 1)),
  used_at        INTEGER,
  wallet_address TEXT,
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_access_codes_created ON access_codes(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS waitlist (
  id         TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random() % 4) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  email      TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
) STRICT;

CREATE TABLE IF NOT EXISTS banned_wallets (
  wallet_address TEXT PRIMARY KEY,
  reason         TEXT,
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_banned_wallets_created ON banned_wallets(created_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  id             TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random() % 4) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  wallet_address TEXT NOT NULL,
  network        TEXT NOT NULL DEFAULT 'BNB',
  started_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  last_ping_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER)),
  ended_at       INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_user_sessions_wallet
  ON user_sessions(wallet_address, last_ping_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_started ON user_sessions(started_at DESC);
-- The stale-session sweep deletes by end time.
CREATE INDEX IF NOT EXISTS idx_user_sessions_ended ON user_sessions(ended_at)
  WHERE ended_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS deposit_locks (
  transaction_hash TEXT PRIMARY KEY,
  user_address     TEXT NOT NULL,
  currency         TEXT NOT NULL,
  amount           INTEGER NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000000 AS INTEGER))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_deposit_locks_created ON deposit_locks(created_at DESC);

-- SEED: below this line runs on a new database only, never again. The version is
-- set here too for tools that apply this file directly.
INSERT INTO banned_wallets (wallet_address, reason)
VALUES ('Csx2cq3q7GeV79hFUuRR4Pa2T6JUBoC2UjWGbkVqQ4t4', 'Platform manipulation / abuse')
ON CONFLICT (wallet_address) DO NOTHING;
PRAGMA user_version = 1;
