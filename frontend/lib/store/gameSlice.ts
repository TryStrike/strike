
import { StateCreator } from "zustand";
import { TargetCell, PricePoint } from "@/lib/types/game";
import { AssetType } from "@/lib/utils/priceFeed";
import { playWinSound, playLoseSound } from "@/lib/utils/sounds";
import { resolveHouseLedgerCurrency } from "@/lib/balance/houseLedgerCurrency";
import { useToastStore } from "@/lib/hooks/useToast";
import { ensureBalanceSession } from "@/lib/balance/balanceClientHeaders";

export type GameMode = 'binomo' | 'box';

export interface ActiveBet {
  id: string;
  mode: GameMode;
  asset: AssetType;
  amount: number;
  multiplier: number;
  direction: 'UP' | 'DOWN';
  timestamp: number;
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
  settlingBets: ActiveBet[];
  maxBands: Record<string, number>;
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
  setMaxBands: (bands: Record<string, number>) => void;


  addActiveBet: (bet: ActiveBet) => void;
  clearError: () => void;


  enableBlitzAccess: () => void;
  updateBlitzTimer: () => void;
  toggleIndicator: (indicatorId: string) => void;
  setIsIndicatorsOpen: (isOpen: boolean) => void;
  setIsTourOpen: (isOpen: boolean) => void;
}



const MAX_PRICE_HISTORY = 720;

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
const FAST_CLAIMS = 8;
const CLAIM_RETRY_MS = 1000;
const SLOW_CLAIMS = 24;
const SLOW_CLAIM_RETRY_MS = 5000;

const sameWallet = (a?: string | null, b?: string | null) => a?.toLowerCase() === b?.toLowerCase();

/** Retries until the server answers, since the sweeper settles the round even if every claim fails. */
async function claimRound(bet: ActiveBet, userAddress: string, currency: string, onSlow: () => void) {
  let sessionRefreshed = false;
  for (let attempt = 0; attempt < FAST_CLAIMS + SLOW_CLAIMS; attempt += 1) {
    if (attempt === FAST_CLAIMS) onSlow();
    try {
      const res = await fetch('/api/balance/win', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAddress,
          winAmount: 0,
          currency,
          betId: bet.id,
          settlementToken: bet.settlementToken,
        }),
      });
      if (res.ok) return await res.json();
      if (res.status === 401 && !sessionRefreshed) {
        sessionRefreshed = true;
        await ensureBalanceSession();
        continue;
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 409) {
        console.error('[settle] claim refused', bet.id, res.status);
        return null;
      }
    } catch (err) {
      console.error('[settle] claim failed, retrying', bet.id, err);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt < FAST_CLAIMS ? CLAIM_RETRY_MS : SLOW_CLAIM_RETRY_MS));
  }
  return null;
}

export const createGameSlice: StateCreator<any> = (set, get) => {
  const roundTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const settleRound = async (betId: string) => {
    roundTimers.delete(betId);
    const { activeBets, settlingBets, address, network, currentPrice } = get();
    const bet: ActiveBet | undefined = activeBets.find((b: ActiveBet) => b.id === betId);
    if (!bet) return;

    set({
      activeBets: activeBets.filter((b: ActiveBet) => b.id !== betId),
      settlingBets: [...settlingBets, bet],
    });

    const wallet = bet.userAddress || address;
    const currency = bet.network || network || 'USDC';
    const warnSlow = () =>
      useToastStore.getState().addToast(
        'Your result is taking longer than usual. Your balance will update once this round settles.',
        'error'
      );
    const result = wallet ? await claimRound(bet, wallet, currency, warnSlow) : null;

    set((state: GameState) => ({ settlingBets: state.settlingBets.filter((b) => b.id !== betId) }));

    if (!sameWallet(wallet, get().address)) return;
    if (wallet) void get().fetchBalance?.(wallet);

    if (!result) {
      console.error('No server result for bet', bet.id);
      return;
    }

    const won = result.won === true;
    const payout = Number(result.payout) || 0;
    const endPrice = result.endPrice ?? currentPrice;
    const timestamp = Date.now();

    if (won) playWinSound();
    else playLoseSound();

    get().addBet?.({
      id: bet.id,
      timestamp,
      amount: bet.amount.toString(),
      won,
      payout: payout.toString(),
      startPrice: bet.strikePrice || 0,
      endPrice,
      actualChange: endPrice - (bet.strikePrice || 0),
      asset: bet.asset,
      endTime: bet.endTime ?? null,
      strikePrice: bet.strikePrice ?? null,
      target: {
        id: bet.mode === 'binomo' ? 'classic' : 'box',
        label: bet.mode === 'binomo' ? `${bet.direction} ${bet.multiplier}x` : `Box ${bet.multiplier}x`,
        multiplier: bet.multiplier,
        priceChange: 0,
        direction: bet.direction,
      },
    });

    set({
      lastResult: {
        won,
        amount: bet.amount,
        payout,
        timestamp,
        asset: bet.asset,
        cellId: bet.cellId,
        currency,
        betId: bet.id,
      },
    });
  };

  const armRoundClock = (bet: ActiveBet) => {
    if (!Number.isFinite(bet.endTime)) return;
    const pending = roundTimers.get(bet.id);
    if (pending) clearTimeout(pending);
    const delay = Math.max(0, (bet.endTime as number) - Date.now()) + ROUND_CLOCK_GRACE_MS;
    roundTimers.set(bet.id, setTimeout(() => void settleRound(bet.id), delay));
  };

  return {
  gameMode: 'binomo',
  selectedAsset: 'BTC',
  currentPrice: 0,
  lastTickAt: 0,
  priceFeed: { mode: 'poll', connected: false },
  setPriceFeed: (feed: { mode: 'stream' | 'poll'; connected: boolean }) => set({ priceFeed: feed }),
  priceHistory: [],
  assetPrices: {},
  assetHistories: {},
  rawAssetPrices: {},

  activeBets: [],
  settlingBets: [],
  maxBands: {},
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
      gameMode === 'box' &&
      activeBets.some((bet: ActiveBet) => bet.mode === 'box')
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

  setMaxBands: (bands: Record<string, number>) => {
    set((state: GameState) => ({ maxBands: { ...state.maxBands, ...bands } }));
  },

  updateAllPrices: (prices: Record<string, number>) => {
    const { 
      selectedAsset, assetPrices, 
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
