"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useStore } from "@/lib/store";
import { isRealWin } from "@/lib/types/bet";
import { useShallow } from "zustand/react/shallow";
import { LiveChart } from "./LiveChart";
import { BalanceDisplay } from "@/components/balance";
import { useToast } from "@/lib/hooks/useToast";
import { ArrowDown, ArrowUp, Check, X } from "@phosphor-icons/react";
import {
  Button,
  Field,
  Label,
  Segmented,
  glassSelected,
} from "@/components/ui/kit";
import {
  IndicatorsToggle,
  MiniHistory,
} from "@/components/history/MiniHistory";
import { WinBurst } from "./WinBurst";
import { ArkivOwnBets } from "@/components/arkiv/ArkivOwnBets";
import {
  SettlementProof,
  matchSettledRound,
  type SettlementProofInput,
} from "./SettlementProof";
import { explorerAddressUrl, getArcConfig } from "@/lib/arc/config";
import { ArrowUpRight } from "@phosphor-icons/react";

export const GameBoard: React.FC = () => {
  const {
    address,
    isConnected,
    walletBalance,
    gameMode,
    setGameMode,
    setTimeframeSeconds,
    placeBetFromHouseBalance,
    isPlacingBet,
    isBlitzActive,
    blitz,
    serverOffsetMs,
    enterBlitz,
    hasBlitzAccess,
    error,
    clearError,
    refreshWalletBalance,
    selectedCurrency,
    setConnectModalOpen,
    bets,
  } = useStore(
    useShallow((s) => ({
      address: s.address,
      isConnected: s.isConnected,
      walletBalance: s.walletBalance,
      gameMode: s.gameMode,
      setGameMode: s.setGameMode,
      setTimeframeSeconds: s.setTimeframeSeconds,
      placeBetFromHouseBalance: s.placeBetFromHouseBalance,
      isPlacingBet: s.isPlacingBet,
      isBlitzActive: s.isBlitzActive,
      blitz: s.blitz,
      serverOffsetMs: s.serverOffsetMs,
      enterBlitz: s.enterBlitz,
      hasBlitzAccess: s.hasBlitzAccess,
      error: s.error,
      clearError: s.clearError,
      refreshWalletBalance: s.refreshWalletBalance,
      selectedCurrency: s.selectedCurrency,
      setConnectModalOpen: s.setConnectModalOpen,
      bets: s.bets,
    })),
  );

  const marketClosed = useStore((s) => s.closedAssets.includes(s.selectedAsset));
  const errorCode = useStore((s) => s.errorCode);

  const [betAmount, setBetAmount] = useState<string>("0.1");
  const [selectedDuration, setSelectedDuration] = useState<number>(5);
  const [blitzCountdown, setBlitzCountdown] = useState<string>("");
  const [blitzTimeRemaining, setBlitzTimeRemaining] = useState<string>("");
  const [isActivatingBlitz, setIsActivatingBlitz] = useState(false);

  const toast = useToast();

  useEffect(() => {
    if (!isConnected || !address) return;
    void refreshWalletBalance();
  }, [selectedCurrency, isConnected, address, refreshWalletBalance]);

  const currencySymbol = "USDC";

  const blitzEntryFee = Number(blitz?.fee ?? 1);
  const blitzEntryCurrencySymbol = currencySymbol;
  const isWalletConnected = !!address;

  const handleEnterBlitz = async () => {
    if (!isWalletConnected) {
      toast.error("Please connect your wallet first");
      return;
    }

    if (!isBlitzActive) {
      toast.error("Blitz Round is not currently active");
      return;
    }

    try {
      setIsActivatingBlitz(true);
      await enterBlitz();
      toast.success("Blitz Mode enabled.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to enter Blitz Round");
    } finally {
      setIsActivatingBlitz(false);
    }
  };

  useEffect(() => {
    const tick = () => {
      const now = Date.now() + serverOffsetMs;
      if (!blitz) {
        setBlitzCountdown("--:--");
        setBlitzTimeRemaining("");
      } else if (isBlitzActive) {
        setBlitzTimeRemaining(`${Math.max(0, Math.ceil((blitz.endsAt - now) / 1000))}s`);
        setBlitzCountdown("");
      } else {
        const timeToNext = Math.max(0, blitz.startsAt - now);
        const mins = Math.floor(timeToNext / 60000);
        const secs = Math.floor((timeToNext % 60000) / 1000);
        setBlitzCountdown(`${mins}:${secs.toString().padStart(2, "0")}`);
        setBlitzTimeRemaining("");
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isBlitzActive, blitz, serverOffsetMs]);

  useEffect(() => {
    setTimeframeSeconds(selectedDuration);
  }, [selectedDuration, setTimeframeSeconds, gameMode]);

  const getMultiplier = (duration: number) => {
    switch (duration) {
      case 5:
        return 1.75;
      case 10:
        return 1.8;
      case 15:
        return 1.85;
      case 30:
        return 1.9;
      case 60:
        return 1.95;
      default:
        return 1.9;
    }
  };

  const handleBet = async (direction: "UP" | "DOWN") => {
    if (!address || !isWalletConnected || gameMode !== "binomo") return;
    if (useStore.getState().isPlacingBet) return;

    try {
      const multiplier = getMultiplier(selectedDuration);

      await placeBetFromHouseBalance(
        betAmount,
        `${direction}-${multiplier}-${selectedDuration}`,
        address,
        undefined,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to place bet");
    }
  };

  const amountNum = Number(betAmount);
  const multiplier = getMultiplier(selectedDuration);
  const isBalanceError = !!error && errorCode === "insufficient_balance";

  const [sessionStart] = useState(() => Date.now());
  const sessionBets = bets.filter((b) => b.timestamp >= sessionStart);
  const sessionPnl = sessionBets.reduce(
    (sum, b) =>
      sum +
      (b.won
        ? parseFloat(b.payout) - parseFloat(b.amount)
        : -parseFloat(b.amount)),
    0,
  );
  let streak = 0;
  while (streak < sessionBets.length && isRealWin(sessionBets[streak]))
    streak++;

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

  const srMessage = useMemo(() => {
    if (error && isBalanceError) return `Insufficient balance. ${error}`;
    if (!lastResult) return "";
    const cur = lastResult.currency || "USDC";
    const count = lastResult.count ?? 1;
    if (count > 1 && !lastResult.refunded) {
      return `${lastResult.wins ?? 0} of ${count} boxes hit. Paid ${lastResult.payout.toFixed(2)} ${cur} on ${lastResult.amount.toFixed(2)} staked.`;
    }
    return lastResult.refunded
      ? `Round draw. Stake ${lastResult.amount.toFixed(2)} ${cur} refunded.`
      : lastResult.won
        ? `Round won. Payout ${lastResult.payout.toFixed(2)} ${cur}.`
        : `Round lost. Stake ${lastResult.amount.toFixed(2)} ${cur} forfeited.`;
  }, [lastResult, error, isBalanceError]);

  const betRef = React.useRef(handleBet);
  useEffect(() => {
    betRef.current = handleBet;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented) return;
      if (
        document.querySelector(
          '[aria-modal="true"], dialog[open], [data-tour-host]:not(:empty)',
        )
      )
        return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const preset = ["0.1", "0.5", "1", "5", "10"][Number(e.key) - 1];
      if (preset) {
        setBetAmount(preset);
        return;
      }
      if (
        gameMode !== "binomo" ||
        !isWalletConnected ||
        isPlacingBet ||
        useStore.getState().closedAssets.includes(useStore.getState().selectedAsset)
      )
        return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        void betRef.current(e.key === "ArrowUp" ? "UP" : "DOWN");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gameMode, isWalletConnected, isPlacingBet]);

  const lastSettledBet = useMemo(() => {
    if ((lastResult?.count ?? 1) > 1)
      return bets.find((b) => b.id === lastResult?.betId) ?? null;
    return matchSettledRound(bets, lastResult);
  }, [bets, lastResult]);
  const resultProof = useMemo<SettlementProofInput | null>(() => {
    if (!lastResult) return null;
    const betId = lastSettledBet?.id ?? lastResult.betId ?? null;
    if (!betId) return null;
    const row = lastSettledBet;
    if ((lastResult.count ?? 1) > 1 && !row) return null;
    const rowAsset =
      (row as unknown as { asset?: string | null } | null)?.asset ?? null;
    return {
      betId,
      asset: lastResult.asset ?? rowAsset ?? null,
      mode: row?.target?.id ?? null,
      direction: row?.target?.direction ?? null,
      multiplier: row?.target?.multiplier ?? null,
      stake: row ? parseFloat(row.amount) : lastResult.amount,
      payout: row ? parseFloat(row.payout) : lastResult.payout,
      won: row ? row.won : lastResult.won,
      recordedEndPrice: row?.endPrice || null,
      strikePrice: row?.startPrice || null,
      priceTop: row?.priceTop ?? null,
      priceBottom: row?.priceBottom ?? null,
      resolvedAt: lastResult.timestamp,
      network: lastResult.currency ?? null,
    };
  }, [lastSettledBet, lastResult]);

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
        priceTop: bet.priceTop ?? null,
        priceBottom: bet.priceBottom ?? null,
        resolvedAt: bet.timestamp,
      })),
    [bets],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col lg:flex-row">
      <div className="relative min-h-[420px] flex-1 lg:min-h-0">
        <LiveChart betAmount={betAmount} showFeedState={false} />
        <WinBurst />
        <div className="absolute left-1/2 top-2 z-[45] -translate-x-1/2">
          <div
            role="status"
            aria-live="polite"
            className={
              feedDelayed
                ? "whitespace-nowrap rounded-full bg-ink/85 px-3.5 py-1 text-[11px] font-medium text-white shadow-lg backdrop-blur-sm"
                : "sr-only"
            }
          >
            {feedDelayed ? "Price feed delayed — showing last known" : ""}
          </div>
        </div>
        <div className="absolute right-4 top-4 z-30">
          <IndicatorsToggle />
        </div>
      </div>

      <div aria-live="polite" className="sr-only">
        {srMessage}
      </div>

      <aside
        className="w-full shrink-0 overflow-y-auto border-t border-line bg-gradient-to-b from-white to-surface/60 lg:w-[380px] lg:border-l lg:border-t-0"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex flex-col gap-7 p-6">
          {resultProof && (
            <SettlementProof
              bet={resultProof}
              wallet={address}
              variant="bar"
              label={lastSettledBet?.target?.label ?? "Last round settled"}
            />
          )}

          {sessionBets.length > 0 && (
            <div className="grid grid-cols-3 gap-2 rounded-3xl bg-ink/[0.03] px-4 py-3 text-center">
              <div>
                <div
                  className={`font-jet text-[15px] font-medium ${sessionPnl > 0 ? "text-up" : sessionPnl < 0 ? "text-down" : "text-ink"}`}
                >
                  {sessionPnl > 0 ? "+" : ""}
                  {sessionPnl.toFixed(2)}
                </div>
                <div className="text-[11px] text-subtle">Session P&amp;L</div>
              </div>
              <div>
                <div className="font-jet text-[15px] font-medium">{streak}</div>
                <div className="text-[11px] text-subtle">Win streak</div>
              </div>
              <div>
                <div className="font-jet text-[15px] font-medium">
                  {sessionBets.length}
                </div>
                <div className="text-[11px] text-subtle">Rounds</div>
              </div>
            </div>
          )}

          <Segmented
            className="[&>button]:py-1.5"
            value={gameMode}
            onChange={setGameMode}
            options={[
              { value: "binomo", label: "Classic", tour: "classic-mode" },
              { value: "box", label: "Box", tour: "box-mode" },
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
                    betAmount === amt.toString()
                      ? glassSelected
                      : "bg-ink/[0.04] text-muted hover:bg-ink/[0.07] hover:text-ink"
                  }`}
                >
                  {amt}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Expiry</Label>
            <Segmented
              value={selectedDuration}
              onChange={setSelectedDuration}
              options={[5, 10, 15, 30, 60].map((d) => ({
                value: d,
                label: d < 60 ? `${d}s` : "1m",
                hint:
                  gameMode === "binomo" ? `×${getMultiplier(d)}` : undefined,
              }))}
            />
          </div>

          {gameMode === "binomo" ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted">Payout if you&apos;re right</span>
                <span className="font-jet font-semibold">
                  {Number.isFinite(amountNum)
                    ? (amountNum * multiplier).toFixed(2)
                    : "0.00"}{" "}
                  {currencySymbol}
                </span>
              </div>
              {isWalletConnected ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="up"
                      size="lg"
                      onClick={() => handleBet("UP")}
                      disabled={isPlacingBet || marketClosed}
                      aria-keyshortcuts="ArrowUp"
                    >
                      <ArrowUp size={18} weight="bold" /> Higher
                    </Button>
                    <Button
                      variant="down"
                      size="lg"
                      onClick={() => handleBet("DOWN")}
                      disabled={isPlacingBet || marketClosed}
                      aria-keyshortcuts="ArrowDown"
                    >
                      <ArrowDown size={18} weight="bold" /> Lower
                    </Button>
                  </div>
                  {marketClosed ? (
                    <p className="text-center text-xs text-down">
                      This market is closed right now
                    </p>
                  ) : (
                    <p className="text-center text-xs text-faint">
                      <kbd className="font-jet">↑</kbd> /{" "}
                      <kbd className="font-jet">↓</kbd> to trade ·{" "}
                      <kbd className="font-jet">1</kbd>–
                      <kbd className="font-jet">5</kbd> for amount
                    </p>
                  )}
                </>
              ) : (
                <Button size="lg" onClick={() => setConnectModalOpen(true)}>
                  Connect wallet to trade
                </Button>
              )}
            </div>
          ) : (
            <p className="rounded-3xl bg-ink/[0.03] px-5 py-4 text-sm leading-relaxed text-muted">
              {gameMode === "box"
                ? "Click a cell on the chart to bet that the price lands inside it. Cells further from the price pay more."
                : "Drag a box on the chart, then confirm to bet the price lands inside it."}
            </p>
          )}

          {isWalletConnected && address && <ArkivOwnBets wallet={address} />}

          {error && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-2xl bg-down-soft px-4 py-3 text-sm text-down"
            >
              <p className="flex-1 leading-snug">
                {isBalanceError
                  ? `Not enough house balance. Deposit ${currencySymbol} below, then place your bet.`
                  : error}
              </p>
              <button
                type="button"
                onClick={clearError}
                aria-label="Dismiss error"
                className="text-down/70 hover:text-down"
              >
                <X size={16} />
              </button>
            </div>
          )}

          <div
            className="border-y border-line py-6"
            data-tour="deposit-section"
          >
            {isWalletConnected && address ? (
              <div className="flex flex-col gap-3" data-tour="wallet-tab">
                <BalanceDisplay />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted">Wallet</span>
                  <span className="font-jet">
                    {walletBalance === null ? "—" : walletBalance.toFixed(4)}{" "}
                    {currencySymbol}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">
                Connect a wallet to deposit USDC and start trading.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                Blitz{" "}
                <span
                  className={`font-jet font-normal ${isBlitzActive ? "text-down" : "text-faint"}`}
                >
                  {isBlitzActive
                    ? `${blitzTimeRemaining} left`
                    : `in ${blitzCountdown}`}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-subtle">2× on boosted cells. The fee comes out of your play balance.</p>
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
                disabled={
                  isActivatingBlitz || (isWalletConnected && !isBlitzActive)
                }
                onClick={() =>
                  isWalletConnected
                    ? void handleEnterBlitz()
                    : setConnectModalOpen(true)
                }
              >
                {isActivatingBlitz
                  ? "Entering…"
                  : `Enter · ${blitzEntryFee} ${blitzEntryCurrencySymbol}`}
              </Button>
            )}
          </div>

          <MiniHistory />

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
                      label={proofBet.direction ?? "Round"}
                    />
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                Proof reads your own rounds only: the server returns a row
                solely when the bet id and your connected wallet match.
              </p>
            </div>
          )}

          <a
            href={explorerAddressUrl(getArcConfig().treasuryAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto inline-flex items-center gap-1 self-start text-xs text-faint hover:text-ink"
          >
            Settled in USDC on Arc · Treasury contract{" "}
            <ArrowUpRight size={12} />
          </a>
        </div>
      </aside>
    </div>
  );
};
