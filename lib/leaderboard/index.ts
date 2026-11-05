/**
 * Pure, side-effect-free helpers for the /leaderboard page.
 *
 * These mirror — and only ever mirror — what GET /api/bets/leaderboard ships:
 *   public:  { leaderboard, cached, assets, meta }
 *   wallet:  { me, meta }   (requires the first-party balance-session cookie)
 *
 * Rules encoded here:
 *  - Wire `wallet_address` values are ALREADY truncated by the API
 *    (`0x1234…abcd`). Nothing in this file ever un-truncates, expands or
 *    fabricates an address; a missing username falls back to the truncated
 *    string the server gave.
 *  - "Partial window" is a first-class state: when `meta.truncated` or
 *    `meta.stale` is true the board is qualified, never presented as complete.
 *  - Polling honours the server's `s-maxage=30` public cache and its 60s
 *    snapshot TTL: never faster, and paused while the tab is hidden.
 */

export type LeaderboardWindow = 'today' | '7d' | '30d' | 'all';
export type LeaderboardMetric = 'netPnl' | 'volume' | 'winRate' | 'bets';

/** One row of the public board (server shape; wallet_address is truncated). */
export interface LeaderboardRow {
  wallet_address: string;
  username: string | null;
  rank: number;
  total_bets: number;
  wins: number;
  losses: number;
  total_wagered: number;
  total_payout: number;
  net_profit: number;
  net_pnl: number;
  total_volume: number;
  win_rate: number;
  primary_network: string;
  primary_asset: string;
  last_bet_at: string | null;
}

/** `me` from the ?wallet= lookup: own row + standing, nothing about others. */
export interface YourStanding extends LeaderboardRow {
  peopleAhead: number;
  walletsOnBoard: number;
  nextRank: number | null;
  nextRankValue: number | null;
  gapToNextRank: number | null;
  metric: LeaderboardMetric;
  estimated: boolean;
}

/** `meta` block, both for the public board and the wallet lookup. */
export interface BoardMeta {
  window: LeaderboardWindow | null;
  timeframeHours?: number | null;
  asset: string;
  metric: LeaderboardMetric;
  limit?: number;
  walletsOnBoard?: number;
  shown?: number;
  /** ISO lower bound applied to created_at; null for an all-time board. */
  since: string | null;
  scannedRows: number;
  realRows: number;
  demoRowsDropped: number;
  /** Row cap hit: the window was only partially scanned. */
  truncated: boolean;
  /** When these numbers were computed server-side (ISO). */
  updatedAt: string;
  cached: boolean;
  /** Snapshot is older than the server TTL: numbers may lag reality. */
  stale: boolean;
  /** Only on a `me: null` lookup. */
  reason?: string;
  /** Only on the degraded cached-failure path. */
  error?: string;
}

export interface BoardResponse {
  leaderboard: LeaderboardRow[];
  cached: boolean;
  assets: { asset: string; bets: number }[];
  meta: BoardMeta;
  stale?: boolean;
  error?: string;
}

export interface MeResponse {
  me: YourStanding | null;
  meta: BoardMeta;
}

/* ------------------------------------------------------------------ *
 * Selection options
 * ------------------------------------------------------------------ */

export const WINDOW_OPTIONS: { key: LeaderboardWindow; label: string; hint: string }[] = [
  { key: 'today', label: 'Today', hint: 'since 00:00 UTC' },
  { key: '7d', label: '7 Days', hint: 'rolling' },
  { key: '30d', label: '30 Days', hint: 'rolling' },
  { key: 'all', label: 'All Time', hint: 'everything' },
];

export const METRIC_OPTIONS: { key: LeaderboardMetric; label: string }[] = [
  { key: 'netPnl', label: 'Net PnL' },
  { key: 'volume', label: 'Volume' },
  { key: 'winRate', label: 'Win Rate' },
  { key: 'bets', label: 'Bets' },
];

const METRIC_LABELS: Record<LeaderboardMetric, string> = Object.fromEntries(
  METRIC_OPTIONS.map((m) => [m.key, m.label])
) as Record<LeaderboardMetric, string>;

export function metricLabel(metric: string | null | undefined): string {
  if (metric && metric in METRIC_LABELS) return METRIC_LABELS[metric as LeaderboardMetric];
  return METRIC_LABELS.netPnl;
}

export function windowLabel(key: string | null | undefined): string {
  const hit = WINDOW_OPTIONS.find((w) => w.key === key);
  return hit ? hit.label : 'All Time';
}

/* ------------------------------------------------------------------ *
 * URL building
 * ------------------------------------------------------------------ */

export const BOARD_LIMIT = 50;
/** Never poll faster than the board can change (s-maxage=30, snapshot TTL 60s). */
export const MIN_POLL_MS = 30_000;
export const POLL_MS = 60_000;

export function buildBoardUrl(opts: {
  window: LeaderboardWindow;
  asset: string;
  metric: LeaderboardMetric;
  limit?: number;
}): string {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? BOARD_LIMIT),
    window: opts.window,
    asset: opts.asset,
    metric: opts.metric,
  });
  return `/api/bets/leaderboard?${params.toString()}`;
}

export function buildWalletUrl(opts: {
  wallet: string;
  window: LeaderboardWindow;
  asset: string;
  metric: LeaderboardMetric;
}): string {
  const params = new URLSearchParams({
    wallet: opts.wallet,
    window: opts.window,
    asset: opts.asset,
    metric: opts.metric,
  });
  return `/api/bets/leaderboard?${params.toString()}`;
}

/**
 * Refresh policy: a sync is due once `POLL_MS` has passed since the last one.
 * The caller additionally checks tab visibility before invoking this.
 */
export function isSyncDue(nowMs: number, lastSyncMs: number, pollMs: number = POLL_MS): boolean {
  const interval = Math.max(pollMs, MIN_POLL_MS);
  return nowMs - lastSyncMs >= interval;
}

/* ------------------------------------------------------------------ *
 * Metric values and formatting
 * ------------------------------------------------------------------ */

export function metricValueOf(row: LeaderboardRow, metric: LeaderboardMetric): number {
  switch (metric) {
    case 'netPnl':
      return row.net_pnl;
    case 'volume':
      return row.total_volume;
    case 'winRate':
      return row.win_rate;
    case 'bets':
      return row.total_bets;
  }
}

export function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatSignedMoney(n: number): string {
  return `${n >= 0 ? '+' : ''}${formatMoney(n)}`;
}

export function formatMetricValue(value: number, metric: LeaderboardMetric): string {
  if (!Number.isFinite(value)) return '—';
  if (metric === 'winRate') return `${value.toFixed(1)}%`;
  if (metric === 'bets') return `${Math.round(value)}`;
  return formatMoney(value);
}

/** Positive delta toward the next rank: "+$50.00", "+3.2 pts", "+2 bets". */
export function formatGap(gap: number | null | undefined, metric: LeaderboardMetric): string | null {
  if (gap == null || !Number.isFinite(gap)) return null;
  if (metric === 'winRate') return `+${gap.toFixed(1)} pts`;
  if (metric === 'bets') return `+${Math.max(1, Math.round(gap))} bets`;
  return formatSignedMoney(gap);
}

/** The value to reach to move up one place — server scalar, formatted here. */
export function formatClimbTarget(me: YourStanding): string | null {
  if (me.gapToNextRank == null || me.nextRankValue == null) return null;
  const target = formatMetricValue(me.nextRankValue, me.metric);
  const gap = formatGap(me.gapToNextRank, me.metric);
  const rankLabel = me.nextRank == null ? 'one place' : `#${me.nextRank}`;
  return gap == null
    ? `Reach ${target} to move up ${rankLabel}`
    : `Reach ${target} (+${stripPlus(gap)} away) to move up ${rankLabel}`;
}

function stripPlus(s: string): string {
  return s.startsWith('+') ? s.slice(1) : s;
}

/* ------------------------------------------------------------------ *
 * Identity — never fabricate, never un-truncate
 * ------------------------------------------------------------------ */

/**
 * Display name for a row: the username when the server gave one, otherwise
 * the truncated address exactly as shipped. The truncated string must never
 * be presented as copyable or as a full identifier.
 */
export function displayNameOf(row: Pick<LeaderboardRow, 'username' | 'wallet_address'>): string {
  const name = row.username?.trim();
  if (name) return name;
  return row.wallet_address?.trim() || 'Unknown trader';
}

export function hasUsername(row: Pick<LeaderboardRow, 'username'>): boolean {
  return Boolean(row.username?.trim());
}

/* ------------------------------------------------------------------ *
 * Rank display
 * ------------------------------------------------------------------ */

/**
 * Fallback: derive the caller's rank from the public board slice by matching
 * the truncated address the server gave both sides. Returns null when the
 * caller is not in the slice — the page must not claim a rank it cannot see.
 */
export function rankFromBoardSlice(
  rows: readonly Pick<LeaderboardRow, 'wallet_address' | 'rank'>[],
  truncatedAddress: string | null | undefined
): number | null {
  const needle = truncatedAddress?.trim().toLowerCase();
  if (!needle) return null;
  const hit = rows.find((r) => r.wallet_address?.toLowerCase() === needle);
  return hit ? hit.rank : null;
}

/** How the wallet-count denominator should read given truncation. */
export function rankDenominatorLabel(me: Pick<YourStanding, 'walletsOnBoard'>): string {
  return `of at least ${me.walletsOnBoard.toLocaleString('en-US')} ranked wallets`;
}

/* ------------------------------------------------------------------ *
 * Freshness / staleness / truncation labelling
 * ------------------------------------------------------------------ */

/** "just now" / "42s ago" / "3m ago" / "5h ago"; '' for missing input. */
export function freshnessText(updatedAtIso: string | null | undefined, nowMs: number): string {
  if (!updatedAtIso) return '';
  const then = Date.parse(updatedAtIso);
  if (!Number.isFinite(then)) return '';
  const ms = nowMs - then;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** UTC HH:MM:SS clock, '—' for anything unparseable. */
export function utcClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export interface PartialWindowNotice {
  label: 'PARTIAL WINDOW';
  detail: string;
}

/**
 * The honest qualifier: non-null when the board cannot claim completeness.
 * truncated → the scan hit the row cap (totals/ranks cover only the most
 * recent `scannedRows` rounds); stale → numbers may lag what is settled now.
 */
export function partialWindowNotice(meta: BoardMeta | null | undefined): PartialWindowNotice | null {
  if (!meta) return null;
  if (meta.truncated) {
    const scanned = meta.scannedRows.toLocaleString('en-US');
    return {
      label: 'PARTIAL WINDOW',
      detail: `Only the most recent ${scanned} settled rounds were scanned — totals and ranks cover that slice, not the whole ${windowLabel(meta.window)} window.`,
    };
  }
  if (meta.stale) {
    return {
      label: 'PARTIAL WINDOW',
      detail: 'Snapshot is older than the server cache window — recently settled rounds may not be counted yet.',
    };
  }
  return null;
}

/** The window boundary, phrased honestly ("all time" has no `since`). */
export function windowBoundaryText(meta: BoardMeta | null | undefined): string {
  if (!meta) return 'All Time · all settled rounds';
  const label = windowLabel(meta.window);
  if (meta.window === 'all' || meta.since == null) return `${label} · all settled rounds`;
  return `${label} · since ${utcClock(meta.since)} UTC`;
}

/** Board scope summary: shown/total, metric, partial-window tail. */
export function boardScopeText(meta: BoardMeta | null | undefined): string {
  if (!meta) return '';
  const shown = meta.shown ?? 0;
  const total = meta.walletsOnBoard ?? 0;
  const base = `${windowBoundaryText(meta)} · by ${metricLabel(meta.metric)} · showing ${shown} of ${total} wallets`;
  return meta.truncated ? `${base} · partial scan (${meta.scannedRows.toLocaleString('en-US')} rounds)` : base;
}

/** Estimate qualifier for the "your rank" card. */
export function standingConfidence(me: Pick<YourStanding, 'estimated'>): {
  label: string;
  detail: string;
} {
  return me.estimated
    ? {
        label: 'ESTIMATED',
        detail: 'The window was only partially scanned, so this standing is an estimate of your true rank.',
      }
    : { label: 'EXACT', detail: 'Computed from the full window scan the public board uses.' };
}
