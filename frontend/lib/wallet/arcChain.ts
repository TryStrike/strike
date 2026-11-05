/** Arc chain presentation and the target chain id for switch/reconnect. */

import { getArcConfig } from '@/lib/arc/config';

export const ARC_MAINNET_CHAIN_ID = 5042;
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** The chain this build settles on. */
export function arcTargetChainId(): number {
  return getArcConfig().chainId;
}

/** Human name for a chain id, aligned with contracts/deploy.mjs naming. */
export function arcChainLabel(chainId: number = arcTargetChainId()): string {
  if (chainId === ARC_TESTNET_CHAIN_ID) return 'Arc Testnet';
  if (chainId === ARC_MAINNET_CHAIN_ID) return 'Arc';
  return getArcConfig().name || 'Arc';
}
