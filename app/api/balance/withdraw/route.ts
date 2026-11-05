import { NextRequest, NextResponse } from 'next/server';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';

const FREQUENCY_REVIEW_THRESHOLD = 10; // withdrawals before manual review kicks in
import { ethers } from 'ethers';
import { calculateFeeAmount, getFeePercentLabel } from '@/lib/fees/platformFee';
import { isWalletGloballyBanned } from '@/lib/bans/walletBan';
import { walletAddressSearchVariants } from '@/lib/admin/walletAddressVariants';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { assertBalanceApiAuthorized } from '@/lib/balance/balanceApiGuard';
import { isAuthorizationFresh } from '@/lib/balance/withdrawalIntent';
import { isWithdrawalFrequencyReviewExemptWallet } from '@/lib/withdrawals/frequencyReviewExempt';

interface WithdrawRequest {
  userAddress: string;
  amount: number;
  currency: string;
  signature?: string;
  signedAt?: number;
}

export async function POST(request: NextRequest) {
  try {
    const unauthorized = assertBalanceApiAuthorized(request);
    if (unauthorized) return unauthorized;

    const body: WithdrawRequest = await request.json();
    const allowTestBypass = process.env.NODE_ENV === 'test';
    const {
      userAddress,
      amount,
      currency = 'USDC',
      signature: authorizationSignature,
      signedAt,
    } = body;

    // Validate required fields
    if (!userAddress || amount === undefined || amount === null) {
      return NextResponse.json(
        { error: 'Missing required fields: userAddress, amount' },
        { status: 400 }
      );
    }

    // Guard against NaN / Infinity which bypass > 0 checks
    if (!Number.isFinite(Number(amount))) {
      return NextResponse.json(
        { error: 'Invalid withdrawal amount' },
        { status: 400 }
      );
    }

    const normalizedCurrency = currency.toUpperCase();

    // Validate address using utility
    const { isValidAddress } = await import('@/lib/utils/address');
    if (!(await isValidAddress(userAddress))) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }

    if (await isWalletGloballyBanned(userAddress)) {
      return NextResponse.json(
        { error: 'This wallet is banned from the platform.' },
        { status: 403 }
      );
    }

    if (amount <= 0) {
      return NextResponse.json(
        { error: 'Withdrawal amount must be greater than zero' },
        { status: 400 }
      );
    }

    // Require a signed withdrawal intent.
    if (!allowTestBypass) {
      if (!authorizationSignature || !signedAt) {
        return NextResponse.json(
          { error: 'Missing signed withdrawal authorization' },
          { status: 401 }
        );
      }

      if (!isAuthorizationFresh(signedAt)) {
        return NextResponse.json(
          { error: 'Withdrawal authorization expired. Please sign again.' },
          { status: 401 }
        );
      }

      // The client signs the Arc USDC ledger currency verbatim.
      const expectedMessage = `STRIKE withdrawal authorization\naddress:${userAddress}\namount:${amount.toFixed(8)}\ncurrency:${normalizedCurrency}\nsignedAt:${signedAt}`;
      const recovered = ethers.verifyMessage(expectedMessage, authorizationSignature);
      if (canonicalHouseUserAddress(recovered) !== canonicalHouseUserAddress(userAddress)) {
        return NextResponse.json(
          { error: 'Invalid withdrawal signature' },
          { status: 401 }
        );
      }
    }

    const addrVariants = walletAddressSearchVariants(userAddress);

    // 1. Get house balance and status from Supabase and validate (merge legacy EVM casing rows)
    const { data: balRows, error: userError } = await supabase
      .from('user_balances')
      .select('balance, status, user_address')
      .in('user_address', addrVariants)
      .eq('currency', normalizedCurrency);

    if (userError || !balRows?.length) {
      return NextResponse.json({ error: 'User record not found' }, { status: 404 });
    }

    for (const row of balRows) {
      if (row.status === 'frozen') {
        return NextResponse.json({ error: 'Account is frozen. Withdrawals are disabled.' }, { status: 403 });
      }
      if (row.status === 'banned') {
        return NextResponse.json({ error: 'Account is banned.' }, { status: 403 });
      }
    }

    const sortedByBal = [...balRows].sort((a, b) => Number(b.balance) - Number(a.balance));
    const userRow = sortedByBal.find(r => Number(r.balance) >= amount);
    if (!userRow) {
      return NextResponse.json({ error: `Insufficient house balance in ${currency}` }, { status: 400 });
    }

    const dbAddress = userRow.user_address;
    const userData = { balance: userRow.balance, status: userRow.status };

    // ── Withdrawal cap: max payout = total_deposited × 1.08 ──
    const [depositRes, withdrawnRes, pendingRes] = await Promise.all([
      supabase
        .from('balance_audit_log')
        .select('amount')
        .in('user_address', addrVariants)
        .eq('currency', normalizedCurrency)
        .eq('operation_type', 'deposit'),
      supabase
        .from('balance_audit_log')
        .select('amount')
        .in('user_address', addrVariants)
        .eq('currency', normalizedCurrency)
        .eq('operation_type', 'withdrawal'),
      supabase
        .from('withdrawal_requests')
        .select('amount')
        .in('user_address', addrVariants)
        .eq('currency', normalizedCurrency)
        .in('status', ['pending', 'approved']),
    ]);

    const totalDeposited   = (depositRes.data  ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
    const totalWithdrawn   = (withdrawnRes.data ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
    const pendingTotal     = (pendingRes.data   ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);

    if (totalDeposited > 0) {
      const maxWithdrawable  = totalDeposited * 1.08;
      const alreadyOut       = totalWithdrawn + pendingTotal;
      const remainingAllowed = Math.max(0, maxWithdrawable - alreadyOut);

      if (alreadyOut + amount > maxWithdrawable) {
        return NextResponse.json(
          {
            error: `Withdrawal amount exceeds your available limit. You have ${remainingAllowed > 0 ? `${remainingAllowed.toFixed(6)} ${normalizedCurrency} remaining` : 'no remaining withdrawal allowance'}. Please contact support if you believe this is an error.`,
          },
          { status: 400 },
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Count ALL completed + pending withdrawals for this user .
    // Completed ones are tracked in balance_audit_log (operation_type='withdrawal').
    // Pending (not yet processed) ones are in withdrawal_requests with status='pending'.
    // We intentionally count across ALL currencies/chains — abuse detection is global.
    const [auditCountRes, pendingCountRes] = await Promise.all([
      supabase
        .from('balance_audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('operation_type', 'withdrawal')
        .in('user_address', addrVariants),
      supabase
        .from('withdrawal_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .in('user_address', addrVariants),
    ]);
    const withdrawalCount = (auditCountRes.count ?? 0) + (pendingCountRes.count ?? 0);
    const isFrequencyReviewExempt = isWithdrawalFrequencyReviewExemptWallet(userAddress);
    const triggersFrequencyReview =
      !isFrequencyReviewExempt &&
      withdrawalCount >= FREQUENCY_REVIEW_THRESHOLD;

    // 2. Resolve user tier from DB — never trust client-supplied value.
    let resolvedTier: 'free' | 'standard' | 'vip' = 'free';
    try {
      const { data: tierRow } = await supabase
        .from('user_balances')
        .select('tier')
        .eq('user_address', dbAddress)
        .limit(1)
        .single();
      if (tierRow?.tier && ['free', 'standard', 'vip'].includes(tierRow.tier)) {
        resolvedTier = tierRow.tier as 'free' | 'standard' | 'vip';
      }
    } catch {
      // default tier is fine
    }

    const feeAmount = Number(calculateFeeAmount(amount, resolvedTier).toFixed(8));
    const netWithdrawAmount = Number((amount - feeAmount).toFixed(8));
    const feePercentLabel = getFeePercentLabel(resolvedTier);

    if (netWithdrawAmount <= 0) {
      return NextResponse.json(
        { error: `Withdrawal amount after ${feePercentLabel} fee must be greater than zero` },
        { status: 400 }
      );
    }

    const { data: pendingRow, error: pendingError } = await supabase
      .from('withdrawal_requests')
      .insert({
        user_address: canonicalHouseUserAddress(userAddress),
        currency: normalizedCurrency,
        amount,
        fee_amount: feeAmount,
        net_amount: netWithdrawAmount,
        signature: authorizationSignature || null,
        signed_at: signedAt || null,
        status: 'pending',
        // Stamp the reason so the dashboard can distinguish security/manual-review cases.
        decided_by: triggersFrequencyReview
          ? `FREQUENCY_REVIEW:count=${withdrawalCount + 1}`
          : null,
      })
      .select('*')
      .single();

    if (pendingError) {
      return NextResponse.json({ error: 'Failed to create withdrawal request. Please try again.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      status: 'pending',
      requestId: pendingRow.id,
      newBalance: userData.balance,
      frequencyReview: triggersFrequencyReview,
      withdrawalCount: withdrawalCount + 1,
    });
  } catch (error) {
    console.error('Unexpected error in POST /api/balance/withdraw:', error);
    return NextResponse.json(
      { error: 'An error occurred processing your request' },
      { status: 500 }
    );
  }
}
