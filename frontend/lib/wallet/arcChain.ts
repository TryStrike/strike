/**
 * Arc chain presentation + the target chain id for switch/reconnect.
 *
 * The app defines its chain once — `getArcConfig()` (lib/arc/config.ts),
 * driven by NEXT_PUBLIC_* with an Arc mainnet (5042) default; a testnet
 * deployment sets NEXT_PUBLIC_ARC_CHAIN_ID=5042002. Nothing here invents a
 * new constant: the ids mirror the existing defaults and the deployment
 * registry under contracts/deployments/.
 */

import { getArcConfig } from '@/lib/arc/config';

/** ARC_DEFAULTS.chainId in lib/arc/config.ts. */
export const ARC_MAINNET_CHAIN_ID = 5042;
/** Arc Testnet, per contracts/deployments/arc-5042002.json. */
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** The chain this build settles on: configured id, default Arc mainnet. */
export function arcTargetChainId(): number {
  return getArcConfig().chainId;
}

/** Human name for a chain id, aligned with contracts/deploy.mjs naming. */
export function arcChainLabel(chainId: number = arcTargetChainId()): string {
  if (chainId === ARC_TESTNET_CHAIN_ID) return 'Arc Testnet';
  if (chainId === ARC_MAINNET_CHAIN_ID) return 'Arc';
  return getArcConfig().name || 'Arc';
}
