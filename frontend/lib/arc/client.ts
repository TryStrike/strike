/** Read-side Arc helpers (USDC via its ERC-20 interface). */

import { ethers } from 'ethers';
import {
  getArcConfig,
  getAssetConfig,
  type ArcAsset,
} from './config';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
];

let provider: ethers.JsonRpcProvider | null = null;

function getArcProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    const config = getArcConfig();
    provider = new ethers.JsonRpcProvider(config.rpcEndpoint, {
      chainId: config.chainId,
      name: config.name,
    });
  }
  return provider;
}

/** Balance of any playable asset, as a whole-token number. */
export async function getAssetBalance(address: string, asset: ArcAsset): Promise<number> {
  if (!address) return 0;
  const cfg = getAssetConfig(asset);
  const rpc = getArcProvider();

  try {
    const token = new ethers.Contract(cfg.address, ERC20_ABI, rpc);
    const balance = await token.balanceOf(address);
    return parseFloat(ethers.formatUnits(balance, cfg.decimals));
  } catch (error) {
    console.error(`Failed to get ${asset} balance:`, error);
    return 0;
  }
}
