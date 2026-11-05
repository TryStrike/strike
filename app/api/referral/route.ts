/**
 * Server-side referral API — replaces all direct Supabase client calls from
 * referralSlice.ts. The browser never touches Supabase directly.
 *
 * GET  /api/referral?address=<wallet>   — fetch or create referral record
 * POST /api/referral                    — register a new user with a ref code
 * GET  /api/referral?leaderboard=1      — top 20 referrers (addresses truncated)
 *
 * The single-wallet fetch and POST require first-party auth so users cannot
 * enumerate each other's referral codes or referred_by fields.
 */

import { NextRequest, NextResponse } from 'next/server';
import { walletAddressSearchVariants } from '@/lib/admin/walletAddressVariants';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { assertBalanceApiAuthorized } from '@/lib/balance/balanceApiGuard';

function truncate(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Leaderboard is public (addresses are already truncated)
  if (searchParams.get('leaderboard') === '1') {
    const { data, error } = await supabase
      .from('user_referrals')
      .select('user_address, referral_count, referral_code')
      .order('referral_count', { ascending: false })
      .limit(20);
    if (error) return NextResponse.json({ error: 'Failed to load leaderboard' }, { status: 500 });
    return NextResponse.json({
      leaderboard: (data ?? []).map(r => ({
        user_address: truncate(r.user_address),
        referral_count: r.referral_count,
        referral_code: r.referral_code,
      })),
    });
  }

  // Single wallet info — requires first-party auth so users cannot enumerate
  // each other's referral codes or referred_by field via the public API.
  const unauthorized = assertBalanceApiAuthorized(req);
  if (unauthorized) return unauthorized;

  const address = searchParams.get('address')?.trim();
  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });
  const variants = walletAddressSearchVariants(address);

  const { data: refRows, error } = await supabase
    .from('user_referrals')
    .select('referral_code, referral_count, referred_by, user_address')
    .in('user_address', variants)
    .limit(1);

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch referral data' }, { status: 500 });
  }

  const row = refRows?.[0];
  return NextResponse.json({
    referral: row
      ? { referral_code: row.referral_code, referral_count: row.referral_count, referred_by: row.referred_by }
      : null,
  });
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const unauthorized = assertBalanceApiAuthorized(req);
  if (unauthorized) return unauthorized;

  try {
    const body = await req.json();
    const { address, referredByCode } = body as { address: string; referredByCode?: string };
    if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });
    const addrKey = canonicalHouseUserAddress(address);

    // Idempotent — return existing record if already registered
    const { data: existingRows } = await supabase
      .from('user_referrals')
      .select('referral_code, referral_count')
      .in('user_address', walletAddressSearchVariants(address))
      .limit(1);

    const existing = existingRows?.[0];
    if (existing) {
      return NextResponse.json({ referral_code: existing.referral_code, referral_count: existing.referral_count });
    }

    // Generate a unique referral code
    const shortAddr = addrKey.slice(-4).toUpperCase();
    const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
    const code = `strike-${shortAddr}${randomStr}`;

    // Resolve referrer address from code (server validates — no client trust)
    let referredByAddress: string | null = null;
    if (referredByCode) {
      const { data: refUser } = await supabase
        .from('user_referrals')
        .select('user_address')
        .eq('referral_code', referredByCode)
        .single();
      if (refUser && canonicalHouseUserAddress(refUser.user_address) !== addrKey) {
        // Use exact DB `user_address` so `increment_referral_count` matches the PK row.
        referredByAddress = refUser.user_address;
      }
    }

    const { data, error } = await supabase
      .from('user_referrals')
      .insert({ user_address: addrKey, referral_code: code, referred_by: referredByAddress, referral_count: 0 })
      .select()
      .single();

    if (error) return NextResponse.json({ error: 'Failed to register referral' }, { status: 500 });

    // Increment referrer's count server-side (no client can fake this)
    if (referredByAddress) {
      await supabase.rpc('increment_referral_count', { referrer_address: referredByAddress });
    }

    return NextResponse.json({ referral_code: data.referral_code, referral_count: data.referral_count });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'unknown' }, { status: 500 });
  }
}
