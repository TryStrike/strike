'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { LiveChart } from './LiveChart';
import { BalanceDisplay } from '@/components/balance';
import { getArcConfig, getAssetConfig } from '@/lib/arc/config';
import { ethers } from 'ethers';
import { useToast } from '@/lib/hooks/useToast';
import { useAccount } from 'wagmi';
import { ArrowDown, ArrowUp, Check, X } from '@phosphor-icons/react';
import { Button, Field, Label, Segmented, glassSelected } from '@/components/ui/kit';
import { IndicatorsToggle, MiniHistory } from '@/components/history/MiniHistory';
import { WinBurst } from './WinBurst';
import { SettlementProof, matchSettledRound, type SettlementProofInput } from './SettlementProof';
import { explorerAddressUrl } from '@/lib/arc/config';
import { ArrowUpRight } from '@phosphor-icons/react';
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
    bets,
  } = useStore(useShallow((s) => ({ address: s.address, isConnected: s.isConnected, network: s.network, walletBalance: s.walletBalance, gameMode: s.gameMode, setGameMode: s.setGameMode, setTimeframeSeconds: s.setTimeframeSeconds, selectedAsset: s.selectedAsset, placeBetFromHouseBalance: s.placeBetFromHouseBalance, isPlacingBet: s.isPlacingBet, isBlitzActive: s.isBlitzActive, blitzEndTime: s.blitzEndTime, nextBlitzTime: s.nextBlitzTime, hasBlitzAccess: s.hasBlitzAccess, updateBlitzTimer: s.updateBlitzTimer, enableBlitzAccess: s.enableBlitzAccess, error: s.error, clearError: s.clearError, isLoading: s.isLoading, userTier: s.userTier, refreshWalletBalance: s.refreshWalletBalance, selectedCurrency: s.selectedCurrency, accessCode: s.accessCode, setConnectModalOpen: s.setConnectModalOpen, bets: s.bets })));

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
    // Read the live flag (not the render snapshot): a second click/keydown that
    // lands before rerenders must not start a duplicate placement.
    if (useStore.getState().isPlacingBet) return;

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

  // Session strip: rounds settled since this page opened.
  const [sessionStart] = useState(() => Date.now());
  const sessionBets = bets.filter((b) => b.timestamp >= sessionStart);
  const sessionPnl = sessionBets.reduce((sum, b) => sum + (b.won ? parseFloat(b.payout) - parseFloat(b.amount) : -parseFloat(b.amount)), 0);
  let streak = 0;
  while (streak < sessionBets.length && sessionBets[streak].won) streak++;

  // Price-feed stall banner. Polled from getState() (lastTickAt changes every
  // second and must not rerender the board); the boolean only flips at the edge.
  const lastResult = useStore((s) => s.lastResult);
  const [feedDelayed, setFeedDelayed] = useState(false);
  useEffect(() => {
    const check = () => {
      const t = useStore.getState().lastTickAt;
      setFeedDelayed(t > 0 && Date.now() - t > 8000);
    };
    check();
    const id = setInterval(check, 2000);
    return () => clearInterval(id);
  }, []);

  // Screen-reader round status: settles and insufficient-balance errors only —
  // never per-tick prices.
  const [srMessage, setSrMessage] = useState('');
  useEffect(() => {
    if (!lastResult) return;
    const cur = lastResult.currency || 'USDC';
    const outcome = lastResult.won
      ? lastResult.payout === lastResult.amount
        ? `Round draw. Stake ${lastResult.amount.toFixed(2)} ${cur} refunded.`
        : `Round won. Payout ${lastResult.payout.toFixed(2)} ${cur}.`
      : `Round lost. Stake ${lastResult.amount.toFixed(2)} ${cur} forfeited.`;
    setSrMessage(outcome);
  }, [lastResult]);
  useEffect(() => {
    if (error && isBalanceError) {
      setSrMessage(`Insufficient balance. ${error}`);
    }
  }, [error, isBalanceError]);

  // Keyboard trading: ↑ / ↓ place Higher / Lower, 1–5 pick an amount preset.
  const betRef = React.useRef(handleStrikeBet);
  useEffect(() => {
    betRef.current = handleStrikeBet;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore OS key auto-repeat — holding ↑ must not fire a burst of bets.
      if (e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      ) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const preset = ['0.1', '0.5', '1', '5', '10'][Number(e.key) - 1];
      if (preset) {
        setBetAmount(preset);
        return;
      }
      if (gameMode !== 'binomo' || !isWalletConnected || isPlacingBet) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        void betRef.current(e.key === 'ArrowUp' ? 'UP' : 'DOWN');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gameMode, isWalletConnected, isPlacingBet]);

  // ── Settlement proof wiring ────────────────────────────────────────────────
  // A settled round is described by its history row (strike / end price / money)
  // plus the result the engine just published (asset + currency). Anything the
  // row cannot know — the click-time round end, the idempotency key, ledger
  // operations and real chain hashes — is filled in read-only by
  // GET /api/bets/[id] when the panel opens.
  const lastSettledBet = useMemo(() => matchSettledRound(bets, lastResult), [bets, lastResult]);
  const resultProof = useMemo<SettlementProofInput | null>(() => {
    if (!lastResult) return null;
    // A settled round ALWAYS offers a proof: the history row is preferred for
    // strike/direction detail, but lastResult now carries the server bet id
    // too, so even a round whose row was lost (history reload, filtered
    // storage) still opens GET /api/bets/<id> and reads the row back.
    const betId = lastSettledBet?.id ?? lastResult.betId ?? null;
    if (!betId) return null;
    const row = lastSettledBet;
    // The engine stamps the asset on the session row it writes at resolve
    // time; BetRecord's public type does not carry it, so read it defensively.
    const rowAsset = (row as unknown as { asset?: string | null } | null)?.asset ?? null;
    return {
      betId,
      // lastResult carries the asset the round ran on, so the panel looks the
      // feed history up under the right key even after the user switches.
      asset: lastResult.asset ?? rowAsset ?? null,
      mode: row?.target?.id ?? null,
      direction: row?.target?.direction ?? null,
      multiplier: row?.target?.multiplier ?? null,
      stake: row ? parseFloat(row.amount) : lastResult.amount,
      payout: row ? parseFloat(row.payout) : lastResult.payout,
      won: row ? row.won : lastResult.won,
      // end_price on the history row is what the client held at resolution.
      recordedEndPrice: row?.endPrice || null,
      strikePrice: row?.startPrice || null,
      resolvedAt: lastResult.timestamp,
      network: lastResult.currency ?? null,
    };
  }, [lastSettledBet, lastResult]);

  // Proof entry points for the resolved-bet list (newest rounds first). Their
  // asset/endTime are not on the row, so the panel reads them from the proof
  // endpoint and falls back to the recorded value with a caveat if it cannot.
  const listProofs = useMemo(
    () =>
      bets.slice(0, 5).map((bet) => ({
        betId: bet.id,
        mode: bet.target?.id ?? null,
        direction: bet.target?.direction ?? null,
        multiplier: bet.target?.multiplier ?? null,
        stake: parseFloat(bet.amount),
        payout: parseFloat(bet.payout),
        won: bet.won,
        recordedEndPrice: bet.endPrice || null,
        strikePrice: bet.startPrice || null,
        resolvedAt: bet.timestamp,
      })),
    [bets],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col lg:flex-row">
      {/* Chart */}
      <div className="relative min-h-[420px] flex-1 lg:min-h-0">
        <LiveChart betAmount={betAmount} />
        <WinBurst />
        {/* Persistent status region: text only appears on a stall, so the
            announcement fires (mounting a fresh live region is unreliable). */}
        <div className="absolute left-1/2 top-2 z-[45] -translate-x-1/2">
          <div
            role="status"
            aria-live="polite"
            className={
              feedDelayed
                ? 'whitespace-nowrap rounded-full bg-ink/85 px-3.5 py-1 text-[11px] font-medium text-white shadow-lg backdrop-blur-sm'
                : 'sr-only'
            }
          >
            {feedDelayed ? 'Price feed delayed — showing last known' : ''}
          </div>
        </div>
        <div className="absolute right-4 top-4 z-30">
          <IndicatorsToggle />
        </div>
      </div>

      {/* Screen-reader announcements: round results + balance errors only. */}
      <div aria-live="polite" className="sr-only">
        {srMessage}
      </div>

      {/* Trade sidebar */}
      <aside
        className="w-full shrink-0 overflow-y-auto border-t border-line bg-gradient-to-b from-white to-surface/60 lg:w-[380px] lg:border-l lg:border-t-0"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex flex-col gap-7 p-6">
          {/* Result moment: the round that just closed, with its settlement
              breakdown one keystroke (Enter/Space) away. */}
          {resultProof && (
            <SettlementProof
              bet={resultProof}
              wallet={address}
              variant="bar"
              label={lastSettledBet?.target?.label ?? 'Last round settled'}
            />
          )}

          {sessionBets.length > 0 && (
            <div className="grid grid-cols-3 gap-2 rounded-3xl bg-ink/[0.03] px-4 py-3 text-center">
              <div>
                <div className={`font-jet text-[15px] font-medium ${sessionPnl > 0 ? 'text-up' : sessionPnl < 0 ? 'text-down' : 'text-ink'}`}>
                  {sessionPnl > 0 ? '+' : ''}{sessionPnl.toFixed(2)}
                </div>
                <div className="text-[11px] text-subtle">Session P&amp;L</div>
              </div>
              <div>
                <div className="font-jet text-[15px] font-medium">{streak}</div>
                <div className="text-[11px] text-subtle">Win streak</div>
              </div>
              <div>
                <div className="font-jet text-[15px] font-medium">{sessionBets.length}</div>
                <div className="text-[11px] text-subtle">Rounds</div>
              </div>
            </div>
          )}

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
                    betAmount === amt.toString() ? glassSelected : 'bg-ink/[0.04] text-muted hover:bg-ink/[0.07] hover:text-ink'
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
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="up" size="lg" onClick={() => handleStrikeBet('UP')} disabled={isPlacingBet} aria-keyshortcuts="ArrowUp">
                      <ArrowUp size={18} weight="bold" /> Higher
                    </Button>
                    <Button variant="down" size="lg" onClick={() => handleStrikeBet('DOWN')} disabled={isPlacingBet} aria-keyshortcuts="ArrowDown">
                      <ArrowDown size={18} weight="bold" /> Lower
                    </Button>
                  </div>
                  <p className="text-center text-xs text-faint">
                    <kbd className="font-jet">↑</kbd> / <kbd className="font-jet">↓</kbd> to trade · <kbd className="font-jet">1</kbd>–<kbd className="font-jet">5</kbd> for amount
                  </p>
                </>
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

          {/* Resolved-bet list: open the proof for any round in this session.
              The chip itself prints the resolve clock, so no formatting here. */}
          {listProofs.length > 0 && (
            <div data-testid="settlement-proof-list">
              <Label>Settlement proofs</Label>
              <ul className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {listProofs.map((proofBet) => (
                  <li key={proofBet.betId}>
                    <SettlementProof
                      bet={proofBet}
                      wallet={address}
                      variant="chip"
                      label={proofBet.direction ?? 'Round'}
                    />
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                Proof reads your own rounds only: the server returns a row solely when the bet id and your connected
                wallet match.
              </p>
            </div>
          )}

          <a
            href={explorerAddressUrl(getArcConfig().treasuryAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto inline-flex items-center gap-1 self-start text-xs text-faint hover:text-ink"
          >
            Settled in USDC on Arc · Treasury contract <ArrowUpRight size={12} />
          </a>
        </div>
      </aside>
    </div>
  );
};
