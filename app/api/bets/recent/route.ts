/**
 * GET /api/bets/recent
 * The latest winning rounds across all players, for the live wins feed.
 * Public: addresses are shortened server-side and demo rows are excluded.
 */
import { NextResponse } from 'next/server';
import { isDemoBetHistoryRow } from '@/lib/admin/walletAddressVariants';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';

export async function GET() {
  const { data, error } = await supabase
    .from('bet_history')
    .select('id, wallet_address, asset, payout, created_at')
    .eq('won', true)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    return NextResponse.json({ wins: [] }, { status: 500 });
  }

  const wins = (data ?? [])
    .filter((row) => !isDemoBetHistoryRow(row))
    .slice(0, 8)
    .map((row) => ({
      id: row.id,
      trader: `${String(row.wallet_address).slice(0, 6)}…${String(row.wallet_address).slice(-4)}`,
      asset: row.asset,
      payout: Number(row.payout) || 0,
      at: row.created_at,
    }));

  return NextResponse.json(
    { wins },
    { headers: { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=30' } }
  );
}
