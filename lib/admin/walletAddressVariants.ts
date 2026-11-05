/**
 * Build possible DB variants for a wallet string (EVM case, legacy lowercased non-EVM).
 */

import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

export function walletAddressSearchVariants(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  const canonical = canonicalHouseUserAddress(t);
  const s = new Set<string>([t, canonical]);
  if (t.startsWith('0x')) {
    return [...s];
  }
  // Non-EVM: keep original; some code paths may have lowercased incorrectly
  if (t.length >= 32) s.add(t.toLowerCase());
  return [...s];
}

export function isDemoWalletAddress(addr: string | null | undefined): boolean {
  return !!addr && addr.toLowerCase().startsWith('0xdemo');
}

/**
 * Demo play writes bet_history with ids like `demo-<timestamp>` while still using the user's real wallet.
 * Exclude these (and explicit demo wallets) from real-money aggregates such as the public leaderboard.
 */
export function isDemoBetHistoryRow(row: {
  wallet_address?: string | null;
  id?: string | null;
}): boolean {
  if (isDemoWalletAddress(row.wallet_address)) return true;
  const id = row.id != null ? String(row.id) : '';
  return id.toLowerCase().startsWith('demo-');
}
