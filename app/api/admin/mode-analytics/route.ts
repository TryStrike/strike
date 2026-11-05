/**
 * GET /api/admin/mode-analytics
 * Per-game-mode performance breakdown sourced from bet_history.
 * Paginates to avoid the default 1 000-row PostgREST limit.
 *
 * Returns stats for each mode (binomo / box / draw) split across:
 *   - Overall (real + demo combined)
 *   - Real wallets only
 * and also a per-chain breakdown within each mode.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';

const PAGE = 1000;

async function fetchAllBets() {
  const rows: {
    id: string;
    wallet_address: string;
    amount: number;
    payout: number;
    won: boolean;
    mode: string;
    network: string;
    asset: string;
    multiplier: number;
  }[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('bet_history')
      .select('id, wallet_address, amount, payout, won, mode, network, asset, multiplier')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    rows.push(...(chunk as typeof rows));
    if (chunk.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

const isDemo = (id: string, wallet: string) =>
  String(id).toLowerCase().startsWith('demo-') ||
  (wallet ?? '').toLowerCase().startsWith('0xdemo');

interface ModeStat {
  mode: string;
  label: string;
  totalBets: number;
  wins: number;
  losses: number;
  winRate: number;
  totalWagered: number;
  totalPaidOut: number;
  housePnL: number;
  avgMultiplier: number;
  byChain: Record<string, {
    totalBets: number;
    wins: number;
    totalWagered: number;
    totalPaidOut: number;
    housePnL: number;
  }>;
  topAssets: { asset: string; count: number }[];
}

const MODE_LABELS: Record<string, string> = {
  binomo: 'Classic (Binomo)',
  box:    'Box Mode',
  draw:   'Draw Mode',
};

function computeModes(bets: ReturnType<typeof fetchAllBets> extends Promise<infer T> ? T : never): ModeStat[] {
  const map: Record<string, {
    bets: number; wins: number; wagered: number; paid: number;
    multiplierSum: number;
    byChain: Record<string, { bets: number; wins: number; wagered: number; paid: number }>;
    assetCount: Record<string, number>;
  }> = {};

  for (const b of bets) {
    const mode = (b.mode || 'binomo').toLowerCase();
    if (!map[mode]) map[mode] = {
      bets: 0, wins: 0, wagered: 0, paid: 0, multiplierSum: 0,
      byChain: {}, assetCount: {},
    };
    const m = map[mode];
    m.bets++;
    if (b.won) m.wins++;
    m.wagered += Number(b.amount ?? 0);
    m.paid    += Number(b.payout ?? 0);
    m.multiplierSum += Number(b.multiplier ?? 1.9);

    const chain = String(b.network || 'UNKNOWN').toUpperCase();
    if (!m.byChain[chain]) m.byChain[chain] = { bets: 0, wins: 0, wagered: 0, paid: 0 };
    const c = m.byChain[chain];
    c.bets++;
    if (b.won) c.wins++;
    c.wagered += Number(b.amount ?? 0);
    c.paid    += Number(b.payout ?? 0);

    const asset = String(b.asset || 'USDC').toUpperCase();
    m.assetCount[asset] = (m.assetCount[asset] ?? 0) + 1;
  }

  return Object.entries(map).map(([mode, m]) => {
    const byChain: ModeStat['byChain'] = {};
    for (const [chain, c] of Object.entries(m.byChain)) {
      byChain[chain] = {
        totalBets: c.bets, wins: c.wins,
        totalWagered: c.wagered, totalPaidOut: c.paid,
        housePnL: c.wagered - c.paid,
      };
    }
    const topAssets = Object.entries(m.assetCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([asset, count]) => ({ asset, count }));

    return {
      mode,
      label: MODE_LABELS[mode] ?? mode,
      totalBets: m.bets,
      wins: m.wins,
      losses: m.bets - m.wins,
      winRate: m.bets > 0 ? Math.round((m.wins / m.bets) * 1000) / 10 : 0,
      totalWagered: m.wagered,
      totalPaidOut: m.paid,
      housePnL: m.wagered - m.paid,
      avgMultiplier: m.bets > 0 ? Math.round((m.multiplierSum / m.bets) * 100) / 100 : 0,
      byChain,
      topAssets,
    };
  }).sort((a, b) => b.totalBets - a.totalBets);
}

export async function GET(request: NextRequest) {
  const deny = requireAdminAuth(request);
  if (deny) return deny;

  try {
    const allBets = await fetchAllBets();

    const realBets = allBets.filter(b => !isDemo(b.id, b.wallet_address));
    const demoBets = allBets.filter(b => isDemo(b.id, b.wallet_address));

    return NextResponse.json({
      real:     computeModes(realBets),
      demo:     computeModes(demoBets),
      combined: computeModes(allBets),
      totalBets:     allBets.length,
      totalRealBets: realBets.length,
      totalDemoBets: demoBets.length,
    });
  } catch (e: any) {
    console.error('[mode-analytics]', e?.message ?? e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
