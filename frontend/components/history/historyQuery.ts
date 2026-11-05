
import {
  EMPTY_BET_HISTORY_FILTERS,
  HISTORY_PAGE_SIZES,
  type BetHistoryFilters,
} from '@/lib/store/historySlice';

export const MAX_HISTORY_OFFSET = 5000;
export const DEFAULT_HISTORY_LIMIT = 50;
export const HISTORY_FILTER_DEBOUNCE_MS = 350;

export interface HistoryView {
  filters: BetHistoryFilters;
  limit: number;
  offset: number;
  hideDemo: boolean;
}

export const DEFAULT_HISTORY_VIEW: HistoryView = {
  filters: { ...EMPTY_BET_HISTORY_FILTERS },
  limit: DEFAULT_HISTORY_LIMIT,
  offset: 0,
  hideDemo: false,
};

const ASSET_CODE = /^[A-Z][A-Z0-9_-]{0,15}$/;
const DIRECTIONS = ['UP', 'DOWN', 'DRAW'] as const;

function parseOffset(raw: string | null, limit: number): number {
  if (raw === null || raw.trim() === '') return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const clamped = Math.min(n, MAX_HISTORY_OFFSET);
  return Math.floor(clamped / limit) * limit;
}

function parseIsoBound(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

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
      : null;

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

export function viewToSearchParams(view: HistoryView): URLSearchParams {
  const sp = new URLSearchParams();
  const f = view.filters;
  if (f.asset && f.asset !== 'ALL') sp.set('asset', f.asset);
  if (f.outcome) sp.set('outcome', f.outcome);
  if (f.direction) sp.set('direction', f.direction);
  if (f.from) sp.set('from', f.from);
  if (f.to) sp.set('to', f.to);
  if (view.limit !== DEFAULT_HISTORY_LIMIT) sp.set('limit', String(view.limit));
  if (view.offset > 0) sp.set('offset', String(view.offset));
  if (view.hideDemo) sp.set('demo', 'hide');
  return sp;
}

export function viewKey(view: HistoryView): string {
  return viewToSearchParams(view).toString();
}

export function isDefaultView(view: HistoryView): boolean {
  return viewKey(view) === viewKey(DEFAULT_HISTORY_VIEW);
}

export interface HistoryViewPatch {
  filters?: Partial<BetHistoryFilters>;
  limit?: number;
  offset?: number;
  hideDemo?: boolean;
}

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

export function clearFiltersPatch(): HistoryViewPatch {
  return { filters: { ...EMPTY_BET_HISTORY_FILTERS }, hideDemo: false, offset: 0 };
}

export interface HistoryFilterChip {
  key: 'asset' | 'outcome' | 'direction' | 'from' | 'to' | 'demo';
  label: string;
  patch: HistoryViewPatch;
}

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
