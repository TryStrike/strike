/** Server-side treasury operations on Arc. */
import 'server-only';
import { ethers } from 'ethers';
import { getArcConfig, getAssetConfig, type ArcAsset } from './config';

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const TREASURY_ABI = [
  'function owner() view returns (address)',
  'function withdrawTokenTo(address to, uint256 amount)',
];

/**
 * Pay `amount` whole USDC out of the StrikeTreasury contract to `to`.
 * ARC_TREASURY_SECRET_KEY must be the contract owner.
 * Returns the transaction hash once it is mined.
 */
export async function transferFromTreasury(
  to: string,
  amount: number | string,
  asset: ArcAsset
): Promise<string> {
  if (!ethers.isAddress(to)) {
    throw new Error(`Invalid destination address: ${to}`);
  }

  const assetConfig = getAssetConfig(asset);
  const value = ethers.parseUnits(String(amount), assetConfig.decimals);
  if (value <= BigInt(0)) {
    throw new Error('Withdrawal amount must be greater than zero');
  }

  const key = process.env.ARC_TREASURY_SECRET_KEY?.trim();
  if (!key) throw new Error('ARC_TREASURY_SECRET_KEY is not configured');
  const config = getArcConfig();
  if (!ethers.isAddress(config.treasuryAddress)) {
    throw new Error('NEXT_PUBLIC_TREASURY_ADDRESS is not a valid address');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcEndpoint, {
    chainId: config.chainId,
    name: config.name,
  });
  const wallet = new ethers.Wallet(key, provider);
  const treasury = new ethers.Contract(config.treasuryAddress, TREASURY_ABI, wallet);

  // A mismatch here would mean the payout reverts on-chain; fail early and clearly.
  const owner: string = await treasury.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `ARC_TREASURY_SECRET_KEY (${wallet.address}) is not the StrikeTreasury owner (${owner})`
    );
  }

  const token = new ethers.Contract(assetConfig.address, ERC20_ABI, provider);
  const balance: bigint = await token.balanceOf(config.treasuryAddress);
  if (balance < value) {
    throw new Error(`Treasury has insufficient ${asset} for this withdrawal`);
  }
  const tx = await treasury.withdrawTokenTo(to, value);
  await tx.wait();
  return tx.hash;
}
