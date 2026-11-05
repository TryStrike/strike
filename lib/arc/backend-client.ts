/** Server-side treasury operations on Arc. */
import 'server-only';
import { ethers } from 'ethers';
import { getArcConfig, getAssetConfig, type ArcAsset } from './config';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

function treasurySigner(): ethers.Wallet {
  const key = process.env.ARC_TREASURY_SECRET_KEY?.trim();
  if (!key) {
    throw new Error('ARC_TREASURY_SECRET_KEY is not configured');
  }
  const config = getArcConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcEndpoint, {
    chainId: config.chainId,
    name: config.name,
  });
  const wallet = new ethers.Wallet(key, provider);

  // A mismatch here would send house funds from an unexpected account.
  if (
    config.treasuryAddress &&
    wallet.address.toLowerCase() !== config.treasuryAddress.toLowerCase()
  ) {
    throw new Error(
      `ARC_TREASURY_SECRET_KEY does not match NEXT_PUBLIC_TREASURY_ADDRESS ` +
        `(key is ${wallet.address}, expected ${config.treasuryAddress})`
    );
  }
  return wallet;
}

/**
 * Send `amount` whole tokens of `asset` from the treasury to `to`.
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

  const wallet = treasurySigner();

  if (assetConfig.isNative) {
    const balance = await wallet.provider!.getBalance(wallet.address);
    if (balance < value) {
      throw new Error('Treasury has insufficient USDC for this withdrawal');
    }
    const tx = await wallet.sendTransaction({ to, value });
    await tx.wait();
    return tx.hash;
  }

  const token = new ethers.Contract(assetConfig.address as string, ERC20_ABI, wallet);
  const balance: bigint = await token.balanceOf(wallet.address);
  if (balance < value) {
    throw new Error(`Treasury has insufficient ${asset} for this withdrawal`);
  }
  const tx = await token.transfer(to, value);
  await tx.wait();
  return tx.hash;
}
