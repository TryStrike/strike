import { getDefaultConfig } from 'connectkit';
import { createConfig, http } from 'wagmi';
import { defineChain } from 'viem';
import { baseSepolia } from 'viem/chains';
import { getArcConfig } from './config';
import { BRAND } from '@/lib/brand';
import { passkeyConnector } from '@/lib/wallet/passkey';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';

const arcConfig = getArcConfig();

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

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';
const app = {
  name: BRAND.name,
  description: BRAND.tagline,
  url: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
  icons: [typeof window !== 'undefined' ? `${window.location.origin}/icon.svg` : '/icon.svg'],
};

export const config = createConfig(
  getDefaultConfig({
    chains: [arc, baseSepolia],
    transports: {
      [arc.id]: http(arcConfig.rpcEndpoint),
      [baseSepolia.id]: http(),
    },
    enableAaveAccount: false,
    walletConnectProjectId,
    appName: app.name,
    appDescription: app.description,
    appUrl: app.url,
    appIcon: app.icons[0],
    connectors: [
      passkeyConnector,
      injected({ target: 'metaMask' }),
      // eoaOnly: Coinbase's smart wallet does not serve Arc, the extension and app do.
      coinbaseWallet({ appName: app.name, appLogoUrl: app.icons[0], preference: { options: 'eoaOnly' } }),
      injected(),
      ...(walletConnectProjectId ? [walletConnect({ projectId: walletConnectProjectId, metadata: app, showQrModal: false })] : []),
    ],
  }),
);
