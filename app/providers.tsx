'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { WagmiProvider, useAccount, useSwitchChain } from 'wagmi';
import { ConnectKitProvider } from 'connectkit';
import { config as wagmiConfig, arc } from '@/lib/arc/wagmi';
import { PrivyEnabledContext } from '@/lib/wallet/privy-enabled';

// Custom Components
import { WalletConnectModal } from '@/components/wallet/WalletConnectModal';
import { ReferralSync } from './ReferralSync';
import type { AssetType } from '@/lib/utils/priceFeed';
import { useSessionTracker } from '@/hooks/useSessionTracker';

// Bridges the connected wallet into the Zustand store. Arc is the only
// network, so this reduces to: adopt the wagmi (or Privy embedded) address,
// make sure the wallet is on the right chain, and load the balances.
function WalletSyncWithPrivy() {
  const { authenticated, ready: privyReady } = usePrivy();
  const { wallets: privyWallets } = useWallets();
  return (
    <WalletSyncCore
      privyReady={privyReady}
      authenticated={authenticated}
      privyWallets={privyWallets}
    />
  );
}

function WalletSync() {
  return (
    <WalletSyncCore
      privyReady={true}
      authenticated={false}
      privyWallets={[]}
    />
  );
}

function WalletSyncCore({
  privyReady,
  authenticated,
  privyWallets,
}: {
  privyReady: boolean;
  authenticated: boolean;
  privyWallets: { address: string }[];
}) {
  const { address: wagmiAddress, isConnected: wagmiConnected, chainId: wagmiChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  const {
    address,
    isConnected: storeIsConnected,
    network: storeNetwork,
    accountType,
    setAddress,
    setIsConnected,
    setNetwork,
    refreshWalletBalance,
    fetchBalance,
    fetchProfile,
  } = useStore(useShallow((s) => ({ address: s.address, isConnected: s.isConnected, network: s.network, accountType: s.accountType, setAddress: s.setAddress, setIsConnected: s.setIsConnected, setNetwork: s.setNetwork, refreshWalletBalance: s.refreshWalletBalance, fetchBalance: s.fetchBalance, fetchProfile: s.fetchProfile })));

  // Track session dwell time for this wallet
  useSessionTracker(address, storeNetwork);

  // The connected address: a wagmi wallet, or Privy's embedded one.
  const connectedAddress = useMemo(() => {
    if (wagmiConnected && wagmiAddress) return wagmiAddress;
    if (authenticated && privyWallets.length > 0) return privyWallets[0].address;
    return null;
  }, [wagmiConnected, wagmiAddress, authenticated, privyWallets]);

  // Put the wallet on Arc as soon as it connects. The old version called
  // the non-async switchChain inside a try/catch, which cannot catch the
  // promise rejection, so a declined or failed switch passed silently and the
  // wallet stayed on whatever network it arrived with.
  useEffect(() => {
    if (!wagmiConnected || wagmiChainId === arc.id || !switchChainAsync) return;
    let cancelled = false;
    switchChainAsync({ chainId: arc.id }).catch((err: unknown) => {
      if (cancelled) return;
      console.warn(
        `Wallet stayed on chain ${wagmiChainId}; Arc is ${arc.id}.`,
        (err as Error)?.message
      );
    });
    return () => {
      cancelled = true;
    };
  }, [wagmiConnected, wagmiChainId, switchChainAsync]);

  useEffect(() => {
    // Demo accounts carry a synthetic address; leave them alone.
    if (accountType === 'demo') return;
    if (!privyReady && !wagmiConnected) return;

    if (connectedAddress) {
      if (address !== connectedAddress || !storeIsConnected || storeNetwork !== 'ARC') {
        setAddress(connectedAddress);
        setIsConnected(true);
        setNetwork('ARC');
        void refreshWalletBalance();
        void fetchBalance(connectedAddress);
        void fetchProfile(connectedAddress);
      }
      return;
    }

    if (address !== null) {
      setAddress(null);
      setIsConnected(false);
      setNetwork(null);
    }
  }, [
    connectedAddress,
    privyReady,
    wagmiConnected,
    address,
    accountType,
    storeIsConnected,
    storeNetwork,
    setAddress,
    setIsConnected,
    setNetwork,
    refreshWalletBalance,
    fetchBalance,
    fetchProfile,
  ]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => {
    let cancelled = false;
    let stopPriceFeed: (() => void) | undefined;

    const initializeApp = async () => {
      try {
        const { updateAllPrices, startGlobalPriceFeed } = useStore.getState();

        if (cancelled) return;

        // Seed a faster default asset for the chart.
        // We try a small set in parallel and pick the first one that returns a valid price.
        // This helps avoid long "Connecting to price feeds..." delays when some feeds are slower.
        try {
          const { fetchPrice } = await import('@/lib/utils/priceFeed');
          const store = useStore.getState();

          const candidates: AssetType[] = ['BTC', 'ETH', 'SOL', 'SUI', 'BNB'];

          const seeded = await Promise.any(
            candidates.map(async (asset) => {
              const p = await fetchPrice(asset);
              if (p?.price && p.price > 0) return { asset, price: p.price };
              throw new Error('No valid price');
            })
          );

          if (cancelled) return;

          store.setSelectedAsset(seeded.asset);
          // Seed at least 2 points so LiveChart can render quickly.
          store.updatePrice(seeded.price, seeded.asset);
          store.updatePrice(seeded.price, seeded.asset);
        } catch (e) {
          // Non-fatal: we'll still start the global feed and show the default chart.
        }

        if (cancelled) return;

        stopPriceFeed = startGlobalPriceFeed(updateAllPrices);
        if (cancelled) {
          stopPriceFeed();
          stopPriceFeed = undefined;
          return;
        }

        const { ensureBalanceSession } = await import('@/lib/balance/balanceClientHeaders');
        await ensureBalanceSession().catch(() => {});

        if (cancelled) return;
        setIsReady(true);
      } catch (error) {
        console.error('Error initializing app:', error);
        if (!cancelled) setIsReady(true);
      }
    };

    void initializeApp();

    return () => {
      cancelled = true;
      stopPriceFeed?.();
    };
  }, []);

  if (!isReady) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
      </div>
    );
  }

  const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() || '';

  // The app tree is identical either way; only the optional Privy wrapper
  // differs, so it lives in one place.
  const app = (privyEnabled: boolean) => (
    <PrivyEnabledContext.Provider value={privyEnabled}>
      {privyEnabled ? <WalletSyncWithPrivy /> : <WalletSync />}
      <ReferralSync />
      {children}
      <WalletConnectModal />
      <ToastProvider />
    </PrivyEnabledContext.Provider>
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider mode="light" customTheme={{ "--ck-font-family": "var(--font-inter-tight), system-ui, sans-serif", "--ck-accent-color": "#2151F5", "--ck-border-radius": "20px" }}>
          {/* Privy is the optional email/social login. Mounting it without an
              app id throws and takes the whole page down, so when it is not
              configured we fall through to ConnectKit, which is the primary
              wallet path either way. Privy hooks must not run in that case. */}
          {PRIVY_APP_ID ? (
            <PrivyProvider
              appId={PRIVY_APP_ID}
              config={{
                appearance: {
                  theme: 'light',
                  accentColor: '#2151F5',
                  showWalletLoginFirst: true,
                },
                supportedChains: [arc],
                defaultChain: arc,
                embeddedWallets: {
                  createOnLogin: 'users-without-wallets',
                },
              }}
            >
              {app(true)}
            </PrivyProvider>
          ) : (
            app(false)
          )}
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
