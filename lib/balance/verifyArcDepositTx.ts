/**
 * On-chain verification for Arc USDC deposits.
 *
 * USDC is the native currency, so the transaction itself must be addressed to the
 * treasury and carry at least the claimed value.
 *
 * Returns false rather than throwing: a deposit that cannot be proven is
 * simply not credited.
 */
import { ethers } from 'ethers';
import { getArcConfig, type ArcAsset } from '@/lib/arc/config';

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const RPC_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('RPC timeout')), ms)
    ),
  ]);
}

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Decodes an indexed address topic (32 bytes, right-aligned). */
function topicToAddress(topic: string): string {
  return ethers.getAddress('0x' + topic.slice(-40));
}

/** Verifies the deposit landed in the house treasury. */
export async function verifyArcDepositTx(
  txHash: string,
  userAddress: string,
  amount: number,
  asset: ArcAsset
): Promise<boolean> {
  const config = getArcConfig();
  const assetConfig = config.assets[asset];
  const recipient = (config.treasuryAddress || '').trim();
  if (!assetConfig) return false;
  if (!config.rpcEndpoint || !recipient) return false;
  if (!(amount > 0)) return false;

  try {
    const provider = new ethers.JsonRpcProvider(config.rpcEndpoint, {
      chainId: config.chainId,
      name: config.name,
    });

    const [tx, receipt] = await Promise.all([
      withTimeout(provider.getTransaction(txHash), RPC_TIMEOUT_MS),
      withTimeout(provider.getTransactionReceipt(txHash), RPC_TIMEOUT_MS),
    ]);

    if (!tx || !receipt || receipt.status !== 1) return false;
    if (!sameAddress(tx.from, userAddress)) return false;

    const required = ethers.parseUnits(amount.toString(), assetConfig.decimals);

    if (assetConfig.isNative) {
      if (!sameAddress(tx.to, recipient)) return false;
      return tx.value >= required;
    }

    // ERC-20: the value rides in a Transfer log, not in tx.value.
    const token = assetConfig.address as string;
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, token)) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;
      if (log.topics.length < 3) continue;

      const from = topicToAddress(log.topics[1]);
      const to = topicToAddress(log.topics[2]);
      if (!sameAddress(from, userAddress)) continue;
      if (!sameAddress(to, recipient)) continue;

      const value = BigInt(log.data);
      if (value >= required) return true;
    }
    return false;
  } catch (err) {
    console.error('[verifyArcDepositTx] RPC error:', err);
    return false;
  }
}
