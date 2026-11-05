
import {
  buildHistoryQueryUrl,
  type BetHistoryPage,
  type BetHistoryRow,
} from '@/lib/store/historySlice';
import type { BetRecord } from '@/lib/types/bet';
import type { HistoryView } from './historyQuery';

export function rowsToBetRecords(rows: BetHistoryRow[], max = 50): BetRecord[] {
  return rows.slice(0, max).map((row) => ({
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
}

export type HistoryErrorKind = 'unauthorized' | 'invalid' | 'server' | 'network';

export class HistoryFeedError extends Error {
  readonly kind: HistoryErrorKind;
  readonly status: number;

  constructor(kind: HistoryErrorKind, message: string, status = 0) {
    super(message);
    this.name = 'HistoryFeedError';
    this.kind = kind;
    this.status = status;
  }
}

interface RawPage {
  bets?: unknown;
  count?: unknown;
  total?: unknown;
  limit?: unknown;
  offset?: unknown;
  hasMore?: unknown;
  error?: unknown;
}

const asFiniteInt = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

export async function loadHistoryViewPage(
  wallet: string,
  view: HistoryView,
  signal?: AbortSignal
): Promise<BetHistoryPage> {
  const url = buildHistoryQueryUrl({
    wallet,
    filters: view.filters,
    limit: view.limit,
    offset: view.offset,
  });

  const send = () =>
    fetch(url, { credentials: 'include', signal });

  let res: Response;
  try {
    res = await send();
    if (res.status === 401) {
      const { ensureBalanceSession } = await import('@/lib/balance/balanceClientHeaders');
      await ensureBalanceSession();
      res = await send();
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new HistoryFeedError('network', 'Could not reach the ledger — check your connection.');
  }

  if (!res.ok) {
    let bodyMessage: string | null = null;
    try {
      const body = (await res.json()) as RawPage;
      if (typeof body?.error === 'string' && body.error.trim()) bodyMessage = body.error.trim();
    } catch {}

    if (res.status === 401) {
      throw new HistoryFeedError(
        'unauthorized',
        bodyMessage ?? 'Your balance session is not authorised for ledger reads.',
        401
      );
    }
    if (res.status === 400) {
      throw new HistoryFeedError(
        'invalid',
        bodyMessage ?? 'The server rejected these filters.',
        400
      );
    }
    if (res.status >= 500) {
      throw new HistoryFeedError(
        'server',
        bodyMessage ?? `The ledger query failed (HTTP ${res.status}).`,
        res.status
      );
    }
    throw new HistoryFeedError(
      'server',
      bodyMessage ?? `History request failed (HTTP ${res.status}).`,
      res.status
    );
  }

  let json: RawPage;
  try {
    json = (await res.json()) as RawPage;
  } catch {
    throw new HistoryFeedError('server', 'The ledger returned a response we could not read.');
  }

  const rows = Array.isArray(json.bets) ? (json.bets as BetHistoryRow[]) : [];
  const totalCount =
    typeof json.count === 'number' && Number.isFinite(json.count)
      ? json.count
      : typeof json.total === 'number' && Number.isFinite(json.total)
        ? json.total
        : null;
  const total = totalCount ?? view.offset + rows.length;
  const hasMore =
    typeof json.hasMore === 'boolean'
      ? json.hasMore
      : totalCount !== null
        ? view.offset + rows.length < totalCount
        : rows.length >= view.limit;

  return {
    rows,
    total,
    limit: asFiniteInt(json.limit, view.limit),
    offset: asFiniteInt(json.offset, view.offset),
    hasMore,
  };
}
