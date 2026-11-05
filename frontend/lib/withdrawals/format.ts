
export const USDC_DECIMALS = 6;

export function shortHash(hash: string): string {
  if (!hash || hash.length < 16) return hash || '';
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function formatUsdc(value: unknown, decimals: number = USDC_DECIMALS): string {
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

export function formatWhenMs(ms: number | null | undefined, locale?: string): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return formatWhen(new Date(ms).toISOString(), locale);
}
