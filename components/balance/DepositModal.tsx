'use client';

import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { Modal } from '@/components/ui/Modal';
import { Button, Segmented } from '@/components/ui/kit';
import { useStore } from '@/lib/store';
import { useToast } from '@/lib/hooks/useToast';
import { useWalletClient, useAccount, useSwitchChain } from 'wagmi';
import {
  getArcConfig,
  ARC_ASSETS,
  type ArcAsset,
} from '@/lib/arc/config';

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (amount: number, txHash: string) => void;
  onError?: (error: Error) => void;
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

/**
 * DepositModal
 *
 * Moves native USDC from the player's wallet into the house treasury on Arc.
 * The credit is only applied after the backend has verified
 * the transaction on-chain.
 */
export const DepositModal: React.FC<DepositModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  onError,
}) => {
  const address = useStore(state => state.address);
  const fetchBalance = useStore(state => state.fetchBalance);
  const setSelectedCurrency = useStore(state => state.setSelectedCurrency);
  const toast = useToast();

  const { data: walletClient } = useWalletClient();
  const { connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [walletBalance, setWalletBalance] = useState(0);

  const config = getArcConfig();
  const asset: ArcAsset = 'USDC';
  const assetConfig = config.assets[asset];
  const quickAmounts = [1, 5, 10, 25];

  /** Reads the connected wallet's balance of the selected asset. */
  useEffect(() => {
    if (!isOpen || !address) return;
    let cancelled = false;

    (async () => {
      try {
        const provider = new ethers.JsonRpcProvider(config.rpcEndpoint, {
          chainId: config.chainId,
          name: config.name,
        });
        const raw = await new ethers.Contract(
          assetConfig.address,
          ERC20_ABI,
          provider
        ).balanceOf(address);
        if (!cancelled) {
          setWalletBalance(parseFloat(ethers.formatUnits(raw, assetConfig.decimals)));
        }
      } catch (err) {
        console.error('Failed to read wallet balance:', err);
        if (!cancelled) setWalletBalance(0);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, address, asset, assetConfig, config.chainId, config.name, config.rpcEndpoint]);

  const validate = (value: string): string | null => {
    if (!value.trim()) return 'Enter an amount';
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 'Amount must be greater than zero';
    if (parsed > walletBalance) return `Insufficient ${asset} balance`;
    return null;
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Digits with at most one decimal point.
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    setAmount(value);
    setError(null);
  };

  const handleQuickSelect = (value: number) => {
    setAmount(value.toString());
    setError(null);
  };

  const handleMaxClick = () => {
    if (walletBalance > 0) {
      setAmount(walletBalance.toString());
      setError(null);
    }
  };

  const handleAssetChange = (next: ArcAsset) => {
    setSelectedCurrency(next);
    setAmount('');
    setError(null);
  };

  const handleDeposit = async () => {
    const validationError = validate(amount);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!address) {
      setError('Connect a wallet first');
      return;
    }
    if (!walletClient && !connector) {
      setError('Wallet is not connected');
      return;
    }

    const depositAmount = parseFloat(amount);
    setIsLoading(true);
    setError(null);

    try {
      const provider = new ethers.BrowserProvider(
        (await connector?.getProvider()) as ethers.Eip1193Provider
      );
      // Offer the switch rather than just refusing, then confirm it landed —
      // This native USDC transfer must not be signed on
      // another network.
      if (Number((await provider.getNetwork()).chainId) !== config.chainId) {
        try {
          await switchChainAsync({ chainId: config.chainId });
        } catch {
          throw new Error(`Switch your wallet to ${config.name} and try again`);
        }
      }
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== config.chainId) {
        throw new Error(`Switch your wallet to ${config.name} and try again`);
      }

      const signer = await provider.getSigner();
      const value = ethers.parseUnits(amount, assetConfig.decimals);

      const tx = await new ethers.Contract(
        assetConfig.address,
        ERC20_ABI,
        signer
      ).transfer(config.treasuryAddress, value);

      await tx.wait();

      // The backend re-verifies the transaction on-chain before crediting.
      const response = await fetch('/api/balance/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAddress: address,
          amount: depositAmount,
          txHash: tx.hash,
          currency: asset,
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || 'Deposit could not be credited');
      }

      await fetchBalance(address);
      toast.success(
        `Successfully deposited ${depositAmount.toFixed(4)} ${asset}! Balance updated.`
      );
      onSuccess?.(depositAmount, tx.hash);
      setAmount('');
      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Deposit failed. Please try again.';
      console.error('Deposit error:', err);
      setError(message);
      toast.error(message);
      onError?.(err instanceof Error ? err : new Error(message));
    } finally {
      setIsLoading(false);
    }
  };

  const chip = (on: boolean) =>
    `h-9 rounded-full font-jet text-[13px] transition-colors disabled:opacity-40 ${
      on ? 'bg-ink text-white' : 'bg-surface text-muted hover:text-ink'
    }`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Deposit ${asset}`}
      showCloseButton={!isLoading}
    >
      <p className="-mt-4 mb-6 text-[15px] text-muted">
        Move USDC from your wallet to your trading balance.
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

      <label htmlFor="deposit-amount" className="sr-only">Amount to deposit</label>
      <div
        className={`flex h-16 items-center rounded-2xl bg-white px-5 ring-1 ring-inset transition-shadow focus-within:ring-ink ${
          error ? 'ring-down' : 'ring-line'
        }`}
      >
        <input
          id="deposit-amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={handleAmountChange}
          placeholder="0.00"
          disabled={isLoading}
          className="min-w-0 flex-1 bg-transparent font-jet text-[28px] font-semibold tracking-[-0.03em] outline-none placeholder:text-faint disabled:opacity-50"
        />
        <span className="ml-2 font-jet text-sm text-faint">{asset}</span>
      </div>

      <div className="mt-3 grid grid-cols-5 gap-2">
        {quickAmounts.map(quickAmount => (
          <button
            key={quickAmount}
            type="button"
            onClick={() => handleQuickSelect(quickAmount)}
            disabled={isLoading}
            className={chip(amount === quickAmount.toString())}
          >
            {quickAmount}
          </button>
        ))}
        <button
          type="button"
          onClick={handleMaxClick}
          disabled={isLoading || walletBalance <= 0}
          className={chip(false)}
        >
          Max
        </button>
      </div>

      <dl className="mt-6 space-y-2 font-jet text-[13px]">
        <div className="flex justify-between">
          <dt className="text-subtle">Wallet</dt>
          <dd>{walletBalance.toFixed(4)} {asset}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-subtle">Network</dt>
          <dd>{config.name}</dd>
        </div>
      </dl>

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-down-soft px-3.5 py-2.5 text-[13px] text-down">
          {error}
        </p>
      )}

      <Button
        size="lg"
        onClick={handleDeposit}
        disabled={isLoading || !amount}
        className="mt-6 w-full"
      >
        {isLoading ? 'Depositing…' : `Deposit ${asset}`}
      </Button>
    </Modal>
  );
};
