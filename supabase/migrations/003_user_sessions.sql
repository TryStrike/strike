-- 003_user_sessions.sql
-- Tracks wallet session dwell time on the platform.
-- A session is opened the first time a wallet sends a ping and updated every
-- ~30 s while they remain active. Idle detection (>90 s since last ping)
-- closes the session automatically via the API.
--
-- HOW TO RUN:
--   Supabase Dashboard → SQL Editor → paste and run this file.

create table if not exists public.user_sessions (
  id               uuid primary key default gen_random_uuid(),
  wallet_address   text not null,
  network          text not null default 'BNB',
  started_at       timestamptz not null default now(),
  last_ping_at     timestamptz not null default now(),
  ended_at         timestamptz
);

create index if not exists idx_user_sessions_wallet  on public.user_sessions (wallet_address);
create index if not exists idx_user_sessions_started on public.user_sessions (started_at desc);
