
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

export function walletAddressSearchVariants(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  const canonical = canonicalHouseUserAddress(t);
  const s = new Set<string>([t, canonical]);
  if (t.startsWith('0x')) {
    return [...s];
  }
  if (t.length >= 32) s.add(t.toLowerCase());
  return [...s];
}

export function isDemoWalletAddress(addr: string | null | undefined): boolean {
  return !!addr && addr.toLowerCase().startsWith('0xdemo');
}

export function isDemoBetHistoryRow(row: {
  wallet_address?: string | null;
  id?: string | null;
}): boolean {
  if (isDemoWalletAddress(row.wallet_address)) return true;
  const id = row.id != null ? String(row.id) : '';
  return id.toLowerCase().startsWith('demo-');
}
