
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
  const fee = amount * getFeePercent(tier);
  return Math.floor(fee * 1e8) / 1e8;
}

function getEnvOptional(key: string): string | null {
  const val = process.env[key];
  return val && val.trim() ? val.trim() : null;
}

export function getPlatformFeeWalletAddress(normalizedCurrency: string): string | null {
  return normalizedCurrency === 'USDC' ? getEnvOptional('NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC') : null;
}

