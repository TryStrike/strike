'use client';

import React, { useCallback, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { useModal } from 'connectkit';
import { useConnect, useConnectors, useSwitchChain } from 'wagmi';
import { useToast } from '@/lib/hooks/useToast';
import { motion, AnimatePresence } from 'framer-motion';
import { CaretRight, ClockCounterClockwise, Fingerprint, Wallet, WarningCircle, X } from '@phosphor-icons/react';
import { PASSKEY_CONNECTOR_ID, passkeySignIn } from '@/lib/wallet/passkey';
import { arcChainLabel, arcTargetChainId } from '@/lib/wallet/arcChain';
import { classifyConnectError, safeConnectErrorMessage } from '@/lib/wallet/connectErrors';
import { connectCopyForError } from '@/lib/wallet/connectMachine';
import { truncateAddress } from '@/lib/wallet/addressDisplay';
import { saveRecentWallets } from '@/lib/wallet/recentWallets';

type IconType = typeof Wallet;

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Working"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-ink/20 border-t-ink"
    />
  );
}

function OptionRow({ icon: Icon, image, title, description, onClick, busy, disabled }: {
    icon: IconType;
    image?: string;
    title: string;
    description: React.ReactNode;
    onClick: () => void;
    busy?: boolean;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-busy={busy || undefined}
            className="group flex w-full items-center gap-4 rounded-2xl bg-white p-4 text-left ring-1 ring-inset ring-line transition-shadow hover:ring-ink disabled:cursor-wait disabled:opacity-50 disabled:hover:ring-line"
        >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface text-ink">
                {busy ? (
                    <Spinner />
                ) : image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image} alt="" className="h-6 w-6" />
                ) : (
                    <Icon size={20} />
                )}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold">{title}</span>
                <span className="mt-0.5 block text-[13px] text-subtle">{description}</span>
            </span>
            <CaretRight size={16} className="shrink-0 text-faint transition-colors group-hover:text-ink" />
        </button>
    );
}

function ErrorPanel() {
    const connectPhase = useStore((s) => s.connectPhase);
    const lastError = useStore((s) => s.lastError);
    const clearLastError = useStore((s) => s.clearLastError);
    const { switchChainAsync } = useSwitchChain();

    if (connectPhase !== 'failed' || !lastError) return null;
    const copy = connectCopyForError(lastError.kind)!;
    const targetChainId = arcTargetChainId();

    return (
        <div role="alert" className="mt-5 rounded-2xl bg-down/5 p-4 ring-1 ring-inset ring-down/20">
            <div className="flex items-start gap-3">
                <WarningCircle size={18} className="mt-0.5 shrink-0 text-down" />
                <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-down">{copy.title}</p>
                    <p className="mt-0.5 text-[13px] text-muted">{copy.hint}</p>
                </div>
                <button
                    type="button"
                    onClick={clearLastError}
                    aria-label="Dismiss error"
                    className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-subtle hover:bg-surface"
                >
                    <X size={14} />
                </button>
            </div>
            {lastError.kind === 'wrong_network' ? (
                <button
                    type="button"
                    onClick={async () => {
                        try {
                            await switchChainAsync({ chainId: targetChainId });
                            clearLastError();
                        } catch (err) {
                            useStore.getState().setLastError({
                                kind: classifyConnectError(err),
                                message: safeConnectErrorMessage(err),
                            });
                        }
                    }}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                >
                    Switch to {arcChainLabel(targetChainId)}
                </button>
            ) : null}
        </div>
    );
}

function RecentWalletRow({ entry }: { entry: { connectorId: string; name: string; address: string } }) {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const connectors = useConnectors();
    const { connectAsync } = useConnect();
    const dispatchConnectEvent = useStore((s) => s.dispatchConnectEvent);
    const recordRecentWallet = useStore((s) => s.recordRecentWallet);
    const setConnectModalOpen = useStore((s) => s.setConnectModalOpen);

    const connector = connectors.find((c) => c.id === entry.connectorId);

    const handleReconnect = useCallback(async () => {
        if (!connector || busy) return;
        setBusy(true);
        dispatchConnectEvent({ type: 'START_RECONNECT' });
        try {
            await connectAsync({ connector });
            dispatchConnectEvent({ type: 'CONNECT_SUCCESS' });
            recordRecentWallet({ connectorId: connector.id, name: connector.name, address: entry.address });
            saveRecentWallets(useStore.getState().recentWallets);
            setConnectModalOpen(false);
        } catch (err) {
            const kind = classifyConnectError(err);
            dispatchConnectEvent({ type: 'RECONNECT_FAILURE', error: kind, message: safeConnectErrorMessage(err) });
            toast.error(connectCopyForError(kind)?.title ?? 'Could not reconnect.');
        } finally {
            setBusy(false);
        }
    }, [connector, busy, dispatchConnectEvent, connectAsync, recordRecentWallet, setConnectModalOpen, entry.address, toast]);

    if (!connector) return null;

    return (
        <OptionRow
            icon={ClockCounterClockwise}
            title={`${entry.name || 'Wallet'} — reconnect`}
            description={<span className="font-jet">{truncateAddress(entry.address)}</span>}
            busy={busy}
            onClick={() => void handleReconnect()}
        />
    );
}

export const WalletConnectModal: React.FC = () => {
    const isOpen = useStore(state => state.isConnectModalOpen);
    const setOpen = useStore(state => state.setConnectModalOpen);
    const { setOpen: openConnectKit } = useModal();
    const recentWallets = useStore((s) => s.recentWallets);
    const dispatchConnectEvent = useStore((s) => s.dispatchConnectEvent);

    const connectors = useConnectors();
    const { connectAsync } = useConnect();
    const toast = useToast();
    const [busy, setBusy] = useState<string | null>(null);

    const metaMask = connectors.find((c) => c.id === 'io.metamask') ?? connectors.find((c) => c.id === 'metaMask');
    const coinbase =
        connectors.find((c) => c.id === 'com.coinbase.wallet') ?? connectors.find((c) => c.id === 'coinbaseWalletSDK');

    const attempt = useRef(0);
    const run = async (key: string, failure: string, connect: () => Promise<unknown>) => {
        const id = ++attempt.current;
        setBusy(key);
        dispatchConnectEvent({ type: 'RESET' });
        dispatchConnectEvent({ type: 'START_CONNECT' });
        try {
            await connect();
            if (id !== attempt.current) return;
            dispatchConnectEvent({ type: 'CONNECT_SUCCESS' });
            setOpen(false);
        } catch (err) {
            if (id !== attempt.current) return;
            const kind = classifyConnectError(err);
            dispatchConnectEvent({ type: 'CONNECT_FAILURE', error: kind, message: safeConnectErrorMessage(err) });
            console.error(`[connect] ${key} failed`, err);
            toast.error(connectCopyForError(kind)?.title ?? failure);
        } finally {
            if (id === attempt.current) setBusy(null);
        }
    };

    const connectWith = (key: string, name: string, connector: (typeof connectors)[number] | undefined) =>
        run(key, `Could not connect ${name}.`, async () => {
            if (!connector) throw new Error(`${name} connector missing`);
            if (key === 'metamask' && !(await connector.getProvider())) {
                // No MetaMask, but Brave Wallet, Rabby and the like inject window.ethereum: use that.
                const browserWallet = connectors.find((c) => c.id === 'injected');
                if (browserWallet && (await browserWallet.getProvider())) {
                    await connectAsync({ connector: browserWallet });
                    return;
                }
                window.open('https://metamask.io/download/', '_blank', 'noopener,noreferrer');
                throw new Error('MetaMask is not installed in this browser');
            }
            await connectAsync({ connector });
        });

    const handlePasskey = (mode: 'register' | 'login') =>
        run(mode, mode === 'register' ? 'Could not create the passkey.' : 'Could not sign in with your passkey.', async () => {
            const connector = connectors.find((c) => c.id === PASSKEY_CONNECTOR_ID);
            if (!connector) throw new Error('passkey connector missing');
            await passkeySignIn(mode);
            await connectAsync({ connector });
        });

    const handleArcConnect = () => {
        attempt.current++;
        setBusy(null);
        dispatchConnectEvent({ type: 'RESET' });
        openConnectKit(true);
        setOpen(false);
    };

    return (
        <>
        {!isOpen ? null : (
        <AnimatePresence>
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setOpen(false)}
                    className="absolute inset-0 bg-ink/20 backdrop-blur-sm"
                />

                <motion.div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Connect"
                    initial={{ opacity: 0, scale: 0.97, y: 12 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97, y: 12 }}
                    className="relative max-h-[90vh] w-full max-w-[420px] overflow-y-auto rounded-[28px] bg-white p-7 font-tight text-ink ring-1 ring-line shadow-[0_40px_80px_-40px_rgba(10,12,16,0.35)]"
                >
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <h2 className="text-[22px] font-semibold tracking-tight">Connect</h2>
                            <p className="mt-1 text-[15px] text-muted">Trade with USDC on Arc.</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            aria-label="Close"
                            className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:bg-surface hover:text-ink"
                        >
                            <X size={18} />
                        </button>
                    </div>

                    <div className="mt-7 space-y-3">
                        {recentWallets.length > 0 ? (
                            <>
                                {recentWallets.map((entry) => (
                                    <RecentWalletRow key={`${entry.connectorId}:${entry.address.toLowerCase()}`} entry={entry} />
                                ))}
                                <div className="mx-auto my-1 h-px w-16 bg-line" aria-hidden="true" />
                            </>
                        ) : null}
                        <OptionRow
                            icon={Wallet}
                            image={metaMask?.icon}
                            title="MetaMask"
                            description={`Connect on ${arcChainLabel(arcTargetChainId())}. We add the network for you.`}
                            busy={busy === 'metamask'}
                            onClick={() => void connectWith('metamask', 'MetaMask', metaMask)}
                        />
                        <OptionRow
                            icon={Wallet}
                            image={coinbase?.icon}
                            title="Coinbase Wallet"
                            description="Extension or the Coinbase Wallet app."
                            busy={busy === 'coinbase'}
                            onClick={() => void connectWith('coinbase', 'Coinbase Wallet', coinbase)}
                        />
                        <OptionRow
                            icon={Wallet}
                            title="Other wallets"
                            description="Rabby, Rainbow, WalletConnect and more."
                            onClick={handleArcConnect}
                        />
                        <div className="flex items-center gap-3 pt-2 text-[12px] text-faint">
                            <span className="h-px flex-1 bg-line" />
                            No wallet? Use a passkey
                            <span className="h-px flex-1 bg-line" />
                        </div>
                        <OptionRow
                            icon={Fingerprint}
                            title="Create passkey account"
                            description="Touch ID or Face ID. No wallet app, no gas."
                            busy={busy === 'register'}
                            onClick={() => void handlePasskey('register')}
                        />
                        <OptionRow
                            icon={Fingerprint}
                            title="Use my passkey"
                            description="Sign back in on this device."
                            busy={busy === 'login'}
                            onClick={() => void handlePasskey('login')}
                        />
                    </div>

                    <ErrorPanel />

                    <p className="mt-5 text-[12px] leading-relaxed text-faint">
                        We never store your wallet address beyond this browser tab.
                    </p>
                </motion.div>
            </div>
        </AnimatePresence>
        )}
        </>
    );
};
