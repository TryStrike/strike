'use client';

import React, { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { ArrowClockwise } from '@phosphor-icons/react';
import { Button } from '@/components/ui/kit';
import { DepositModal, type DepositProof } from './DepositModal';
import { WithdrawModal, type WithdrawRequestDetails } from './WithdrawModal';
import { ReceiptDrawer, type ReceiptData } from './ReceiptDrawer';
import { useToast } from '@/lib/hooks/useToast';
import { ARC_ASSETS } from '@/lib/arc/config';
import { resolveHouseLedgerCurrency } from '@/lib/balance/houseLedgerCurrency';
import { calculateFeeAmount } from '@/lib/fees/platformFee';


const nowMs = () => Date.now();

export const BalanceDisplay: React.FC = () => {
  const houseBalance = useStore(state => state.houseBalance);
  const houseBalanceKnown = useStore(state => state.houseBalanceKnown);
  const network = useStore(state => state.network);
  const userTier = useStore(state => state.userTier);
  const selectedCurrency = useStore(state => state.selectedCurrency);
  const setSelectedCurrency = useStore(state => state.setSelectedCurrency);
  const isLoading = useStore(state => state.isLoading);
  const address = useStore(state => state.address);
  const fetchBalance = useStore(state => state.fetchBalance);
  const toast = useToast();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);
  const [isReceiptOpen, setIsReceiptOpen] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  useEffect(() => {
    if (!address || !network) return;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (!cancelled) void fetchBalance(address);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [address, network, selectedCurrency, fetchBalance]);

  const handleRefresh = async () => {
    if (!address || isLoading) return;

    setIsRefreshing(true);
    try {
      await fetchBalance(address);
      toast.success('Balance refreshed');
    } catch (error) {
      console.error('Error refreshing balance:', error);
      toast.error('Failed to refresh balance');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleDeposit = () => {
    setIsDepositModalOpen(true);
  };

  const handleWithdraw = () => {
    setIsWithdrawModalOpen(true);
  };

  const handleDepositSuccess = (amount: number, txHash: string, proof?: DepositProof) => {
    const fee = typeof proof?.fee === 'number' ? proof.fee : calculateFeeAmount(amount, userTier);
    const net =
      typeof proof?.netCredited === 'number' ? proof.netCredited : amount - fee;
    const creditedAtMs = proof?.creditedAt ? Date.parse(proof.creditedAt) : NaN;
    setReceipt({
      kind: 'deposit',
      amount,
      fee,
      net,
      chain: network || 'ARC',
      currency: currentSymbol,
      txHash: proof?.txHash ?? txHash,
      createdAt: Number.isFinite(creditedAtMs) ? creditedAtMs : nowMs(),
      status: 'confirmed',
    });
    setIsReceiptOpen(true);
  };

  const handleWithdrawSuccess = (
    amount: number,
    txHash: string,
    requestId?: number,
    details?: WithdrawRequestDetails
  ) => {
    const fee = typeof details?.feeAmount === 'number' ? details.feeAmount : calculateFeeAmount(amount, userTier);
    const net = typeof details?.netAmount === 'number' ? details.netAmount : amount - fee;
    const requestedAtMs = details?.requestedAt ? Date.parse(details.requestedAt) : NaN;
    setReceipt({
      kind: 'withdrawal',
      amount,
      fee,
      net,
      chain: network || 'ARC',
      currency: currentSymbol,
      txHash,
      createdAt: Number.isFinite(requestedAtMs) ? requestedAtMs : nowMs(),
      status: txHash === 'PENDING' ? 'pending' : 'confirmed',
      requestId,
    });
    setIsReceiptOpen(true);
  };

  const formattedBalance = houseBalanceKnown ? houseBalance.toFixed(4) : "--";

  const currentSymbol = resolveHouseLedgerCurrency({ selectedCurrency });

  return (
    <>
      <div className="font-tight text-ink">
        <div className="flex items-center justify-between">
          <span className="text-sm text-subtle">
            House Balance
          </span>

          <div className="flex items-center gap-1">
              {ARC_ASSETS.length > 1 && ARC_ASSETS.map((asset) => (
                <button
                  key={asset}
                  type="button"
                  onClick={() => {
                    setSelectedCurrency(asset);
                    setTimeout(() => fetchBalance(address!), 100);
                  }}
                  className={`rounded-full px-2 py-0.5 font-jet text-[11px] transition-colors ${currentSymbol === asset ? 'bg-surface text-ink' : 'text-faint hover:text-ink'}`}
                >
                  {asset}
                </button>
              ))}
              <button
                type="button"
                onClick={handleRefresh}
                disabled={!address || isLoading || isRefreshing}
                title="Refresh balance"
                aria-label="Refresh balance"
                className="flex h-8 w-8 items-center justify-center rounded-full text-faint transition-colors hover:bg-surface hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                <ArrowClockwise size={16} className={isRefreshing ? 'animate-spin' : ''} />
              </button>
          </div>
        </div>

        {isLoading ? (
          <div className="mt-1 h-10 w-40 animate-pulse rounded-lg bg-surface" />
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-jet text-[32px] font-semibold leading-10 tracking-[-0.04em] tabular-nums">
              {formattedBalance}
            </span>
            <span className="font-jet text-sm text-faint">{currentSymbol}</span>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2">
            <Button onClick={handleDeposit} disabled={!address || isLoading} variant="primary" size="sm">
              Deposit
            </Button>
            <Button
              onClick={handleWithdraw}
              disabled={!address || isLoading || houseBalance <= 0}
              variant="secondary"
              size="sm"
            >
              Withdraw
            </Button>
          </div>

        {!address && (
          <p className="mt-3 text-[13px] text-subtle">Connect a wallet to see your balance.</p>
        )}
      </div>

      <DepositModal
        isOpen={isDepositModalOpen}
        onClose={() => setIsDepositModalOpen(false)}
        onSuccess={handleDepositSuccess}
      />

      <WithdrawModal
        isOpen={isWithdrawModalOpen}
        onClose={() => setIsWithdrawModalOpen(false)}
        onSuccess={handleWithdrawSuccess}
      />

      <ReceiptDrawer
        open={isReceiptOpen}
        onClose={() => setIsReceiptOpen(false)}
        receipt={receipt}
      />
    </>
  );
};
