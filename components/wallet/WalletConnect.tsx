'use client';

import React from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { SignOut, Wallet } from '@phosphor-icons/react';
import { useDisconnect as useWagmiDisconnect } from 'wagmi';
import { usePrivyEnabled } from '@/lib/wallet/privy-enabled';

function WalletConnectButton({
  ready,
  logoutPrivy,
}: {
  ready: boolean;
  logoutPrivy?: () => void;
}) {
  const { disconnect: wagmiDisconnect } = useWagmiDisconnect();
  const { address, setConnectModalOpen, disconnect: disconnectStore } = useStore(useShallow((s) => ({ address: s.address, setConnectModalOpen: s.setConnectModalOpen, disconnect: s.disconnect })));

  const handleDisconnect = () => {
    logoutPrivy?.();
    wagmiDisconnect();
    disconnectStore();
  };

  const isConnected = !!address;

  if (!ready) {
    return <div className="h-9 w-32 animate-pulse rounded-full bg-surface" />;
  }

  if (!isConnected) {
    return (
      <button
        type="button"
        onClick={() => setConnectModalOpen(true)}
        data-tour="connect-button"
        className="inline-flex h-9 items-center gap-2 rounded-full bg-ink px-4 font-tight text-sm font-semibold text-white transition-colors hover:bg-up"
      >
        <Wallet size={16} />
        Connect wallet
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 font-tight">
      <span className="inline-flex h-9 items-center gap-2 rounded-full bg-surface px-3.5 font-jet text-[13px] text-ink">
        <span className="h-1.5 w-1.5 rounded-full bg-up" aria-hidden="true" />
        {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '…'}
      </span>
      <button
        type="button"
        onClick={handleDisconnect}
        aria-label="Disconnect wallet"
        title="Disconnect"
        className="grid h-9 w-9 place-items-center rounded-full text-subtle transition-colors hover:bg-surface hover:text-down"
      >
        <SignOut size={16} />
      </button>
    </div>
  );
}

function WalletConnectWithPrivy() {
  const { logout, ready } = usePrivy();
  return <WalletConnectButton ready={ready} logoutPrivy={logout} />;
}

export const WalletConnect: React.FC = () => {
  const privyEnabled = usePrivyEnabled();
  if (!privyEnabled) {
    return <WalletConnectButton ready />;
  }
  return <WalletConnectWithPrivy />;
};
