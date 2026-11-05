'use client';

import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
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
        const raw = assetConfig.isNative
          ? await provider.getBalance(address)
          : await new ethers.Contract(
              assetConfig.address as string,
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

      const tx = assetConfig.isNative
        ? await signer.sendTransaction({ to: config.treasuryAddress, value })
        : await new ethers.Contract(
            assetConfig.address as string,
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Deposit ${asset}`}
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
            {config.name}
          </div>
          <p className="text-gray-400 text-[10px] uppercase tracking-wider mb-1 font-mono">
            Wallet Balance
          </p>
          <p className="text-[#00f5ff] text-xl font-bold font-mono flex items-center gap-2">
            <img
              src="/logos/usdc.png"
              alt={asset}
              className="w-5 h-5 rounded-full"
            />
            {walletBalance.toFixed(4)} {asset}
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="deposit-amount"
            className="text-gray-400 text-xs font-mono uppercase"
          >
            Amount to Deposit
          </label>
          <div className="relative">
            <input
              id="deposit-amount"
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
              disabled={isLoading || walletBalance <= 0}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#00f5ff] hover:text-cyan-400 font-mono disabled:opacity-50 transition-colors uppercase tracking-wider"
            >
              Use Max
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {quickAmounts.map(quickAmount => (
            <button
              key={quickAmount}
              onClick={() => handleQuickSelect(quickAmount)}
              disabled={isLoading}
              className={`
                py-2 rounded-lg border text-xs font-mono transition-all
                disabled:opacity-50 disabled:cursor-not-allowed
                ${
                  amount === quickAmount.toString()
                    ? 'bg-[#00f5ff]/20 border-[#00f5ff] text-[#00f5ff] shadow-[0_0_10px_rgba(0,245,255,0.3)]'
                    : 'bg-white/[0.03] border-white/10 text-white/60 hover:text-white'
                }
              `}
            >
              {quickAmount}
            </button>
          ))}
        </div>

        {error && (
          <div className="bg-red-900/20 border border-red-500 rounded-lg px-3 py-2">
            <p className="text-red-400 text-xs font-mono">{error}</p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={isLoading} className="flex-1">
            Cancel
          </Button>
          <Button onClick={handleDeposit} disabled={isLoading || !amount} className="flex-1">
            {isLoading ? 'Depositing…' : `Deposit ${asset}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
