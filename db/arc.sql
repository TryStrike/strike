-- Arc adjustments on top of the inherited schema.
--
-- The platform settles on Arc only, with one playable asset:
-- USDC.

-- user_balances.currency is part of the primary key and was NOT NULL with no
-- default at all, so every insert had to name it explicitly.
ALTER TABLE public.user_balances
  ALTER COLUMN currency SET DEFAULT 'BOT';

-- The audit log's operation_type check listed six values, but the application
-- also writes 'bet_lost' (settlement), 'refund' (cancelled round),
-- 'admin_balance_wipe' (the unban flow) — and, since the money-path fixes in
-- migration 008, 'bet_lock', 'payout_lock' and 'platform_fee'. Those inserts
-- were failing the constraint (23514); the routes logged it as non-blocking and
-- carried on, which made every dedupe lock dead code and left gaps in the audit
-- trail that balance reconciliation reads as the source of truth.
--
-- Kept identical to supabase/migrations/008_ledger_integrity.sql: this file runs
-- after that migration on the Neon path, so a narrower list here would undo it.
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
-- Ledger integrity constraints (mirror of 008_ledger_integrity.sql)
-- ------------------------------------------------------------
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS idempotency_key  TEXT;
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS settlement_token TEXT;
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS max_payout       NUMERIC(30, 10);
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS end_time         TIMESTAMPTZ;
ALTER TABLE public.balance_audit_log ADD COLUMN IF NOT EXISTS consumed_at       TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_audit_settlement_lock
  ON public.balance_audit_log (bet_id, operation_type)
  WHERE bet_id IS NOT NULL AND operation_type IN ('payout_lock', 'bet_won', 'bet_lost');

CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_audit_idempotency
  ON public.balance_audit_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Created only when the existing ledger has no repeated hash — see the guarded
-- DO block in 008, which carries the reasoning.
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_audit_tx_hash_unique
  ON public.balance_audit_log (transaction_hash)
  WHERE transaction_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_balance_audit_bet_id
  ON public.balance_audit_log (bet_id)
  WHERE bet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_balance_audit_open_bets
  ON public.balance_audit_log (bet_id)
  WHERE operation_type = 'bet_lock' AND consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.deposit_locks (
  transaction_hash TEXT        PRIMARY KEY,
  user_address     TEXT        NOT NULL,
  currency         TEXT        NOT NULL,
  amount           NUMERIC(30, 10) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deposit_locks_created ON public.deposit_locks(created_at DESC);

ALTER TABLE public.user_balances
  DROP CONSTRAINT IF EXISTS user_balances_balance_check;

ALTER TABLE public.user_balances
  ADD CONSTRAINT user_balances_balance_check CHECK (balance >= 0) NOT VALID;

ALTER TABLE public.withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;

ALTER TABLE public.withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'paid_needs_reconciliation'));

