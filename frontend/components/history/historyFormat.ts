
import type { BetHistoryFilters, BetHistoryRow } from '@/lib/store/historySlice';
import { formatMoney } from '@/components/ui/MoneyText';

export function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function formatAmount(value: unknown, decimals: 2 | 4 = 2): string {
  return formatMoney(asNumber(value), decimals);
}

export function formatSignedAmount(value: number): string {
  const n = asNumber(value);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${formatAmount(Math.abs(n))}`;
}

export function formatPrice(value: unknown): string {
  const n = asNumber(value);
  if (n === 0) return '0.00';
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

export function formatMultiplier(value: unknown): string {
  return `${asNumber(value).toFixed(2).replace(/\.?0+$/, '')}x`;
}

function safeTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function rowTimeMs(row: Pick<BetHistoryRow, 'resolved_at' | 'created_at'>): number | null {
  return safeTime(row.resolved_at) ?? safeTime(row.created_at);
}

export function formatDateTime(iso: string | null | undefined): string {
  const t = safeTime(iso);
  if (t === null) return '—';
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRowDateTime(
  row: Pick<BetHistoryRow, 'resolved_at' | 'created_at'>
): string {
  const t = rowTimeMs(row);
  if (t === null) return '—';
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatClock(iso: string | null | undefined): string {
  const t = safeTime(iso);
  if (t === null) return '—';
  return new Date(t).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function shortenAddress(address: string | null | undefined): string {
  const a = (address ?? '').trim();
  if (a.length < 12) return a || '—';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function shortenHash(hash: string | null | undefined): string {
  const h = (hash ?? '').trim();
  if (h.length < 14) return h;
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

export function priceDelta(row: BetHistoryRow): number {
  return asNumber(row.end_price) - asNumber(row.strike_price);
}

export type HistoryOutcome = 'won' | 'lost';

export function outcomeOf(row: Pick<BetHistoryRow, 'won'>): HistoryOutcome {
  return row.won ? 'won' : 'lost';
}

export function netOf(row: BetHistoryRow): number {
  return row.won ? asNumber(row.payout) - asNumber(row.amount) : -asNumber(row.amount);
}

export interface HistorySummary {
  rounds: number;
  wins: number;
  losses: number;
  wagered: number;
  credited: number;
  net: number;
  winRate: number;
}

export function summarizeHistoryRows(rows: BetHistoryRow[]): HistorySummary {
  let wins = 0;
  let losses = 0;
  let wagered = 0;
  let credited = 0;
  let net = 0;

  for (const row of rows) {
    const stake = asNumber(row.amount);
    wagered += stake;
    credited += asNumber(row.payout);
    net += netOf(row);
    const result = netOf(row);
    if (result > 0) wins += 1;
    else if (result < 0) losses += 1;
  }

  // A tie refunds the stake: it is neither a win nor a loss.
  const rounds = rows.length;
  const decided = wins + losses;
  return {
    rounds,
    wins,
    losses,
    wagered,
    credited,
    net,
    winRate: decided > 0 ? (wins / decided) * 100 : 0,
  };
}

export function isDemoRow(row: BetHistoryRow): boolean {
  return row.isDemoBet === true || String(row.id ?? '').toLowerCase().startsWith('demo-');
}

export interface DemoSplit {
  real: BetHistoryRow[];
  demo: BetHistoryRow[];
}

export function splitDemoRows(rows: BetHistoryRow[]): DemoSplit {
  const real: BetHistoryRow[] = [];
  const demo: BetHistoryRow[] = [];
  for (const row of rows) (isDemoRow(row) ? demo : real).push(row);
  return { real, demo };
}

export function summarizeRealRows(rows: BetHistoryRow[]): HistorySummary & { practiceRounds: number } {
  const { real, demo } = splitDemoRows(rows);
  return { ...summarizeHistoryRows(real), practiceRounds: demo.length };
}



export const CSV_HEADERS = [
  'bet_id',
  'settled_at',
  'asset',
  'direction',
  'stake',
  'multiplier',
  'strike_price',
  'end_price',
  'price_change',
  'outcome',
  'payout',
  'net',
  'mode',
  'network',
  'demo',
  'tx_hash',
] as const;

export function escapeCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function historyRowToCsvCells(row: BetHistoryRow): string[] {
  const settledMs = rowTimeMs(row);
  return [
    row.id ?? '',
    settledMs !== null ? new Date(settledMs).toISOString() : '',
    String(row.asset ?? ''),
    String(row.direction ?? ''),
    asNumber(row.amount).toFixed(2),
    asNumber(row.multiplier).toFixed(4),
    row.strike_price === null || row.strike_price === undefined ? '' : asNumber(row.strike_price).toFixed(8),
    row.end_price === null || row.end_price === undefined ? '' : asNumber(row.end_price).toFixed(8),
    priceDelta(row).toFixed(8),
    outcomeOf(row),
    asNumber(row.payout).toFixed(2),
    netOf(row).toFixed(2),
    String(row.mode ?? ''),
    String(row.network ?? ''),
    row.isDemoBet ? 'demo' : 'real',
    row.txHash ?? '',
  ];
}

export function buildHistoryCsv(rows: BetHistoryRow[]): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(historyRowToCsvCells(row).map(escapeCsvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function tokenise(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildHistoryExportFilename(opts: {
  address?: string | null;
  filters?: BetHistoryFilters | null;
  generatedAt?: Date;
}): string {
  const parts = ['history'];
  const wallet = tokenise(opts.address);
  if (wallet) parts.push(wallet.slice(-8));

  const f = opts.filters;
  if (f?.asset && f.asset !== 'ALL') parts.push(tokenise(f.asset));
  if (f?.outcome) parts.push(f.outcome);
  if (f?.direction) parts.push(tokenise(f.direction));
  if (f?.from) parts.push(tokenise(f.from).slice(0, 10));
  if (f?.to) parts.push(tokenise(f.to).slice(0, 10));

  const d = opts.generatedAt ?? new Date();
  const stamp = Number.isFinite(d.getTime())
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : 'export';

  return `strike-${parts.join('-')}-${stamp}.csv`;
}

export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayStartIso(dateInput: string): string | null {
  if (!dateInput) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function dayEndIso(dateInput: string): string | null {
  if (!dateInput) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function hasActiveFilters(filters: BetHistoryFilters): boolean {
  return Boolean(
    (filters.asset && filters.asset !== 'ALL') ||
      filters.outcome ||
      filters.direction ||
      filters.from ||
      filters.to
  );
}

export function filterSummary(filters: BetHistoryFilters): string {
  const bits: string[] = [];
  if (filters.asset && filters.asset !== 'ALL') bits.push(filters.asset);
  if (filters.outcome) bits.push(filters.outcome === 'won' ? 'Wins' : 'Losses');
  if (filters.direction) bits.push(filters.direction);
  if (filters.from) bits.push(`from ${formatDateTime(filters.from)}`);
  if (filters.to) bits.push(`to ${formatDateTime(filters.to)}`);
  return bits.length ? bits.join(' · ') : 'All rounds';
}
