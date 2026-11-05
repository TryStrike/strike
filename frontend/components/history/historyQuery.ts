/**
 * URL <-> view binding for /history.
 *
 * The query string is the single source of truth for filters, page size and
 * offset: the same URL must reproduce the same page after a reload, a shared
 * link, or the browser back button. This module is pure (no React, no fetch)
 * and mirrors the server's validation rules from backend/crates/server/src/routes/bets/history.rs
 * — anything the server would reject is dropped to its default here, and the
 * clamps (page sizes, MAX offset) keep a hand-edited URL from asking for an
 * unbounded read.
 *
 * `demo=hide` is the one client-only parameter: the history route has no
 * play-money filter yet, so practice rows are hidden from the loaded page
 * (see the note in the pager) — it round-trips through the URL anyway so a
 * shared link reproduces the same view.
 */

import {
  EMPTY_BET_HISTORY_FILTERS,
  HISTORY_PAGE_SIZES,
  type BetHistoryFilters,
} from '@/lib/store/historySlice';

/** Deepest offset the server accepts (MAX_HISTORY_OFFSET in the route). */
export const MAX_HISTORY_OFFSET = 5000;
export const DEFAULT_HISTORY_LIMIT = 50;
/** Filter edits are written to the URL after this quiet period. */
export const HISTORY_FILTER_DEBOUNCE_MS = 350;

export interface HistoryView {
  filters: BetHistoryFilters;
  limit: number;
  offset: number;
  /** Hide play-money (`isDemoBet`) rows from the loaded page. Client-side only. */
  hideDemo: boolean;
}

export const DEFAULT_HISTORY_VIEW: HistoryView = {
  filters: { ...EMPTY_BET_HISTORY_FILTERS },
  limit: DEFAULT_HISTORY_LIMIT,
  offset: 0,
  hideDemo: false,
};

/** Same shape as the route's ASSET_CODE — anything else never reaches the server. */
const ASSET_CODE = /^[A-Z][A-Z0-9_-]{0,15}$/;
const DIRECTIONS = ['UP', 'DOWN', 'DRAW'] as const;

function parseOffset(raw: string | null, limit: number): number {
  if (raw === null || raw.trim() === '') return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const clamped = Math.min(n, MAX_HISTORY_OFFSET);
  // Snap to a page boundary so back/forward always lands on a real page.
  return Math.floor(clamped / limit) * limit;
}

/** Parse one ISO bound; date-only strings are accepted by the route too. */
function parseIsoBound(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Read the view out of a query string. Invalid values never throw and never
 * leak through to the server — they fall back to the default.
 */
export function parseHistoryView(sp: URLSearchParams): HistoryView {
  const rawLimit = Number.parseInt(sp.get('limit') ?? '', 10);
  const limit = (HISTORY_PAGE_SIZES as readonly number[]).includes(rawLimit)
    ? rawLimit
    : DEFAULT_HISTORY_LIMIT;

  let asset: string | null = null;
  const rawAsset = (sp.get('asset') ?? '').trim().toUpperCase();
  if (rawAsset && rawAsset !== 'ALL' && ASSET_CODE.test(rawAsset)) asset = rawAsset;

  const rawOutcome = (sp.get('outcome') ?? 'all').trim().toLowerCase();
  const outcome =
    rawOutcome === 'won' || rawOutcome === 'lost'
      ? (rawOutcome as 'won' | 'lost')
      : null; // 'all' and junk alike

  const rawDirection = (sp.get('direction') ?? '').trim().toUpperCase();
  const direction = (DIRECTIONS as readonly string[]).includes(rawDirection)
    ? (rawDirection as BetHistoryFilters['direction'])
    : null;

  return {
    filters: {
      asset,
      outcome,
      direction,
      from: parseIsoBound(sp.get('from')),
      to: parseIsoBound(sp.get('to')),
    },
    limit,
    offset: parseOffset(sp.get('offset'), limit),
    hideDemo: (sp.get('demo') ?? '').trim().toLowerCase() === 'hide',
  };
}

/** Serialise the view back to a query string, omitting every default value. */
export function viewToSearchParams(view: HistoryView): URLSearchParams {
  const sp = new URLSearchParams();
  const f = view.filters;
  if (f.asset && f.asset !== 'ALL') sp.set('asset', f.asset);
  // The route defaults outcome to `all`, so an unfiltered view writes nothing.
  if (f.outcome) sp.set('outcome', f.outcome);
  if (f.direction) sp.set('direction', f.direction);
  if (f.from) sp.set('from', f.from);
  if (f.to) sp.set('to', f.to);
  if (view.limit !== DEFAULT_HISTORY_LIMIT) sp.set('limit', String(view.limit));
  if (view.offset > 0) sp.set('offset', String(view.offset));
  if (view.hideDemo) sp.set('demo', 'hide');
  return sp;
}

/** Stable identity of a view — used to dedupe URL writes and refetches. */
export function viewKey(view: HistoryView): string {
  return viewToSearchParams(view).toString();
}

/** True when the URL matches the unfiltered first page (nothing to clear). */
export function isDefaultView(view: HistoryView): boolean {
  return viewKey(view) === viewKey(DEFAULT_HISTORY_VIEW);
}

/**
 * A control patch against the current view. `filters` merges key-by-key so a
 * single chip toggle never has to resend the untouched filters.
 */
export interface HistoryViewPatch {
  filters?: Partial<BetHistoryFilters>;
  limit?: number;
  offset?: number;
  hideDemo?: boolean;
}

/**
 * Apply a control patch to the view. Any change to the filter set (or the
 * practice toggle) resets the offset to 0 — never paginate across a filter
 * swap. A page-size change also returns to the first page, because the old
 * offset is meaningless against the new denominator.
 */
export function applyViewPatch(view: HistoryView, patch: HistoryViewPatch): HistoryView {
  const next: HistoryView = {
    ...view,
    ...patch,
    filters: { ...view.filters, ...(patch.filters ?? {}) },
  };
  const touchedFilters =
    patch.filters !== undefined ||
    Object.prototype.hasOwnProperty.call(patch, 'hideDemo');
  const touchedLimit =
    patch.limit !== undefined && patch.limit !== view.limit;
  if (touchedFilters || touchedLimit) next.offset = 0;
  if (next.offset > MAX_HISTORY_OFFSET) next.offset = MAX_HISTORY_OFFSET;
  return next;
}

/** The "clear filters" patch: defaults in place, still on the same page size. */
export function clearFiltersPatch(): HistoryViewPatch {
  return { filters: { ...EMPTY_BET_HISTORY_FILTERS }, hideDemo: false, offset: 0 };
}

export interface HistoryFilterChip {
  key: 'asset' | 'outcome' | 'direction' | 'from' | 'to' | 'demo';
  label: string;
  patch: HistoryViewPatch;
}

/**
 * One removable chip per server-side filter the user actually applied, plus
 * the client-only practice toggle. Each chip carries the exact patch that
 * clears just it, so "×" on a chip and "Clear filters" share this code path.
 */
export function activeFilterChips(
  view: HistoryView,
  formatTime: (iso: string) => string
): HistoryFilterChip[] {
  const chips: HistoryFilterChip[] = [];
  const f = view.filters;
  if (f.asset && f.asset !== 'ALL') {
    chips.push({ key: 'asset', label: f.asset, patch: { filters: { ...f, asset: null } } });
  }
  if (f.outcome) {
    chips.push({
      key: 'outcome',
      label: f.outcome === 'won' ? 'Wins only' : 'Losses only',
      patch: { filters: { ...f, outcome: null } },
    });
  }
  if (f.direction) {
    chips.push({
      key: 'direction',
      label: `Direction: ${f.direction}`,
      patch: { filters: { ...f, direction: null } },
    });
  }
  if (f.from) {
    chips.push({
      key: 'from',
      label: `From ${formatTime(f.from)}`,
      patch: { filters: { ...f, from: null } },
    });
  }
  if (f.to) {
    chips.push({
      key: 'to',
      label: `To ${formatTime(f.to)}`,
      patch: { filters: { ...f, to: null } },
    });
  }
  if (view.hideDemo) {
    chips.push({ key: 'demo', label: 'Practice hidden', patch: { hideDemo: false } });
  }
  return chips;
}
