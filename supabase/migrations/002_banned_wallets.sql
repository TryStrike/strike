-- ============================================================
-- Global wallet bans (cross-currency) + RPC enforcement
-- Run in Supabase SQL Editor if you already applied 001_complete_schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.banned_wallets (
  wallet_address TEXT PRIMARY KEY,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_banned_wallets_created ON public.banned_wallets(created_at DESC);

CREATE OR REPLACE FUNCTION public.normalize_ban_address(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN trim(p) LIKE '0x%' THEN lower(trim(p))
    ELSE trim(p)
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_wallet_globally_banned(p_address TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.banned_wallets b
    WHERE b.wallet_address = public.normalize_ban_address(p_address)
  );
$$;

-- Known abuser (Solana) — idempotent
INSERT INTO public.banned_wallets (wallet_address, reason)
VALUES (
  'Csx2cq3q7GeV79hFUuRR4Pa2T6JUBoC2UjWGbkVqQ4t4',
  'Platform manipulation / abuse'
)
ON CONFLICT (wallet_address) DO UPDATE
SET reason = EXCLUDED.reason;

-- Replace RPC bodies to enforce global ban at database level
DROP FUNCTION IF EXISTS public.update_balance_for_deposit(TEXT, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.update_balance_for_deposit(TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.update_balance_for_deposit(TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION public.update_balance_for_deposit(
  p_user_address     TEXT,
  p_deposit_amount   NUMERIC,
  p_currency         TEXT DEFAULT 'BOT',
  p_transaction_hash TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_balance NUMERIC := 0;
  v_new_balance NUMERIC;
BEGIN
  IF public.is_wallet_globally_banned(p_user_address) THEN
    RETURN json_build_object('success', false, 'error', 'This wallet is banned from the platform.', 'new_balance', 0);
  END IF;

  IF p_deposit_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Deposit amount must be greater than zero', 'new_balance', 0);
  END IF;

  INSERT INTO public.user_balances (user_address, currency, balance)
  VALUES (p_user_address, p_currency, 0)
  ON CONFLICT (user_address, currency) DO NOTHING;

  SELECT balance INTO v_old_balance
  FROM public.user_balances
  WHERE user_address = p_user_address AND currency = p_currency
  FOR UPDATE;

  v_new_balance := v_old_balance + p_deposit_amount;

  UPDATE public.user_balances
  SET balance = v_new_balance, updated_at = NOW()
  WHERE user_address = p_user_address AND currency = p_currency;

  INSERT INTO public.balance_audit_log
    (user_address, currency, operation_type, amount, balance_before, balance_after, transaction_hash)
  VALUES
    (p_user_address, p_currency, 'deposit', p_deposit_amount, v_old_balance, v_new_balance, p_transaction_hash);

  RETURN json_build_object('success', true, 'error', NULL, 'new_balance', v_new_balance);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM, 'new_balance', 0);
END;
$$;

DROP FUNCTION IF EXISTS public.deduct_balance_for_bet(TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.deduct_balance_for_bet(TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION public.deduct_balance_for_bet(
  p_user_address TEXT,
  p_bet_amount   NUMERIC,
  p_currency     TEXT DEFAULT 'BOT'
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_balance NUMERIC;
  v_new_balance NUMERIC;
  v_status      TEXT;
BEGIN
  IF public.is_wallet_globally_banned(p_user_address) THEN
    RETURN json_build_object('success', false, 'error', 'This wallet is banned from the platform.', 'new_balance', 0);
  END IF;

  IF p_bet_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Bet amount must be greater than zero', 'new_balance', 0);
  END IF;

  SELECT balance, status INTO v_old_balance, v_status
  FROM public.user_balances
  WHERE user_address = p_user_address AND currency = p_currency
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'User not found', 'new_balance', 0);
  END IF;

  IF v_status = 'frozen' THEN
    RETURN json_build_object('success', false, 'error', 'Account is frozen. Please contact support.', 'new_balance', v_old_balance);
  END IF;

  IF v_status = 'banned' THEN
    RETURN json_build_object('success', false, 'error', 'Account is banned.', 'new_balance', v_old_balance);
  END IF;

  IF v_old_balance < p_bet_amount THEN
    RETURN json_build_object('success', false, 'error', 'Insufficient balance', 'new_balance', v_old_balance);
  END IF;

  v_new_balance := v_old_balance - p_bet_amount;

  UPDATE public.user_balances
  SET balance = v_new_balance, updated_at = NOW()
  WHERE user_address = p_user_address AND currency = p_currency;

  INSERT INTO public.balance_audit_log
    (user_address, currency, operation_type, amount, balance_before, balance_after)
  VALUES
    (p_user_address, p_currency, 'bet_placed', p_bet_amount, v_old_balance, v_new_balance);

  RETURN json_build_object('success', true, 'error', NULL, 'new_balance', v_new_balance);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM, 'new_balance', 0);
END;
$$;

DROP FUNCTION IF EXISTS public.credit_balance_for_payout(TEXT, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credit_balance_for_payout(TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.credit_balance_for_payout(TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION public.credit_balance_for_payout(
  p_user_address  TEXT,
  p_payout_amount NUMERIC,
  p_currency      TEXT DEFAULT 'BOT',
  p_bet_id        TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_balance NUMERIC;
  v_new_balance NUMERIC;
BEGIN
  IF public.is_wallet_globally_banned(p_user_address) THEN
    RETURN json_build_object('success', false, 'error', 'This wallet is banned from the platform.', 'new_balance', 0);
  END IF;

  IF p_payout_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Payout amount must be greater than zero', 'new_balance', 0);
  END IF;

  SELECT balance INTO v_old_balance
  FROM public.user_balances
  WHERE user_address = p_user_address AND currency = p_currency
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.user_balances (user_address, currency, balance)
    VALUES (p_user_address, p_currency, p_payout_amount);
    v_old_balance := 0;
    v_new_balance := p_payout_amount;
  ELSE
    v_new_balance := v_old_balance + p_payout_amount;
    UPDATE public.user_balances
    SET balance = v_new_balance, updated_at = NOW()
    WHERE user_address = p_user_address AND currency = p_currency;
  END IF;

  INSERT INTO public.balance_audit_log
    (user_address, currency, operation_type, amount, balance_before, balance_after, bet_id)
  VALUES
    (p_user_address, p_currency, 'payout', p_payout_amount, v_old_balance, v_new_balance, p_bet_id);

  RETURN json_build_object('success', true, 'error', NULL, 'new_balance', v_new_balance);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM, 'new_balance', 0);
END;
$$;

DROP FUNCTION IF EXISTS public.update_balance_for_withdrawal(TEXT, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.update_balance_for_withdrawal(TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.update_balance_for_withdrawal(TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION public.update_balance_for_withdrawal(
  p_user_address      TEXT,
  p_withdrawal_amount NUMERIC,
  p_currency          TEXT DEFAULT 'BOT',
  p_transaction_hash  TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_balance NUMERIC;
  v_new_balance NUMERIC;
  v_status      TEXT;
BEGIN
  IF public.is_wallet_globally_banned(p_user_address) THEN
    RETURN json_build_object('success', false, 'error', 'This wallet is banned from the platform.', 'new_balance', 0);
  END IF;

  IF p_withdrawal_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Withdrawal amount must be greater than zero', 'new_balance', 0);
  END IF;

  SELECT balance, status INTO v_old_balance, v_status
  FROM public.user_balances
  WHERE user_address = p_user_address AND currency = p_currency
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'User not found', 'new_balance', 0);
  END IF;

  IF v_status = 'frozen' THEN
    RETURN json_build_object('success', false, 'error', 'Account is frozen. Withdrawals are disabled.', 'new_balance', v_old_balance);
  END IF;

  IF v_status = 'banned' THEN
    RETURN json_build_object('success', false, 'error', 'Account is banned.', 'new_balance', v_old_balance);
  END IF;

  IF v_old_balance < p_withdrawal_amount THEN
    RETURN json_build_object('success', false, 'error', 'Insufficient balance', 'new_balance', v_old_balance);
  END IF;

  v_new_balance := v_old_balance - p_withdrawal_amount;

  UPDATE public.user_balances
  SET balance = v_new_balance, updated_at = NOW()
  WHERE user_address = p_user_address AND currency = p_currency;

  INSERT INTO public.balance_audit_log
    (user_address, currency, operation_type, amount, balance_before, balance_after, transaction_hash)
  VALUES
    (p_user_address, p_currency, 'withdrawal', p_withdrawal_amount, v_old_balance, v_new_balance, p_transaction_hash);

  RETURN json_build_object('success', true, 'error', NULL, 'new_balance', v_new_balance);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM, 'new_balance', 0);
END;
$$;
