/**
 * GET /api/balance/[address] endpoint
 * 
 * Task: 4.1 Create GET /api/balance/[address] endpoint
 * Requirements: 2.3
 * 
 * Returns the current house balance for a user address.
 * Handles user not found by returning 0 balance.
 * Includes error handling for database errors.
 */

import { NextRequest, NextResponse } from 'next/server';
import { walletAddressSearchVariants } from '@/lib/admin/walletAddressVariants';
import { isWalletGloballyBanned } from '@/lib/bans/walletBan';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { isValidAddress } from '@/lib/utils/address';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    // Await params in Next.js 15+
    const { address } = await params;

    const { searchParams } = new URL(request.url);
    const currency = searchParams.get('currency') || 'USDC';

    const isValid = await isValidAddress(address);

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid wallet address format (an Arc address is required)' },
        { status: 400 }
      );
    }

    const variants = walletAddressSearchVariants(address);

    // Sum balances across legacy duplicate rows (e.g. mixed EVM casing)
    const { data: balRows, error } = await supabase
      .from('user_balances')
      .select('balance, updated_at, user_address')
      .in('user_address', variants)
      .eq('currency', currency);

    if (error) {
      console.error('Database error fetching balance:', error);
      return NextResponse.json(
        { error: 'Service temporarily unavailable. Please try again.' },
        { status: 503 }
      );
    }

    if (!balRows?.length) {
      const globallyBanned = await isWalletGloballyBanned(address);
      return NextResponse.json({
        balance: 0,
        updatedAt: null,
        tier: 'free',
        globallyBanned,
      });
    }

    const totalBalance = balRows.reduce((s, r) => s + parseFloat(String(r.balance)), 0);
    const latestRow = balRows.reduce((best, r) =>
      !best || new Date(r.updated_at) > new Date(best.updated_at) ? r : best,
    balRows[0]);

    const userKey = canonicalHouseUserAddress(address);
    const tierSource =
      balRows.find(r => r.user_address === userKey) ?? latestRow;

    let userTier = 'free';
    try {
      const { data: tierData } = await supabase
        .from('user_balances')
        .select('user_tier')
        .eq('user_address', tierSource.user_address)
        .eq('currency', currency)
        .single();

      if (tierData && (tierData as { user_tier?: string }).user_tier) {
        userTier = String((tierData as { user_tier?: string }).user_tier);
      }
    } catch (e) {
      console.warn('Could not fetch user_tier, defaulting to free:', e);
    }

    const globallyBanned = await isWalletGloballyBanned(address);

    return NextResponse.json({
      balance: totalBalance,
      updatedAt: latestRow.updated_at,
      tier: userTier,
      globallyBanned,
    });
  } catch (error) {
    // Handle unexpected errors
    console.error('Unexpected error in GET /api/balance/[address]:', error);
    return NextResponse.json(
      { error: 'An error occurred processing your request' },
      { status: 500 }
    );
  }
}
