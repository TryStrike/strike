'use client';

import React from 'react';
import { useStore } from '@/lib/store';
import { usePrivy } from '@privy-io/react-auth';
import { useModal } from 'connectkit';
import { motion, AnimatePresence } from 'framer-motion';
import { CaretRight, EnvelopeSimple, Wallet, X } from '@phosphor-icons/react';
import { usePrivyEnabled } from '@/lib/wallet/privy-enabled';

type IconType = typeof Wallet;

function OptionRow({ icon: Icon, title, description, onClick }: {
    icon: IconType;
    title: string;
    description: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex w-full items-center gap-4 rounded-2xl bg-white p-4 text-left ring-1 ring-inset ring-line transition-shadow hover:ring-ink"
        >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface text-ink">
                <Icon size={20} />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold">{title}</span>
                <span className="mt-0.5 block text-[13px] text-subtle">{description}</span>
            </span>
            <CaretRight size={16} className="shrink-0 text-faint transition-colors group-hover:text-ink" />
        </button>
    );
}

function PrivySocialLoginButton({ onConnected }: { onConnected: () => void }) {
    const { login } = usePrivy();

    return (
        <OptionRow
            icon={EnvelopeSimple}
            title="Email or social"
            description="Sign in with Google, X or email."
            onClick={() => {
                login();
                onConnected();
            }}
        />
    );
}

export const WalletConnectModal: React.FC = () => {
    const isOpen = useStore(state => state.isConnectModalOpen);
    const setOpen = useStore(state => state.setConnectModalOpen);
    const privyEnabled = usePrivyEnabled();
    const { setOpen: openConnectKit } = useModal();

    const handleArcConnect = () => {
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
                        <OptionRow
                            icon={Wallet}
                            title="Browser wallet"
                            description="MetaMask, WalletConnect and others."
                            onClick={handleArcConnect}
                        />
                        {privyEnabled ? (
                            <PrivySocialLoginButton onConnected={() => setOpen(false)} />
                        ) : null}
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
        )}
        </>
    );
};
