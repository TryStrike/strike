/**
 * Approximate USD valuation for the Arc treasury.
 * Not financial advice — for ops visibility only.
 *
 * Arc USDC is pegged, so it is quoted at $1. No token address or external
 * price feed is invented while the Arc contract address remains unset.
 */

const ARC_USDC_UNIT_USD = 1;

/** USD per 1 unit of the on-chain asset (null if unknown). */
export function usdPerUnit(asset: string): number | null {
  return asset.toUpperCase() === 'USDC' ? ARC_USDC_UNIT_USD : null;
}

export function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n > 0 && n < 0.01) return '<$0.01';
  if (n >= 1e9) return `$${n.toExponential(2)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function balanceTimesUsd(balance: number | null, unitUsd: number | null): number | null {
  if (balance === null || !Number.isFinite(balance) || unitUsd === null || !Number.isFinite(unitUsd)) return null;
  return balance * unitUsd;
}
