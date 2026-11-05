/**
 * Treasury balance snapshot for the admin dashboard.
 *
 * The platform settles on Arc only, so this reports the treasury's
 * USDC holding. Each
 * row is best-effort — a failed read is reported as an error on that row
 * rather than failing the whole snapshot.
 */
import { ethers } from 'ethers';
import {
  getArcConfig,
  explorerAddressUrl,
  ARC_ASSETS,
  type ArcAsset,
} from '@/lib/arc/config';

type TreasuryBalanceRow = {
  chain: string;
  label: string;
  address: string;
  asset: string;
  balance: number | null;
  formatted: string;
  explorerUrl: string | null;
  error: string | null;
};

const FETCH_MS = 14_000;

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function fmt(n: number | null, maxFrac = 6): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n >= 1e9) return n.toExponential(4);
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

async function readBalance(
  provider: ethers.JsonRpcProvider,
  address: string,
  asset: ArcAsset
): Promise<number> {
  const config = getArcConfig();
  const assetConfig = config.assets[asset];
  const raw = await new ethers.Contract(assetConfig.address, ERC20_ABI, provider).balanceOf(
    address
  );
  return parseFloat(ethers.formatUnits(raw, assetConfig.decimals));
}

/**
 * Collect the treasury's balance of every playable asset.
 */
export async function buildTreasuryBalanceSnapshot(): Promise<{
  generatedAt: string;
  rows: TreasuryBalanceRow[];
}> {
  const config = getArcConfig();
  const address = config.treasuryAddress?.trim();

  const base = {
    chain: 'ARC',
    label: config.name,
    address: address || '',
    explorerUrl: address ? explorerAddressUrl(address) : null,
  };

  if (!address) {
    return {
      generatedAt: new Date().toISOString(),
      rows: ARC_ASSETS.map((asset) => ({
        ...base,
        asset,
        balance: null,
        formatted: '—',
        error: 'NEXT_PUBLIC_TREASURY_ADDRESS is not configured',
      })),
    };
  }

  const provider = new ethers.JsonRpcProvider(config.rpcEndpoint, {
    chainId: config.chainId,
    name: config.name,
  });

  const rows = await Promise.all(
    ARC_ASSETS.map(async (asset): Promise<TreasuryBalanceRow> => {
      try {
        const balance = await withTimeout(readBalance(provider, address, asset), FETCH_MS);
        return { ...base, asset, balance, formatted: fmt(balance), error: null };
      } catch (e) {
        return {
          ...base,
          asset,
          balance: null,
          formatted: '—',
          error: e instanceof Error ? e.message : 'failed',
        };
      }
    })
  );

  return { generatedAt: new Date().toISOString(), rows };
}
