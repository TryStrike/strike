/**
 * API Route: Fetch bet history for a wallet
 * GET /api/bets/history?wallet=0x...&limit=50
 *
 * Requires the caller to prove ownership via the balance API header.
 * The wallet in the query must match the requesting session's balance key.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { assertBalanceApiAuthorized } from '@/lib/balance/balanceApiGuard';

export async function GET(request: NextRequest) {
    // Require first-party authorization header to prevent enumeration of any wallet
    const unauthorized = assertBalanceApiAuthorized(request);
    if (unauthorized) return unauthorized;

    try {
        const { searchParams } = new URL(request.url);
        const wallet = searchParams.get('wallet');
        const limitParam = parseInt(searchParams.get('limit') || '50');
        const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 200);

        if (!wallet) {
            return NextResponse.json({ error: 'Missing wallet parameter' }, { status: 400 });
        }

        const { data, error } = await supabase
            .from('bet_history')
            .select('id, wallet_address, asset, direction, amount, multiplier, strike_price, end_price, payout, won, mode, network, resolved_at, created_at')
            .eq('wallet_address', canonicalHouseUserAddress(wallet))
            .order('resolved_at', { ascending: false })
            .limit(limit);

        if (error) {
            return NextResponse.json({ error: 'Failed to fetch bets' }, { status: 500 });
        }

        return NextResponse.json({ bets: data || [] });
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
