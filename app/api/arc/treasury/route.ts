/**
 * GET /api/arc/treasury
 * Live, on-chain view of the StrikeTreasury contract on Arc: its USDC balance and
 * the latest USDC transfers into (deposits) and out of (payouts) it.
 * Read straight from the Arc RPC; CDN-cached briefly so the landing page can poll it.
 */
import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getArcConfig } from '@/lib/arc/config';

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
// Arc's RPC caps eth_getLogs at a 5,000-block range (roughly the last hour).
const LOOKBACK_BLOCKS = 4_900;

export async function GET() {
  const config = getArcConfig();
  const treasury = config.treasuryAddress;
  if (!ethers.isAddress(treasury)) {
    return NextResponse.json({ error: 'Treasury not configured' }, { status: 503 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(config.rpcEndpoint, config.chainId, { staticNetwork: true });
    const usdc = new ethers.Contract(config.usdc, ['function balanceOf(address) view returns (uint256)'], provider);
    const padded = ethers.zeroPadValue(treasury, 32);

    const head = await provider.getBlockNumber();
    const range = { address: config.usdc, fromBlock: Math.max(0, head - LOOKBACK_BLOCKS), toBlock: head };
    const [balance, inLogs, outLogs] = await Promise.all([
      usdc.balanceOf(treasury) as Promise<bigint>,
      provider.getLogs({ ...range, topics: [TRANSFER, null, padded] }),
      provider.getLogs({ ...range, topics: [TRANSFER, padded] }),
    ]);

    const toEvent = (type: 'deposit' | 'payout') => (log: ethers.Log) => ({
      type,
      amount: Number(ethers.formatUnits(BigInt(log.data), config.assets.USDC.decimals)),
      counterparty: ethers.getAddress('0x' + log.topics[type === 'deposit' ? 1 : 2].slice(-40)),
      txHash: log.transactionHash,
      block: log.blockNumber,
    });

    const events = [...inLogs.map(toEvent('deposit')), ...outLogs.map(toEvent('payout'))]
      .sort((a, b) => b.block - a.block)
      .slice(0, 6);

    return NextResponse.json(
      {
        address: treasury,
        chainId: config.chainId,
        explorer: config.explorer,
        balance: Number(ethers.formatUnits(balance, config.assets.USDC.decimals)),
        events,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=60' } }
    );
  } catch {
    return NextResponse.json({ error: 'Arc RPC unavailable' }, { status: 502 });
  }
}
