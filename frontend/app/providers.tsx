'use client';

import React, { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useSwitchChain } from 'wagmi';
import { ConnectKitProvider } from 'connectkit';
import { config as wagmiConfig, arc } from '@/lib/arc/wagmi';

// Custom Components
import { WalletConnectModal } from '@/components/wallet/WalletConnectModal';
import { ReferralSync } from './ReferralSync';
import { useSessionTracker } from '@/lib/hooks/useSessionTracker';
import { useThemeSync } from '@/lib/useTheme';

// Bridges the connected wallet into the Zustand store: adopt the wagmi address,
// put the wallet on Arc, and load the balances.
function WalletSync() {
  const { address: wagmiAddress, isConnected: wagmiConnected, chainId: wagmiChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  const {
    address,
    isConnected: storeIsConnected,
    network: storeNetwork,
    setAddress,
    setIsConnected,
    setNetwork,
    refreshWalletBalance,
    fetchBalance,
  } = useStore(useShallow((s) => ({ address: s.address, isConnected: s.isConnected, network: s.network, setAddress: s.setAddress, setIsConnected: s.setIsConnected, setNetwork: s.setNetwork, refreshWalletBalance: s.refreshWalletBalance, fetchBalance: s.fetchBalance })));

  // Track session dwell time for this wallet
  useSessionTracker(address, storeNetwork);

  const connectedAddress = wagmiConnected && wagmiAddress ? wagmiAddress : null;

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
    if (connectedAddress) {
      if (address !== connectedAddress || !storeIsConnected || storeNetwork !== 'ARC') {
        setAddress(connectedAddress);
        setIsConnected(true);
        setNetwork('ARC');
        void refreshWalletBalance();
        void fetchBalance(connectedAddress);
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
    address,
    storeIsConnected,
    storeNetwork,
    setAddress,
    setIsConnected,
    setNetwork,
    refreshWalletBalance,
    fetchBalance,
  ]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  useThemeSync();

  // Prices and the balance session warm up in the background. Nothing waits on them.
  useEffect(() => {
    const store = useStore.getState();
    const stopPriceFeed = store.startGlobalPriceFeed(store.updateAllPrices);
    void import('@/lib/balance/balanceClientHeaders').then(({ ensureBalanceSession }) => ensureBalanceSession());
    return stopPriceFeed;
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider mode="light" customTheme={{ "--ck-font-family": "var(--font-inter-tight), system-ui, sans-serif", "--ck-accent-color": "#2151F5", "--ck-border-radius": "20px" }}>
          <WalletSync />
          <ReferralSync />
          {children}
          <WalletConnectModal />
          <ToastProvider />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
