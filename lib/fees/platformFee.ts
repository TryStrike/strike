/**
 * Platform / protocol fee collector helpers.
 *
 * Business rule:
 * - Charge tiered fee on every deposit and withdrawal (regardless of profit/loss):
 *   free=10%, standard=9%, vip=8%.
 * - Transfer the fee from the chain treasury to a dedicated collector wallet.
 */

type UserTier = 'free' | 'standard' | 'vip';

const FEE_PERCENT_BY_TIER: Record<UserTier, number> = {
  free: 0.10,
  standard: 0.09,
  vip: 0.08,
};

function normalizeTier(tier?: string | null): UserTier {
  if (tier === 'standard' || tier === 'vip' || tier === 'free') return tier;
  return 'free';
}

function getFeePercent(tier?: string | null): number {
  return FEE_PERCENT_BY_TIER[normalizeTier(tier)];
}

export function getFeePercentLabel(tier?: string | null): string {
  return `${Math.round(getFeePercent(tier) * 100)}%`;
}

export function calculateFeeAmount(amount: number, tier?: string | null): number {
  // Keep numeric stability (UI inputs are typically <= 4 decimals, but we round to 8).
  const fee = amount * getFeePercent(tier);
  return Math.floor(fee * 1e8) / 1e8;
}

function getEnvOptional(key: string): string | null {
  const val = process.env[key];
  return val && val.trim() ? val.trim() : null;
}

/**
 * The fee collector for Arc USDC. NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC
 * overrides the shared collector when needed.
 */
export function getPlatformFeeWalletAddress(normalizedCurrency: string): string | null {
  return normalizedCurrency === 'USDC' ? getEnvOptional('NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC') : null;
}

