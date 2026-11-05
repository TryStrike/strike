'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';
import { Check, CopySimple, SignOut, Wallet } from '@phosphor-icons/react';
import { glassPrimary } from '@/components/ui/kit';
import { useAccount, useDisconnect as useWagmiDisconnect, useEnsName, useSwitchChain } from 'wagmi';
import { usePrivyEnabled } from '@/lib/wallet/privy-enabled';
import { arcChainLabel, arcTargetChainId } from '@/lib/wallet/arcChain';
import { classifyConnectError, safeConnectErrorMessage } from '@/lib/wallet/connectErrors';
import { isConnectingPhase } from '@/lib/wallet/connectMachine';
import { copyTextToClipboard, displayNameForWallet, truncateAddress } from '@/lib/wallet/addressDisplay';
import { loadRecentWallets, saveRecentWallets } from '@/lib/wallet/recentWallets';

/**
 * A connect attempt with no provider answer for this long is abandoned: the
 * user closed the wallet popup, dismissed ConnectKit, or walked away. The
 * watchdog clears the spinner; a late success still resolves to `authed`
 * because the state machine allows failed -> CONNECT_SUCCESS.
 */
const CONNECT_TIMEOUT_MS = 60_000;
/** Allow re-opening the picker mid-"connecting" once an attempt looks stale. */
const STALE_CONNECT_MS = 8_000;

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Connecting"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
    />
  );
}

function WalletConnectButton({
  ready,
  privyLabel,
  logoutPrivy,
}: {
  ready: boolean;
  /** Email/username from a Privy session, used as a human label when set. */
  privyLabel?: string | null;
  logoutPrivy?: () => void;
}) {
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

  // Hydrate recent wallets from sessionStorage (client-only, dies with the tab).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const stored = loadRecentWallets();
    if (stored.length > 0) setRecentWallets(stored);
  }, [setRecentWallets]);

  // Resolve success from the single source of truth (store address,
  // set by WalletSync for both wagmi and Privy-embedded wallets). Also
  // adopts an already-restored session on mount (idle -> authed).
  useEffect(() => {
    if (address && connectPhase !== 'authed') {
      dispatchConnectEvent({ type: 'CONNECT_SUCCESS' });
    }
  }, [address, connectPhase, dispatchConnectEvent]);

  // Remember the wallet for one-tap reconnect (wagmi path only — embedded
  // Privy sessions have no connector to re-open).
  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wagmiConnected || !wagmiAddress || !connector) return;
    const key = `${connector.id}:${wagmiAddress.toLowerCase()}`;
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    recordRecentWallet({ connectorId: connector.id, name: connector.name, address: wagmiAddress });
    saveRecentWallets(useStore.getState().recentWallets);
  }, [wagmiConnected, wagmiAddress, connector, recordRecentWallet]);

  // Wallet (or Privy) ended an authed session -> disconnected.
  useEffect(() => {
    if (connectPhase === 'authed' && !address) {
      dispatchConnectEvent({ type: 'DISCONNECT' });
    }
  }, [connectPhase, address, dispatchConnectEvent]);

  // Watchdog: a prompt that never resolves must not pin the spinner forever.
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

  // ENS when the connected chain actually ships an ENS registry; elsewhere
  // (Arc has no ENS contracts) the label falls through to Privy/connector.
  const ensEnabled = wagmiConnected && (chainId === 1 || chainId === 5 || chainId === 11155111);
  const { data: ensName } = useEnsName({ address: wagmiAddress, query: { enabled: ensEnabled } });

  const isConnected = !!address;
  const pending = isConnectingPhase(connectPhase);
  const stalePending = pending && connectingSince !== null && Date.now() - connectingSince > STALE_CONNECT_MS;

  const handleDisconnect = () => {
    logoutPrivy?.();
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

  if (!ready) {
    return <div className="h-9 w-32 animate-pulse rounded-full bg-surface" />;
  }

  if (!isConnected) {
    const disabled = pending && !stalePending;
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (pending && !stalePending) return; // double-click guard against stacked prompts
            // The modal's option rows start the connect: dispatching here would
            // disable them, leaving the modal with nothing clickable.
            setConnectModalOpen(true);
          }}
          disabled={disabled}
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
    ens: ensName,
    label: privyLabel,
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
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={copied ? 'Address copied' : 'Copy wallet address'}
        title={address}
        className="inline-flex h-9 max-w-[260px] items-center gap-2 rounded-full bg-surface px-3.5 font-jet text-[13px] text-ink transition-colors hover:bg-line"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${wrongNetwork ? 'bg-down' : 'bg-up'}`} aria-hidden="true" />
        <span className="truncate">{label || truncateAddress(address)}</span>
        {copied ? <Check size={14} className="shrink-0 text-up" /> : <CopySimple size={14} className="shrink-0 text-subtle" />}
      </button>
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

/** Compact one-liners for the nav; full sentences live in the modal. */
const ERROR_SUMMARY: Record<string, string> = {
  rejected: 'Connection declined',
  no_provider: 'No wallet found',
  locked: 'Wallet is locked',
  wrong_network: 'Wrong network',
  timeout: 'Connection timed out',
  unknown: 'Connection failed',
};

function WalletConnectWithPrivy() {
  const { logout, ready, authenticated, user } = usePrivy();
  const optionalUsername = (user as { username?: string } | null)?.username;
  const privyLabel = authenticated ? (user?.email?.address ?? optionalUsername ?? null) : null;
  return <WalletConnectButton ready={ready} privyLabel={privyLabel} logoutPrivy={logout} />;
}

export const WalletConnect: React.FC = () => {
  const privyEnabled = usePrivyEnabled();
  if (!privyEnabled) {
    return <WalletConnectButton ready />;
  }
  return <WalletConnectWithPrivy />;
}
