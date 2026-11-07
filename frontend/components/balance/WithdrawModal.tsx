'use client';

import React, { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Modal } from '@/components/ui/Modal';
import { Button, Segmented } from '@/components/ui/kit';
import { useStore } from '@/lib/store';
import { resolveHouseLedgerCurrency } from '@/lib/balance/houseLedgerCurrency';
import { useToast } from '@/lib/hooks/useToast';
import { useWalletClient, useAccount } from 'wagmi';
import { ensureBalanceSession } from '@/lib/balance/balanceClientHeaders';
import { ARC_ASSETS, type ArcAsset } from '@/lib/arc/config';
import { calculateFeeAmount, getFeePercentLabel } from '@/lib/fees/platformFee';
import { ApiFailure, wait } from '@/lib/api/errors';
import { useWorldConfig } from '@/lib/world/human';
import { useNow } from '@/components/world/StepUpCard';

const Bridge = dynamic(() => import('./Bridge'), { ssr: false });

export interface WithdrawRequestDetails {
  status?: string;
  feeAmount?: number;
  netAmount?: number;
  requestedAt?: string;
  duplicate?: boolean;
  frequencyReview?: boolean;
  requestId?: number;
}

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (
    amount: number,
    txHash: string,
    requestId?: number,
    details?: WithdrawRequestDetails
  ) => void;
  onError?: (error: string) => void;
}

export const WithdrawModal: React.FC<WithdrawModalProps> = ({ isOpen, onClose, onSuccess, onError }) => {
  const [amount, setAmount] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const now = useNow(retryAt != null);
  const coolingDown = retryAt != null && retryAt > now;
  const stepupOver = useWorldConfig().data?.stepup.withdrawOver;

  const address = useStore(state => state.address);
  const withdrawFunds = useStore(state => state.withdrawFunds);
  const houseBalance = useStore(state => state.houseBalance);
  const houseBalanceKnown = useStore(state => state.houseBalanceKnown);
  const refreshWalletBalance = useStore(state => state.refreshWalletBalance);
  const isConnected = useStore(state => state.isConnected);
  const setSelectedCurrency = useStore(state => state.setSelectedCurrency);
  const userTier = useStore(state => state.userTier);
  const toast = useToast();

  const { data: walletClient } = useWalletClient();
  const { connector } = useAccount();

  const selectedCurrency = useStore((state) => state.selectedCurrency);
  const asset: ArcAsset = resolveHouseLedgerCurrency({ selectedCurrency });

  const feeLabel = getFeePercentLabel(userTier);

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

  const signAuthorization = async (
    withdrawAmount: number,
    signedAt: number
  ): Promise<string> => {
    const message =
      `Strike withdrawal authorization\n` +
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
      const { arcWalletClient } = await import('@/lib/arc/client');
      const provider = (await connector.getProvider()) as import('viem').EIP1193Provider;
      return arcWalletClient(provider, address as `0x${string}`).signMessage({ message });
    }

    throw new Error(
      'Unable to sign the withdrawal authorization. Reconnect your wallet and try again.'
    );
  };

  const handleWithdraw = async () => {
    if (inFlight.current) return;
    const validationError = validateAmount(amount);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!isConnected || !address) {
      setError('Please connect your wallet');
      return;
    }

    inFlight.current = true;
    try {
      setIsLoading(true);
      setError(null);

      const withdrawAmount = parseFloat(amount);
      toast.info('Processing withdrawal...');

      await ensureBalanceSession();

      const signedAt = Date.now();
      const signature = await signAuthorization(withdrawAmount, signedAt);

      const result = await withdrawFunds(address, withdrawAmount, { signature, signedAt });

      refreshWalletBalance();

      const details = (result ?? {}) as WithdrawRequestDetails & { txHash?: string };
      const status = typeof details.status === 'string' ? details.status : undefined;
      const txHash =
        details.txHash && /^0x[0-9a-fA-F]{64}$/.test(String(details.txHash))
          ? String(details.txHash)
          : 'PENDING';
      const rawRequestId = details.requestId;
      const requestId =
        typeof rawRequestId === 'number' && Number.isFinite(rawRequestId) ? rawRequestId : undefined;

      const paid = status === 'paid' || status === 'completed' || status === 'accepted_paid';
      if (paid) {
        toast.success(
          `Withdrawal of ${withdrawAmount.toFixed(4)} ${asset} paid out on Arc. Balance updated.`
        );
      } else {
        toast.success('Withdrawal recorded. Its payout status is under Withdrawals.');
      }
      onSuccess?.(withdrawAmount, paid ? txHash : 'PENDING', requestId, {
        status,
        feeAmount: typeof details.feeAmount === 'number' ? details.feeAmount : undefined,
        netAmount: typeof details.netAmount === 'number' ? details.netAmount : undefined,
        requestedAt: typeof details.requestedAt === 'string' ? details.requestedAt : undefined,
        duplicate: details.duplicate === true,
      });
      setAmount('');
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiFailure) setRetryAt(err.api.retryAfter ?? null);
      const raw = (err instanceof Error && err.message) || 'Failed to withdraw funds';
      // The server caps lifetime withdrawals at 108% of lifetime deposits and does not expose the
      // total, so Max cannot know it; explain the rule when it trips.
      const left = raw.match(/You have (.+?)\. Please/i)?.[1];
      const errorMessage = /exceeds your available limit/i.test(raw)
        ? `Over your withdrawal limit. You can withdraw up to 108% of everything you have deposited, minus what you already took out.${left ? ` Left for you: ${left}.` : ''}`
        : raw;
      console.error('Withdrawal error:', err);
      setError(errorMessage);
      toast.error(errorMessage);
      onError?.(errorMessage);
    } finally {
      setIsLoading(false);
      inFlight.current = false;
    }
  };

  const parsedAmount = parseFloat(amount);
  const hasAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const netPreview = hasAmount ? parsedAmount - calculateFeeAmount(parsedAmount, userTier) : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Withdraw ${asset}`}
      showCloseButton={!isLoading}
    >
      <p className="-mt-4 mb-6 text-[15px] text-muted">
        Paid automatically to your wallet on Arc. Up to 50 {asset} per request and 200 per day.
        {' '}Lifetime withdrawals are capped at 108% of what you have deposited, so Max may be more than you can take out.
        {stepupOver != null && ` Over ${stepupOver} ${asset} needs a quick approval in World App.`}
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
          <dd>{houseBalanceKnown ? houseBalance.toFixed(4) : "--"} {asset}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-subtle">Fee</dt>
          <dd>{feeLabel}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-subtle">You receive</dt>
          <dd className="font-semibold">
            {hasAmount && !error ? netPreview.toFixed(4) : '0.0000'} {asset}
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
        disabled={isLoading || coolingDown || !amount || houseBalance <= 0}
        className="mt-6 w-full"
      >
        {isLoading ? 'Withdrawing…' : coolingDown ? `Try again in ${wait(retryAt, now)}` : `Withdraw ${asset}`}
      </Button>

      {asset === 'USDC' && (
        <div className="mt-6">
          <Bridge direction="out" onArrived={() => void useStore.getState().refreshWalletBalance()} />
        </div>
      )}
    </Modal>
  );
};
