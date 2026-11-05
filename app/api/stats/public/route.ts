/**
 * GET /api/stats/public
 * Public (unauthenticated) aggregate stats for the landing page.
 *
 * Uses the same `computePlatformStats()` function as /api/admin/stats so
 * numbers on the public dashboard always match the admin dashboard exactly.
 *
 * Only the `real` subset is exposed — no demo data, no PII, no wallet addresses.
 * Cached for 5 minutes via Next.js revalidation.
 */

import { NextResponse } from 'next/server';
import { computePlatformStats } from '@/lib/admin/computeStats';

export const revalidate = 300;

export async function GET() {
  try {
    const { real, totalDeposits, totalWithdrawals } =
      await computePlatformStats();

    // Top currencies by bet count from per-network breakdown
    const topCurrencies = Object.entries(real.platformPnLByNetwork)
      .sort((a, b) => b[1].volume - a[1].volume)
      .slice(0, 5)
      .map(([currency, row]) => ({
        currency,
        wagered: row.volume,
        paid:    row.payout,
        count:   0, // not needed by UI
      }));

    return NextResponse.json({
      // Core metrics — real bets only, matching admin dashboard exactly
      totalBets:    real.totalBets,
      totalWins:    real.totalWins,
      totalLosses:  real.totalLosses,
      winRate:      real.winRate,
      totalWagered: real.totalVolume,
      totalPaidOut: real.totalPayout,
      uniqueWallets: real.totalUsers,
      chainsActive:  1, // Arc
      totalDeposits,
      totalWithdrawals,
      topCurrencies,
    });
  } catch (e: any) {
    console.error('[stats/public]', e?.message ?? e);
    return NextResponse.json(
      {
        totalBets: 0, totalWins: 0, totalLosses: 0, winRate: 0,
        totalWagered: 0, totalPaidOut: 0, uniqueWallets: 0,
        chainsActive: 1, totalDeposits: 0, totalWithdrawals: 0,
        topCurrencies: [],
      },
      { status: 500 },
    );
  }
}
