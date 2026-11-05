'use client';

import React, { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { ArrowClockwise } from '@phosphor-icons/react';
import { Button } from '@/components/ui/kit';
import { DepositModal } from './DepositModal';
import { WithdrawModal } from './WithdrawModal';
import { ReceiptDrawer, type ReceiptData } from './ReceiptDrawer';
import { useToast } from '@/lib/hooks/useToast';
import { ARC_ASSETS } from '@/lib/arc/config';
import { resolveHouseLedgerCurrency } from '@/lib/balance/houseLedgerCurrency';

/**
 * BalanceDisplay Component
 * 
 * Displays the user's house balance with controls for deposit and withdrawal
 * 
 * Task: 8.1 Create BalanceDisplay component
 * Requirements: 8.1
 * 
 * Features:
 * - Display current house balance with chain-appropriate symbol
 * - Refresh button to fetch latest balance
 * - Deposit and Withdraw buttons with modals
 * - Show loading state while fetching
 * - Format balance to 4 decimal places
 */
export const BalanceDisplay: React.FC = () => {
  const houseBalance = useStore(state => state.houseBalance);
  const demoBalance = useStore(state => state.demoBalance);
  const accountType = useStore(state => state.accountType);
  const network = useStore(state => state.network);
  const userTier = useStore(state => state.userTier);
  const selectedCurrency = useStore(state => state.selectedCurrency);
  const setSelectedCurrency = useStore(state => state.setSelectedCurrency);
  const toggleAccountType = useStore(state => state.toggleAccountType);
  const isLoading = useStore(state => state.isLoading);
  const address = useStore(state => state.address);
  const fetchBalance = useStore(state => state.fetchBalance);
  const updateBalance = useStore(state => state.updateBalance);
  const toast = useToast();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);
  const [isReceiptOpen, setIsReceiptOpen] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const feePercent = userTier === 'vip' ? 0.08 : userTier === 'standard' ? 0.09 : 0.10;

  // House credits: sync when this panel mounts or wallet / ledger currency changes.
  // WalletSync only refreshed on-chain balance; fetchBalance loads the house balance.
  useEffect(() => {
    if (accountType === 'demo' || !address || !network) return;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (!cancelled) void fetchBalance(address);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [accountType, address, network, selectedCurrency, fetchBalance]);

  // Actions from other slices (using the unified store)
  const setAddress = useStore(state => state.setAddress);
  const setIsConnected = useStore(state => state.setIsConnected);

  /**
   * Exit demo mode and reset demo credentials
   */
  const handleExitDemo = () => {
    toggleAccountType(); // Switch back to 'real'
    setAddress(null);    // Clear 0xDEMO address
    setIsConnected(false); // Logout from demo session
    toast.info('Returned to real account');
  };

  /**
   * Handle refresh button click
   * Fetches the latest balance from the API
   */
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

  /**
   * Handle deposit button click
   * Opens the deposit modal
   */
  const handleDeposit = () => {
    setIsDepositModalOpen(true);
  };

  /**
   * Handle withdraw button click
   * Opens the withdraw modal
   */
  const handleWithdraw = () => {
    setIsWithdrawModalOpen(true);
  };

  /**
   * Handle successful deposit
   * Refreshes balance and shows success message
   */
  const handleDepositSuccess = async (amount: number, txHash: string) => {
    const fee = amount * feePercent;
    setReceipt({
      kind: 'deposit',
      amount,
      fee,
      net: amount - fee,
      chain: network || 'ARC',
      currency: currentSymbol,
      txHash,
      createdAt: Date.now(),
      status: 'confirmed',
    });
    setIsReceiptOpen(true);
  };

  /**
   * Handle successful withdrawal
   * Refreshes balance and shows success message
   */
  const handleWithdrawSuccess = async (amount: number, txHash: string) => {
    const fee = amount * feePercent;
    setReceipt({
      kind: 'withdrawal',
      amount,
      fee,
      net: amount - fee,
      chain: network || 'ARC',
      currency: currentSymbol,
      txHash,
      createdAt: Date.now(),
      status: txHash === 'PENDING' ? 'pending' : 'confirmed',
    });
    setIsReceiptOpen(true);
  };

  // Choose balance based on account type
  const activeBalance = accountType === 'real' ? houseBalance : demoBalance;
  const formattedBalance = activeBalance.toFixed(4);

  // The ledger row the player is playing with.
  const currentSymbol = resolveHouseLedgerCurrency({ selectedCurrency });

  return (
    <>
      <div className="font-tight text-ink">
        <div className="flex items-center justify-between">
          <span className="text-sm text-subtle">
            {accountType === 'demo' ? 'Practice Balance' : 'House Balance'}
          </span>

          {accountType === 'real' && (
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
          )}
        </div>

        {isLoading && accountType === 'real' ? (
          <div className="mt-1 h-10 w-40 animate-pulse rounded-lg bg-surface" />
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-jet text-[32px] font-semibold leading-10 tracking-[-0.04em] tabular-nums">
              {formattedBalance}
            </span>
            <span className="font-jet text-sm text-faint">{currentSymbol}</span>
          </div>
        )}

        {accountType === 'demo' ? (
          <>
            <p className="mt-2 text-[13px] text-subtle">
              Practice funds, no real USDC.{' '}
              <button type="button" onClick={handleExitDemo} className="font-medium text-ink underline-offset-2 hover:underline">
                Exit practice
              </button>
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => updateBalance(10000 - demoBalance, 'add')}
              className="mt-4 w-full"
            >
              Reset Practice Balance
            </Button>
          </>
        ) : (
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
        )}

        {!address && (
          <p className="mt-3 text-[13px] text-subtle">Connect a wallet to see your balance.</p>
        )}
      </div>

      {/* Deposit Modal */}
      <DepositModal
        isOpen={isDepositModalOpen}
        onClose={() => setIsDepositModalOpen(false)}
        onSuccess={handleDepositSuccess}
      />

      {/* Withdraw Modal */}
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
