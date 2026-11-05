import { NextRequest, NextResponse } from 'next/server';
import { walletAddressSearchVariants } from '@/lib/admin/walletAddressVariants';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';
import { calculateFeeAmount, collectPlatformFeeFromTreasury } from '@/lib/fees/platformFee';
import { supabaseService as supabase } from '@/lib/supabase/serviceClient';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { isWalletGloballyBanned } from '@/lib/bans/walletBan';
import { ethers } from 'ethers';
import type { ArcAsset } from '@/lib/arc/config';

async function executeTreasuryWithdrawal(
  userAddress: string,
  currency: string,
  amount: number,
  feeAmountOverride?: number,
) {
  const normalizedCurrency = currency.toUpperCase();
  if (normalizedCurrency !== 'USDC') {
    throw new Error(`Unsupported currency for withdrawal: ${currency}`);
  }
  const asset = normalizedCurrency as ArcAsset;
  const feeAmount =
    typeof feeAmountOverride === 'number' && Number.isFinite(feeAmountOverride)
      ? feeAmountOverride
      : calculateFeeAmount(amount);
  const netWithdrawAmount = amount - feeAmount;

  if (netWithdrawAmount <= 0) {
    throw new Error('Withdrawal net amount after fees must be > 0');
  }

  const feeTxHash = await collectPlatformFeeFromTreasury(asset, feeAmount);
  const { transferFromTreasury } = await import('@/lib/arc/backend-client');
  const withdrawTxHash = await transferFromTreasury(
    userAddress,
    netWithdrawAmount,
    asset
  );
  const combinedTxHash = feeTxHash ? `${feeTxHash}|netTx:${withdrawTxHash}` : withdrawTxHash;
  return { combinedTxHash, withdrawTxHash, feeTxHash, feeAmount, netWithdrawAmount };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const deny = requireAdminAuth(request);
  if (deny) return deny;
  try {
    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Invalid request id' }, { status: 400 });
    }

    // Explicit column selection to avoid exposing sensitive future columns
    const { data: req, error: reqError } = await supabase
      .from('withdrawal_requests')
      .select('id, user_address, currency, amount, net_amount, fee_amount, requested_at, status, decided_by, tx_hash, signature, signed_at, created_at')
      .eq('id', id)
      .single();

    if (reqError) throw reqError;
    if (!req) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    if (req.status !== 'pending') {
      return NextResponse.json({ error: `Cannot accept request in status: ${req.status}` }, { status: 400 });
    }

    const userAddress = String(req.user_address).trim();
    const currency = String(req.currency);
    const amount = Number(req.amount);
    const normalizedCurrency = currency.toUpperCase();

    // Global ban list must block approval — user_balances.status may still be "active"
    // if only banned_wallets was updated (instant /api/balance/withdraw already checks this).
    if (await isWalletGloballyBanned(userAddress)) {
      return NextResponse.json(
        {
          error:
            'This wallet is on the global ban list. Reject the withdrawal; treasury payout is not allowed.',
        },
        { status: 403 },
      );
    }

    // Re-verify the signed intent. Every settled asset lives on Arc, an
    // EVM chain, so the signature is always required - an admin accepting a
    // request must never be able to move funds the user did not authorise.
    if (!req.signature || !req.signed_at) {
      return NextResponse.json({ error: 'Missing signed withdrawal authorization' }, { status: 401 });
    }
    {
      const signedAt = Number(req.signed_at);

      // The wallet signs the address in whatever casing it reports — wagmi hands
      // back the checksummed form — but the row stores it lowercased. Rebuilding
      // the message from the stored value alone therefore recovers a different
      // signer, so try both spellings before rejecting.
      const spellings = new Set([userAddress]);
      try {
        spellings.add(ethers.getAddress(userAddress));
      } catch {
        // Not a checksummable address; the stored form is all we have.
      }

      const matches = Array.from(spellings).some((spelling) => {
        const message = `STRIKE withdrawal authorization\naddress:${spelling}\namount:${amount.toFixed(8)}\ncurrency:${normalizedCurrency}\nsignedAt:${signedAt}`;
        try {
          const recovered = ethers.verifyMessage(message, String(req.signature));
          return canonicalHouseUserAddress(recovered) === canonicalHouseUserAddress(userAddress);
        } catch {
          return false;
        }
      });

      if (!matches) {
        return NextResponse.json({ error: 'Invalid withdrawal signature' }, { status: 401 });
      }
    }

    const addrVariants = walletAddressSearchVariants(userAddress);

    const { data: balRows, error: userError } = await supabase
      .from('user_balances')
      .select('balance, status, user_address')
      .in('user_address', addrVariants)
      .eq('currency', currency);

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
      return NextResponse.json({ error: 'Insufficient house balance for acceptance' }, { status: 400 });
    }
    const dbAddress = userRow.user_address;

    // Execute chain transfers.
    const feeAmountFromRequest = Number(req.fee_amount);
    const { combinedTxHash, feeTxHash } = await executeTreasuryWithdrawal(
      userAddress.trim(),
      currency,
      amount,
      Number.isFinite(feeAmountFromRequest) ? feeAmountFromRequest : undefined,
    );

    // Update Supabase balance (deducts user's balance and logs withdrawal audit).
    const { data: updData, error: updError } = await supabase.rpc('update_balance_for_withdrawal', {
      p_user_address: dbAddress,
      p_withdrawal_amount: amount,
      p_currency: currency,
      p_transaction_hash: combinedTxHash,
    });

    if (updError) {
      return NextResponse.json({ error: updError.message || 'Balance update failed' }, { status: 500 });
    }

    const { error: updateReqError } = await supabase
      .from('withdrawal_requests')
      .update({
        status: 'accepted',
        decided_at: new Date().toISOString(),
        decided_by: 'admin',
        tx_hash: combinedTxHash,
        fee_tx_hash: feeTxHash,
      })
      .eq('id', id);

    if (updateReqError) throw updateReqError;

    return NextResponse.json({ success: true, newBalance: updData?.new_balance });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to accept withdrawal request' }, { status: 500 });
  }
}

