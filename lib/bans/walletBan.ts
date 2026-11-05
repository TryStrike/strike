/**
 * Global wallet ban list — blocks deposits, bets, payouts, and withdrawals
 * across all currencies for a given chain address.
 *
 * Uses the service-role client so lookups work even when RLS blocks the anon key.
 */

import { supabaseService } from '@/lib/supabase/serviceClient';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

/** Normalize for storage/lookup: EVM hex lowercased. */
export function normalizeWalletForBanKey(address: string): string {
  return canonicalHouseUserAddress(address);
}

/** Emergency list without DB migration — comma-separated in BANNED_WALLET_ADDRESSES */
function isBannedViaEnv(address: string): boolean {
  const raw = process.env.BANNED_WALLET_ADDRESSES || '';
  if (!raw.trim()) return false;
  const key = normalizeWalletForBanKey(address);
  return raw
    .split(',')
    .map(s => normalizeWalletForBanKey(s.trim()))
    .filter(Boolean)
    .includes(key);
}

/**
 * True if the wallet is on the global ban list (env and/or `banned_wallets` table).
 * On lookup errors, falls back to env-only so a missing table does not brick deposits.
 */
export async function isWalletGloballyBanned(address: string): Promise<boolean> {
  if (isBannedViaEnv(address)) return true;
  const key = normalizeWalletForBanKey(address);
  const { data, error } = await supabaseService
    .from('banned_wallets')
    .select('wallet_address')
    .eq('wallet_address', key)
    .maybeSingle();

  if (error) {
    console.warn('[walletBan] banned_wallets lookup failed:', error.message);
    return isBannedViaEnv(address);
  }
  return !!data;
}
