/**
 * Display-only formatting for /profile.
 *
 * Everything is numeric-in/text-out and free of side effects: the house ledger
 * is USDC with 6 decimals (lib/store/balanceSlice.ts feeds plain numbers), so
 * amounts are shown with fixed decimals and never with binary-float noise.
 */

export const USDC_DECIMALS = 6;

/** Coerce a NUMERIC-as-string or number into a finite number (0 otherwise). */
export function toAmount(value: unknown): number {
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
    return Number.isFinite(n) ? n : 0;
}

const LOCALE = 'en-US';

function clampDecimals(decimals: number): number {
    return Math.max(0, Math.min(USDC_DECIMALS, Math.trunc(decimals)));
}

/** `1,234.57` — fixed decimals, grouped, never `NaN`. */
export function formatUsdc(value: unknown, decimals = 2): string {
    const n = toAmount(value);
    const dp = clampDecimals(decimals);
    return n.toLocaleString(LOCALE, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * `+12.50` / `-12.50` / `0.00`. The sign is taken from the ROUNDED figure, so a
 * -0.004 residue shows as `0.00` instead of a misleading `-0.00` loss.
 */
export function formatSignedUsdc(value: unknown, decimals = 2): string {
    const dp = clampDecimals(decimals);
    const n = toAmount(value);
    const rounded = Number(n.toFixed(dp));
    const body = formatUsdc(Math.abs(rounded), dp);
    if (rounded > 0) return `+${body}`;
    if (rounded < 0) return `-${body}`;
    return body;
}

/** `57.3%`; an unknown denominator is rendered as `—`, not as `0%`. */
export function formatPercent(value: unknown, decimals = 1): string {
    if (value === null || value === undefined) return '—';
    const n = toAmount(value);
    return `${formatUsdc(n, decimals)}%`;
}

/** Win/loss split line, e.g. `8W / 5L`. */
export function winLossLabel(wins: unknown, losses: unknown): string {
    return `${Math.trunc(toAmount(wins))}W / ${Math.trunc(toAmount(losses))}L`;
}

export type Tone = 'positive' | 'negative' | 'flat';

export function pnlTone(value: unknown): Tone {
    const n = toAmount(value);
    if (n > 0) return 'positive';
    if (n < 0) return 'negative';
    return 'flat';
}

const TONE_CLASS: Record<Tone, string> = {
    positive: 'text-emerald-400',
    negative: 'text-rose-400',
    flat: 'text-white/40',
};

export function pnlClass(value: unknown): string {
    return TONE_CLASS[pnlTone(value)];
}

/** `2026-02-10` from an ISO timestamp; anything unparseable becomes `—`. */
export function formatShortDay(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(String(iso));
    if (!Number.isFinite(t)) return '—';
    return new Date(t).toISOString().slice(0, 10);
}

/** Relative "n min/h/d ago" from an epoch/ISO instant; unknown becomes `—`. */
export function formatAgo(value: string | number | null | undefined, now: number = Date.now()): string {
    const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    if (!Number.isFinite(ms)) return '—';
    const delta = Math.max(0, now - ms);
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export type BalanceView = 'disconnected' | 'loading' | 'failed' | 'demo' | 'empty' | 'ready';

export interface BalanceFacts {
    isConnected: boolean;
    hasAddress: boolean;
    isLoading: boolean;
    /** balanceSlice.error — set when the last read failed. */
    error: string | null;
    accountType: 'real' | 'demo';
    /** Credits currently in the store (0 is a legitimate value). */
    balance: number;
    /** True once a balance read for this wallet has completed without error. */
    loadedOnce: boolean;
}

/**
 * Which balance panel state to render. Ordering matters: a failed read must
 * never fall through to "0.0000 USDC" (that reads as an emptied account), and a
 * refresh failure keeps the last known figure on screen while `balanceIsStale`
 * flags it.
 */
export function resolveBalanceView(facts: BalanceFacts): BalanceView {
    if (!facts.isConnected || !facts.hasAddress) return 'disconnected';
    if (facts.accountType === 'demo') return 'demo';
    if (!facts.loadedOnce && facts.isLoading) return 'loading';
    if (!facts.loadedOnce && facts.error) return 'failed';
    if (!facts.loadedOnce) return 'empty';
    return toAmount(facts.balance) === 0 ? 'empty' : 'ready';
}

/** Last figure is on screen but the most recent read failed. */
export function balanceIsStale(facts: BalanceFacts): boolean {
    return facts.loadedOnce && !!facts.error;
}

export const BALANCE_VIEW_COPY: Record<BalanceView, { label: string; hint: string }> = {
    disconnected: { label: 'Balance', hint: 'Connect a wallet to see house credits.' },
    loading: { label: 'Balance', hint: 'Reading the house ledger…' },
    failed: { label: 'Balance', hint: 'Balance could not be read. Your funds are untouched.' },
    demo: { label: 'Practice balance', hint: 'Demo credits — not on-chain, not withdrawable.' },
    empty: { label: 'House credits', hint: 'No house balance yet — deposit to start betting.' },
    ready: { label: 'House credits', hint: 'Settled in USDC on Arc.' },
};

/** `1,234.5678` with the 4-decimal house-credit convention. */
export function formatHouseCredits(value: unknown): string {
    return formatUsdc(value, 4);
}

/**
 * Net result of one settled row, the same definition the stats aggregation uses
 * (backend/crates/core/src/bets.rs betNet): a win books payout - stake, a loss
 * books -stake. Showing the gross payout here would read as twice the profit the
 * player actually made.
 */
export function ledgerRowNet(row: {
    won?: boolean | null;
    payout?: string | number | null;
    amount?: string | number | null;
}): number {
    return row.won ? toAmount(row.payout) - toAmount(row.amount) : -toAmount(row.amount);
}
