'use client';

/**
 * /profile — the player hub.
 *
 * Three server-backed blocks, each with its own loading / empty / failed /
 * unauthorised state so one dead read never degrades the whole page:
 *
 *   identity   user_profiles username (registry) + derived avatar
 *   treasury   house credits + tier   (GET /api/balance/[address])
 *   record     win rate, net PnL, streaks, sparkline (GET /api/bets/stats)
 *   ledger     last settled rounds   (GET /api/bets/history)
 *
 * Identity is always keyed by the CANONICAL address (lowercase for 0x…), the
 * same spelling the ledger rows use, so one wallet can never accumulate two
 * profile rows. Usernames are rendered as text only. The full wallet address is
 * never on screen: it is shortened by lib/utils/address and leaves through an
 * explicit copy action (components/profile/AddressChip).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { useShallow } from 'zustand/react/shallow';
import { useStore, useHouseBalance, useWalletAddress, useIsConnected, useUserTier } from '@/lib/store';
import { useToast } from '@/lib/hooks/useToast';
import { openReferralShareOnX, referralLandingUrl } from '@/lib/referral/shareOnX';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';
import { ensureBalanceSession } from '@/lib/balance/balanceClientHeaders';
import { WalletConnect } from '@/components/wallet';
import { identityDisplayState, prepareUsernameWrite, readProfile, type ProfileRead } from '@/lib/profile/identity';
import PerformanceSection from '@/components/profile/PerformanceSection';
import IdentityPanel from '@/components/profile/IdentityPanel';
import BalanceTierPanel from '@/components/profile/BalanceTierPanel';
import LedgerPreview from '@/components/profile/LedgerPreview';
import { AddressChip } from '@/components/profile/AddressChip';
import {
    User as UserIcon,
    Link as LinkIcon,
    Check,
    Lightning as Zap,
    Shield,
    Crown,
    Pulse as Activity,
    ShieldCheck,
    CaretRight as ChevronRight,
    WarningCircle,
    Wallet,
    ClockCounterClockwise as History,
} from '@phosphor-icons/react';

const TIER_DATA = [
    {
        id: 'free',
        name: 'Free',
        color: 'text-gray-400',
        borderColor: 'border-gray-800',
        bgColor: 'bg-gray-400/5',
        iconComp: Shield,
        assets: 'All',
        blitz: 'Enabled',
        payout: '100.0%',
        withdrawal: 'Instant',
        fee: '10%',
        requirement: '$0',
    },
    {
        id: 'standard',
        name: 'Standard',
        color: 'text-amber-400',
        borderColor: 'border-amber-800/30',
        bgColor: 'bg-amber-400/5',
        iconComp: Zap,
        assets: 'All',
        blitz: 'Enabled',
        payout: '100.0%',
        withdrawal: 'Instant',
        fee: '9%',
        requirement: '$50',
    },
    {
        id: 'vip',
        name: 'VIP',
        color: 'text-purple-400',
        borderColor: 'border-purple-800/30',
        bgColor: 'bg-purple-400/5',
        iconComp: Crown,
        assets: 'All',
        blitz: 'Enabled',
        payout: '100.0%',
        withdrawal: 'Instant',
        fee: '8%',
        requirement: '$500',
    },
];

export default function ProfilePage() {
    const isConnected = useIsConnected();
    const address = useWalletAddress();
    const houseBalance = useHouseBalance();
    const userTier = useUserTier();
    const {
        isUpdatingUsername,
        referralCode,
        referralCount,
        referralLoadError,
        referralsLoading,
        accessCode,
        accountType,
        demoBalance,
        balanceError,
        balanceLoading,
        fetchBalance,
        fetchReferralInfo,
        updateUsername,
    } = useStore(
        useShallow((s) => ({
            isUpdatingUsername: s.isUpdatingUsername,
            referralCode: s.referralCode,
            referralCount: s.referralCount,
            referralLoadError: s.referralLoadError,
            referralsLoading: s.isLoadingReferrals,
            accessCode: s.accessCode,
            accountType: s.accountType,
            demoBalance: s.demoBalance,
            balanceError: s.error,
            balanceLoading: s.isLoading,
            fetchBalance: s.fetchBalance,
            fetchReferralInfo: s.fetchReferralInfo,
            updateUsername: s.updateUsername,
        })),
    );

    /** The ONE identity key: canonical, so the registry cannot fork a wallet. */
    const identityKey = useMemo(() => (address ? canonicalHouseUserAddress(address) : null), [address]);

    // ── identity ──────────────────────────────────────────────────────────────
    const [profileRead, setProfileRead] = useState<ProfileRead | null>(null);
    const [profileLoading, setProfileLoading] = useState(false);
    const [profileNonce, setProfileNonce] = useState(0);

    useEffect(() => {
        if (!identityKey) {
            setProfileRead(null);
            setProfileLoading(false);
            return;
        }
        let cancelled = false;
        setProfileLoading(true);
        setProfileRead(null);
        void readProfile(identityKey).then((read) => {
            if (cancelled) return;
            setProfileRead(read);
            setProfileLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [identityKey, profileNonce]);

    const identityState = identityDisplayState(profileRead, profileLoading);
    const storedUsername = profileRead?.kind === 'found' ? profileRead.username : null;

    const handleSaveUsername = useCallback(
        async (stored: string) => {
            // Re-check the rules + identity key at the write site: a scripted
            // call must not be able to store what the input would have refused.
            const intent = prepareUsernameWrite(identityKey, stored);
            if (!intent.ok) return { outcome: 'rejected' as const, message: intent.error.message };
            if (accountType === 'demo') {
                return { outcome: 'error' as const, message: 'Practice wallets cannot register a public name.' };
            }
            // Existing app write path (store -> profileSlice -> POST /api/db).
            const ok = await updateUsername(intent.address, intent.stored);
            if (!ok) {
                return {
                    outcome: 'rejected' as const,
                    message: 'That name is already claimed, or the registry refused it.',
                };
            }
            setProfileRead({ kind: 'found', username: intent.stored });
            return { outcome: 'ok' as const, message: null };
        },
        [accountType, identityKey, updateUsername],
    );

    // ── treasury ──────────────────────────────────────────────────────────────
    const [balanceLoadedFor, setBalanceLoadedFor] = useState<string | null>(null);
    const [balanceNonce, setBalanceNonce] = useState(0);

    useEffect(() => {
        if (!isConnected || !identityKey || accountType === 'demo') return;
        let cancelled = false;
        void Promise.resolve(fetchBalance(identityKey)).then(() => {
            if (!cancelled) setBalanceLoadedFor(identityKey);
        });
        return () => {
            cancelled = true;
        };
    }, [isConnected, identityKey, accountType, fetchBalance, balanceNonce]);

    const refreshBalance = useCallback(() => setBalanceNonce((n) => n + 1), []);

    // ── referrals (unchanged server path) ─────────────────────────────────────
    useEffect(() => {
        if (isConnected && identityKey) void fetchReferralInfo(identityKey);
    }, [isConnected, identityKey, fetchReferralInfo]);

    const [copySuccess, setCopySuccess] = useState<string | null>(null);
    const [isTierModalOpen, setIsTierModalOpen] = useState(false);
    const toast = useToast();

    const copyReferralCode = useCallback(async () => {
        const code = (referralCode ?? '').trim();
        if (!code) {
            toast.error('Referral code not ready yet');
            return;
        }
        try {
            await navigator.clipboard.writeText(code);
            setCopySuccess('Code');
            setTimeout(() => setCopySuccess(null), 2000);
        } catch {
            toast.error('Clipboard is blocked in this browser');
        }
    }, [referralCode, toast]);

    const currentTierIndex = TIER_DATA.findIndex((t) => t.id === userTier);
    const safeTierIndex = currentTierIndex === -1 ? 0 : currentTierIndex;
    const currentTierData = TIER_DATA[safeTierIndex];
    const nextTier = TIER_DATA[safeTierIndex + 1];

    // ── not connected ─────────────────────────────────────────────────────────
    if (!isConnected) {
        return (
            <motion.main
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex min-h-screen flex-col items-center justify-center gap-8 bg-[#02040a] p-6 text-center text-white"
            >
                <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
                    <Wallet className="h-8 w-8 text-white/40" />
                </div>
                <div className="space-y-3">
                    <h1 className="text-2xl font-black uppercase tracking-widest">Strike Registry</h1>
                    <p className="mx-auto max-w-xs text-[10px] font-bold uppercase leading-relaxed tracking-[0.2em] text-gray-500">
                        A connected wallet is required to read your identity, house credits and betting record.
                    </p>
                </div>
                <WalletConnect />
                <div className="h-[1px] w-80 bg-white/10" />
            </motion.main>
        );
    }

    return (
        <motion.main
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="min-h-screen bg-[#02040a] text-white selection:bg-white selection:text-black pb-20"
        >
            {/* Identity + treasury bar */}
            <motion.div
                initial={{ y: -50 }}
                animate={{ y: 0 }}
                transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
                className="sticky top-0 z-40 border-b border-white/5 bg-[#050505] px-6 py-5"
            >
                <div className="mx-auto flex max-w-6xl flex-col justify-between gap-6 md:flex-row md:items-center">
                    <IdentityPanel
                        address={address}
                        username={storedUsername}
                        loadedOnce={identityState !== 'loading'}
                        nameUnavailable={identityState === 'unknown'}
                        isSaving={isUpdatingUsername}
                        readOnly={accountType === 'demo'}
                        onSave={handleSaveUsername}
                    />
                    <div className="flex flex-col items-end gap-4 sm:flex-row sm:items-center sm:gap-4 sm:justify-end">
                        <BalanceTierPanel
                            isConnected={isConnected}
                            address={address}
                            accountType={accountType}
                            balance={houseBalance}
                            demoBalance={demoBalance}
                            tier={userTier}
                            isLoading={balanceLoading}
                            error={balanceError}
                            loadedOnce={balanceLoadedFor === identityKey}
                            onRefresh={refreshBalance}
                        />
                        <div className="hidden h-10 w-[1px] bg-white/5 md:block" />
                        <div className="flex flex-wrap items-center gap-2">
                            <Link
                                href="/history"
                                className="inline-flex items-center gap-1.5 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white transition-all hover:bg-white/15"
                            >
                                <History className="h-3.5 w-3.5" /> Bet History
                            </Link>
                            <Link
                                href="/withdrawals"
                                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white transition-all hover:bg-white/15"
                            >
                                Withdrawals
                            </Link>
                            <Link
                                href="/referrals"
                                className="rounded-xl bg-white px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-black transition-all hover:bg-gray-200"
                            >
                                Referrals
                            </Link>
                        </div>
                    </div>
                </div>
            </motion.div>

            <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
                {accountType === 'demo' && (
                    <p className="flex items-center gap-2 rounded-2xl border border-emerald-500/15 bg-emerald-500/[0.03] px-4 py-3 text-[9px] font-black uppercase tracking-widest text-emerald-400/80">
                        <InfoDot /> Practice balance — demo bets are excluded from the official record and from payouts.
                    </p>
                )}

                {identityState === 'unknown' && (
                    <button
                        type="button"
                        onClick={() => setProfileNonce((n) => n + 1)}
                        className="flex w-full items-center gap-2 rounded-2xl border border-rose-500/15 bg-rose-500/[0.04] px-4 py-3 text-left text-[9px] font-black uppercase tracking-widest text-rose-400 transition-colors hover:text-rose-300"
                    >
                        <WarningCircle className="h-4 w-4 shrink-0" />
                        Registry read failed — your name could not be loaded. Click to retry.
                    </button>
                )}

                {/* Compact real-state grid. Nothing here is decorative: every
                    cell is either a server fact or an explicit unknown. */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <StatCard
                        label="Referrals"
                        value={
                            referralLoadError
                                ? 'Unavailable'
                                : referralsLoading && !referralCode
                                  ? '…'
                                  : String(referralCount ?? 0)
                        }
                        icon={UserIcon}
                        status={referralLoadError ? 'rose' : 'emerald'}
                        purple
                    />
                    <StatCard
                        label="Record Window"
                        value={accountType === 'demo' ? 'Practice' : 'On-chain'}
                        icon={Activity}
                        status="emerald"
                    />
                    <StatCard label="Tier" value={userTier.toUpperCase()} icon={Shield} status="emerald" clickable onClick={() => setIsTierModalOpen(true)} />
                </div>

                <PerformanceSection
                    wallet={address}
                    accountType={accountType}
                    ensureSession={ensureBalanceSession}
                />

                {/* Tier benefits */}
                <section className="rounded-[2rem] border border-white/10 bg-[#050505] p-6">
                    <div className="mb-6 flex items-center justify-between">
                        <h2 className="text-[10px] font-black uppercase tracking-[0.4em] text-white/30">Tier Benefits</h2>
                        <button
                            onClick={() => setIsTierModalOpen(true)}
                            className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-white/50 transition-colors hover:text-white"
                        >
                            View all tiers <ChevronRight className="h-3 h-3" />
                        </button>
                    </div>

                    <div className={`mb-4 rounded-2xl border ${currentTierData.borderColor} ${currentTierData.bgColor} p-5`}>
                        <div className="mb-4 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <currentTierData.iconComp className={`h-5 w-5 ${currentTierData.color}`} />
                                <span className={`text-sm font-black uppercase tracking-widest ${currentTierData.color}`}>
                                    {currentTierData.name} Tier
                                </span>
                            </div>
                            <span className="text-[10px] font-mono text-white/50">{currentTierData.requirement}</span>
                        </div>

                        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
                            <BenefitItem label="Assets" value={currentTierData.assets} />
                            <BenefitItem label="Blitz" value={currentTierData.blitz} colored />
                            <BenefitItem label="Payout" value={currentTierData.payout} colored />
                            <BenefitItem label="Withdrawal" value={currentTierData.withdrawal} />
                            <BenefitItem label="Protocol Fee" value={currentTierData.fee} />
                        </div>
                    </div>

                    {nextTier && (
                        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] p-4">
                            <div>
                                <p className="mb-1 text-[9px] font-black uppercase tracking-widest text-white/30">Next Unlock</p>
                                <p className="text-sm font-bold text-white/80">
                                    Reach <span className="font-mono">{nextTier.requirement}</span> to unlock{' '}
                                    <span className={nextTier.color}>{nextTier.name}</span>
                                </p>
                            </div>
                            <span className="text-[10px] font-black uppercase text-white/30">Progression</span>
                        </div>
                    )}
                </section>

                {/* Ledger + referral sidebar */}
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                    <div className="lg:col-span-7">
                        <LedgerPreview wallet={address} ensureSession={ensureBalanceSession} />
                    </div>

                    <div className="flex flex-col gap-6 lg:col-span-5">
                        <section className="flex flex-col justify-between rounded-[2rem] border border-white/5 bg-[#050505] p-6">
                            <div className="space-y-5">
                                <h2 className="text-[10px] font-black uppercase tracking-[0.4em] text-white/20">Referral Code</h2>
                                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] p-4">
                                    <span className="font-mono text-lg font-black tracking-widest text-white/80">
                                        {referralCode || '---'}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => void copyReferralCode()}
                                        aria-label="Copy referral code"
                                        className="text-white/20 transition-all hover:text-white"
                                    >
                                        {copySuccess === 'Code' ? (
                                            <Check className="h-4 h-4 text-emerald-400" />
                                        ) : (
                                            <LinkIcon className="h-4 h-4" />
                                        )}
                                    </button>
                                </div>
                                {referralLoadError && (
                                    <p className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-rose-400">
                                        <WarningCircle className="h-3 w-3" /> {referralLoadError}
                                    </p>
                                )}
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!referralCode?.trim()) {
                                            toast.error('Referral code not ready yet');
                                            return;
                                        }
                                        openReferralShareOnX(referralLandingUrl(referralCode));
                                    }}
                                    className="w-full rounded-xl bg-white py-4 text-[9px] font-black uppercase tracking-[0.2em] text-black transition-all hover:bg-gray-200"
                                >
                                    Share Access
                                </button>
                            </div>
                        </section>

                        <section className="space-y-4 rounded-[2rem] border border-emerald-500/10 bg-emerald-500/[0.02] p-6">
                            <h2 className="text-[10px] font-black uppercase tracking-[0.4em] text-emerald-500/40">Session</h2>
                            {accessCode ? (
                                <div className="flex items-center justify-between rounded-xl border border-emerald-500/10 bg-emerald-500/5 p-4">
                                    <span className="font-mono text-sm font-black tracking-[0.2em] text-emerald-400">
                                        Access: Verified
                                    </span>
                                    <ShieldCheck className="h-5 w-5 text-emerald-400/60" />
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <p className="text-[9px] font-bold uppercase leading-relaxed text-white/20">
                                        Reads use this browser&apos;s first-party session. Access codes are never displayed.
                                    </p>
                                    <AddressChip address={address} label="Wallet" className="justify-start" />
                                </div>
                            )}
                        </section>
                    </div>
                </div>
            </div>

            {/* Tier modal */}
            <AnimatePresence>
                {isTierModalOpen && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setIsTierModalOpen(false)}
                            className="absolute inset-0 bg-black/80 backdrop-blur-md"
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="relative w-full max-w-4xl overflow-hidden rounded-[3rem] border border-white/10 bg-[#0a0a0b] p-8 shadow-[0_32px_120px_rgba(0,0,0,1)] md:p-12"
                        >
                            <div className="mb-12 flex items-start justify-between">
                                <div>
                                    <h2 className="mb-2 text-[10px] font-black uppercase tracking-[0.4em] text-white/20">
                                        Tier System
                                    </h2>
                                    <h2 className="text-3xl font-black tracking-tighter">Tier Access Rights</h2>
                                </div>
                                <button
                                    onClick={() => setIsTierModalOpen(false)}
                                    aria-label="Close tiers"
                                    className="rounded-2xl bg-white/5 p-3 transition-all hover:bg-white/10"
                                >
                                    <Check className="h-6 w-6 rotate-45" />
                                </button>
                            </div>

                            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                                {TIER_DATA.map((t, index) => (
                                    <div
                                        key={t.id}
                                        className={`rounded-[2rem] border p-8 transition-all ${
                                            t.id === userTier
                                                ? 'border-white/20 bg-white/[0.04] shadow-[0_0_50px_rgba(255,255,255,0.03)]'
                                                : 'border-white/5 bg-white/[0.01]'
                                        }`}
                                    >
                                        <div className="mb-8 flex items-center justify-between">
                                            <t.iconComp className={`h-8 w-8 ${t.id === userTier ? t.color : 'text-white/20'}`} />
                                            {t.id === userTier && (
                                                <span className="flex items-center gap-1.5 rounded-full border border-[#00ff88]/20 bg-[#00ff88]/10 px-3 py-1 text-[8px] font-black text-[#00ff88]">
                                                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00ff88]" />
                                                    Active
                                                </span>
                                            )}
                                        </div>
                                        <h3 className="mb-1 text-2xl font-black">{t.name}</h3>
                                        <p className="mb-10 text-[9px] font-black uppercase tracking-[0.3em] text-white/20">
                                            Access level 0{index + 1}
                                        </p>

                                        <div className="space-y-6">
                                            <div className="flex items-center justify-between">
                                                <span className="text-[9px] font-black uppercase tracking-widest text-white/20">Payout</span>
                                                <span className="text-xs font-black text-[#00ff88]">{t.payout}</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-[9px] font-black uppercase tracking-widest text-white/20">Blitz</span>
                                                <span className="text-xs font-black text-[#00ff88]">{t.blitz}</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-[9px] font-black uppercase tracking-widest text-white/20">Protocol Fee</span>
                                                <span className="text-xs font-black text-[#00ff88]">{t.fee}</span>
                                            </div>
                                            <div className="border-t border-white/5 pt-6">
                                                <p className="mb-1 text-[8px] font-black uppercase text-white/10">Requirement</p>
                                                <p className="font-mono text-lg font-black text-white/40">{t.requirement}</p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </motion.main>
    );
}

function InfoDot() {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />;
}

const StatCard = ({
    label,
    value,
    icon: Icon,
    status,
    clickable,
    onClick,
    purple,
}: {
    label: string;
    value: string;
    icon: React.ComponentType<{ className?: string }>;
    status?: string;
    clickable?: boolean;
    onClick?: () => void;
    purple?: boolean;
}) => (
    <motion.div
        whileHover={clickable ? { scale: 1.02, y: -4 } : {}}
        whileTap={clickable ? { scale: 0.98 } : {}}
        onClick={clickable ? onClick : undefined}
        className={`group relative overflow-hidden rounded-[2rem] border p-8 transition-all ${
            purple
                ? 'border-purple-500/30 bg-gradient-to-br from-[#0a0510] to-[#050505] shadow-[0_0_30px_rgba(168,85,247,0.1)]'
                : 'border-white/5 bg-[#050505] shadow-xl hover:bg-white/[0.02]'
        } ${clickable ? 'cursor-pointer hover:border-white/20' : ''}`}
    >
        <div className="flex items-center justify-between">
            <div
                className={`flex h-10 w-10 items-center justify-center rounded-xl transition-transform group-hover:scale-110 ${
                    purple ? 'bg-purple-500/20' : 'bg-white/5'
                }`}
            >
                <Icon className={`h-5 w-5 ${purple ? 'text-purple-400' : 'text-white/30'}`} />
            </div>
            {status && (
                <div
                    className={`h-2 w-2 rounded-full ${
                        status === 'emerald' ? 'bg-[#00ff88] shadow-[0_0_10px_#00ff88]' : 'bg-rose-400'
                    }`}
                />
            )}
        </div>
        <div>
            <p
                className={`mb-1.5 text-[10px] font-black uppercase tracking-[0.3em] ${
                    purple ? 'text-purple-400/40' : 'text-white/20'
                }`}
            >
                {label}
            </p>
            <p className="text-2xl font-black tracking-tight">{value}</p>
        </div>
    </motion.div>
);

const BenefitItem = ({ label, value, colored }: { label: string; value: string; colored?: boolean }) => (
    <div className="flex flex-col">
        <span className="mb-2 text-[9px] font-black uppercase leading-none tracking-widest text-white/10">{label}</span>
        <span className={`truncate text-[11px] font-black uppercase tracking-widest ${colored ? 'text-[#00ff88]' : 'text-white/60'}`}>
            {value}
        </span>
    </div>
);
