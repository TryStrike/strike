'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useStore, useHouseBalance } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { CaretDown, Check, CopySimple, SignOut, Wallet } from '@phosphor-icons/react';
import { glassPrimary } from '@/components/ui/kit';
import { useAccount, useDisconnect as useWagmiDisconnect, useSwitchChain } from 'wagmi';
import { arcChainLabel, arcTargetChainId } from '@/lib/wallet/arcChain';
import { classifyConnectError, safeConnectErrorMessage } from '@/lib/wallet/connectErrors';
import { isConnectingPhase } from '@/lib/wallet/connectMachine';
import { copyTextToClipboard, displayNameForWallet, truncateAddress } from '@/lib/wallet/addressDisplay';
import { loadRecentWallets, saveRecentWallets } from '@/lib/wallet/recentWallets';

const CONNECT_TIMEOUT_MS = 60_000;

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Connecting"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
    />
  );
}

export const WalletConnect: React.FC = () => {
  const { address: wagmiAddress, connector, isConnected: wagmiConnected, chainId } = useAccount();
  const { disconnect: wagmiDisconnect } = useWagmiDisconnect();
  const { switchChainAsync } = useSwitchChain();

  const {
    address,
    connectPhase,
    lastError,
    connectingSince,
    setConnectModalOpen,
    disconnect: disconnectStore,
    dispatchConnectEvent,
    recordRecentWallet,
    setRecentWallets,
    setLastError,
  } = useStore(
    useShallow((s) => ({
      address: s.address,
      connectPhase: s.connectPhase,
      lastError: s.lastError,
      connectingSince: s.connectingSince,
      setConnectModalOpen: s.setConnectModalOpen,
      disconnect: s.disconnect,
      dispatchConnectEvent: s.dispatchConnectEvent,
      recordRecentWallet: s.recordRecentWallet,
      setRecentWallets: s.setRecentWallets,
      setLastError: s.setLastError,
    })),
  );

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const stored = loadRecentWallets();
    if (stored.length > 0) setRecentWallets(stored);
  }, [setRecentWallets]);

  useEffect(() => {
    if (address && connectPhase !== 'authed') {
      dispatchConnectEvent({ type: 'CONNECT_SUCCESS' });
    }
  }, [address, connectPhase, dispatchConnectEvent]);

  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wagmiConnected || !wagmiAddress || !connector) return;
    const key = `${connector.id}:${wagmiAddress.toLowerCase()}`;
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    recordRecentWallet({ connectorId: connector.id, name: connector.name, address: wagmiAddress });
    saveRecentWallets(useStore.getState().recentWallets);
  }, [wagmiConnected, wagmiAddress, connector, recordRecentWallet]);

  useEffect(() => {
    if (connectPhase === 'authed' && !address) {
      dispatchConnectEvent({ type: 'DISCONNECT' });
    }
  }, [connectPhase, address, dispatchConnectEvent]);

  useEffect(() => {
    if (!isConnectingPhase(connectPhase) || connectingSince === null) return;
    const remaining = CONNECT_TIMEOUT_MS - (Date.now() - connectingSince);
    const t = setTimeout(() => {
      if (isConnectingPhase(useStore.getState().connectPhase)) {
        dispatchConnectEvent({ type: 'CONNECT_FAILURE', error: 'timeout' });
      }
    }, Math.max(0, remaining));
    return () => clearTimeout(t);
  }, [connectPhase, connectingSince, dispatchConnectEvent]);

  const targetChainId = arcTargetChainId();
  const wrongNetwork = wagmiConnected && chainId != null && chainId !== targetChainId;


  const isConnected = !!address;
  const pending = isConnectingPhase(connectPhase);

  const handleDisconnect = () => {
    wagmiDisconnect();
    disconnectStore();
    dispatchConnectEvent({ type: 'DISCONNECT' });
  };

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    if (!address) return;
    const ok = await copyTextToClipboard(address);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }
  }, [address]);

  const handleSwitch = useCallback(async () => {
    try {
      await switchChainAsync({ chainId: targetChainId });
    } catch (err) {
      const kind = classifyConnectError(err);
      setLastError({ kind, message: safeConnectErrorMessage(err) });
    }
  }, [switchChainAsync, targetChainId, setLastError]);

  if (!isConnected) {
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (pending) dispatchConnectEvent({ type: 'RESET' });
            setConnectModalOpen(true);
          }}
          data-tour="connect-button"
          aria-busy={pending}
          className={`inline-flex h-9 items-center gap-2 rounded-full px-4 font-tight text-sm font-semibold ${glassPrimary} disabled:cursor-wait disabled:opacity-70`}
        >
          {pending ? <Spinner /> : <Wallet size={16} />}
          {pending ? 'Connecting…' : connectPhase === 'failed' && lastError ? 'Try again' : 'Connect wallet'}
        </button>
        {connectPhase === 'failed' && lastError ? (
          <span
            role="status"
            title={lastError.message || undefined}
            className="max-w-[220px] truncate font-tight text-xs text-down"
          >
            {ERROR_SUMMARY[lastError.kind]}
          </span>
        ) : null}
      </div>
    );
  }

  const label = displayNameForWallet({
    address: wagmiAddress ?? address,
  });

  return (
    <div className="flex items-center gap-1 font-tight">
      {wrongNetwork ? (
        <button
          type="button"
          onClick={() => void handleSwitch()}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-down/10 px-3 font-jet text-[12px] font-semibold text-down ring-1 ring-inset ring-down/30 transition-colors hover:bg-down/20"
        >
          Switch to {arcChainLabel(targetChainId)}
        </button>
      ) : null}
      <AccountMenu
        label={label || truncateAddress(address)}
        address={address}
        wrongNetwork={wrongNetwork}
        copied={copied}
        onCopy={() => void handleCopy()}
        onDisconnect={handleDisconnect}
      />
    </div>
  );
}

const MENU_LINKS = [
  ['/history', 'History'],
  ['/withdrawals', 'Withdrawals'],
] as const;

function AccountMenu({
  label,
  address,
  wrongNetwork,
  copied,
  onCopy,
  onDisconnect,
}: {
  label: string;
  address: string;
  wrongNetwork: boolean;
  copied: boolean;
  onCopy: () => void;
  onDisconnect: () => void;
}) {
  const balance = useHouseBalance();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = 'flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-ink';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-9 max-w-[260px] items-center gap-2 rounded-full bg-surface px-3.5 font-jet text-[13px] text-ink"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${wrongNetwork ? 'bg-down' : 'bg-up'}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
        <CaretDown size={12} className="shrink-0 text-subtle" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-60 rounded-2xl bg-white p-1.5 font-tight shadow-[0_20px_40px_-16px_rgba(10,12,16,0.25)] ring-1 ring-ink/[0.08]"
        >
          <div className="px-3 pb-2 pt-1.5">
            <p className="font-jet text-[11px] uppercase tracking-[0.14em] text-faint">Balance</p>
            <p className="font-jet text-lg font-semibold tabular-nums">{balance.toFixed(2)} USDC</p>
          </div>
          <button type="button" role="menuitem" onClick={onCopy} title={address} className={item}>
            <span className="truncate font-jet text-[13px]">{truncateAddress(address)}</span>
            {copied ? <Check size={14} className="text-up" /> : <CopySimple size={14} className="text-subtle" />}
          </button>
          <div className="my-1 h-px bg-line" />
          {MENU_LINKS.map(([href, text]) => (
            <Link key={href} href={href} role="menuitem" onClick={() => setOpen(false)} className={item}>
              {text}
            </Link>
          ))}
          <div className="my-1 h-px bg-line" />
          <button type="button" role="menuitem" onClick={onDisconnect} className={`${item} text-down`}>
            Disconnect
            <SignOut size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

const ERROR_SUMMARY: Record<string, string> = {
  rejected: 'Connection declined',
  no_provider: 'No wallet found',
  locked: 'Wallet is locked',
  wrong_network: 'Wrong network',
  timeout: 'Connection timed out',
  unknown: 'Connection failed',
};
