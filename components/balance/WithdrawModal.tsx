'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button, Segmented } from '@/components/ui/kit';
import { useStore } from '@/lib/store';
import { useToast } from '@/lib/hooks/useToast';
import { useWalletClient, useAccount } from 'wagmi';
import { ARC_ASSETS, type ArcAsset } from '@/lib/arc/config';

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (amount: number, txHash: string) => void;
  onError?: (error: string) => void;
}

/**
 * WithdrawModal
 *
 * Moves credits out of the house balance and back to the player's wallet on
 * Arc. The withdrawal is authorised by a signed message so the backend
 * can prove the request came from the wallet that owns the balance.
 */
export const WithdrawModal: React.FC<WithdrawModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  onError,
}) => {
  const [amount, setAmount] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = useStore(state => state.address);
  const withdrawFunds = useStore(state => state.withdrawFunds);
  const houseBalance = useStore(state => state.houseBalance);
  const refreshWalletBalance = useStore(state => state.refreshWalletBalance);
  const isConnected = useStore(state => state.isConnected);
  const setSelectedCurrency = useStore(state => state.setSelectedCurrency);
  const userTier = useStore(state => state.userTier);
  const toast = useToast();

  const { data: walletClient } = useWalletClient();
  const { connector } = useAccount();

  const asset: ArcAsset = 'USDC';

  const feePercent = userTier === 'vip' ? 0.08 : userTier === 'standard' ? 0.09 : 0.1;
  const feeLabel = `${Math.round(feePercent * 100)}%`;

  const validateAmount = (value: string): string | null => {
    if (!value.trim()) return 'Enter an amount';
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 'Amount must be greater than zero';
    if (parsed > houseBalance) return 'Insufficient house balance';
    return null;
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    setAmount(value);
    setError(null);
  };

  const handleMaxClick = () => {
    if (houseBalance > 0) {
      setAmount(houseBalance.toString());
      setError(null);
    }
  };

  const handleAssetChange = (next: ArcAsset) => {
    setSelectedCurrency(next);
    setAmount('');
    setError(null);
  };

  /** Proves the request came from the wallet that owns the balance. */
  const signAuthorization = async (
    withdrawAmount: number,
    signedAt: number
  ): Promise<string> => {
    const message =
      `STRIKE withdrawal authorization\n` +
      `address:${address}\n` +
      `amount:${withdrawAmount.toFixed(8)}\n` +
      `currency:${asset}\n` +
      `signedAt:${signedAt}`;

    if (walletClient) {
      return walletClient.signMessage({
        account: address as `0x${string}`,
        message,
      });
    }

    if (connector) {
      const provider = (await connector.getProvider()) as any;
      const { ethers } = await import('ethers');
      const signer = await new ethers.BrowserProvider(provider).getSigner();
      return signer.signMessage(message);
    }

    throw new Error('Unable to sign the withdrawal authorization with this wallet');
  };

  const handleWithdraw = async () => {
    const validationError = validateAmount(amount);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!isConnected || !address) {
      setError('Please connect your wallet');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const withdrawAmount = parseFloat(amount);
      toast.info('Processing withdrawal...');

      const signedAt = Date.now();
      const signature = await signAuthorization(withdrawAmount, signedAt);

      const result = await withdrawFunds(address, withdrawAmount, { signature, signedAt });

      refreshWalletBalance();

      const txHash =
        result && (result as any).txHash ? String((result as any).txHash) : 'PENDING';
      const status = result && (result as any).status;
      const frequencyReview = result && (result as any).frequencyReview;

      if (status === 'pending') {
        toast.success(
          frequencyReview
            ? 'Your withdrawal request has been submitted for manual review due to high withdrawal frequency. An admin will process it shortly.'
            : 'Withdrawal request submitted. Awaiting manual approval.'
        );
      } else {
        toast.success(
          `Successfully withdrew ${withdrawAmount.toFixed(4)} ${asset}! Balance updated.`
        );
      }
      onSuccess?.(withdrawAmount, txHash);
      setAmount('');
      onClose();
    } catch (err: any) {
      const errorMessage = err?.message || 'Failed to withdraw funds';
      console.error('Withdrawal error:', err);
      setError(errorMessage);
      toast.error(errorMessage);
      onError?.(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const parsedAmount = parseFloat(amount);
  const hasAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Withdraw ${asset}`}
      showCloseButton={!isLoading}
    >
      <p className="-mt-4 mb-6 text-[15px] text-muted">
        Withdrawals are reviewed before payout to your wallet.
      </p>

      {ARC_ASSETS.length > 1 && (
        <Segmented
          className="mb-4"
          options={ARC_ASSETS.map(token => ({ value: token, label: token }))}
          value={asset}
          onChange={handleAssetChange}
          disabled={isLoading}
        />
      )}

      <label htmlFor="withdraw-amount" className="sr-only">Amount to withdraw</label>
      <div
        className={`flex h-16 items-center rounded-2xl bg-white px-5 ring-1 ring-inset transition-shadow focus-within:ring-ink ${
          error ? 'ring-down' : 'ring-line'
        }`}
      >
        <input
          id="withdraw-amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={handleAmountChange}
          placeholder="0.00"
          disabled={isLoading}
          className="min-w-0 flex-1 bg-transparent font-jet text-[28px] font-semibold tracking-[-0.03em] outline-none placeholder:text-faint disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleMaxClick}
          disabled={isLoading || houseBalance <= 0}
          className="ml-2 rounded-full bg-surface px-3 py-1 font-jet text-xs text-muted transition-colors hover:text-ink disabled:opacity-40"
        >
          Max
        </button>
        <span className="ml-2 font-jet text-sm text-faint">{asset}</span>
      </div>

      <dl className="mt-6 space-y-2 font-jet text-[13px]">
        <div className="flex justify-between">
          <dt className="text-subtle">Available</dt>
          <dd>{houseBalance.toFixed(4)} {asset}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-subtle">Fee</dt>
          <dd>{feeLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-subtle">You receive</dt>
          <dd className="font-semibold">
            {hasAmount && !error ? (parsedAmount * (1 - feePercent)).toFixed(4) : '0.0000'} {asset}
          </dd>
        </div>
      </dl>

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-down-soft px-3.5 py-2.5 text-[13px] text-down">
          {error}
        </p>
      )}

      <Button
        size="lg"
        onClick={handleWithdraw}
        disabled={isLoading || !amount || houseBalance <= 0}
        className="mt-6 w-full"
      >
        {isLoading ? 'Withdrawing…' : `Withdraw ${asset}`}
      </Button>
    </Modal>
  );
};
