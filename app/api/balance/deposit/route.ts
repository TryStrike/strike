/**
 * POST /api/balance/deposit endpoint
 * 
 * Called by blockchain event listener after deposit transaction.
 * Updates house balance by adding deposit amount.
 * Inserts audit log entry with operation_type='deposit'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { isValidAddress } from '@/lib/utils/address';
import { calculateFeeAmount, collectPlatformFeeFromTreasury, getFeePercentLabel } from '@/lib/fees/platformFee';
import { isWalletGloballyBanned } from '@/lib/bans/walletBan';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { assertBalanceApiAuthorized } from '@/lib/balance/balanceApiGuard';

interface DepositRequest {
  userAddress: string;
  amount: number;
  txHash: string;
  currency: string;
}

export async function POST(request: NextRequest) {
  try {
    const unauthorized = assertBalanceApiAuthorized(request);
    if (unauthorized) return unauthorized;

    // Parse request body
    const body: DepositRequest = await request.json();
    const { userAddress, amount, txHash, currency = 'USDC' } = body;

    // Validate required fields
    if (!userAddress || amount === undefined || amount === null || !txHash) {
      return NextResponse.json(
        { error: 'Missing required fields: userAddress, amount, txHash' },
        { status: 400 }
      );
    }

    // Guard against NaN / Infinity which bypass > 0 checks
    if (!Number.isFinite(Number(amount))) {
      return NextResponse.json(
        { error: 'Invalid deposit amount' },
        { status: 400 }
      );
    }

    const isValid = await isValidAddress(userAddress);

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid wallet address format (an Arc address is required)' },
        { status: 400 }
      );
    }

    if (await isWalletGloballyBanned(userAddress)) {
      return NextResponse.json(
        { error: 'This wallet is banned from the platform.' },
        { status: 403 }
      );
    }

    // Validate amount is positive
    if (amount <= 0) {
      return NextResponse.json(
        { error: 'Deposit amount must be greater than zero' },
        { status: 400 }
      );
    }

    const normalizedCurrency = currency.toUpperCase();
    const supportedCurrencies = new Set(['USDC']);
    if (!supportedCurrencies.has(normalizedCurrency)) {
      return NextResponse.json(
        { error: `Unsupported deposit currency: ${normalizedCurrency}` },
        { status: 400 }
      );
    }
    // ── Idempotency: reject if this txHash was already credited ──
    // Check both the raw txHash AND any combinedTxHash variant (e.g. txHash|feeTx:…)
    // This prevents replay when fee collection generates a combined hash stored in the audit log
    const { data: existingTxByHash } = await supabase
      .from('balance_audit_log')
      .select('id, transaction_hash')
      .eq('operation_type', 'deposit')
      .or(`transaction_hash.eq.${txHash},transaction_hash.like.${txHash}|feeTx:%`)
      .limit(1);
    if (existingTxByHash && existingTxByHash.length > 0) {
      return NextResponse.json(
        { error: 'This transaction has already been credited' },
        { status: 409 }
      );
    }

    // Look up user tier from DB instead of trusting client
    const depositUserKey = canonicalHouseUserAddress(userAddress);
    let resolvedTier: 'free' | 'standard' | 'vip' = 'free';
    try {
      const { data: tierRow } = await supabase
        .from('user_balances')
        .select('tier')
        .eq('user_address', depositUserKey)
        .limit(1)
        .single();
      if (tierRow?.tier && ['free', 'standard', 'vip'].includes(tierRow.tier)) {
        resolvedTier = tierRow.tier as 'free' | 'standard' | 'vip';
      }
    } catch {
      // New user — default tier is fine
    }

    const feeAmount = calculateFeeAmount(amount, resolvedTier);
    const netDepositAmount = amount - feeAmount;
    const feePercentLabel = getFeePercentLabel(resolvedTier);

    if (netDepositAmount <= 0) {
      return NextResponse.json(
        { error: `Deposit amount after ${feePercentLabel} fee must be greater than zero` },
        { status: 400 }
      );
    }

    // Verify the transfer on-chain before crediting.
    const { verifyArcDepositTx } = await import('@/lib/balance/verifyArcDepositTx');
    const verified = await verifyArcDepositTx(
      txHash,
      userAddress,
      amount,
      normalizedCurrency as 'USDC'
    );
    if (!verified) {
      return NextResponse.json(
        { error: 'Deposit transaction could not be verified on-chain' },
        { status: 400 }
      );
    }
    // Tiered platform/protocol fee: move the fee portion from treasury to a dedicated collector wallet.
    // A failure here must NOT block the user's deposit — log the error and continue.
    let feeTxHash: string | null = null;
    try {
      feeTxHash = await collectPlatformFeeFromTreasury(normalizedCurrency, feeAmount);
    } catch (feeErr) {
      console.error('[deposit] Fee collection failed (non-blocking):', feeErr);
    }
    const combinedTxHash = feeTxHash ? `${txHash}|feeTx:${feeTxHash}` : txHash;

    const userKey = canonicalHouseUserAddress(userAddress);

    // Call update_balance_for_deposit stored procedure
    const { data, error } = await supabase.rpc('update_balance_for_deposit', {
      p_user_address: userKey,
      p_deposit_amount: netDepositAmount,
      p_currency: normalizedCurrency,
      p_transaction_hash: combinedTxHash,
    });

    // Handle database errors
    if (error) {
      console.error('Database error in deposit:', error);
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
        { error: result.error || 'Deposit failed' },
        { status: 400 }
      );
    }

    // Log the platform fee so the admin dashboard can track per-wallet fee totals.
    // Non-blocking — a fee logging failure must never break the deposit.
    if (feeAmount > 0) {
      supabase.from('balance_audit_log').insert({
        user_address: userKey,
        currency: normalizedCurrency,
        operation_type: 'platform_fee',
        amount: feeAmount,
        transaction_hash: `fee:deposit:${combinedTxHash}`,
      }).then(({ error: feeErr }) => {
        if (feeErr) console.warn('[deposit] fee log failed (non-blocking):', feeErr.message);
      });
    }

    // Return success with new balance
    return NextResponse.json({
      success: true,
      newBalance: parseFloat(result.new_balance.toString()),
    });
  } catch (error) {
    // Handle unexpected errors
    console.error('Unexpected error in POST /api/balance/deposit:', error);
    return NextResponse.json(
      { error: 'An error occurred processing your request' },
      { status: 500 }
    );
  }
}
