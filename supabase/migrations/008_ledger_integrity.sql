-- ============================================================
-- Migration 008: ledger integrity
--
-- Every money path in the app already tries to write a lock row into
-- balance_audit_log ('bet_lock', 'payout_lock', 'platform_fee'), but the
-- operation_type CHECK constraint never listed those values. Each insert
-- therefore failed with 23514, the routes logged it as "non-blocking" and
-- carried on — so the deduplication guards were dead code and a retried
-- request could double-deduct or double-pay.
--
-- This migration:
--   1. makes the operation_type CHECK match what the application writes;
--   2. adds the unique indexes those lock rows were relying on;
--   3. stores the server-side bet record (idempotency key, settlement token,
--      round end time, consumed_at) so settlement can be claimed exactly once;
--   4. adds a deposit lock table keyed by the raw tx hash;
--   5. keeps balances non-negative and lets the admin queue record a
--      post-payout reconciliation state;
--   6. adds the two atomic RPCs the bet / win routes call.
--
-- Written to be rerunnable (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS) per
-- db/migrate.mjs, which replays every file on each deploy and tolerates
-- "already exists" errors only.
-- ============================================================

-- ------------------------------------------------------------
-- 1. operation_type CHECK: superset of every value the code writes
-- ------------------------------------------------------------
ALTER TABLE public.balance_audit_log
  DROP CONSTRAINT IF EXISTS balance_audit_log_operation_type_check;

ALTER TABLE public.balance_audit_log
  ADD CONSTRAINT balance_audit_log_operation_type_check
  CHECK (operation_type IN (
    'deposit',
    'withdrawal',
    'bet_placed',
    'bet_won',
    'bet_lost',
    'bet_lock',
    'payout_lock',
    'payout',
    'platform_fee',
    'refund',
    'reconciliation',
    'admin_balance_wipe'
  ));

-- ------------------------------------------------------------
-- 2. Server-side bet record columns on the audit table
-- ------------------------------------------------------------
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS idempotency_key  TEXT;
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS settlement_token TEXT;
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS max_payout       NUMERIC(30, 10);
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS end_time         TIMESTAMPTZ;
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS consumed_at       TIMESTAMPTZ;

COMMENT ON COLUMN public.balance_audit_log.idempotency_key  IS 'Client betRequestId for a bet_lock row; the dedupe key.';
COMMENT ON COLUMN public.balance_audit_log.settlement_token IS 'Signed payout token issued for this bet (replayed on a duplicate request).';
COMMENT ON COLUMN public.balance_audit_log.max_payout       IS 'Payout ceiling approved at bet time; settlement may not exceed it.';
COMMENT ON COLUMN public.balance_audit_log.end_time         IS 'Round end frozen at click time.';
COMMENT ON COLUMN public.balance_audit_log.consumed_at      IS 'Set when a bet_lock row has been claimed by a payout.';

-- ------------------------------------------------------------
-- 3. Unique indexes the lock rows were supposed to have
-- ------------------------------------------------------------

-- One settlement per bet: payout_lock / bet_won / bet_lost are written once per bet_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_audit_settlement_lock
  ON public.balance_audit_log (bet_id, operation_type)
  WHERE bet_id IS NOT NULL AND operation_type IN ('payout_lock', 'bet_won', 'bet_lost');

-- One bet per client request id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_audit_idempotency
  ON public.balance_audit_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- One credit per chain transaction hash. Guarded because a ledger that already
-- contains a double credit (the bug this migration closes) cannot build a unique
-- index over it — failing the whole migration would brick the deploy. When the
-- index cannot be built the route-level deposit_locks table still dedupes.
DO $do$
DECLARE
  v_dupes BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_balance_audit_tx_hash_unique') THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_dupes
  FROM (
    SELECT transaction_hash
    FROM public.balance_audit_log
    WHERE transaction_hash IS NOT NULL
    GROUP BY transaction_hash
    HAVING COUNT(*) > 1
  ) d;

  IF v_dupes > 0 THEN
    RAISE WARNING
      '008_ledger_integrity: skipped idx_balance_audit_tx_hash_unique — % transaction_hash value(s) are already credited more than once. Reconcile them, then re-run this migration.',
      v_dupes;
    RETURN;
  END IF;

  CREATE UNIQUE INDEX idx_balance_audit_tx_hash_unique
    ON public.balance_audit_log (transaction_hash)
    WHERE transaction_hash IS NOT NULL;
END
$do$;

-- Fast lookup of the settlement claim target.
CREATE INDEX IF NOT EXISTS idx_balance_audit_bet_id
  ON public.balance_audit_log (bet_id)
  WHERE bet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_balance_audit_open_bets
  ON public.balance_audit_log (bet_id)
  WHERE operation_type = 'bet_lock' AND consumed_at IS NULL;

-- ------------------------------------------------------------
-- 4. Deposit lock table — keyed by the RAW tx hash
-- ------------------------------------------------------------
-- The audit row stores a combined hash once a fee transfer happened
-- (txHash|feeTx:...), so a replay of the same chain tx used to slip past the
-- old SELECT-then-credit pre-check. A primary key on the raw hash cannot.
CREATE TABLE IF NOT EXISTS public.deposit_locks (
  transaction_hash TEXT        PRIMARY KEY,
  user_address     TEXT        NOT NULL,
  currency         TEXT        NOT NULL,
  amount           NUMERIC(30, 10) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deposit_locks_created ON public.deposit_locks(created_at DESC);

-- ------------------------------------------------------------
-- 5. Balance floor + withdrawal reconciliation status
-- ------------------------------------------------------------
-- NOT VALID: legacy negative rows (another consequence of the dead locks) must
-- not abort the deploy, but no new negative balance may be written.
ALTER TABLE public.user_balances
  DROP CONSTRAINT IF EXISTS user_balances_balance_check;

ALTER TABLE public.user_balances
  ADD CONSTRAINT user_balances_balance_check CHECK (balance >= 0) NOT VALID;

ALTER TABLE public.withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;

ALTER TABLE public.withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'paid_needs_reconciliation'));

COMMENT ON COLUMN public.withdrawal_requests.status IS
  'pending -> accepted/rejected by an admin. paid_needs_reconciliation = funds were already moved (or their outcome is unknown) when the accept flow errored.';

-- ------------------------------------------------------------
-- 6a. place_bet_locked — idempotency lock + deduction in one transaction
-- ------------------------------------------------------------
-- Replaces the "insert lock row, ignore the error, deduct anyway" sequence.
-- A duplicate betRequestId never deducts a second time; it returns the ORIGINAL
-- bet id, settlement token and remaining balance. A failed deduction voids the
-- lock row, so a bet that was never paid for can never be settled.
CREATE OR REPLACE FUNCTION public.place_bet_locked(
  p_user_address     TEXT,
  p_bet_amount       NUMERIC,
  p_currency         TEXT,
  p_idempotency_key  TEXT,
  p_bet_id           TEXT,
  p_max_payout       NUMERIC        DEFAULT 0,
  p_end_time         TIMESTAMPTZ    DEFAULT NULL,
  p_settlement_token TEXT           DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_res JSON;
  v_row RECORD;
BEGIN
  IF p_idempotency_key IS NULL OR p_bet_id IS NULL THEN
    RETURN json_build_object('success', false, 'duplicate', false,
      'error', 'Bet placement requires an idempotency key', 'new_balance', 0);
  END IF;

  -- Lock first. unique_violation => this exact request was already seen.
  BEGIN
    INSERT INTO public.balance_audit_log
      (user_address, currency, operation_type, amount, bet_id,
       idempotency_key, max_payout, end_time, settlement_token)
    VALUES
      (p_user_address, p_currency, 'bet_lock', p_bet_amount, p_bet_id,
       p_idempotency_key, p_max_payout, p_end_time, p_settlement_token);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_row
    FROM public.balance_audit_log
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;

    IF NOT FOUND THEN
      -- The conflict came from a settlement lock, not the bet request.
      RETURN json_build_object('success', false, 'duplicate', true,
        'error', 'Bet already processed', 'new_balance', 0);
    END IF;

    RETURN json_build_object(
      'success',          v_row.settlement_token IS NOT NULL,
      'duplicate',        true,
      'error',            CASE WHEN v_row.settlement_token IS NULL
                               THEN 'Bet already processed' ELSE NULL END,
      'bet_id',           v_row.bet_id,
      'settlement_token', v_row.settlement_token,
      'new_balance',      v_row.balance_after,
      'max_payout',       v_row.max_payout,
      'user_address',     v_row.user_address,
      'currency',         v_row.currency
    );
  END;

  -- Deduct under the row lock held by the RPC.
  v_res := public.deduct_balance_for_bet(p_user_address, p_bet_amount, p_currency);

  IF v_res IS NULL OR COALESCE((v_res ->> 'success')::BOOLEAN, false) = false THEN
    -- No money moved: void the lock so the request id is not marked as spent.
    DELETE FROM public.balance_audit_log
    WHERE idempotency_key = p_idempotency_key AND operation_type = 'bet_lock';

    RETURN json_build_object(
      'success',   false,
      'duplicate', false,
      'error',     COALESCE(v_res ->> 'error', 'Bet placement failed'),
      'new_balance', COALESCE((v_res ->> 'new_balance')::NUMERIC, 0)
    );
  END IF;

  UPDATE public.balance_audit_log
     SET balance_after = (v_res ->> 'new_balance')::NUMERIC
   WHERE idempotency_key = p_idempotency_key
     AND operation_type = 'bet_lock';

  RETURN json_build_object(
    'success',          true,
    'duplicate',        false,
    'error',            NULL,
    'bet_id',           p_bet_id,
    'settlement_token', p_settlement_token,
    'new_balance',      (v_res ->> 'new_balance')::NUMERIC,
    'max_payout',       p_max_payout,
    'user_address',     p_user_address,
    'currency',         p_currency
  );
END;
$fn$;

-- ------------------------------------------------------------
-- 6b. settle_bet_payout — payout lock + bet claim + credit atomically
-- ------------------------------------------------------------
-- Credits the ledger row recorded at bet time (never the caller-supplied
-- address), may not exceed the payout approved then, and can only be claimed
-- once: the payout_lock insert and the consumed_at UPDATE are both single
-- statements racing on the same row.
CREATE OR REPLACE FUNCTION public.settle_bet_payout(
  p_bet_id        TEXT,
  p_user_address  TEXT,
  p_payout_amount NUMERIC,
  p_currency      TEXT
)
RETURNS JSON
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_bet RECORD;
  v_res JSON;
BEGIN
  IF p_bet_id IS NULL THEN
    RETURN json_build_object('success', false, 'duplicate', false,
      'error', 'Bet id is required', 'new_balance', 0);
  END IF;

  -- 1. payout lock: one settlement per bet, ever.
  BEGIN
    INSERT INTO public.balance_audit_log
      (user_address, currency, operation_type, amount, bet_id, transaction_hash)
    VALUES
      (p_user_address, p_currency, 'payout_lock', 0, p_bet_id, 'lock:' || p_bet_id);
  EXCEPTION WHEN unique_violation THEN
    RETURN json_build_object('success', false, 'duplicate', true,
      'error', 'Payout already processed for this bet', 'new_balance', 0);
  END;

  -- 2. claim the server-side bet record.
  UPDATE public.balance_audit_log
     SET consumed_at = NOW()
   WHERE bet_id = p_bet_id
     AND operation_type = 'bet_lock'
     AND consumed_at IS NULL
  RETURNING user_address, currency, amount, max_payout
     INTO v_bet;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.balance_audit_log
      WHERE bet_id = p_bet_id AND operation_type = 'bet_lock' AND consumed_at IS NOT NULL
    ) THEN
      RETURN json_build_object('success', false, 'duplicate', true,
        'error', 'Payout already processed for this bet', 'new_balance', 0);
    END IF;
    -- Unknown bet id: abort so the payout lock rolls back with everything else.
    RAISE EXCEPTION 'strike_unknown_bet:%', p_bet_id;
  END IF;

  -- 3. never pay more than the bet approved.
  IF p_payout_amount <= 0 THEN
    RAISE EXCEPTION 'strike_invalid_payout_amount';
  END IF;
  IF v_bet.max_payout IS NOT NULL
     AND p_payout_amount > v_bet.max_payout + 0.00000001 THEN
    RAISE EXCEPTION 'strike_payout_exceeds_max';
  END IF;

  -- 4. credit the ledger row captured at bet time.
  v_res := public.credit_balance_for_payout(
    v_bet.user_address, p_payout_amount, v_bet.currency, p_bet_id);

  IF v_res IS NULL OR COALESCE((v_res ->> 'success')::BOOLEAN, false) = false THEN
    -- Abort: the credit did not happen, so the lock and the claim roll back too.
    RAISE EXCEPTION 'strike_credit_failed:%', COALESCE(v_res ->> 'error', 'unknown');
  END IF;

  RETURN json_build_object(
    'success',      true,
    'duplicate',    false,
    'error',        NULL,
    'new_balance',  (v_res ->> 'new_balance')::NUMERIC,
    'user_address', v_bet.user_address,
    'currency',     v_bet.currency,
    'bet_id',       p_bet_id
  );
END;
$fn$;
