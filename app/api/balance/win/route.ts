/**
 * POST /api/balance/win endpoint
 * 
 * Credits winning amount to user's house balance.
 * Called when a bet is won in the instant-resolution system.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { assertBalanceApiAuthorized } from '@/lib/balance/balanceApiGuard';
import { verifySettlementToken } from '@/lib/balance/settlementToken';
import { isWalletGloballyBanned } from '@/lib/bans/walletBan';

interface WinRequest {
    userAddress: string;
    winAmount: number;
    currency: string;
    betId: string;
    settlementToken: string;
}

export async function POST(request: NextRequest) {
    try {
        const unauthorized = assertBalanceApiAuthorized(request);
        if (unauthorized) return unauthorized;

        // Parse request body
        const body: WinRequest = await request.json();
        const userAddress = body.userAddress;
        const winAmount = body.winAmount;
        const currency = (body.currency || 'USDC') as string;
        const betId = body.betId;
        const settlementToken = body.settlementToken;
        const allowTestBypass = process.env.NODE_ENV === 'test';

        // Validate required fields
        if (!userAddress || winAmount === undefined || winAmount === null) {
            return NextResponse.json(
                { error: 'Missing required fields: userAddress, winAmount' },
                { status: 400 }
            );
        }
        if (!betId || (!settlementToken && !allowTestBypass)) {
            return NextResponse.json(
                { error: 'Missing required fields: betId, settlementToken' },
                { status: 400 }
            );
        }

        // Validate address using utility
        const { isValidAddress } = await import('@/lib/utils/address');
        if (!(await isValidAddress(userAddress))) {
            return NextResponse.json(
                { error: 'Invalid wallet address format' },
                { status: 400 }
            );
        }

        // Validate win amount is positive
        if (winAmount <= 0) {
            return NextResponse.json(
                { error: 'Win amount must be greater than zero' },
                { status: 400 }
            );
        }

        if (await isWalletGloballyBanned(userAddress)) {
            return NextResponse.json(
                { error: 'This wallet is banned from the platform.' },
                { status: 403 }
            );
        }

        const userKey = canonicalHouseUserAddress(userAddress);
        const normalizedCurrency = currency.toUpperCase();
        if (normalizedCurrency !== 'USDC') {
            return NextResponse.json({ error: 'Unsupported currency' }, { status: 400 });
        }

        if (settlementToken) {
            const tokenPayload = verifySettlementToken(settlementToken);
            if (!tokenPayload) {
                return NextResponse.json({ error: 'Invalid settlement token' }, { status: 401 });
            }
            if (
                tokenPayload.betId !== betId ||
                canonicalHouseUserAddress(tokenPayload.userAddress) !== userKey ||
                tokenPayload.currency !== normalizedCurrency
            ) {
                return NextResponse.json({ error: 'Settlement token does not match bet' }, { status: 401 });
            }
            if (winAmount > tokenPayload.maxPayout + 1e-8) {
                return NextResponse.json({ error: 'Win amount exceeds approved payout' }, { status: 400 });
            }
        }

        // ── Atomic deduplication guard ──────────────────────────────────────
        // Insert a lock row first; if it conflicts, the payout was already processed.
        const { error: lockError } = await supabase
            .from('balance_audit_log')
            .insert({
                user_address: userKey,
                currency: normalizedCurrency,
                operation_type: 'payout_lock',
                amount: 0,
                bet_id: betId,
                transaction_hash: `lock:${betId}`,
            });
        if (lockError) {
            if (lockError.code === '23505') {
                console.warn(`[balance/win] duplicate payout blocked for betId=${betId}`);
                return NextResponse.json({ success: true, duplicate: true, winAmount });
            }
        }

        const { data: existing } = await supabase
            .from('balance_audit_log')
            .select('id')
            .eq('operation_type', 'payout')
            .eq('bet_id', betId)
            .limit(1);
        if (existing && existing.length > 0) {
            console.warn(`[balance/win] duplicate payout blocked for betId=${betId}`);
            return NextResponse.json({ success: true, duplicate: true, winAmount });
        }

        // Call credit_balance_for_payout stored procedure
        const { data, error } = await supabase.rpc('credit_balance_for_payout', {
            p_user_address: userKey,
            p_payout_amount: winAmount,
            p_currency: normalizedCurrency,
            p_bet_id: betId,
        });

        // Handle database errors
        if (error) {
            console.error('Database error in win credit:', error);
            return NextResponse.json(
                { error: 'Service temporarily unavailable. Please try again.' },
                { status: 503 }
            );
        }

        // Parse the JSON result from the stored procedure
        const result = data as { success: boolean; error: string | null; new_balance: number };

        // Check if the procedure reported an error
        if (!result.success) {
            return NextResponse.json(
                { error: result.error || 'Failed to credit winnings' },
                { status: 400 }
            );
        }

        // Return success with new balance
        return NextResponse.json({
            success: true,
            newBalance: parseFloat(result.new_balance.toString()),
            winAmount: winAmount
        });

    } catch (error) {
        console.error('Unexpected error in POST /api/balance/win:', error);
        return NextResponse.json(
            { error: 'An error occurred processing your request' },
            { status: 500 }
        );
    }
}
