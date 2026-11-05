'use client';

/**
 * Danger zone panel: high-frequency withdrawal review queue (with the same live
 * accept-window countdown as Financials), the global wallet ban list, and
 * win-streak suspiction controls. Every mutating action here touches money or
 * access, so each one requires typing a confirmation string first.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { explorerAddressUrl } from '@/lib/arc/config';
import { adminMutation, useAdminFetch } from './useAdminFetch';
import { type DashFilters } from './dashQuery';
import { EmptyState, ErrorState, SkeletonRows, Table, THead, TypedConfirmButton, shortenAddress } from './AdminUi';
import WithdrawalQueue from './WithdrawalQueue';
import type { BannedWalletRow, PendingWithdrawal } from './types';

interface FrequencyUser {
    user_address: string;
    total_withdrawals: number;
    completed_withdrawals: number;
    pending_withdrawals: number;
    total_deposited: number;
    total_withdrawn: number;
    total_available_balance: number;
    net_pnl: number;
    has_frequency_flag?: boolean;
    currencies?: string[];
    pending_requests?: PendingWithdrawal[];
}

interface SuspiciousUser {
    user_address: string;
    currency?: string;
    balance: number;
    status?: string;
    maxStreak: number;
    latestBets: boolean[];
}

interface DangerApi {
    suspiciousUsers?: SuspiciousUser[];
    frequencyUsers?: FrequencyUser[];
    /** Additive: set when a bounded scan hit its row cap (counts under-reported). */
    scans?: {
        betsTruncated?: boolean;
        auditTruncated?: boolean;
        pendingTruncated?: boolean;
        betScanCap?: number;
        auditScanCap?: number;
        pendingScanCap?: number;
    };
}

interface BansApi {
    bans?: BannedWalletRow[];
}

/** Confirmation phrase for an address-scoped action: the wallet's last 6 chars. */
const tail = (addr: string) => String(addr).slice(-6).toLowerCase();

const fmt = (n: unknown, dec = 6) => {
    // Missing/failed money values must render as '—', never as a misleading 0.
    if (n === null || n === undefined || n === '') return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(dec).replace(/\.?0+$/, '') || '0';
};

const btnDanger = 'px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 rounded text-xs font-bold text-rose-400 uppercase transition-all disabled:opacity-40';
const btnWarn = 'px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded text-xs font-bold text-amber-500 uppercase transition-all disabled:opacity-40';
const btnNeutral = 'px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-xs font-bold text-white uppercase transition-all disabled:opacity-40';

export default function DangerZonePanel({
    filters, nonce, onUnauthorized, onQueueChanged,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
    onQueueChanged: () => void;
}) {
    const danger = useAdminFetch<DangerApi>('/api/admin/danger-zone', { nonce, onUnauthorized });
    const bans = useAdminFetch<BansApi>('/api/admin/banned-wallets', { nonce, onUnauthorized });

    const [banAddress, setBanAddress] = useState('');
    const [banReason, setBanReason] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionOk, setActionOk] = useState<string | null>(null);

    const frequencyUsers = useMemo(() => {
        const all = danger.data?.frequencyUsers ?? [];
        const q = filters.q.toLowerCase();
        return q ? all.filter((u) => u.user_address.toLowerCase().includes(q)) : all;
    }, [danger.data, filters.q]);

    const suspiciousUsers = danger.data?.suspiciousUsers ?? [];
    const banRows = bans.data?.bans ?? [];

    const refresh = useCallback(() => {
        danger.reload();
        bans.reload();
    }, [danger, bans]);

    const runAction = useCallback(async (
        key: string,
        url: string,
        init: RequestInit,
        successText: string,
    ) => {
        setBusy(key);
        setActionError(null);
        setActionOk(null);
        const res = await adminMutation(url, init, onUnauthorized);
        setBusy(null);
        if (!res.ok) {
            setActionError(res.error ?? 'Action failed');
            return false;
        }
        setActionOk(successText);
        refresh();
        onQueueChanged();
        return true;
    }, [onUnauthorized, refresh, onQueueChanged]);

    const accept = useCallback(async (id: number) => {
        await runAction(`wd-${id}`, `/api/admin/withdrawal-requests/${id}/accept`, { method: 'POST' }, `Withdrawal #${id} accepted.`);
    }, [runAction]);

    const reject = useCallback(async (id: number) => {
        await runAction(`wd-${id}`, `/api/admin/withdrawal-requests/${id}/reject`, { method: 'POST' }, `Withdrawal #${id} rejected.`);
    }, [runAction]);

    const addBan = useCallback(async () => {
        const addr = banAddress.trim();
        if (!addr) {
            setActionError('Enter a wallet address first.');
            return;
        }
        const ok = await runAction(
            `ban-${addr}`,
            '/api/admin/banned-wallets',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ walletAddress: addr, reason: banReason.trim() || 'Banned by administrator' }),
            },
            `${shortenAddress(addr)} is banned across every currency.`,
        );
        if (ok) {
            setBanAddress('');
            setBanReason('');
        }
    }, [banAddress, banReason, runAction]);

    const removeBan = useCallback(async (walletAddress: string) => {
        await runAction(
            `unban-${walletAddress}`,
            `/api/admin/banned-wallets?walletAddress=${encodeURIComponent(walletAddress)}`,
            { method: 'DELETE' },
            `Ban lifted for ${shortenAddress(walletAddress)}.`,
        );
    }, [runAction]);

    const setStatus = useCallback(async (userAddress: string, status: 'active' | 'frozen' | 'banned') => {
        await runAction(
            `status-${userAddress}-${status}`,
            '/api/admin/users/status',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userAddress, status }),
            },
            `${shortenAddress(userAddress)} → ${status}.`,
        );
    }, [runAction]);

    const banTargetTail = tail(banAddress.trim());

    return (
        <div className="space-y-10 text-left">
            {(actionError || actionOk) && (
                <div className="px-8 pt-6">
                    {actionError ? (
                        <p className="text-xs font-mono text-rose-400" role="alert">{actionError}</p>
                    ) : (
                        <p className="text-xs font-mono text-emerald-400" role="status">{actionOk}</p>
                    )}
                </div>
            )}

            {/* High-frequency withdrawal review */}
            <section className="space-y-4" aria-labelledby="freq-queue-heading">
                <div className="flex items-center gap-3 px-1">
                    <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                    <h3 id="freq-queue-heading" className="text-xs font-black uppercase tracking-widest text-amber-400">
                        Manual Review Queue — High Withdrawal Frequency
                    </h3>
                    {frequencyUsers.length > 0 && (
                        <span className="px-2 py-0.5 rounded bg-amber-400/20 border border-amber-400/30 text-amber-300 text-xs font-black">
                            {frequencyUsers.length}
                        </span>
                    )}
                </div>
                <p className="text-xs text-white/30 px-1 leading-relaxed">
                    Wallets with <strong className="text-white/50">10+ total withdrawals</strong>. From withdrawal #11 onwards every
                    request is queued for manual approval regardless of amount — review the full financial profile first.
                    {(danger.data?.scans?.auditTruncated || danger.data?.scans?.pendingTruncated || danger.data?.scans?.betsTruncated) && (
                        <span className="text-amber-400/90"> Scan hit its row cap — counts below may be under-reported.</span>
                    )}
                </p>

                {danger.error ? (
                    <ErrorState message={danger.error} onRetry={danger.reload} retrying={danger.loading} />
                ) : danger.loading && frequencyUsers.length === 0 ? (
                    <SkeletonRows rows={3} className="border border-white/5 rounded-2xl" />
                ) : frequencyUsers.length === 0 ? (
                    <EmptyState title="No frequency-flagged wallets" hint="Nothing has crossed the 10-withdrawal review threshold yet." />
                ) : (
                    <div className="space-y-4">
                        {frequencyUsers.map((u) => {
                            const isWinner = u.net_pnl > 0;
                            const requests = u.pending_requests ?? [];
                            return (
                                <div key={u.user_address} className="border border-amber-400/20 bg-amber-400/[0.03] rounded-2xl p-6 space-y-5">
                                    <div className="flex flex-wrap items-start justify-between gap-4">
                                        <div className="space-y-1">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <a
                                                    href={explorerAddressUrl(u.user_address)}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    title={u.user_address}
                                                    className="font-mono text-white text-sm hover:underline hover:text-amber-300 transition-colors"
                                                >
                                                    {shortenAddress(u.user_address)} ↗
                                                </a>
                                                {u.has_frequency_flag && (
                                                    <span className="px-2 py-0.5 text-xs font-black uppercase rounded bg-amber-400/20 border border-amber-400/40 text-amber-300 tracking-wider">
                                                        Frequency Flag
                                                    </span>
                                                )}
                                                {(u.currencies ?? []).map((c) => (
                                                    <span key={c} className="px-2 py-0.5 text-xs font-black border border-white/10 rounded uppercase">{c}</span>
                                                ))}
                                            </div>
                                            <p className="text-xs text-white/30">Full wallet: <span className="font-mono">{u.user_address}</span></p>
                                        </div>
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setBanAddress(u.user_address);
                                                    setBanReason('High-frequency withdrawal — automated flag');
                                                    setActionOk('Ban form pre-filled — confirm the wallet address, then type the address tail to submit.');
                                                }}
                                                className="px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 rounded text-xs font-bold text-rose-400 uppercase tracking-wide transition-all"
                                            >
                                                Pre-fill Ban
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                                        {[
                                            { label: 'Total Withdrawals', value: String(u.total_withdrawals), color: 'text-amber-400', big: true },
                                            { label: 'Completed', value: String(u.completed_withdrawals), color: 'text-white', big: false },
                                            { label: 'Pending Review', value: String(u.pending_withdrawals), color: u.pending_withdrawals > 0 ? 'text-amber-300' : 'text-white/30', big: false },
                                            { label: 'Total Deposited', value: fmt(u.total_deposited), color: 'text-white', big: false },
                                            { label: 'Total Withdrawn', value: fmt(u.total_withdrawn), color: 'text-white/70', big: false },
                                            { label: 'Avail. Balance', value: fmt(u.total_available_balance), color: u.total_available_balance > 0 ? 'text-amber-300' : 'text-white/30', big: false },
                                        ].map((s) => (
                                            <div key={s.label} className="bg-black/30 border border-white/5 rounded-xl px-4 py-3 space-y-1">
                                                <p className="text-white/30 text-xs uppercase tracking-wider">{s.label}</p>
                                                <p className={`font-mono font-black tabular-nums ${s.color} ${s.big ? 'text-xl' : 'text-sm'}`}>{s.value}</p>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="flex items-center gap-3 flex-wrap">
                                        <span className="text-xs text-white/30 uppercase tracking-widest">Player P&amp;L</span>
                                        <span className={`font-mono font-black text-lg tabular-nums ${isWinner ? 'text-rose-400' : 'text-emerald-400'}`}>
                                            {isWinner ? '+' : ''}{fmt(u.net_pnl)}
                                            <span className="text-xs ml-1 font-normal">
                                                {isWinner ? '(user is net-UP — house lost)' : '(user is net-DOWN — house won)'}
                                            </span>
                                        </span>
                                    </div>

                                    {requests.length > 0 && (
                                        <div className="space-y-2">
                                            <p className="text-xs font-black uppercase tracking-widest text-white/40">
                                                Pending Withdrawal Requests ({requests.length})
                                            </p>
                                            <div className="rounded-xl border border-white/5 bg-black/20">
                                                <WithdrawalQueue
                                                    requests={requests}
                                                    onAccept={accept}
                                                    onReject={reject}
                                                    busyId={busy && busy.startsWith('wd-') ? Number(busy.slice(3)) : null}
                                                    emptyHint="None."
                                                />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Global ban list */}
            <section className="p-8 bg-rose-500/5 border border-rose-500/20 rounded-[2rem] space-y-4" aria-labelledby="ban-list-heading">
                <p id="ban-list-heading" className="text-xs font-black uppercase tracking-wider text-rose-400/80">Global wallet ban list</p>
                <p className="text-sm text-white/40 leading-relaxed max-w-2xl">
                    Blocks deposits, bets, payouts, and withdrawals for an address across every currency.
                    Addresses are matched case-insensitively. Adding or lifting a ban requires typing the address tail.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
                    <div className="flex-1 space-y-1">
                        <label htmlFor="ban-addr" className="text-sm font-black uppercase tracking-wider text-white/50">Wallet address</label>
                        <input
                            id="ban-addr"
                            value={banAddress}
                            onChange={(e) => setBanAddress(e.target.value)}
                            placeholder="0x…"
                            className="w-full px-4 py-2.5 rounded-xl bg-black/40 border border-white/10 text-white text-sm font-mono placeholder:text-white/20"
                        />
                    </div>
                    <div className="flex-[2] space-y-1">
                        <label htmlFor="ban-reason" className="text-xs font-black uppercase tracking-widest text-white/30">Reason (optional)</label>
                        <input
                            id="ban-reason"
                            value={banReason}
                            onChange={(e) => setBanReason(e.target.value)}
                            maxLength={500}
                            placeholder="e.g. manipulation / abuse"
                            className="w-full px-4 py-2.5 rounded-xl bg-black/40 border border-white/10 text-white text-sm placeholder:text-white/20"
                        />
                    </div>
                    <TypedConfirmButton
                        phrase={banTargetTail}
                        label="Ban wallet"
                        busy={busy === `ban-${banAddress.trim()}`}
                        disabled={!banAddress.trim()}
                        onConfirm={addBan}
                        buttonClassName="px-6 py-2.5 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 font-black uppercase text-xs tracking-widest rounded-xl transition-all disabled:opacity-40"
                    />
                </div>

                {bans.error ? (
                    <ErrorState message={bans.error} onRetry={bans.reload} retrying={bans.loading} />
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <THead labels={['Address', 'Reason', 'Added', 'Lift ban']} />
                            <tbody>
                                {bans.loading && banRows.length === 0
                                    ? Array.from({ length: 3 }).map((_, i) => (
                                        <tr key={i} className="border-b border-white/5 animate-pulse">
                                            {[0, 1, 2, 3].map((j) => (
                                                <td key={j} className="px-8 py-6"><div className="h-3 rounded bg-white/[0.05]" /></td>
                                            ))}
                                        </tr>
                                    ))
                                    : banRows.map((b) => (
                                        <tr key={b.wallet_address} className="border-b border-white/5">
                                            <td className="px-8 py-4 font-mono text-xs text-white break-all">{b.wallet_address}</td>
                                            <td className="px-8 py-4 text-white/50 text-xs max-w-xs">{b.reason || '—'}</td>
                                            <td className="px-8 py-4 text-white/30 text-xs font-mono whitespace-nowrap">
                                                {new Date(b.created_at).toLocaleString()}
                                            </td>
                                            <td className="px-8 py-4 text-right">
                                                <TypedConfirmButton
                                                    phrase={tail(b.wallet_address)}
                                                    label="Remove"
                                                    busy={busy === `unban-${b.wallet_address}`}
                                                    onConfirm={() => removeBan(b.wallet_address)}
                                                    buttonClassName="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-xs font-bold text-white/70 uppercase"
                                                />
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </Table>
                    </div>
                )}
                {!bans.loading && banRows.length === 0 && !bans.error && (
                    <EmptyState title="No global bans yet" hint="Bans you add appear here and take effect immediately for every currency." />
                )}
            </section>

            {/* Win-streak suspicion */}
            <section aria-labelledby="streak-heading">
                <p id="streak-heading" className="px-1 pb-3 text-xs font-black uppercase tracking-widest text-white/30">
                    Win-streak anomalies (10+ consecutive wins)
                </p>
                {danger.error ? (
                    <ErrorState message={danger.error} onRetry={danger.reload} retrying={danger.loading} />
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <THead labels={['Node Identity', 'Max Streak', 'Pattern', 'Current Status', 'Operations']} />
                            <tbody>
                                {danger.loading && suspiciousUsers.length === 0
                                    ? Array.from({ length: 3 }).map((_, i) => (
                                        <tr key={i} className="border-b border-white/5 animate-pulse">
                                            {[0, 1, 2, 3, 4].map((j) => (
                                                <td key={j} className="px-8 py-6"><div className="h-3 rounded bg-white/[0.05]" /></td>
                                            ))}
                                        </tr>
                                    ))
                                    : suspiciousUsers.map((u) => {
                                        const status = String(u.status || 'active');
                                        return (
                                            <tr key={u.user_address} className="hover:bg-white/[0.02] transition-colors border-b border-white/5 last:border-0">
                                                <td className="px-8 py-6">
                                                    <div className="flex flex-col">
                                                        <a
                                                            href={explorerAddressUrl(u.user_address)}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            title={u.user_address}
                                                            className="font-mono text-white text-sm hover:underline"
                                                        >
                                                            {shortenAddress(u.user_address)} ↗
                                                        </a>
                                                        <span className="text-xs text-white/20">Balance: {fmt(u.balance)}</span>
                                                    </div>
                                                </td>
                                                <td className="px-8 py-6">
                                                    <span className="text-rose-500 font-black text-2xl tabular-nums">{u.maxStreak} wins</span>
                                                </td>
                                                <td className="px-8 py-6">
                                                    <div className="flex gap-1">
                                                        {(u.latestBets ?? []).map((won, i) => (
                                                            <div key={i} className={`w-1.5 h-4 rounded-full ${won ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-rose-500/20'}`} />
                                                        ))}
                                                    </div>
                                                </td>
                                                <td className="px-8 py-6">
                                                    <span className={`text-xs font-black uppercase px-2 py-1 rounded ${
                                                        status === 'banned' ? 'bg-rose-500/20 text-rose-500 border border-rose-500/30'
                                                            : status === 'frozen' ? 'bg-amber-500/20 text-amber-500 border border-amber-500/30'
                                                                : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                                                    }`}>
                                                        {status}
                                                    </span>
                                                </td>
                                                <td className="px-8 py-6 text-right">
                                                    <div className="flex justify-end gap-2 flex-wrap">
                                                        {status !== 'frozen' && status !== 'banned' && (
                                                            <TypedConfirmButton
                                                                phrase={tail(u.user_address)}
                                                                label="Freeze"
                                                                busy={busy === `status-${u.user_address}-frozen`}
                                                                onConfirm={() => setStatus(u.user_address, 'frozen')}
                                                                buttonClassName={btnWarn}
                                                            />
                                                        )}
                                                        {status !== 'banned' && (
                                                            <TypedConfirmButton
                                                                phrase={tail(u.user_address)}
                                                                label="Ban"
                                                                busy={busy === `status-${u.user_address}-banned`}
                                                                onConfirm={() => setStatus(u.user_address, 'banned')}
                                                                buttonClassName={btnDanger}
                                                            />
                                                        )}
                                                        {(status === 'frozen' || status === 'banned') && (
                                                            <TypedConfirmButton
                                                                phrase="ACTIVE"
                                                                label="Reactivate"
                                                                busy={busy === `status-${u.user_address}-active`}
                                                                onConfirm={() => setStatus(u.user_address, 'active')}
                                                                buttonClassName={btnNeutral}
                                                            />
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                            </tbody>
                        </Table>
                    </div>
                )}
                {!danger.loading && suspiciousUsers.length === 0 && !danger.error && (
                    <EmptyState title="No suspicious activity detected" hint="Streak detection scans settled real-wallet rounds." />
                )}
            </section>
        </div>
    );
}
