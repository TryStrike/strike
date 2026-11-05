
import { getArcConfig } from '@/lib/arc/config';

export const ARC_MAINNET_CHAIN_ID = 5042;
export const ARC_TESTNET_CHAIN_ID = 5042002;

export function arcTargetChainId(): number {
  return getArcConfig().chainId;
}

export function arcChainLabel(chainId: number = arcTargetChainId()): string {
  if (chainId === ARC_TESTNET_CHAIN_ID) return 'Arc Testnet';
  if (chainId === ARC_MAINNET_CHAIN_ID) return 'Arc';
  return getArcConfig().name || 'Arc';
}
