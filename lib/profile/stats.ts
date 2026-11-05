/**
 * Pure request/response classification for the profile hub's server reads.
 *
 * The rule this module exists to enforce: a response that never reached the
 * aggregation (network drop, 401 from the balance-session guard, 500, 503,
 * malformed JSON) must NOT be representable as "this wallet has zero bets".
 * Only an explicitly successful, well-formed `stats` payload may be read that
 * way, and even then `statsHasActivity()` decides between the empty and the
 * populated view.
 *
 * Types are structural clones of what GET /api/bets/stats ships (see
 * backend/crates/core/src/bets.rs) so the client bundle never imports the
 * server module; the tests assert they stay in sync.
 */

import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

export type StatsWindow = '7d' | '30d' | 'all';

export const STATS_WINDOWS: readonly StatsWindow[] = ['7d', '30d', 'all'];

export const DEFAULT_STATS_WINDOW: StatsWindow = '30d';

export function isStatsWindow(value: unknown): value is StatsWindow {
    return typeof value === 'string' && (STATS_WINDOWS as readonly string[]).includes(value);
}

export type TradeHighlight = {
    asset: string;
    net: number;
    at: string | null;
    amount: number;
    won: boolean;
};

export type AssetStat = {
    asset: string;
    bets: number;
    wins: number;
    winRate: number;
    volume: number;
    netPnl: number;
};

export type DailyPoint = {
    date: string;
    bets: number;
    volume: number;
    net: number;
    cumNet: number;
};

export type WalletStats = {
    window: StatsWindow;
    totalBets: number;
    wins: number;
    losses: number;
    winRate: number;
    volume: number;
    netPnl: number;
    longestWinStreak: number;
    longestLossStreak: number;
    bestTrade: TradeHighlight | null;
    worstTrade: TradeHighlight | null;
    perAsset: AssetStat[];
    series: DailyPoint[];
    truncated: boolean;
};

export type LedgerRow = {
    id?: string | null;
    asset?: string | null;
    direction?: string | null;
    amount?: string | number | null;
    payout?: string | number | null;
    won?: boolean | null;
    resolved_at?: string | null;
    created_at?: string | null;
    isDemoBet?: boolean | null;
};

/** The four states every server read on /profile has to be able to show. */
export type Outcome<T> =
    | { kind: 'unauthorized'; status: number; message: string }
    | { kind: 'failed'; status: number | null; reason: FailedReason; message: string }
    | { kind: 'ready'; data: T };

export type FailedReason = 'network' | 'http' | 'payload';

const UNAUTHORIZED_STATUSES = [401, 403];

export function isUnauthorizedStatus(status: number): boolean {
    return UNAUTHORIZED_STATUSES.includes(status);
}

/**
 * HTTP status -> whether a body can be trusted at all. 2xx alone counts: a
 * 3xx that fetch surfaced, or a 5xx from an intermediary, is a failure.
 */
export function isOkStatus(status: number): boolean {
    return status >= 200 && status < 300;
}

/** Shape check for the stats payload; a partial body is a payload failure. */
export function isWalletStats(value: unknown): value is WalletStats {
    if (!value || typeof value !== 'object') return false;
    const s = value as Record<string, unknown>;
    return (
        isStatsWindow(s.window) &&
        typeof s.totalBets === 'number' &&
        typeof s.winRate === 'number' &&
        typeof s.volume === 'number' &&
        typeof s.netPnl === 'number' &&
        Array.isArray(s.perAsset) &&
        Array.isArray(s.series)
    );
}

/** GET /api/bets/stats -> Outcome<WalletStats>. */
export function classifyStatsResponse(status: number, body: unknown): Outcome<WalletStats> {
    if (isUnauthorizedStatus(status)) {
        return { kind: 'unauthorized', status, message: 'Session not verified for this wallet.' };
    }
    if (!isOkStatus(status)) {
        return {
            kind: 'failed',
            status,
            reason: 'http',
            message: errorMessageOf(body) || `Stats request failed (HTTP ${status}).`,
        };
    }
    const stats = (body as { stats?: unknown } | null)?.stats;
    if (!isWalletStats(stats)) {
        return {
            kind: 'failed',
            status,
            reason: 'payload',
            message: 'Stats response was incomplete.',
        };
    }
    return { kind: 'ready', data: stats };
}

/** GET /api/bets/history -> Outcome<LedgerRow[]>. An empty array is a real empty. */
export function classifyLedgerResponse(status: number, body: unknown): Outcome<LedgerRow[]> {
    if (isUnauthorizedStatus(status)) {
        return { kind: 'unauthorized', status, message: 'Session not verified for this wallet.' };
    }
    if (!isOkStatus(status)) {
        return {
            kind: 'failed',
            status,
            reason: 'http',
            message: errorMessageOf(body) || `History request failed (HTTP ${status}).`,
        };
    }
    const bets = (body as { bets?: unknown } | null)?.bets;
    if (!Array.isArray(bets)) {
        return { kind: 'failed', status, reason: 'payload', message: 'History response was incomplete.' };
    }
    return { kind: 'ready', data: bets as LedgerRow[] };
}

function errorMessageOf(body: unknown): string {
    const msg = (body as { error?: unknown } | null)?.error;
    return typeof msg === 'string' ? msg : '';
}

/** A thrown fetch (offline, DNS, aborted-by-cors) is a failure, never an empty. */
export function networkFailure(): Outcome<never> {
    return { kind: 'failed', status: null, reason: 'network', message: 'Could not reach the stats service.' };
}

/**
 * Only a ready payload can be read as "no bets". Everything else means the
 * numbers are unknown and the UI must say so.
 */
export function statsHasActivity(stats: WalletStats): boolean {
    if (stats.totalBets > 0) return true;
    if (stats.volume > 0) return true;
    if (stats.perAsset.length > 0) return true;
    return stats.series.some((p) => p.bets > 0 || p.net !== 0);
}

export type StatsView = 'loading' | 'unauthorized' | 'failed' | 'empty' | 'populated';

/**
 * The view the panel renders. `outcome` is the latest settled attempt; loading
 * is decided by the caller (it is a request-lifecycle fact, not a response one).
 */
export function statsViewFor(outcome: Outcome<WalletStats> | null, loading: boolean): StatsView {
    if (!outcome) return loading ? 'loading' : 'failed';
    if (outcome.kind === 'unauthorized') return 'unauthorized';
    if (outcome.kind === 'failed') return 'failed';
    return statsHasActivity(outcome.data) ? 'populated' : 'empty';
}

/** True when the numbers on screen must not be presented as the player's record. */
export function statsNotCountable(outcome: Outcome<WalletStats> | null): boolean {
    return outcome !== null && outcome.kind !== 'ready';
}

/**
 * A failed/unauthorised refresh with stale numbers on screen keeps the stale
 * numbers but flags them, rather than silently swapping in the empty state.
 */
export function shouldMarkStale(outcome: Outcome<WalletStats> | null, hasDisplayedStats: boolean): boolean {
    return hasDisplayedStats && outcome !== null && outcome.kind !== 'ready';
}

/** Human copy for the unavailable panel — the message differs by cause. */
export function statsUnavailableCopy(outcome: Outcome<WalletStats> | null): { title: string; hint: string; retry: boolean } {
    if (outcome?.kind === 'unauthorized') {
        return {
            title: 'Session not verified',
            hint: 'Your wallet is connected but this browser session is not authorised to read your record. Re-authorise to reload it.',
            retry: true,
        };
    }
    if (outcome?.kind === 'failed' && outcome.reason === 'payload') {
        return {
            title: 'Performance data unreadable',
            hint: 'The stats service answered, but with an incomplete payload. Nothing here is counted as a bet.',
            retry: true,
        };
    }
    return {
        title: 'Performance unavailable',
        hint: 'The stats service could not be reached. These are not zero results — your record is simply unknown right now.',
        retry: true,
    };
}

/**
 * Request URL for the stats read. The wallet is canonicalised exactly like the
 * route does, so a checksummed address cannot produce a second identity.
 */
export function statsRequestUrl(wallet: string, window: StatsWindow): string {
    const address = canonicalHouseUserAddress(wallet);
    return `/api/bets/stats?wallet=${encodeURIComponent(address)}&window=${window}`;
}

/** Request URL for the ledger preview (bounded: limit only, no offset). */
export function ledgerRequestUrl(wallet: string, limit: number): string {
    const address = canonicalHouseUserAddress(wallet);
    return `/api/bets/history?wallet=${encodeURIComponent(address)}&limit=${Math.max(1, Math.min(50, Math.trunc(limit)))}`;
}

/** Window label used by the sparkline caption (the series is always day-sized). */
export function windowCaption(window: StatsWindow): string {
    switch (window) {
        case '7d':
            return 'Last 7 days';
        case '30d':
            return 'Last 30 days';
        case 'all':
        default:
            return 'All-time totals · 30-day trend';
    }
}
