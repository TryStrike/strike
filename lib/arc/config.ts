/** Arc mainnet configuration. */

export type ArcAsset = 'USDC';

interface ArcAssetConfig {
  symbol: ArcAsset;
  decimals: number;
  /** Null while the Arc USDC contract address has not been supplied. */
  address: `0x${string}` | null;
  isNative: boolean;
  logo: string;
}

interface NetworkConfig {
  chainId: number;
  name: string;
  rpcEndpoint: string;
  explorer: string;
  usdc: `0x${string}` | null;
}

const ARC_DEFAULTS: NetworkConfig = {
  chainId: 5042,
  name: 'Arc',
  rpcEndpoint: 'https://rpc.mainnet.arc.io',
  explorer: 'https://explorer.arc.io',
  usdc: null,
};

interface ArcConfig extends NetworkConfig {
  treasuryAddress: string;
  assets: Record<ArcAsset, ArcAssetConfig>;
}

export function getArcConfig(): ArcConfig {
  const net = ARC_DEFAULTS;

  const chainId = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID) || net.chainId;
  const rpcEndpoint = process.env.NEXT_PUBLIC_ARC_RPC_ENDPOINT?.trim() || net.rpcEndpoint;
  const explorer = process.env.NEXT_PUBLIC_ARC_EXPLORER?.trim() || net.explorer;
  const usdc = (process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS?.trim() || net.usdc) as `0x${string}` | null;
  const treasuryAddress = process.env.NEXT_PUBLIC_TREASURY_ADDRESS?.trim() || '';

  if (!treasuryAddress) {
    console.warn('Missing NEXT_PUBLIC_TREASURY_ADDRESS. Please set it in your .env file.');
  }

  return {
    ...net,
    chainId,
    rpcEndpoint,
    explorer,
    usdc,
    treasuryAddress,
    assets: {
      USDC: {
        symbol: 'USDC',
        decimals: 6,
        address: usdc,
        isNative: true,
        logo: '/logos/usdc.png',
      },
    },
  };
}

export const ARC_ASSETS: ArcAsset[] = ['USDC'];

export function isArcAsset(value: string): value is ArcAsset {
  return (ARC_ASSETS as string[]).includes(value.toUpperCase());
}

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
