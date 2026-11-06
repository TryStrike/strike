'use client';

import React, { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useSwitchChain } from 'wagmi';
import { ConnectKitProvider } from 'connectkit';
import { config as wagmiConfig, arc } from '@/lib/arc/wagmi';

import { WalletConnectModal } from '@/components/wallet/WalletConnectModal';
import { WorldGate } from '@/components/world/WorldGate';
import { useSessionTracker } from '@/lib/hooks/useSessionTracker';
import { useThemeSync } from '@/lib/useTheme';
import { usePriceStream } from '@/lib/hooks/usePriceStream';
import { bridging } from '@/lib/bridge/bridging';

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

  useSessionTracker(address, storeNetwork);

  const connectedAddress = wagmiConnected && wagmiAddress ? wagmiAddress : null;

  useEffect(() => {
    if (!wagmiConnected || wagmiChainId === arc.id || !switchChainAsync || bridging.get()) return;
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
        void import('@/lib/balance/balanceClientHeaders')
          .then(({ ensureBalanceSession }) => ensureBalanceSession())
          .catch((err) => console.error('[session] wallet sign-in failed', err));
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

  const updateAllPrices = useStore((s) => s.updateAllPrices);
  const setMaxBands = useStore((s) => s.setMaxBands);
  const setClosedAssets = useStore((s) => s.setClosedAssets);
  const seedHistory = useStore((s) => s.seedHistory);
  const setMarketState = useStore((s) => s.setMarketState);
  const refreshBlitzPass = useStore((s) => s.refreshBlitzPass);
  const passWallet = useStore((s) => s.address);
  const blitzStart = useStore((s) => s.blitz?.startsAt);
  const feed = usePriceStream(updateAllPrices, {
    onBands: setMaxBands,
    onClosed: setClosedAssets,
    onHistory: seedHistory,
    onMarket: setMarketState,
  });
  useEffect(() => {
    // Until the first market event arrives over the stream.
    fetch('/api/market/state')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => m && !useStore.getState().blitz && setMarketState(m))
      .catch(() => {});
  }, [setMarketState]);
  useEffect(() => {
    void refreshBlitzPass();
  }, [refreshBlitzPass, passWallet, blitzStart]);
  useEffect(() => {
    useStore.getState().setPriceFeed(feed);
  }, [feed.mode, feed.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider mode="light" customTheme={{ "--ck-font-family": "var(--font-inter-tight), system-ui, sans-serif", "--ck-accent-color": "#2151F5", "--ck-border-radius": "20px" }}>
          <WalletSync />
          {children}
          <WalletConnectModal />
          <WorldGate />
          <ToastProvider />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
