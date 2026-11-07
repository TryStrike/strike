
export type ArcAsset = 'USDC' | 'EURC';

interface ArcAssetConfig {
  symbol: ArcAsset;
  decimals: number;
  address: `0x${string}`;
  logo: string;
}

interface NetworkConfig {
  chainId: number;
  name: string;
  rpcEndpoint: string;
  explorer: string;
  usdc: `0x${string}`;
  eurc: `0x${string}`;
}

const ARC_DEFAULTS: NetworkConfig = {
  chainId: 5042002,
  name: 'Arc Testnet',
  rpcEndpoint: 'https://rpc.testnet.arc.network',
  explorer: 'https://explorer.testnet.arc.io',
  usdc: '0x3600000000000000000000000000000000000000',
  eurc: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
};

interface ArcConfig extends NetworkConfig {
  treasuryAddress: string;
  assets: Record<ArcAsset, ArcAssetConfig>;
}

function envKey(): string {
  return [
    process.env.NEXT_PUBLIC_ARC_CHAIN_ID ?? '',
    process.env.NEXT_PUBLIC_ARC_RPC_ENDPOINT ?? '',
    process.env.NEXT_PUBLIC_ARC_EXPLORER ?? '',
    process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS ?? '',
    process.env.NEXT_PUBLIC_ARC_EURC_ADDRESS ?? '',
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? '',
  ].join('|');
}

let cachedKey: string | null = null;
let cachedConfig: ArcConfig | null = null;

/**
 * Every Arc testnet RPC we can read from, preferred first. arc.network rate-limits bursts;
 * arc.io is blocked by common ad-block lists. Reads fail over between them.
 */
export function arcRpcUrls(): string[] {
  const primary = getArcConfig().rpcEndpoint;
  return [...new Set([primary, 'https://rpc.testnet.arc.network', 'https://rpc.testnet.arc.io'])];
}

export function getArcConfig(): ArcConfig {
  const key = envKey();
  if (cachedConfig && cachedKey === key) return cachedConfig;

  const net = ARC_DEFAULTS;

  const chainId = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID) || net.chainId;
  const rpcEndpoint = process.env.NEXT_PUBLIC_ARC_RPC_ENDPOINT?.trim() || net.rpcEndpoint;
  const explorer = process.env.NEXT_PUBLIC_ARC_EXPLORER?.trim() || net.explorer;
  const usdc = (process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS?.trim() || net.usdc) as `0x${string}`;
  const eurc = (process.env.NEXT_PUBLIC_ARC_EURC_ADDRESS?.trim() || net.eurc) as `0x${string}`;
  const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS?.trim() || '';

  if (!treasuryAddress) {
    console.warn('Missing NEXT_PUBLIC_TREASURY_ADDRESS. Please set it in your .env file.');
  }

  cachedKey = key;
  cachedConfig = {
    ...net,
    chainId,
    rpcEndpoint,
    explorer,
    usdc,
    eurc,
    treasuryAddress,
    assets: {
      USDC: {
        symbol: 'USDC',
        decimals: 6,
        address: usdc,
        logo: '/logos/usdc.png',
      },
      EURC: {
        symbol: 'EURC',
        decimals: 6,
        address: eurc,
        logo: '/logos/eurc.png',
      },
    },
  };
  return cachedConfig;
}

export const ARC_ASSETS: ArcAsset[] = ['USDC', 'EURC'];

export function getAssetConfig(asset: ArcAsset): ArcAssetConfig {
  return getArcConfig().assets[asset];
}

export function explorerTxUrl(hash: string): string {
  const { explorer } = getArcConfig();
  const h = (hash || '').trim();
  return h ? `${explorer}/tx/${h}` : explorer;
}

export function explorerAddressUrl(address: string): string {
  const { explorer } = getArcConfig();
  const a = (address || '').trim();
  return a ? `${explorer}/address/${a}` : explorer;
}
