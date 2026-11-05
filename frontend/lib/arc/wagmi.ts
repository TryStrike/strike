import { getDefaultConfig } from 'connectkit';
import { createConfig, http } from 'wagmi';
import { defineChain } from 'viem';
import { getArcConfig } from './config';
import { BRAND } from '@/lib/brand';

const arcConfig = getArcConfig();

/** Arc — the only network this platform settles on. */
export const arc = defineChain({
  id: arcConfig.chainId,
  name: arcConfig.name,
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [arcConfig.rpcEndpoint] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: arcConfig.explorer },
  },
});

export const config = createConfig(
  getDefaultConfig({
    chains: [arc],
    transports: {
      [arc.id]: http(arcConfig.rpcEndpoint),
    },


    // Required API Keys
    walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'dummy-id',

    // Required App Info
    appName: BRAND.name,

    // Optional App Info
    appDescription: BRAND.tagline,
    appUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
    appIcon: typeof window !== 'undefined' ? `${window.location.origin}/favicon.ico` : '/favicon.ico',
  })
);
