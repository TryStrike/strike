
import { StateCreator } from "zustand";
import type { Store } from "./index";
import { BetRecord } from "@/lib/types/bet";

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
  isDemoBet?: boolean;
  txHash?: string | null;
  ledgerRef?: string | null;
}

export interface BetHistoryFilters {
  asset: string | null;
  outcome: 'won' | 'lost' | null;
  direction: 'UP' | 'DOWN' | 'DRAW' | null;
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
  bets: BetRecord[];
  isLoading: boolean;
  error: string | null;

  historyRows: BetHistoryRow[];
  historyTotal: number | null;
  historyLimit: number;
  historyOffset: number;
  isHistoryLoading: boolean;
  historyError: string | null;

  addBet: (bet: BetRecord) => void;
  clearError: () => void;
  loadBetHistoryPage: (args: LoadBetHistoryArgs) => Promise<BetHistoryPage>;
  resetBetHistory: () => void;
}

const MAX_RECENT_BETS = 50;
export const HISTORY_PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_HISTORY_LIMIT = 50;
export const HISTORY_EXPORT_CAP = 2000;

let historyLoadSeq = 0;

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

export async function fetchBetHistoryPage(args: LoadBetHistoryArgs): Promise<BetHistoryPage> {
  const limit = args.limit ?? DEFAULT_HISTORY_LIMIT;
  const offset = args.offset ?? 0;
  const url = buildHistoryQueryUrl({ ...args, limit, offset });

  let res = await fetch(url, { credentials: 'include', signal: args.signal });

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
    } catch {}
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
    total: total ?? offset + rows.length,
    limit,
    offset,
    hasMore:
      json.hasMore === true ||
      (total !== null ? offset + rows.length < total : rows.length >= limit),
  };
}

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

export const createHistorySlice: StateCreator<Store, [], [], HistoryState> = (set, get) => ({
  bets: [],
  isLoading: false,
  error: null,

  historyRows: [],
  historyTotal: null,
  historyLimit: DEFAULT_HISTORY_LIMIT,
  historyOffset: 0,
  isHistoryLoading: false,
  historyError: null,

  addBet: (bet: BetRecord) => {
    const { bets } = get();

    const existingIndex = bets.findIndex(b => b.id === bet.id);

    let updatedBets: BetRecord[];
    if (existingIndex >= 0) {
      updatedBets = [...bets];
      updatedBets[existingIndex] = bet;
    } else {
      updatedBets = [bet, ...bets];
    }

    updatedBets.sort((a, b) => b.timestamp - a.timestamp);

    set({ bets: updatedBets.slice(0, MAX_RECENT_BETS) });
  },

  clearError: () => {
    set({ error: null });
  },

  loadBetHistoryPage: async (args: LoadBetHistoryArgs) => {
    const seq = ++historyLoadSeq;
    const limit = args.limit ?? DEFAULT_HISTORY_LIMIT;
    const offset = args.offset ?? 0;

    set({ isHistoryLoading: true, historyError: null });

    try {
      const page = await fetchBetHistoryPage({ ...args, limit, offset });
      if (seq !== historyLoadSeq) return page;

      set({
        historyRows: page.rows,
        historyTotal: page.total,
        historyLimit: limit,
        historyOffset: offset,
        isHistoryLoading: false,
        historyError: null,
      });

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
