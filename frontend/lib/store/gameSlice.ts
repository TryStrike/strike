
import { StateCreator } from "zustand";
import { TargetCell, PricePoint } from "@/lib/types/game";
import { AssetType } from "@/lib/utils/priceFeed";
import { playWinSound, playLoseSound } from "@/lib/utils/sounds";
import { resolveHouseLedgerCurrency } from "@/lib/balance/houseLedgerCurrency";
import { useToastStore } from "@/lib/hooks/useToast";

export type GameMode = 'binomo' | 'box' | 'draw';

export interface ActiveBet {
  id: string;
  mode: GameMode;
  asset: AssetType;
  amount: number;
  multiplier: number;
  direction: 'UP' | 'DOWN';
  timestamp: number;
  status: 'active' | 'settled';
  network?: string;
  userAddress?: string;
  settlementToken?: string;
  strikePrice?: number;
  endTime?: number;
  cellId?: string;
  priceTop?: number;
  priceBottom?: number;
  startTime?: number;
}

export interface GameState {
  gameMode: GameMode;
  selectedAsset: AssetType;
  currentPrice: number;
  priceHistory: PricePoint[];
  lastTickAt: number;
  priceFeed: { mode: 'stream' | 'poll'; connected: boolean };
  setPriceFeed: (feed: { mode: 'stream' | 'poll'; connected: boolean }) => void;
  assetPrices: Record<string, number>;
  assetHistories: Record<string, PricePoint[]>;
  rawAssetPrices: Record<string, number>;
  activeBets: ActiveBet[];
  targetCells: TargetCell[];
  isPlacingBet: boolean;
  lastResult: {
    won: boolean;
    amount: number;
    payout: number;
    timestamp: number;
    asset: AssetType;
    cellId?: string;
    currency?: string;
    betId?: string;
  } | null;
  error: string | null;
  timeframeSeconds: number;

  isBlitzActive: boolean;
  blitzEndTime: number | null;
  nextBlitzTime: number;
  hasBlitzAccess: boolean;
  blitzMultiplier: number;
  activeTab: 'bet' | 'wallet' | 'blitz';
  activeIndicators: Record<string, boolean>;
  isIndicatorsOpen: boolean;
  isTourOpen: boolean;

  setActiveTab: (tab: 'bet' | 'wallet' | 'blitz') => void;
  setGameMode: (mode: GameMode) => void;
  setSelectedAsset: (asset: AssetType) => void;
  setTimeframeSeconds: (seconds: number) => void;
  placeBetFromHouseBalance: (amount: string, targetId: string, userAddress: string, cellId?: string, metadata?: { priceTop?: number; priceBottom?: number; startTime?: number; endTime?: number }) => Promise<{ betId: string; remainingBalance: number; bet: ActiveBet } | void>;
  updatePrice: (price: number, asset?: AssetType) => void;
  updateAllPrices: (prices: Record<string, number>) => void;


  addActiveBet: (bet: ActiveBet) => void;
  resolveBet: (betId: string, won: boolean, payout: number) => void;
  clearError: () => void;


  enableBlitzAccess: () => void;
  updateBlitzTimer: () => void;
  toggleIndicator: (indicatorId: string) => void;
  setIsIndicatorsOpen: (isOpen: boolean) => void;
  setIsTourOpen: (isOpen: boolean) => void;
}



const MAX_PRICE_HISTORY = 200;

const priceAtOrBefore = (
  history: PricePoint[],
  endTime: number,
  fallback: number
): number => {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].timestamp <= endTime) return history[i].price;
  }
  return fallback;
};


const DEFAULT_TARGET_CELLS: TargetCell[] = [
  { id: '1', label: '+$5 in 30s', multiplier: 1.5, priceChange: 5, direction: 'UP' },
  { id: '2', label: '+$10 in 30s', multiplier: 2.0, priceChange: 10, direction: 'UP' },
  { id: '3', label: '+$20 in 30s', multiplier: 3.0, priceChange: 20, direction: 'UP' },
  { id: '4', label: '+$50 in 30s', multiplier: 5.0, priceChange: 50, direction: 'UP' },
  { id: '5', label: '+$100 in 30s', multiplier: 10.0, priceChange: 100, direction: 'UP' },
  { id: '6', label: '-$5 in 30s', multiplier: 1.5, priceChange: -5, direction: 'DOWN' },
  { id: '7', label: '-$10 in 30s', multiplier: 2.0, priceChange: -10, direction: 'DOWN' },
  { id: '8', label: '-$20 in 30s', multiplier: 3.0, priceChange: -20, direction: 'DOWN' },
];

const ROUND_CLOCK_GRACE_MS = 400;
const ROUND_CLOCK_MAX_REARMS = 60;

export const createGameSlice: StateCreator<any> = (set, get) => {
  const roundTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearRoundTimer = (betId: string) => {
    const t = roundTimers.get(betId);
    if (t) {
      clearTimeout(t);
      roundTimers.delete(betId);
    }
  };

  const settleByWallClock = (betId: string, rearmsLeft = ROUND_CLOCK_MAX_REARMS) => {
    roundTimers.delete(betId);
    const state = get();
    const bet: ActiveBet | undefined = state.activeBets.find((b: ActiveBet) => b.id === betId);
    if (!bet || bet.status !== 'active' || !bet.endTime) return;
    if (Date.now() < bet.endTime) return;
    const endTime = bet.endTime;

    const key = (bet.asset || 'BNB') as string;
    const history: PricePoint[] = state.assetHistories?.[key] || [];
    const knownPrice = state.assetPrices?.[key];
    const usable =
      history.some((p) => p.timestamp <= endTime) ||
      (typeof knownPrice === 'number' && knownPrice > 0);
    if (!usable) {
      if (rearmsLeft > 0) {
        roundTimers.set(betId, setTimeout(() => settleByWallClock(betId, rearmsLeft - 1), 1000));
      }
      return;
    }

    const settledPrice = priceAtOrBefore(history, endTime, knownPrice ?? 0);
    if (settledPrice <= 0) return;

    if (bet.mode === 'binomo' && bet.strikePrice !== undefined) {
      if (settledPrice === bet.strikePrice) {
        get().resolveBet(bet.id, true, bet.amount);
      } else {
        const won = bet.direction === 'UP' ? settledPrice > bet.strikePrice : settledPrice < bet.strikePrice;
        get().resolveBet(bet.id, won, won ? bet.amount * bet.multiplier : 0);
      }
    } else if (
      (bet.mode === 'box' || bet.mode === 'draw') &&
      bet.priceTop !== undefined &&
      bet.priceBottom !== undefined
    ) {
      const won = settledPrice <= bet.priceTop && settledPrice >= bet.priceBottom;
      get().resolveBet(bet.id, won, won ? bet.amount * bet.multiplier : 0);
    }
  };

  const armRoundClock = (bet: ActiveBet) => {
    if (!Number.isFinite(bet.endTime)) return;
    clearRoundTimer(bet.id);
    const delay = Math.max(0, (bet.endTime as number) - Date.now()) + ROUND_CLOCK_GRACE_MS;
    roundTimers.set(bet.id, setTimeout(() => settleByWallClock(bet.id), delay));
  };

  return {
  gameMode: 'binomo',
  selectedAsset: 'BNB',
  currentPrice: 0,
  lastTickAt: 0,
  priceFeed: { mode: 'poll', connected: false },
  setPriceFeed: (feed: { mode: 'stream' | 'poll'; connected: boolean }) => set({ priceFeed: feed }),
  priceHistory: [],
  assetPrices: {},
  assetHistories: {},
  rawAssetPrices: {},

  activeBets: [],
  targetCells: DEFAULT_TARGET_CELLS,
  isPlacingBet: false,
  lastResult: null,
  error: null,
  timeframeSeconds: 5,
  activeTab: 'bet',
  activeIndicators: {},
  isIndicatorsOpen: false,
  isTourOpen: false,

  isBlitzActive: false,
  blitzEndTime: null,
  nextBlitzTime: (() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('binomo_blitz_next');
      if (stored) {
        const t = parseInt(stored, 10);
        if (t > Date.now()) return t;
      }
      const next = Date.now() + 2 * 60 * 1000;
      localStorage.setItem('binomo_blitz_next', next.toString());
      return next;
    }
    return Date.now() + 2 * 60 * 1000;
  })(),
  hasBlitzAccess: false,
  blitzMultiplier: 2.0,

  setGameMode: (mode: GameMode) => {
    set({
      gameMode: mode,
      lastResult: null,
    });

  },

  setActiveTab: (tab: 'bet' | 'wallet' | 'blitz') => {
    set({ activeTab: tab });
  },

  toggleIndicator: (indicatorId: string) => {
    set((state: GameState) => ({
      activeIndicators: {
        ...state.activeIndicators,
        [indicatorId]: !state.activeIndicators[indicatorId]
      }
    }));
  },

  setIsIndicatorsOpen: (isOpen: boolean) => {
    set({ isIndicatorsOpen: isOpen });
  },

  setIsTourOpen: (isOpen: boolean) => {
    set({ isTourOpen: isOpen });
  },


  setTimeframeSeconds: (seconds: number) => {
    const { gameMode, activeBets } = get();

    if (
      (gameMode === 'box' || gameMode === 'draw') &&
      activeBets.some((bet: ActiveBet) => bet.mode === 'box' || bet.mode === 'draw')
    ) {
      return;
    }

    set((state: GameState) => ({
      timeframeSeconds: seconds,
      activeBets: state.activeBets,
    }));
  },




  setSelectedAsset: (asset: AssetType) => {
    const { selectedAsset: currentAsset, assetHistories, assetPrices } = get();

    if (currentAsset !== asset) {
      set({
        selectedAsset: asset,
        priceHistory: assetHistories[asset] || [],
        currentPrice: assetPrices[asset] || 0
      });
    }
  },


  placeBetFromHouseBalance: async (
    amount: string,
    targetId: string,
    userAddress: string,
    cellId?: string,
    metadata?: { priceTop?: number; priceBottom?: number; startTime?: number; endTime?: number }
  ) => {
    if (get().isPlacingBet) return;

    set({ isPlacingBet: true, error: null });

    const { targetCells, currentPrice, addActiveBet, gameMode, timeframeSeconds, selectedAsset, assetHistories } = get();

    try {
      const betAmount = Number(amount);
      if (!Number.isFinite(betAmount) || betAmount <= 0) {
        throw new Error("Invalid bet amount");
      }

      if (currentPrice <= 0 || !assetHistories?.[selectedAsset]?.length) {
        throw new Error("Price feed is not ready yet — try again in a moment");
      }


      let target: TargetCell;
      let direction: 'UP' | 'DOWN' = 'UP';
      let multiplier = 1.9;
      let durationSeconds = timeframeSeconds || 30;

      if (targetId.startsWith('UP-') || targetId.startsWith('DOWN-')) {
        const parts = targetId.split('-');
        direction = parts[0] as 'UP' | 'DOWN';
        multiplier = parseFloat(parts[1]) || 1.9;
        durationSeconds = parseInt(parts[2]) || durationSeconds;

        target = {
          id: targetId,
          label: `${direction} x${multiplier} (${durationSeconds}s)`,
          multiplier: multiplier,
          priceChange: direction === 'UP' ? 10 : -10,
          direction: direction
        };
      } else {
        const foundTarget = targetCells.find((cell: TargetCell) => cell.id === targetId);
        if (!foundTarget) {
          throw new Error("Invalid target cell");
        }
        target = foundTarget;
        direction = target.direction;
        multiplier = target.multiplier;
      }

      const clickTime = Date.now();
      const betEndTime =
        gameMode === 'binomo'
          ? clickTime + durationSeconds * 1000
          : metadata?.endTime ?? clickTime + durationSeconds * 1000;
      const betRequestId = crypto.randomUUID();

      const selectedCurrency = (get() as any).selectedCurrency;
      const currency = resolveHouseLedgerCurrency({
        selectedCurrency,
      });

      const response = await fetch('/api/balance/bet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userAddress: userAddress,
          betAmount,
          currency: currency,
          roundId: clickTime,
          targetPrice: currentPrice,
          strikePrice: currentPrice,
          mode: gameMode,
          endTime: betEndTime,
          priceTop: metadata?.priceTop,
          priceBottom: metadata?.priceBottom,
          betRequestId,
          isOver: direction === 'UP',
          multiplier: multiplier,
          asset: selectedAsset,
          targetCell: {
            id: 9,
            priceChange: target.priceChange,
            direction: direction,
            timeframe: durationSeconds,
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to place bet');
      }

      const data = await response.json();

      if (data.duplicate) {
        if (data.betId == null || data.settlementToken == null) {
          await (get() as any).fetchBalance?.(userAddress);
          set({ isPlacingBet: false, error: null });
          throw new Error(data.message || 'Bet already processed');
        }
      }

      if (data.betId == null || data.settlementToken == null) {
        await (get() as any).fetchBalance?.(userAddress);
        set({ isPlacingBet: false, error: null });
        throw new Error('Invalid bet response from server');
      }

      const remRaw = data.remainingBalance;
      const rem = remRaw === null || remRaw === undefined ? NaN : Number(remRaw);
      if (Number.isFinite(rem)) {
        (get() as any).setBalance?.(rem);
      }

      const activeBet: ActiveBet = {
        id: data.betId,
        mode: gameMode,
        asset: selectedAsset,
        amount: betAmount,
        multiplier: data.multiplier ?? multiplier,
        direction: direction,
        timestamp: clickTime,
        status: 'active',
        network: currency,
        userAddress: userAddress,
        settlementToken: data.settlementToken,
        ...(gameMode === 'binomo' ? {
          strikePrice: data.strikePrice ?? currentPrice,
          endTime: data.endTime ?? betEndTime
        } : {
          cellId: cellId || targetId,
          priceTop: metadata?.priceTop,
          priceBottom: metadata?.priceBottom,
          startTime: metadata?.startTime,
          endTime: data.endTime ?? metadata?.endTime
        })
      };


      addActiveBet(activeBet);

      set({
        isPlacingBet: false,
        error: null
      });

      return {
        betId: data.betId,
        remainingBalance: data.remainingBalance,
        bet: activeBet
      };
    } catch (error) {
      console.error("Error placing bet from house balance:", error);
      set({
        isPlacingBet: false,
        error: error instanceof Error ? error.message : "Failed to place bet"
      });
      throw error;
    }
  },

  updatePrice: (price: number, asset?: AssetType) => {
    if (!Number.isFinite(price) || price <= 0) return;
    const { selectedAsset, assetPrices, assetHistories, rawAssetPrices } = get();
    const key = asset ?? selectedAsset;
    const now = Date.now();

    const history = [...(assetHistories[key] || [])];
    history.push({ timestamp: now, price });

    const update: Partial<GameState> = {
      assetPrices: { ...assetPrices, [key]: price },
      assetHistories: { ...assetHistories, [key]: history.slice(-MAX_PRICE_HISTORY) },
      rawAssetPrices: { ...rawAssetPrices, [key]: price },
      lastTickAt: now,
    };

    if (key === selectedAsset) {
      update.currentPrice = price;
      update.priceHistory = update.assetHistories![key];
    }

    set(update as GameState);
  },

  updateAllPrices: (prices: Record<string, number>) => {
    const { 
      selectedAsset, activeBets, resolveBet, assetPrices, 
      assetHistories, rawAssetPrices
    } = get();
    const now = Date.now();
    
    const updatedAssetPrices = { ...assetPrices };
    const updatedAssetHistories = { ...assetHistories };
    const updatedRawPrices = { ...rawAssetPrices };
    
    let currentAssetUpdated = false;
    let nextCurrentPrice = 0;
    let nextCurrentHistory: PricePoint[] = [];
    let anyFreshTick = false;

    Object.entries(prices).forEach(([asset, price]) => {
      const assetKey = asset as AssetType;

      const lastRawPrice = updatedRawPrices[assetKey];
      const previousVirtualPrice = updatedAssetPrices[assetKey];
      const unchanged =
        lastRawPrice !== undefined &&
        previousVirtualPrice !== undefined &&
        price === lastRawPrice;

      let finalPrice: number;

      if (unchanged) {
        finalPrice = previousVirtualPrice as number;
      } else {
        const rawDelta = price - (lastRawPrice ?? price);
        finalPrice = (previousVirtualPrice ?? price) + rawDelta;

        updatedAssetPrices[assetKey] = finalPrice;
        updatedRawPrices[assetKey] = price;
        anyFreshTick = true;

        const history = [...(updatedAssetHistories[assetKey] || [])];
        history.push({ timestamp: now, price: finalPrice });
        updatedAssetHistories[assetKey] = history.slice(-MAX_PRICE_HISTORY);
      }

      if (assetKey === selectedAsset) {
        currentAssetUpdated = true;
        nextCurrentPrice = finalPrice;
        nextCurrentHistory = updatedAssetHistories[assetKey] || [];
      }

      if (activeBets && activeBets.length > 0) {
        const settleHistory = updatedAssetHistories[assetKey] || [];
        activeBets.forEach((bet: ActiveBet) => {
          if ((bet.asset || 'BNB') !== assetKey || bet.status !== 'active') return;

          if (bet.mode === 'binomo' && bet.endTime && bet.strikePrice !== undefined && now >= bet.endTime) {
            const settledPrice = priceAtOrBefore(settleHistory, bet.endTime, finalPrice);
            if (settledPrice === bet.strikePrice) {
              resolveBet(bet.id, true, bet.amount);
            } else {
              const won = bet.direction === 'UP' ? settledPrice > bet.strikePrice : settledPrice < bet.strikePrice;
              resolveBet(bet.id, won, won ? bet.amount * bet.multiplier : 0);
            }
          } else if ((bet.mode === 'box' || bet.mode === 'draw') && bet.endTime && bet.priceTop !== undefined && bet.priceBottom !== undefined && now >= bet.endTime) {
            const settledPrice = priceAtOrBefore(settleHistory, bet.endTime, finalPrice);
            const won = settledPrice <= bet.priceTop && settledPrice >= bet.priceBottom;
            resolveBet(bet.id, won, won ? bet.amount * bet.multiplier : 0);
          }
        });
      }
    });

    const updateObj: any = {
      assetPrices: updatedAssetPrices,
      assetHistories: updatedAssetHistories,
      rawAssetPrices: updatedRawPrices,
      error: null
    };

    if (currentAssetUpdated) {
      updateObj.currentPrice = nextCurrentPrice;
      updateObj.priceHistory = nextCurrentHistory;
    }

    if (anyFreshTick) updateObj.lastTickAt = now;

    set(updateObj);
  },


  addActiveBet: (bet: ActiveBet) => {
    const { activeBets } = get();
    set({ activeBets: [...activeBets, bet] });
    armRoundClock(bet);
  },

  resolveBet: (betId: string, won: boolean, payout: number) => {
    const { activeBets, currentPrice, address, network, fetchBalance } = get();
    const resolvedBet = activeBets.find((b: ActiveBet) => b.id === betId);

    clearRoundTimer(betId);

    if (resolvedBet) {
      const now = Date.now();

      if (won) playWinSound();
      else playLoseSound();

      set({
        activeBets: activeBets.filter((b: ActiveBet) => b.id !== betId),
        lastResult: {
          won,
          amount: resolvedBet.amount,
          payout,
          timestamp: now,
          asset: resolvedBet.asset,
          cellId: resolvedBet.cellId,
          currency: resolvedBet.network || network || 'USDC',
          betId: resolvedBet.id
        }
      });

      const settlementAddress = resolvedBet.userAddress || address;
      const settlementCurrency = resolvedBet.network || network || 'USDC';

      const anyGet = get() as any;
      const historyRecord = {
          id: resolvedBet.id,
          timestamp: now,
          amount: resolvedBet.amount.toString(),
          won: won,
          payout: payout.toString(),
          startPrice: resolvedBet.strikePrice || 0,
          endPrice: currentPrice,
          actualChange: currentPrice - (resolvedBet.strikePrice || 0),
          asset: resolvedBet.asset,
          endTime: resolvedBet.endTime ?? null,
          strikePrice: resolvedBet.strikePrice ?? null,
          target: {
            id:
              resolvedBet.mode === 'binomo'
                ? 'classic'
                : resolvedBet.mode === 'draw'
                  ? 'draw'
                  : 'box',
            label:
              resolvedBet.mode === 'binomo'
                ? `${resolvedBet.direction} ${resolvedBet.multiplier}x`
                : resolvedBet.mode === 'draw'
                  ? `Draw ${resolvedBet.multiplier}x`
                  : `Box ${resolvedBet.multiplier}x`,
            multiplier: resolvedBet.multiplier,
            priceChange: 0,
            direction: resolvedBet.direction
          }
      };
      anyGet.addBet?.(historyRecord);

      const reconcileRound = async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            const res = await fetch('/api/balance/win', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userAddress: settlementAddress,
                winAmount: payout,
                currency: settlementCurrency,
                betId: resolvedBet.id,
                settlementToken: resolvedBet.settlementToken,
              }),
            });
            if (res.ok) return await res.json();
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return null;
      };

      if (settlementAddress) {
        void (async () => {
          const result = await reconcileRound();
          if (fetchBalance) fetchBalance(settlementAddress);
          if (!result) {
            console.error('No server result yet for bet', resolvedBet.id);
            if (won) {
              useToastStore.getState().addToast(
                'Your result is taking longer than usual. Your balance will update once this round settles.',
                'error'
              );
            }
            return;
          }
          const serverPayout = Number(result.payout) || 0;
          const serverWon = result.won === true;
          const shown = get().lastResult;
          if (shown?.betId === resolvedBet.id) {
            set({ lastResult: { ...shown, won: serverWon, payout: serverPayout } });
          }
          anyGet.addBet?.({
            ...historyRecord,
            won: serverWon,
            payout: serverPayout.toString(),
            endPrice: result.endPrice ?? historyRecord.endPrice,
          });
        })();
      }
    }
  },

  clearError: () => {
    set({ error: null });
  },

  enableBlitzAccess: () => {
    set({ hasBlitzAccess: true });
  },

  updateBlitzTimer: () => {
    const { isBlitzActive, blitzEndTime, nextBlitzTime } = get();
    const now = Date.now();
    const BLITZ_DURATION = 60 * 1000;
    const BLITZ_INTERVAL = 2 * 60 * 1000;

    if (isBlitzActive) {
      if (blitzEndTime && now >= blitzEndTime) {
        const newNextTime = now + BLITZ_INTERVAL;
        if (typeof window !== 'undefined') {
          localStorage.setItem('binomo_blitz_next', newNextTime.toString());
        }
        set({
          isBlitzActive: false,
          blitzEndTime: null,
          nextBlitzTime: newNextTime,
          hasBlitzAccess: false,
        });
      }
    } else {
      if (now >= nextBlitzTime) {
        const newNextTime = now + BLITZ_INTERVAL + BLITZ_DURATION;
        if (typeof window !== 'undefined') {
          localStorage.setItem('binomo_blitz_next', newNextTime.toString());
        }
        set({
          isBlitzActive: true,
          blitzEndTime: now + BLITZ_DURATION,
          nextBlitzTime: newNextTime,
        });
      }
    }
  }
  };
};
