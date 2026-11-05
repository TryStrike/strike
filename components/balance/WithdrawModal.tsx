'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Withdraw ${asset}`}
      showCloseButton={!isLoading}
    >
      <div className="space-y-4">
        {/* Arc asset selector. */}
        <div className="flex gap-2">
          {ARC_ASSETS.map(token => (
            <button
              key={token}
              onClick={() => handleAssetChange(token)}
              disabled={isLoading}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border text-xs font-black uppercase tracking-widest transition-colors disabled:opacity-50 ${
                asset === token
                  ? 'border-[#00f5ff]/60 bg-[#00f5ff]/10 text-[#00f5ff]'
                  : 'border-white/10 bg-white/[0.03] text-white/30 hover:text-white/60'
              }`}
            >
              <img
                src="/logos/usdc.png"
                alt={token}
                className="w-4 h-4 rounded-full"
              />
              {token}
            </button>
          ))}
        </div>

        <div className="bg-gradient-to-br from-[#00f5ff]/10 to-purple-500/10 border border-[#00f5ff]/30 rounded-lg p-3 relative overflow-hidden">
          <div className="absolute top-0 right-0 px-2 py-0.5 bg-[#00f5ff]/20 text-[#00f5ff] text-[8px] font-bold uppercase tracking-tighter rounded-bl-lg">
            Arc
          </div>
          <p className="text-gray-400 text-[10px] uppercase tracking-wider mb-1 font-mono">
            House Balance
          </p>
          <p className="text-[#00f5ff] text-xl font-bold font-mono flex items-center gap-2">
            <img
              src="/logos/usdc.png"
              alt={asset}
              className="w-5 h-5 rounded-full"
            />
            {houseBalance.toFixed(4)} {asset}
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="withdraw-amount"
            className="text-gray-400 text-xs font-mono uppercase"
          >
            Amount to Withdraw
          </label>
          <div className="relative">
            <input
              id="withdraw-amount"
              type="text"
              value={amount}
              onChange={handleAmountChange}
              placeholder="0.00"
              disabled={isLoading}
              className={`
                w-full px-4 py-3 bg-black/50 border rounded-lg text-lg
                text-white font-mono
                focus:outline-none focus:ring-1 focus:ring-[#00f5ff]
                disabled:opacity-50 disabled:cursor-not-allowed
                ${error ? 'border-red-500' : 'border-[#00f5ff]/30'}
              `}
            />
            <button
              onClick={handleMaxClick}
              disabled={isLoading || houseBalance <= 0}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#00f5ff] hover:text-cyan-400 font-mono disabled:opacity-50 transition-colors uppercase tracking-wider"
            >
              Use Max
            </button>
          </div>
        </div>

        {amount && !error && (
          <div className="bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 space-y-1">
            <p className="text-gray-400 text-[10px] font-mono uppercase tracking-wider">
              Protocol Fee: {feeLabel}
            </p>
            <p className="text-xs font-mono text-gray-300">
              You Receive:{' '}
              <span className="text-green-400">
                {(parseFloat(amount) * (1 - feePercent)).toFixed(4)} {asset}
              </span>
            </p>
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-500 rounded-lg px-3 py-2">
            <p className="text-red-400 text-xs font-mono">{error}</p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={isLoading} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={handleWithdraw}
            disabled={isLoading || !amount || houseBalance <= 0}
            className="flex-1"
          >
            {isLoading ? 'Withdrawing…' : `Withdraw ${asset}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
