-- ============================================================
-- STRIKE — Complete Supabase Schema
-- Run this once on a fresh Supabase project via SQL Editor
-- ============================================================


-- ============================================================
-- 1. TABLES
-- ============================================================

-- user_balances: house balance per user per currency
CREATE TABLE IF NOT EXISTS public.user_balances (
  user_address  TEXT        NOT NULL,
  currency      TEXT        NOT NULL,
  balance       NUMERIC(30, 10) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  user_tier     TEXT        NOT NULL DEFAULT 'free'
                CHECK (user_tier IN ('free', 'standard', 'vip')),
  status        TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'frozen', 'banned')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_address, currency)
);
CREATE INDEX IF NOT EXISTS idx_ub_user_address ON public.user_balances(user_address);
CREATE INDEX IF NOT EXISTS idx_ub_currency     ON public.user_balances(currency);
CREATE INDEX IF NOT EXISTS idx_ub_status       ON public.user_balances(status);


-- balance_audit_log: full transaction history
CREATE TABLE IF NOT EXISTS public.balance_audit_log (
  id                BIGSERIAL   PRIMARY KEY,
  user_address      TEXT        NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'BOT',
  operation_type    TEXT        NOT NULL
                    CHECK (operation_type IN ('deposit', 'withdrawal', 'bet_placed', 'bet_won', 'payout', 'reconciliation')),
  amount            NUMERIC(30, 10) NOT NULL,
  balance_before    NUMERIC(30, 10),
  balance_after     NUMERIC(30, 10),
  transaction_hash  TEXT,
  bet_id            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_al_user_address   ON public.balance_audit_log(user_address);
CREATE INDEX IF NOT EXISTS idx_al_user_currency  ON public.balance_audit_log(user_address, currency);
CREATE INDEX IF NOT EXISTS idx_al_created_at     ON public.balance_audit_log(created_at DESC);


-- withdrawal_requests: manual approval queue
CREATE TABLE IF NOT EXISTS public.withdrawal_requests (
  id            BIGSERIAL   PRIMARY KEY,
  user_address  TEXT        NOT NULL,
  currency      TEXT        NOT NULL,
  amount        NUMERIC(30, 10) NOT NULL CHECK (amount > 0),
  fee_amount    NUMERIC(30, 10) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  net_amount    NUMERIC(30, 10) NOT NULL CHECK (net_amount >= 0),
  signature     TEXT,
  signed_at     BIGINT,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected')),
  tx_hash       TEXT,
  fee_tx_hash   TEXT,
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wr_user_address  ON public.withdrawal_requests(user_address);
CREATE INDEX IF NOT EXISTS idx_wr_status        ON public.withdrawal_requests(status);
CREATE INDEX IF NOT EXISTS idx_wr_requested_at  ON public.withdrawal_requests(requested_at DESC);


-- bet_history: every settled bet
CREATE TABLE IF NOT EXISTS public.bet_history (
  id             TEXT        PRIMARY KEY,
  wallet_address TEXT        NOT NULL,
  asset          TEXT        NOT NULL DEFAULT 'BTC',
  direction      TEXT        NOT NULL DEFAULT 'UP'
                 CHECK (direction IN ('UP', 'DOWN', 'DRAW')),
  amount         NUMERIC(30, 10) NOT NULL DEFAULT 0,
  multiplier     NUMERIC(10, 4)  NOT NULL DEFAULT 1.9,
  strike_price   NUMERIC(20, 8),
  end_price      NUMERIC(20, 8),
  payout         NUMERIC(30, 10) NOT NULL DEFAULT 0,
  won            BOOLEAN     NOT NULL DEFAULT false,
  mode           TEXT        NOT NULL DEFAULT 'binomo',
  network        TEXT        NOT NULL DEFAULT 'BOT',
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bh_wallet_address ON public.bet_history(wallet_address);
CREATE INDEX IF NOT EXISTS idx_bh_resolved_at    ON public.bet_history(resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_bh_network        ON public.bet_history(network);
CREATE INDEX IF NOT EXISTS idx_bh_won_payout     ON public.bet_history(won, payout DESC);

-- Allow public read (leaderboard) and insert (server-side)
ALTER TABLE public.bet_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read" ON public.bet_history;
DROP POLICY IF EXISTS "public_insert" ON public.bet_history;
CREATE POLICY "public_read"   ON public.bet_history FOR SELECT USING (true);
CREATE POLICY "public_insert" ON public.bet_history FOR INSERT WITH CHECK (true);


-- user_profiles: usernames and access codes
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_address  TEXT        PRIMARY KEY,
  username      TEXT        UNIQUE,
  access_code   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- user_referrals: referral codes and counts
CREATE TABLE IF NOT EXISTS public.user_referrals (
  user_address   TEXT        PRIMARY KEY,
  referral_code  TEXT        UNIQUE NOT NULL,
  referred_by    TEXT,
  referral_count INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ur_referral_code ON public.user_referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_ur_referral_count ON public.user_referrals(referral_count DESC);


-- access_codes: invite codes
CREATE TABLE IF NOT EXISTS public.access_codes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT        UNIQUE NOT NULL,
  is_used        BOOLEAN     NOT NULL DEFAULT false,
  used_at        TIMESTAMPTZ,
  wallet_address TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- waitlist: email waitlist
CREATE TABLE IF NOT EXISTS public.waitlist (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT        UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- banned_wallets: global ban list (one row per wallet; applies to all currencies)
CREATE TABLE IF NOT EXISTS public.banned_wallets (
  wallet_address TEXT        PRIMARY KEY,
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

-- Seed: known abuser wallet (Solana) — safe to re-run
INSERT INTO public.banned_wallets (wallet_address, reason)
VALUES (
  'Csx2cq3q7GeV79hFUuRR4Pa2T6JUBoC2UjWGbkVqQ4t4',
  'Platform manipulation / abuse'
)
ON CONFLICT (wallet_address) DO UPDATE
SET reason = EXCLUDED.reason;


-- ============================================================
-- 2. STORED PROCEDURES (RPCs)
-- ============================================================

-- Drop legacy function signatures first.
-- This avoids "cannot change return type of existing function" errors
-- when a previous database already has older versions.
DROP FUNCTION IF EXISTS public.update_balance_for_deposit(TEXT, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.update_balance_for_deposit(TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.update_balance_for_deposit(TEXT, NUMERIC);

DROP FUNCTION IF EXISTS public.deduct_balance_for_bet(TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.deduct_balance_for_bet(TEXT, NUMERIC);

DROP FUNCTION IF EXISTS public.credit_balance_for_payout(TEXT, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credit_balance_for_payout(TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.credit_balance_for_payout(TEXT, NUMERIC);

DROP FUNCTION IF EXISTS public.update_balance_for_withdrawal(TEXT, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.update_balance_for_withdrawal(TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.update_balance_for_withdrawal(TEXT, NUMERIC);

DROP FUNCTION IF EXISTS public.increment_referral_count(TEXT);

-- update_balance_for_deposit
-- Creates user row if needed, credits deposit, logs audit entry.
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


-- deduct_balance_for_bet
-- Atomically deducts bet amount; blocks frozen/banned accounts.
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


-- credit_balance_for_payout
-- Credits winnings to user balance after a won bet.
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
    -- Create row if missing (e.g. first win after account wipe)
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


-- update_balance_for_withdrawal
-- Deducts balance after a successful on-chain withdrawal.
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


-- increment_referral_count
-- Called when a new user joins via a referral link.
CREATE OR REPLACE FUNCTION public.increment_referral_count(
  referrer_address TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.user_referrals
  SET referral_count = referral_count + 1
  WHERE user_address = referrer_address;
END;
$$;
