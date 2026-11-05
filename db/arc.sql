-- Arc adjustments on top of the inherited schema.
--
-- The platform settles on Arc only, with one playable asset:
-- USDC.

-- user_balances.currency is part of the primary key and was NOT NULL with no
-- default at all, so every insert had to name it explicitly.
ALTER TABLE public.user_balances
  ALTER COLUMN currency SET DEFAULT 'BOT';

-- The audit log's operation_type check listed six values, but the application
-- also writes 'bet_lost' (settlement), 'refund' (cancelled round) and
-- 'admin_balance_wipe' (the unban flow). Those inserts were failing the
-- constraint, leaving gaps in the audit trail that balance reconciliation
-- reads as the source of truth.
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
    'payout',
    'refund',
    'reconciliation',
    'admin_balance_wipe'
  ));
