'use client';

import React, { useState, useEffect } from 'react';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { LiveChart } from './LiveChart';
import { BalanceDisplay } from '@/components/balance';
import { getArcConfig, getAssetConfig } from '@/lib/arc/config';
import { ethers } from 'ethers';
import { useToast } from '@/lib/hooks/useToast';
import { useAccount } from 'wagmi';
import { ArrowDown, ArrowUp, Check, X } from '@phosphor-icons/react';
import { Button, Field, Label, Segmented } from '@/components/ui/kit';
import { IndicatorsToggle, MiniHistory } from '@/components/history/MiniHistory';
import posthog from 'posthog-js';


export const GameBoard: React.FC = () => {
  const {
    address,
    isConnected,
    network,
    walletBalance,
    gameMode,
    setGameMode,
    setTimeframeSeconds,
    selectedAsset,
    placeBetFromHouseBalance,
    isPlacingBet,
    isBlitzActive,
    blitzEndTime,
    nextBlitzTime,
    hasBlitzAccess,
    updateBlitzTimer,
    enableBlitzAccess,
    error,
    clearError,
    isLoading: isLoadingBalance,
    userTier,
    refreshWalletBalance,
    selectedCurrency,
    accessCode,
    setConnectModalOpen,
  } = useStore(useShallow((s) => ({ address: s.address, isConnected: s.isConnected, network: s.network, walletBalance: s.walletBalance, gameMode: s.gameMode, setGameMode: s.setGameMode, setTimeframeSeconds: s.setTimeframeSeconds, selectedAsset: s.selectedAsset, placeBetFromHouseBalance: s.placeBetFromHouseBalance, isPlacingBet: s.isPlacingBet, isBlitzActive: s.isBlitzActive, blitzEndTime: s.blitzEndTime, nextBlitzTime: s.nextBlitzTime, hasBlitzAccess: s.hasBlitzAccess, updateBlitzTimer: s.updateBlitzTimer, enableBlitzAccess: s.enableBlitzAccess, error: s.error, clearError: s.clearError, isLoading: s.isLoading, userTier: s.userTier, refreshWalletBalance: s.refreshWalletBalance, selectedCurrency: s.selectedCurrency, accessCode: s.accessCode, setConnectModalOpen: s.setConnectModalOpen })));

  const { connector } = useAccount();

  const [betAmount, setBetAmount] = useState<string>('0.1');
  // Default box-mode settings (when user lands on /trade):
  // - Quick Amount: 0.1
  // - Expiration Time: 5s
  const [selectedDuration, setSelectedDuration] = useState<number>(5);

  const [blitzCountdown, setBlitzCountdown] = useState<string>('');
  const [blitzTimeRemaining, setBlitzTimeRemaining] = useState<string>('');
  const [isActivatingBlitz, setIsActivatingBlitz] = useState(false);

  const toast = useToast();

  // Refresh the wallet figure whenever the ledger asset changes.
  useEffect(() => {
    if (!isConnected || !address) return;
    void refreshWalletBalance();
  }, [selectedCurrency, isConnected, address, refreshWalletBalance]);

  const currencySymbol = 'USDC';

  // Blitz entry is paid to the platform fee collector, not the treasury.
  const blitzEntryFee = 1;
  const blitzEntryCurrencySymbol = currencySymbol;
  // Connection status
  const isWalletConnected = !!address;

  const handleEnterBlitz = async () => {
    if (!isWalletConnected || !address) {
      toast.error("Please connect your wallet first");
      return;
    }

    if (!isBlitzActive) {
      toast.error("Blitz Round is not currently active");
      return;
    }

    try {
      setIsActivatingBlitz(true);
      
      // Track Blitz entry attempt (no wallet address sent to third-party analytics)
      posthog.capture('blitz_entry_started', {
        network,
        entryFee: blitzEntryFee
        // address intentionally omitted to protect user privacy
      })

      const arcConfig = getArcConfig();
      const assetConfig = getAssetConfig('USDC');
      const feeWallet = process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC;
      if (!feeWallet) {
        throw new Error('Arc fee collector wallet not configured');
      }

      const { ethers } = await import('ethers');
      const injected = (await connector?.getProvider()) as ethers.Eip1193Provider | undefined;
      if (!injected) {
        throw new Error('Active wallet not found in session. Please reconnect.');
      }
      const browserProvider = new ethers.BrowserProvider(injected);
      const chain = await browserProvider.getNetwork();
      if (Number(chain.chainId) !== arcConfig.chainId) {
        throw new Error(`Switch your wallet to ${arcConfig.name} and try again`);
      }
      const signer = await browserProvider.getSigner();
      const feeValue = ethers.parseUnits(String(blitzEntryFee), assetConfig.decimals);

      toast.info(`Confirming ${blitzEntryFee} ${currencySymbol} Blitz Entry...`);
      const feeTx = await new ethers.Contract(
        assetConfig.address,
        ['function transfer(address to, uint256 amount) returns (bool)'],
        signer
      ).transfer(feeWallet, feeValue);
      await feeTx.wait();
      toast.success("Payment successful! Blitz Mode enabled.");
      enableBlitzAccess();
      refreshWalletBalance();
      
      // Track successful Blitz entry (sanitized - no wallet address)
      posthog.capture('blitz_entry_success', {
        network,
        entryFee: blitzEntryFee
        // address removed to protect user privacy
      })
    } catch (err: unknown) {
      if (process.env.NODE_ENV === 'development') {
        console.error("Blitz entry failed:", err);
      }
      const errorMessage = err instanceof Error ? err.message : String(err ?? "");
      
      // Track Blitz entry failure (sanitized - no wallet address)
      posthog.capture('blitz_entry_failed', {
        network,
        error: errorMessage
        // address removed to protect user privacy
      })
      
      if (errorMessage.includes('rejected') || errorMessage.includes('denied') || errorMessage.includes('User rejected')) {
        toast.error("User rejected");
      } else {
        toast.error(errorMessage || "Failed to enter Blitz Round");
      }
    } finally {
      setIsActivatingBlitz(false);
    }
  };

  // Update Blitz Timer every second
  useEffect(() => {
    const interval = setInterval(() => {
      updateBlitzTimer();
      const now = Date.now();
      if (isBlitzActive && blitzEndTime) {
        const remaining = Math.max(0, blitzEndTime - now);
        setBlitzTimeRemaining(`${Math.floor(remaining / 1000)}s`);
        setBlitzCountdown('');
      } else {
        const timeToNext = Math.max(0, nextBlitzTime - now);
        const mins = Math.floor(timeToNext / 60000);
        const secs = Math.floor((timeToNext % 60000) / 1000);
        setBlitzCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
        setBlitzTimeRemaining('');
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isBlitzActive, blitzEndTime, nextBlitzTime, updateBlitzTimer]);

  // Identify user when wallet connects — use a one-way hash of the address
  // so PostHog receives a stable anonymous ID without the raw wallet address.
  // This keeps session stitching while protecting user privacy.
  useEffect(() => {
    if (address) {
      // Simple deterministic hash: last 12 chars is NOT sufficient, use a digest approach
      // We XOR-fold a basic hash to create a stable non-reversible identifier
      const simpleHash = address
        .split('')
        .reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
      const anonymousId = `u_${Math.abs(simpleHash).toString(36)}_${address.slice(-6)}`;
      posthog.identify(anonymousId, {
        // Never send raw wallet address to third-party analytics
        network,
        hasBlitzAccess,
        userTier,
        hasAccessCode: !!accessCode
      });
    }
  }, [address, network, hasBlitzAccess, userTier, accessCode])


  // Sync selectedDuration with store's timeframeSeconds
  useEffect(() => {
    // Classic: duration picker affects both betting window & grid
    if (gameMode === 'binomo') {
      setTimeframeSeconds(selectedDuration);
      return;
    }

    // Box/Draw: keep draw sizing/parity stable with the reference behavior
    if (gameMode === 'draw') {
      setTimeframeSeconds(5);
      return;
    }

    // Box keeps the existing behavior
    setTimeframeSeconds(selectedDuration);
  }, [selectedDuration, setTimeframeSeconds, gameMode]);

  // Multiplier mapping based on duration
  const getMultiplier = (duration: number) => {
    switch (duration) {
      case 5: return 1.75;
      case 10: return 1.80;
      case 15: return 1.85;
      case 30: return 1.90;
      case 60: return 1.95;
      default: return 1.90;
    }
  };

  const handleStrikeBet = async (direction: 'UP' | 'DOWN') => {
    if (!address || !isWalletConnected || gameMode !== 'binomo') return;

    try {
      const multiplier = getMultiplier(selectedDuration);
      // Track bet placement (sanitized - no wallet address or specific amounts)
      posthog.capture('bet_placed', {
        direction,
        // amount removed to protect financial privacy
        multiplier,
        duration: selectedDuration,
        asset: selectedAsset,
        network,
        currency: currencySymbol
        // wallet address never sent to analytics
      })

      // House balance only — /api/balance/bet deducts house balance; no on-chain stake per bet.
      await placeBetFromHouseBalance(
        betAmount,
        `${direction}-${multiplier}-${selectedDuration}`,
        address,
        undefined,
      );
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.error("Failed to place bet:", err instanceof Error ? err.message : err);
      }
      
      // Track bet failure (sanitized - no wallet address or specific amounts)
      posthog.capture('bet_failed', {
        direction,
        // amount removed to protect financial privacy
        error: err instanceof Error ? err.message : 'Unknown error',
        network
        // wallet address never sent to analytics
      })
    }
  };

  const activeWalletBalance = walletBalance;
  const formatBalance = (bal: number) => (isNaN(bal) ? '0.0000' : bal.toFixed(4));
  const amountNum = Number(betAmount);
  const multiplier = getMultiplier(selectedDuration);
  const isBalanceError =
    !!error &&
    (error.includes('User not found') ||
      error.includes('No house balance') ||
      error.includes('Insufficient house') ||
      error.includes('balance'));

  return (
    <div className="flex h-full min-h-0 w-full flex-col lg:flex-row">
      {/* Chart */}
      <div className="relative min-h-[420px] flex-1 lg:min-h-0">
        <LiveChart betAmount={betAmount} />
        <div className="absolute right-4 top-4 z-30">
          <IndicatorsToggle />
        </div>
      </div>

      {/* Trade sidebar */}
      <aside className="w-full shrink-0 overflow-y-auto border-t border-line bg-gradient-to-b from-white to-surface/60 lg:w-[380px] lg:border-l lg:border-t-0">
        <div className="flex flex-col gap-7 p-6">
          <Segmented
            className="[&>button]:py-1.5"
            value={gameMode}
            onChange={setGameMode}
            options={[
              { value: 'binomo', label: 'Classic', tour: 'classic-mode' },
              { value: 'box', label: 'Box', tour: 'box-mode' },
              { value: 'draw', label: 'Draw', tour: 'draw-mode' },
            ]}
          />

          <div>
            <Label>Amount</Label>
            <Field
              type="number"
              inputMode="decimal"
              min="0"
              value={betAmount}
              onChange={(e) => setBetAmount(e.target.value)}
              placeholder="0.00"
              unit={currencySymbol}
              aria-label="Bet amount in USDC"
            />
            <div className="mt-2 grid grid-cols-5 gap-1.5">
              {[0.1, 0.5, 1, 5, 10].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setBetAmount(amt.toString())}
                  className={`h-9 rounded-full font-jet text-sm font-medium transition-all ${
                    betAmount === amt.toString() ? 'bg-ink text-white shadow-[0_6px_16px_-8px_rgba(10,12,16,0.6)]' : 'bg-ink/[0.04] text-muted hover:bg-ink/[0.07] hover:text-ink'
                  }`}
                >
                  {amt}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>{gameMode === 'draw' ? 'Expiry · fixed at 5s in Draw' : 'Expiry'}</Label>
            <Segmented
              value={selectedDuration}
              onChange={setSelectedDuration}
              disabled={gameMode === 'draw'}
              options={[5, 10, 15, 30, 60].map((d) => ({
                value: d,
                label: d < 60 ? `${d}s` : '1m',
                hint: gameMode === 'binomo' ? `×${getMultiplier(d)}` : undefined,
              }))}
            />
          </div>

          {gameMode === 'binomo' ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted">Payout if you&apos;re right</span>
                <span className="font-jet font-semibold">
                  {Number.isFinite(amountNum) ? (amountNum * multiplier).toFixed(2) : '0.00'} {currencySymbol}
                </span>
              </div>
              {isWalletConnected ? (
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="up" size="lg" onClick={() => handleStrikeBet('UP')} disabled={isPlacingBet}>
                    <ArrowUp size={18} weight="bold" /> Higher
                  </Button>
                  <Button variant="down" size="lg" onClick={() => handleStrikeBet('DOWN')} disabled={isPlacingBet}>
                    <ArrowDown size={18} weight="bold" /> Lower
                  </Button>
                </div>
              ) : (
                <Button size="lg" onClick={() => setConnectModalOpen(true)}>
                  Connect wallet to trade
                </Button>
              )}
            </div>
          ) : (
            <p className="rounded-3xl bg-ink/[0.03] px-5 py-4 text-sm leading-relaxed text-muted">
              {gameMode === 'box'
                ? 'Click a cell on the chart to bet that the price lands inside it. Cells further from the price pay more.'
                : 'Drag a box on the chart, then confirm to bet the price lands inside it.'}
            </p>
          )}

          {error && (
            <div role="alert" className="flex items-start gap-3 rounded-2xl bg-down-soft px-4 py-3 text-sm text-down">
              <p className="flex-1 leading-snug">
                {isBalanceError ? `Not enough house balance. Deposit ${currencySymbol} below, then place your bet.` : error}
              </p>
              <button type="button" onClick={clearError} aria-label="Dismiss error" className="text-down/70 hover:text-down">
                <X size={16} />
              </button>
            </div>
          )}

          {/* Balance */}
          <div className="border-y border-line py-6" data-tour="deposit-section">
            {isWalletConnected && address ? (
              <div className="flex flex-col gap-3" data-tour="wallet-tab">
                <BalanceDisplay />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted">Wallet</span>
                  <span className="font-jet">
                    {isLoadingBalance ? '…' : formatBalance(activeWalletBalance)} {currencySymbol}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">Connect a wallet to deposit USDC and start trading.</p>
            )}
          </div>

          {/* Blitz */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                Blitz{' '}
                <span className={`font-jet font-normal ${isBlitzActive ? 'text-down' : 'text-faint'}`}>
                  {isBlitzActive ? `${blitzTimeRemaining} left` : `in ${blitzCountdown}`}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-subtle">2× on boosted cells.</p>
            </div>
            {hasBlitzAccess ? (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-up">
                <Check size={16} weight="bold" /> Entered
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 whitespace-nowrap"
                disabled={isActivatingBlitz || (isWalletConnected && !isBlitzActive)}
                onClick={() => (isWalletConnected ? void handleEnterBlitz() : setConnectModalOpen(true))}
              >
                {isActivatingBlitz ? 'Paying…' : `Enter · ${blitzEntryFee} ${blitzEntryCurrencySymbol}`}
              </Button>
            )}
          </div>

          <MiniHistory />
        </div>
      </aside>
    </div>
  );
};
