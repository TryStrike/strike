/**
 * Game state slice for Zustand store
 * Manages game state, active rounds, price data, and betting actions
 * 
 * Note: game logic remains off-chain.
 * Only deposit/withdrawal operations interact with the blockchain.
 */

import { StateCreator } from "zustand";
import { TargetCell, PricePoint } from "@/lib/types/game";
import { AssetType } from "@/lib/utils/priceFeed";
import { playWinSound, playLoseSound } from "@/lib/utils/sounds";
import { resolveHouseLedgerCurrency } from "@/lib/balance/houseLedgerCurrency";
import { useToastStore } from "@/lib/hooks/useToast";

// Game Modes
export type GameMode = 'binomo' | 'box' | 'draw';

// Active bet (Supports both modes)
export interface ActiveBet {
  id: string;
  mode: GameMode;
  asset: AssetType; // Added for multi-asset tracking
  amount: number;
  multiplier: number;
  direction: 'UP' | 'DOWN';
  timestamp: number;
  status: 'active' | 'settled';
  network?: string; // Track which network (currency) this bet uses
  /** Account type (demo/real) frozen at placement time — settlement must use
   *  this, never the live store value, in case the user toggles mid-round. */
  accountType?: 'real' | 'demo';
  /** Wallet address captured at placement time — used for settlement even if
   *  the user disconnects their wallet before the round resolves. */
  userAddress?: string;
  settlementToken?: string;
  // Classic mode specific
  strikePrice?: number;
  endTime?: number;
  // Box mode specific
  cellId?: string;
  priceTop?: number;
  priceBottom?: number;
  // Draw mode specific
  startTime?: number;
}

export interface GameState {
  // Core State
  gameMode: GameMode;
  selectedAsset: AssetType;
  currentPrice: number;
  priceHistory: PricePoint[];
  /** Wall-clock of the last FRESH (non-stale) feed tick. UI shows a
   *  "price feed delayed" notice when Date.now() - lastTickAt exceeds a threshold. */
  lastTickAt: number;
  assetPrices: Record<string, number>; // Global price tracking
  assetHistories: Record<string, PricePoint[]>; // History for each asset
  rawAssetPrices: Record<string, number>; // Store original prices for delta amplification
  activeBets: ActiveBet[];
  targetCells: TargetCell[];
  isPlacingBet: boolean;
  lastResult: {
    won: boolean;
    amount: number;
    payout: number;
    timestamp: number;
    asset: AssetType; // Track which asset this result belongs to
    cellId?: string; // For box mode visual feedback
    currency?: string; // The currency usage (e.g. USDC)
    /** Server bet id of the settled round. Lets the UI offer the settlement
     *  proof (GET /api/bets/<id>) even when no history row matches. Absent on
     *  results produced before this field existed. */
    betId?: string;
  } | null;
  error: string | null;
  timeframeSeconds: number;

  // Blitz Round State (Premium Feature)
  isBlitzActive: boolean;
  blitzEndTime: number | null;
  nextBlitzTime: number;
  hasBlitzAccess: boolean;
  blitzMultiplier: number;
  activeTab: 'bet' | 'wallet' | 'blitz';
  activeIndicators: Record<string, boolean>;
  isIndicatorsOpen: boolean;
  isTourOpen: boolean;

  // Actions
  setActiveTab: (tab: 'bet' | 'wallet' | 'blitz') => void;
  setGameMode: (mode: GameMode) => void;
  setSelectedAsset: (asset: AssetType) => void;
  setTimeframeSeconds: (seconds: number) => void;
  placeBetFromHouseBalance: (amount: string, targetId: string, userAddress: string, cellId?: string, metadata?: { priceTop?: number; priceBottom?: number; startTime?: number; endTime?: number }) => Promise<{ betId: string; remainingBalance: number; bet: ActiveBet } | void>;
  updatePrice: (price: number, asset?: AssetType) => void;
  updateAllPrices: (prices: Record<string, number>) => void;
  startGlobalPriceFeed: (updateAllPrices: (prices: Record<string, number>) => void) => (() => void);


  addActiveBet: (bet: ActiveBet) => void;
  resolveBet: (betId: string, won: boolean, payout: number) => void;
  clearError: () => void;


  // Blitz Round Actions
  enableBlitzAccess: () => void;
  updateBlitzTimer: () => void;
  // Indicators Actions
  toggleIndicator: (indicatorId: string) => void;
  setIsIndicatorsOpen: (isOpen: boolean) => void;
  setIsTourOpen: (isOpen: boolean) => void;
}



// Maximum price history points (reduced for performance)
const MAX_PRICE_HISTORY = 200;

/**
 * Settlement source of truth: the last history point whose timestamp is at or
 * before the bet's endTime. Falls back to `fallback` only if the history has
 * no usable point (should not happen — placement requires history).
 */
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


// Default target cells configuration
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

/** Grace after the round end before the wall-clock watchdog settles a round,
 *  so the normal tick path (which settles on the arriving tick) stays the
 *  primary path and the watchdog is only the fallback for a stalled feed. */
const ROUND_CLOCK_GRACE_MS = 400;
/** If no usable price exists yet when the watchdog fires (feed stalled
 *  exactly across the round end), retry at 1s intervals for this many tries
 *  before deferring to the next incoming tick. Never invents a price. */
const ROUND_CLOCK_MAX_REARMS = 60;

/**
 * Create game slice for Zustand store
 * Handles betting, round management, and price updates
 */
export const createGameSlice: StateCreator<any> = (set, get) => {
  // ── Round clock watchdog ───────────────────────────────────────────────────
  // Rounds must settle from their deterministic endTime even when the price
  // feed stalls or the tab is throttled. Timers fire LATE under throttling,
  // never early: settleByWallClock re-checks Date.now() >= endTime and applies
  // the exact tick rule (priceAtOrBefore) the tick path uses.
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
    // The tick path already settled it (or the user cleared it): terminal.
    if (!bet || bet.status !== 'active' || !bet.endTime) return;
    // Never settle before the deterministic round end.
    if (Date.now() < bet.endTime) return;
    // Snapshot the narrowed end: the closure below would otherwise widen it
    // back to `number | undefined`.
    const endTime = bet.endTime;

    const key = (bet.asset || 'BNB') as string;
    const history: PricePoint[] = state.assetHistories?.[key] || [];
    const knownPrice = state.assetPrices?.[key];
    const usable =
      history.some((p) => p.timestamp <= endTime) ||
      (typeof knownPrice === 'number' && knownPrice > 0);
    if (!usable) {
      // No price the engine could legitimately settle against yet — retry,
      // then defer to the next real tick (updateAllPrices settles on arrival).
      if (rearmsLeft > 0) {
        roundTimers.set(betId, setTimeout(() => settleByWallClock(betId, rearmsLeft - 1), 1000));
      }
      return;
    }

    const settledPrice = priceAtOrBefore(history, endTime, knownPrice ?? 0);
    if (settledPrice <= 0) return;

    if (bet.mode === 'binomo' && bet.strikePrice !== undefined) {
      if (settledPrice === bet.strikePrice) {
        // Tie: Draw — stake refunded, mirrors the tick path exactly.
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
  // Initial state
  gameMode: 'binomo', // Default to classic mode
  selectedAsset: 'BNB',
  currentPrice: 0,
  lastTickAt: 0,
  priceHistory: [],
  assetPrices: {},
  assetHistories: {},
  rawAssetPrices: {},

  activeBets: [],
  targetCells: DEFAULT_TARGET_CELLS,
  isPlacingBet: false,
  lastResult: null,
  error: null,
  // Default pacing. Classic (binomo) mode uses a countdown timer set by the user; 5s is a sensible default.
  timeframeSeconds: 5,
  activeTab: 'bet',
  activeIndicators: {},
  isIndicatorsOpen: false,
  isTourOpen: false,

  // Blitz Initial State
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

  /**
   * Set game mode (binomo or box)
   */
  setGameMode: (mode: GameMode) => {
    set({
      gameMode: mode,
      lastResult: null,
    });

  },

  /**
   * Set UI active tab
   */
  setActiveTab: (tab: 'bet' | 'wallet' | 'blitz') => {
    set({ activeTab: tab });
  },

  /**
   * Toggle a technical indicator
   */
  toggleIndicator: (indicatorId: string) => {
    set((state: GameState) => ({
      activeIndicators: {
        ...state.activeIndicators,
        [indicatorId]: !state.activeIndicators[indicatorId]
      }
    }));
  },

  /**
   * Set indicators menu open state
   */
  setIsIndicatorsOpen: (isOpen: boolean) => {
    set({ isIndicatorsOpen: isOpen });
  },

  setIsTourOpen: (isOpen: boolean) => {
    set({ isTourOpen: isOpen });
  },


  /**
   * Set timeframe for grid cells (box mode)
   */
  setTimeframeSeconds: (seconds: number) => {
    const { gameMode, activeBets } = get();

    /**
     * In 'box' mode, the grid (columns/boundaries) is directly tied to timeframeSeconds.
     * If there are active box bets, we MUST NOT allow changing the duration,
     * as it would rebuild the grid and make existing bets visually/logically lost.
     */
    if (
      (gameMode === 'box' || gameMode === 'draw') &&
      activeBets.some((bet: ActiveBet) => bet.mode === 'box' || bet.mode === 'draw')
    ) {
      return;
    }

    set((state: GameState) => ({
      timeframeSeconds: seconds,
      /**
       * In 'binomo' (classic) mode or when there are no box bets, we update timeframeSeconds.
       * Classic bets are independent of the current selector (they have strikePrice/endTime),
       * so we keep them active.
       */
      activeBets: state.activeBets,
    }));
  },




  /**
   * Set selected asset for price tracking
   */
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


  /**
   * Place a bet using house balance (no wallet signature required)
   * Instant-resolution system: bet is placed on a specific cell, resolves when chart hits it
   * @param amount - Bet amount in USDC
   * @param targetId - Dynamic grid target (e.g., "UP-2.50") containing direction and multiplier
   * @param userAddress - User's wallet address
   * @param cellId - Optional: The specific cell ID this bet is placed on
   * @param metadata - Optional: Extra resolution info (price bounds, end time)
   */
  placeBetFromHouseBalance: async (
    amount: string,
    targetId: string,
    userAddress: string,
    cellId?: string,
    metadata?: { priceTop?: number; priceBottom?: number; startTime?: number; endTime?: number }
  ) => {
    // Synchronous re-entry guard BEFORE any await: blocks double-fire from
    // rapid clicks / keyboard auto-repeat while a placement request is in flight.
    if (get().isPlacingBet) return;

    set({ isPlacingBet: true, error: null });

    const { targetCells, currentPrice, addActiveBet, gameMode, timeframeSeconds, selectedAsset, assetHistories } = get();

    try {
      // Parse amount for validation
      const betAmount = Number(amount);
      if (!Number.isFinite(betAmount) || betAmount <= 0) {
        throw new Error("Invalid bet amount");
      }

      // Refuse to open a round when the feed isn't live: a strike of 0 (or a
      // missing history) would make every UP bet a guaranteed win.
      if (currentPrice <= 0 || !assetHistories?.[selectedAsset]?.length) {
        throw new Error("Price feed is not ready yet — try again in a moment");
      }


      let target: TargetCell;
      let direction: 'UP' | 'DOWN' = 'UP';
      let multiplier = 1.9;
      let durationSeconds = timeframeSeconds || 30;

      // Check if this is a dynamic grid target (e.g., "UP-1.9-30" or "DOWN-1.2-5")
      if (targetId.startsWith('UP-') || targetId.startsWith('DOWN-')) {
        const parts = targetId.split('-');
        direction = parts[0] as 'UP' | 'DOWN';
        multiplier = parseFloat(parts[1]) || 1.9;
        durationSeconds = parseInt(parts[2]) || durationSeconds;

        // Create dynamic target
        target = {
          id: targetId,
          label: `${direction} x${multiplier} (${durationSeconds}s)`,
          multiplier: multiplier,
          priceChange: direction === 'UP' ? 10 : -10,
          direction: direction
        };
      } else {
        // Find predefined target cell
        const foundTarget = targetCells.find((cell: TargetCell) => cell.id === targetId);
        if (!foundTarget) {
          throw new Error("Invalid target cell");
        }
        target = foundTarget;
        direction = target.direction;
        multiplier = target.multiplier;
      }

      // Freeze the round clock and account type at CLICK time — not after the
      // fetch resolves — so strike/endTime honestly reflect when the bet began.
      const clickTime = Date.now();
      const betEndTime =
        gameMode === 'binomo'
          ? clickTime + durationSeconds * 1000
          : metadata?.endTime ?? clickTime + durationSeconds * 1000;
      // One id per bet intent; the server dedupes retried POSTs with it.
      const betRequestId = crypto.randomUUID();

      // DEMO MODE: Skip API call for demo mode
      const { accountType, demoBalance, updateBalance: storeUpdateBalance } = get();
      const isDemoMode = accountType === 'demo';

      if (isDemoMode) {
        if (demoBalance < betAmount) {
          throw new Error("Insufficient demo balance");
        }

        // Simulate bet placement without API
        const fakeBetId = `demo-${Date.now()}`;

        const selectedCurrency = (get() as any).selectedCurrency;
        const currency = resolveHouseLedgerCurrency({
          selectedCurrency,
        });

        // Create active bet for tracking
        const activeBet: ActiveBet = {
          id: fakeBetId,
          mode: gameMode,
          asset: selectedAsset, // Set current asset
          amount: betAmount,
          multiplier: multiplier,
          direction: direction,
          timestamp: clickTime,
          status: 'active',
          network: currency,
          accountType, // Frozen at placement — settlement uses this, not the live store value
          userAddress,
          ...(gameMode === 'binomo' ? {
            strikePrice: currentPrice,
            endTime: betEndTime
          } : {
            cellId: cellId || targetId,
            priceTop: metadata?.priceTop,
            priceBottom: metadata?.priceBottom,
            startTime: metadata?.startTime,
            endTime: metadata?.endTime
          })
        };


        // Update local demo balance immediately
        storeUpdateBalance(betAmount, 'subtract');

        // Add to active bets
        addActiveBet(activeBet);

        set({ isPlacingBet: false, error: null });

        return {
          betId: fakeBetId,
          remainingBalance: demoBalance - betAmount,
          bet: activeBet
        };
      }

      const selectedCurrency = (get() as any).selectedCurrency;
      const currency = resolveHouseLedgerCurrency({
        selectedCurrency,
      });

      // Call API endpoint to place bet from house balance
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
          // Checked against the server's feed; the frozen strike comes back below.
          strikePrice: currentPrice,
          mode: gameMode,
          // Classic rounds run from the server's clock, so it ignores this there.
          endTime: betEndTime,
          priceTop: metadata?.priceTop,
          priceBottom: metadata?.priceBottom,
          // Client-generated idempotency key for this bet intent.
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
        // The server saw this betRequestId before. When the first attempt got
        // far enough to commit, the route REPLAYS the original bet id +
        // settlement token with a 200: the stake was deducted exactly once, so
        // the only terminal-correct client move is to adopt that round (it can
        // still be won back). A duplicate without an adoptable response stays
        // an error — the board must never show a round the server did not mint.
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
      // Number(null) is 0 — a missing field must never zero out the balance.
      const rem = remRaw === null || remRaw === undefined ? NaN : Number(remRaw);
      if (Number.isFinite(rem)) {
        (get() as any).setBalance?.(rem);
      }

      // Create ActiveBet object
      const activeBet: ActiveBet = {
        id: data.betId,
        mode: gameMode,
        asset: selectedAsset, // Set current asset
        amount: betAmount,
        multiplier: data.multiplier ?? multiplier,
        direction: direction,
        timestamp: clickTime,
        status: 'active',
        network: currency, // Save the currency identifier used (e.g. XLM, NEAR, PC)
        accountType, // Frozen at placement — settlement uses this, not the live store value
        userAddress: userAddress, // Capture address at placement time for settlement
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


      // Add to active bets (multiple bets can be active simultaneously)
      addActiveBet(activeBet);

      set({
        isPlacingBet: false,
        error: null
      });

      // Return bet info for UI
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

  /**
   * Seed a single price point for an asset (used at app boot before the live
   * feed starts, so the chart has at least a starting price and one point).
   */
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
      // Treat the seed as the raw baseline so the live feed applies deltas from here.
      rawAssetPrices: { ...rawAssetPrices, [key]: price },
      lastTickAt: now,
    };

    if (key === selectedAsset) {
      update.currentPrice = price;
      update.priceHistory = update.assetHistories![key];
    }

    set(update as GameState);
  },

  /**
   * Update all prices at once (Atomic)
   */
  updateAllPrices: (prices: Record<string, number>) => {
    const { 
      selectedAsset, activeBets, resolveBet, assetPrices, 
      assetHistories, rawAssetPrices
    } = get();
    const now = Date.now();
    
    // Create clones of existing collections to modify
    const updatedAssetPrices = { ...assetPrices };
    const updatedAssetHistories = { ...assetHistories };
    const updatedRawPrices = { ...rawAssetPrices };
    
    let currentAssetUpdated = false;
    let nextCurrentPrice = 0;
    let nextCurrentHistory: PricePoint[] = [];
    // True when at least one asset carried a genuinely new raw price in this
    // snapshot. Cached-fallback (stale) ticks repeat the previous raw values,
    // hit the `unchanged` guard below, are never appended to history, and must
    // not refresh lastTickAt — that is what lets the UI detect a stalled feed.
    let anyFreshTick = false;

    Object.entries(prices).forEach(([asset, price]) => {
      const assetKey = asset as AssetType;

      const lastRawPrice = updatedRawPrices[assetKey];
      const previousVirtualPrice = updatedAssetPrices[assetKey];
      // Cheap no-change guard: when the feed repeats the last raw price, skip
      // rebuilding this asset's history array entirely (was O(all assets) per tick).
      const unchanged =
        lastRawPrice !== undefined &&
        previousVirtualPrice !== undefined &&
        price === lastRawPrice;

      let finalPrice: number;

      if (unchanged) {
        finalPrice = previousVirtualPrice as number;
      } else {
        const rawDelta = price - (lastRawPrice ?? price);
        // Keep chart/settlement on true oracle-driven prices (no synthetic amplification/jitter).
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

      // RESOLUTION LOGIC: Check bets for this asset.
      // Settlement source of truth is the last history point at/ before the
      // bet's endTime — not whatever price happens to arrive after it.
      if (activeBets && activeBets.length > 0) {
        const settleHistory = updatedAssetHistories[assetKey] || [];
        activeBets.forEach((bet: ActiveBet) => {
          if ((bet.asset || 'BNB') !== assetKey || bet.status !== 'active') return;

          if (bet.mode === 'binomo' && bet.endTime && bet.strikePrice !== undefined && now >= bet.endTime) {
            const settledPrice = priceAtOrBefore(settleHistory, bet.endTime, finalPrice);
            if (settledPrice === bet.strikePrice) {
              // Tie: resolve as Draw — stake refunded, no win, no loss.
              resolveBet(bet.id, true, bet.amount);
            } else {
              const won = bet.direction === 'UP' ? settledPrice > bet.strikePrice : settledPrice < bet.strikePrice;
              resolveBet(bet.id, won, won ? bet.amount * bet.multiplier : 0);
            }
          } else if ((bet.mode === 'box' || bet.mode === 'draw') && bet.endTime && bet.priceTop !== undefined && bet.priceBottom !== undefined && now >= bet.endTime) {
            // Draw mode is included here on purpose: the chart resolves draw
            // boxes only while the user is IN draw mode, so a round placed in
            // draw and left behind by a mode switch would otherwise never
            // settle. This path runs off the store, not the UI.
            const settledPrice = priceAtOrBefore(settleHistory, bet.endTime, finalPrice);
            const won = settledPrice <= bet.priceTop && settledPrice >= bet.priceBottom;
            resolveBet(bet.id, won, won ? bet.amount * bet.multiplier : 0);
          }
        });
      }
    });

    // Atomic set call for all updates
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

    // Only a fresh (non-stale) snapshot refreshes the feed heartbeat clock.
    if (anyFreshTick) updateObj.lastTickAt = now;

    set(updateObj);
  },


  /**
   * Add a new active bet (for instant-resolution system)
   * @param bet - The bet to add
   */
  addActiveBet: (bet: ActiveBet) => {
    const { activeBets } = get();
    set({ activeBets: [...activeBets, bet] });
    // Deterministic round clock: guarantee the round settles at endTime even
    // if no further feed tick arrives (stalled feed / throttled tab).
    armRoundClock(bet);
  },

  /**
   * End a round on screen. For a real bet `won` and `payout` are only the
   * optimistic display: the server decides, and `reconcileRound` replaces them
   * with its answer. Demo bets have no server, so these are their result.
   * @param betId - The bet ID to resolve
   * @param won - Whether the bet looks won
   * @param payout - The payout it looks like it earned
   */
  resolveBet: (betId: string, won: boolean, payout: number) => {
    const { activeBets, currentPrice, address, network, accountType, fetchBalance } = get();
    const resolvedBet = activeBets.find((b: ActiveBet) => b.id === betId);

    // Cancel the wall-clock watchdog first: whichever path (tick or clock)
    // resolves the round wins once, the other becomes a no-op.
    clearRoundTimer(betId);

    if (resolvedBet) {
      // Use the account type frozen at placement; never the live store value
      // (the user may have toggled demo/real mid-round).
      const betAccountType = resolvedBet.accountType ?? accountType;
      const now = Date.now();

      // Play sound effects
      if (won) playWinSound();
      else playLoseSound();

      // ── Remove bet from active state FIRST ───────────────────────────────
      // This must happen synchronously before any async API calls to prevent
      // the price-tick loop from resolving the same bet a second time.
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

      // ── Use the address that was captured at bet-placement time ───────────
      // Falls back to current store address in case of older bets without it.
      const settlementAddress = resolvedBet.userAddress || address;
      const settlementCurrency = resolvedBet.network || network || 'USDC';

      // ── Handle Balance Update ──────────────────────────────────────────────
      if (won && betAccountType === 'demo') {
        // Credit the frozen demo account directly (updateBalance branches on
        // the live accountType, which may have been toggled mid-round).
        set((state: any) => ({ demoBalance: state.demoBalance + payout }));
      }

      // Also add to persistent local history store
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
          // Extra session-only fields the settlement proof reads (the server
          // row is the durable copy; this call goes through an untyped handle
          // into the history slice, so the additions are safe at runtime):
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

      // ── Ask the server what happened ───────────────────────────────────────
      // It settles every round itself, so this only fetches the answer: a failure
      // here costs the display, never the money. It answers 409 round_open until
      // its own clock reaches the end, and a local clock can be ahead of that.
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
          } catch {
            /* network failure: same retry */
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return null;
      };

      if (betAccountType === 'real' && settlementAddress) {
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

      // ── Save to Supabase bet_history ──────────────────────────────────────
      // Demo bets only: a real bet's row is written by the server when it settles.
      const isDemoBet = String(resolvedBet.id).toLowerCase().startsWith('demo-');
      if (settlementAddress) {
        if (betAccountType === 'demo' && isDemoBet) {
          fetch('/api/bets/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: resolvedBet.id,
              walletAddress: settlementAddress,
              asset: resolvedBet.asset || 'BNB',
              direction: resolvedBet.direction,
              amount: resolvedBet.amount,
              multiplier: resolvedBet.multiplier,
              strikePrice: resolvedBet.strikePrice || 0,
              endPrice: currentPrice,
              payout: payout,
              won: won,
              mode: resolvedBet.mode,
              network: settlementCurrency,
            }),
          }).catch(err => console.error('Failed to save demo bet to Supabase:', err));
        }
      }
    }
  },

  /**
   * Clear error message
   */
  clearError: () => {
    set({ error: null });
  },

  // Blitz Actions
  enableBlitzAccess: () => {
    set({ hasBlitzAccess: true });
  },

  updateBlitzTimer: () => {
    const { isBlitzActive, blitzEndTime, nextBlitzTime } = get();
    const now = Date.now();
    const BLITZ_DURATION = 60 * 1000; // 1 minute
    const BLITZ_INTERVAL = 2 * 60 * 1000; // 2 minutes between blitzes

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
  },

  /**
   * Start global multi-asset price feed tracking
   */
  startGlobalPriceFeed: (updateAllPrices: (prices: Record<string, number>) => void) => {
    return startGlobalPriceFeed(updateAllPrices);
  }
  };
};



/**
 * Start global multi-asset price feed tracking
 */
const startGlobalPriceFeed = (
  updateAllPrices: (prices: Record<string, number>) => void
): (() => void) => {
  let stopFeedFn: (() => void) | null = null;
  let isActive = true;

  // Use a more immediate load
  import('@/lib/utils/priceFeed').then(({ startMultiPythPriceFeed }) => {
    if (!isActive) return;
    
    stopFeedFn = startMultiPythPriceFeed((prices) => {
      if (isActive && Object.keys(prices).length > 0) {
        // Wrap in a try-catch to prevent one bad update from freezing the feed
        try {
          updateAllPrices(prices);
        } catch (e) {
          console.error("Price update error:", e);
        }
      }
    });
  }).catch(err => {
    console.error('Failed to start multi-asset price feed:', err);
  });

  return () => {
    isActive = false;
    if (stopFeedFn) {
      stopFeedFn();
    }
  };
};
