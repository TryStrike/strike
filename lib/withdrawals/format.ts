/**
 * Display-only formatters for the withdrawal status page. Pure and deterministic
 * (locale-free by default) so they can be unit-tested.
 */

/** USDC on Arc has 6 decimals; anything finer cannot actually be paid. */
export const USDC_DECIMALS = 6;

export function shortHash(hash: string): string {
  if (!hash || hash.length < 16) return hash || '';
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/**
 * Render a ledger amount honestly:
 *  - non-numeric / NaN values never render as "NaN" money,
 *  - sub-micro positive amounts show as "<0.000001" rather than 0 (the player
 *    must not read a fee rounding artifact as a zero payout),
 *  - trailing zeros are trimmed so 1.5 shows as "1.5", not "1.500000".
 */
export function formatUsdc(value: unknown, decimals: number = USDC_DECIMALS): string {
  // Missing/blank is not "0 USDC" — say so honestly.
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '—';
  const smallest = 10 ** -decimals;
  if (n > 0 && n < smallest) return `<${smallest.toFixed(decimals)}`;
  return trimZeros(n.toFixed(Math.min(decimals, 20)));
}

function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Wall-clock timestamp in a stable en-GB-ish layout (server and tests render
 * identically; the page passes its own locale through `locale` when it wants
 * one). Returns the raw string unchanged when it is not a valid date.
 */
export function formatWhen(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return String(iso);
  return d.toLocaleString(locale, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Epoch ms (`signed_at` is a BIGINT column) into the same layout. */
export function formatWhenMs(ms: number | null | undefined, locale?: string): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return formatWhen(new Date(ms).toISOString(), locale);
}
