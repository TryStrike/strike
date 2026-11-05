/**
 * Bet history: the session's recent rounds, and bounded pages of the ledger from
 * GET /api/bets/history. Read-only with respect to the ledger.
 */

import { StateCreator } from "zustand";
import { BetRecord } from "@/lib/types/bet";

/** Raw `bet_history` row as returned by /api/bets/history (NUMERICs arrive as strings). */
export interface BetHistoryRow {
  id: string;
  wallet_address: string;
  asset: string;
  direction: 'UP' | 'DOWN' | 'DRAW' | string;
  amount: string | number;
  multiplier: string | number;
  strike_price: string | number | null;
  end_price: string | number | null;
  payout: string | number;
  won: boolean;
  mode: string | null;
  network: string | null;
  resolved_at: string | null;
  created_at: string | null;
  /** Added server-side: play-money marker (see isDemoBetHistoryRow). */
  isDemoBet?: boolean;
  /** Added server-side: Arc tx hash when the row or its payout audit has one. */
  txHash?: string | null;
  /** Added server-side: the bet_history primary key, quotable as a ledger ref. */
  ledgerRef?: string | null;
}

export interface BetHistoryFilters {
  /** Exact asset code, or null/`ALL` for every asset. */
  asset: string | null;
  outcome: 'won' | 'lost' | null;
  direction: 'UP' | 'DOWN' | 'DRAW' | null;
  /** ISO bound (inclusive) on resolved_at. */
  from: string | null;
  to: string | null;
}

export const EMPTY_BET_HISTORY_FILTERS: BetHistoryFilters = {
  asset: null,
  outcome: null,
  direction: null,
  from: null,
  to: null,
};

export interface LoadBetHistoryArgs {
  wallet: string;
  filters?: BetHistoryFilters;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface BetHistoryPage {
  rows: BetHistoryRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface HistoryState {
  // State
  bets: BetRecord[];
  isLoading: boolean;
  error: string | null;

  // Dedicated /history surface (paged, filtered; never shares state with `bets`)
  historyRows: BetHistoryRow[];
  historyTotal: number | null;
  historyLimit: number;
  historyOffset: number;
  isHistoryLoading: boolean;
  historyError: string | null;

  // Actions
  addBet: (bet: BetRecord) => void;
  clearError: () => void;
  loadBetHistoryPage: (args: LoadBetHistoryArgs) => Promise<BetHistoryPage>;
  resetBetHistory: () => void;
}

/** Session rounds kept for the recent-rounds list. */
const MAX_RECENT_BETS = 50;
/** Server clamps at 200 (MAX_HISTORY_LIMIT in the route); keep the client in step. */
export const HISTORY_PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_HISTORY_LIMIT = 50;
/** Cap for "export the current filter": bounded paging, not the whole ledger. */
export const HISTORY_EXPORT_CAP = 2000;

/**
 * Guards against overlapping loads: only the newest request may write state,
 * so a slow page-1 response can never clobber a fast page-2 one.
 */
let historyLoadSeq = 0;

/** Builds the bounded, filtered query string for /api/bets/history. */
export function buildHistoryQueryUrl(args: {
  wallet: string;
  filters?: BetHistoryFilters;
  limit?: number;
  offset?: number;
}): string {
  const params = new URLSearchParams();
  params.set('wallet', args.wallet);
  params.set('limit', String(args.limit ?? DEFAULT_HISTORY_LIMIT));
  if (typeof args.offset === 'number') params.set('offset', String(args.offset));

  const f = args.filters;
  if (f?.asset && f.asset !== 'ALL') params.set('asset', f.asset);
  if (f?.outcome) params.set('outcome', f.outcome);
  if (f?.direction) params.set('direction', f.direction);
  if (f?.from) params.set('from', f.from);
  if (f?.to) params.set('to', f.to);

  return `/api/bets/history?${params.toString()}`;
}

function toIntOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read one bounded page of settled bets straight from the ledger route.
 * Throws on a non-OK response so callers can show a retryable error state.
 */
export async function fetchBetHistoryPage(args: LoadBetHistoryArgs): Promise<BetHistoryPage> {
  const limit = args.limit ?? DEFAULT_HISTORY_LIMIT;
  const offset = args.offset ?? 0;
  const url = buildHistoryQueryUrl({ ...args, limit, offset });

  let res = await fetch(url, { credentials: 'include', signal: args.signal });

  // The route answers 401 without the balance-session cookie. The app shell
  // mints it on boot (app/providers.tsx), but a deep link straight to /history
  // can beat that request, so mint once and retry instead of showing an error
  // the player cannot act on. Aborts propagate as AbortError either way.
  if (res.status === 401) {
    const { ensureBalanceSession } = await import('@/lib/balance/balanceClientHeaders');
    await ensureBalanceSession();
    res = await fetch(url, { credentials: 'include', signal: args.signal });
  }

  if (!res.ok) {
    let message = `History request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* keep the status-based message */
    }
    throw new Error(message);
  }

  const json = (await res.json()) as {
    bets?: BetHistoryRow[];
    count?: number | null;
    total?: number | null;
    hasMore?: boolean;
  };
  const rows = Array.isArray(json.bets) ? json.bets : [];
  const total = toIntOrNull(json.count ?? json.total);
  return {
    rows,
    // Without a count we can only claim "at least this page" — the pager then
    // falls back to hasMore rather than inventing a denominator.
    total: total ?? offset + rows.length,
    limit,
    offset,
    // With a server count the answer is exact; without one, a full page is the
    // only honest signal that more rows may exist.
    hasMore:
      json.hasMore === true ||
      (total !== null ? offset + rows.length < total : rows.length >= limit),
  };
}

/**
 * Walk the filtered set page by page up to `HISTORY_EXPORT_CAP` rows.
 * Still bounded: every request asks for at most 200 rows.
 */
export async function fetchAllFilteredBetHistory(
  wallet: string,
  filters?: BetHistoryFilters,
  onPage?: (loaded: number) => void
): Promise<BetHistoryRow[]> {
  const pageLimit = 200;
  const collected: BetHistoryRow[] = [];

  for (let offset = 0; offset < HISTORY_EXPORT_CAP; offset += pageLimit) {
    const page = await fetchBetHistoryPage({ wallet, filters, limit: pageLimit, offset });
    if (page.rows.length === 0) break;
    collected.push(...page.rows);
    onPage?.(collected.length);
    if (!page.hasMore || collected.length >= HISTORY_EXPORT_CAP) break;
  }

  return collected.slice(0, HISTORY_EXPORT_CAP);
}

/**
 * Create history slice for Zustand store
 * Handles bet history storage and management
 */
export const createHistorySlice: StateCreator<HistoryState> = (set, get) => ({
  // Initial state
  bets: [],
  isLoading: false,
  error: null,

  historyRows: [],
  historyTotal: null,
  historyLimit: DEFAULT_HISTORY_LIMIT,
  historyOffset: 0,
  isHistoryLoading: false,
  historyError: null,

  /**
   * Add a new bet to history
   * Used when a bet is placed to immediately update UI
   * @param bet - The bet record to add
   */
  addBet: (bet: BetRecord) => {
    const { bets } = get();

    // Check if bet already exists
    const existingIndex = bets.findIndex(b => b.id === bet.id);

    let updatedBets: BetRecord[];
    if (existingIndex >= 0) {
      // Update existing bet
      updatedBets = [...bets];
      updatedBets[existingIndex] = bet;
    } else {
      // Add new bet at the beginning
      updatedBets = [bet, ...bets];
    }

    // Sort by timestamp (newest first)
    updatedBets.sort((a, b) => b.timestamp - a.timestamp);

    set({ bets: updatedBets.slice(0, MAX_RECENT_BETS) });
  },

  /**
   * Clear error message
   */
  clearError: () => {
    set({ error: null });
  },

  /**
   * Load one bounded, filtered page of settled bets for the /history surface.
   * Also keeps the legacy `bets` cache warm when the caller loads the newest
   * unfiltered page (that is what MiniHistory / the trade panel read).
   */
  loadBetHistoryPage: async (args: LoadBetHistoryArgs) => {
    const seq = ++historyLoadSeq;
    const limit = args.limit ?? DEFAULT_HISTORY_LIMIT;
    const offset = args.offset ?? 0;

    set({ isHistoryLoading: true, historyError: null });

    try {
      const page = await fetchBetHistoryPage({ ...args, limit, offset });
      if (seq !== historyLoadSeq) return page; // a newer load won; do not resurrect this one

      set({
        historyRows: page.rows,
        historyTotal: page.total,
        historyLimit: limit,
        historyOffset: offset,
        isHistoryLoading: false,
        historyError: null,
      });

      // Newest page, no filters → also refresh the lightweight recent-rounds list.
      const unfiltered = !args.filters || Object.values(args.filters).every((v) => !v || v === 'ALL');
      if (offset === 0 && unfiltered && page.rows.length > 0) {
        const mapped: BetRecord[] = page.rows.slice(0, MAX_RECENT_BETS).map((row) => ({
          id: row.id,
          timestamp: new Date(row.resolved_at ?? row.created_at ?? 0).getTime(),
          amount: String(row.amount),
          won: !!row.won,
          payout: String(row.payout),
          startPrice: parseFloat(String(row.strike_price)) || 0,
          endPrice: parseFloat(String(row.end_price)) || 0,
          actualChange: (parseFloat(String(row.end_price)) || 0) - (parseFloat(String(row.strike_price)) || 0),
          target: {
            id: row.mode === 'binomo' ? 'classic' : row.mode === 'draw' ? 'draw' : 'box',
            label: `${row.direction} ${row.multiplier}x`,
            multiplier: parseFloat(String(row.multiplier)) || 1.9,
            priceChange: 0,
            direction: row.direction as 'UP' | 'DOWN',
          },
        }));
        set({ bets: mapped });
      }

      return page;
    } catch (error) {
      // Aborted navigations are not errors the player should see — but if no
      // newer load replaced this one, the spinner has to stop anyway.
      if ((error as Error)?.name === 'AbortError') {
        if (seq === historyLoadSeq) set({ isHistoryLoading: false });
        return { rows: [], total: get().historyTotal ?? 0, limit, offset, hasMore: false };
      }
      if (seq === historyLoadSeq) {
        set({
          isHistoryLoading: false,
          historyError: error instanceof Error ? error.message : 'Failed to load history',
        });
      }
      throw error;
    }
  },

  /**
   * Clear the /history surface state (wallet switched / filters reset).
   */
  resetBetHistory: () => {
    historyLoadSeq++;
    set({
      historyRows: [],
      historyTotal: null,
      historyOffset: 0,
      isHistoryLoading: false,
      historyError: null,
    });
  },
});
