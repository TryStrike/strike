'use client';

/**
 * Player P&L panel: per-wallet financial summary backed by the paginated
 * /api/admin/player-ledger endpoint (filters + total come from the URL via
 * DashFilters). Banned wallets are highlighted and can be unbanned only after
 * the operator types the confirmation phrase — the unban call also zeroes the
 * wallet balance, so it is treated as a money-path action.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { explorerAddressUrl } from '@/lib/arc/config';
import { adminMutation, useAdminFetch } from './useAdminFetch';
import { apiListQuery, type DashFilters } from './dashQuery';
import { EmptyState, ErrorState, Pagination, TypedConfirmButton, shortenAddress } from './AdminUi';

interface PlayerRow {
    user_address: string;
    currency: string;
    username: string | null;
    total_deposited: number;
    total_withdrawn: number;
    current_balance: number;
    net_pnl: number;
    total_bets: number;
    total_wins: number;
    total_wagered: number;
    total_fees_paid: number;
    first_deposit_at: string | null;
    _has_explicit_fee?: boolean;
}

interface LedgerApi {
    players?: PlayerRow[];
    total?: number;
}

interface BansApi {
    bans?: { wallet_address: string }[];
}

type SortCol =
    | 'first_deposit_at'
    | 'total_deposited'
    | 'total_withdrawn'
    | 'current_balance'
    | 'net_pnl'
    | 'total_bets'
    | 'total_wagered'
    | 'total_fees_paid';

const fmt = (n: number | null | undefined, dec = 6) => {
    // Number(null) is 0 — a missing ledger value must not render as a real zero.
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(dec).replace(/\.?0+$/, '') || '0';
};

const fmtJoinedAt = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });

export default function PlayerPnlPanel({
    filters, nonce, onUnauthorized, onPatch,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
}) {
    const url = useMemo(() => `/api/admin/player-ledger?${apiListQuery(filters)}`, [filters]);
    const ledger = useAdminFetch<LedgerApi>(url, { nonce, onUnauthorized });
    const bans = useAdminFetch<BansApi>('/api/admin/banned-wallets', { nonce, onUnauthorized });

    const [sort, setSort] = useState<{ col: SortCol; dir: 'asc' | 'desc' }>({ col: 'first_deposit_at', dir: 'asc' });
    const [busyAddress, setBusyAddress] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const bannedSet = useMemo(
        () => new Set((bans.data?.bans ?? []).map((b) => String(b.wallet_address).toLowerCase())),
        [bans.data],
    );

    // Ordering happens over the loaded page; the server owns filtering + totals
    // so a page never mixes rows from outside the active window.
    const rows = useMemo(() => {
        const page = [...(ledger.data?.players ?? [])];
        const col = sort.col;
        const dir = sort.dir;
        page.sort((a, b) => {
            if (col === 'first_deposit_at') {
                const da = a.first_deposit_at ?? '';
                const db = b.first_deposit_at ?? '';
                return dir === 'asc' ? da.localeCompare(db) : db.localeCompare(da);
            }
            const v = (x: PlayerRow) => Number((x as unknown as Record<string, unknown>)[col] ?? 0);
            return dir === 'desc' ? v(b) - v(a) : v(a) - v(b);
        });
        return page;
    }, [ledger.data, sort]);

    const toggleSort = useCallback((col: SortCol) => {
        setSort((s) => (s.col === col ? { col, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: 'desc' }));
    }, []);

    const unban = useCallback(async (walletAddress: string) => {
        setBusyAddress(walletAddress);
        setActionError(null);
        const res = await adminMutation(
            '/api/admin/unban-wallet',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ walletAddress }),
            },
            onUnauthorized,
        );
        setBusyAddress(null);
        if (!res.ok) {
            setActionError(res.error ?? 'Failed to unban wallet');
            return;
        }
        ledger.reload();
        bans.reload();
    }, [ledger, bans, onUnauthorized]);

    const SortTh = ({ col, label }: { col: SortCol; label: string }) => (
        <th
            scope="col"
            onClick={() => toggleSort(col)}
            aria-sort={sort.col === col ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}
            className="px-8 py-5 text-left text-xs font-black text-subtle uppercase tracking-widest cursor-pointer hover:text-muted select-none transition-colors"
        >
            {label}{sort.col === col ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ' ↕'}
        </th>
    );

    const total = ledger.data?.total;
    const offset = filters.offset;
    const rankBase = offset;

    return (
        <div className="text-left space-y-4">
            <div className="px-8 pt-6 pb-2 text-xs text-subtle leading-relaxed">
                Per-wallet financial summary across all currencies.{' '}
                <strong className="text-muted">Deposited</strong> = on-chain top-ups.{' '}
                <strong className="text-muted">Withdrawn</strong> = confirmed payouts.{' '}
                <strong className="text-muted">Avail. Balance</strong> = funds sitting in the house they can still withdraw.{' '}
                <strong className="text-up">Player P&amp;L</strong> = (Withdrawn + Avail. Balance) − Deposited; positive = user is net-up.
                {!bans.loading && bans.error && (
                    <span className="text-down"> Ban list unavailable — highlighting is off.</span>
                )}
            </div>

            {ledger.error ? (
                <ErrorState message={ledger.error} onRetry={ledger.reload} retrying={ledger.loading} />
            ) : (
                <>
                    {actionError && (
                        <p className="px-8 text-xs font-mono text-down" role="alert">{actionError}</p>
                    )}
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse">
                            <thead>
                                <tr className="border-b border-line">
                                    <th scope="col" className="px-8 py-5 text-left text-xs font-black text-subtle uppercase tracking-widest">Player</th>
                                    <th scope="col" className="px-8 py-5 text-left text-xs font-black text-subtle uppercase tracking-widest">Currency</th>
                                    <SortTh col="first_deposit_at" label="Joined" />
                                    <SortTh col="total_deposited" label="Deposited" />
                                    <SortTh col="total_withdrawn" label="Withdrawn" />
                                    <SortTh col="current_balance" label="Avail. Balance" />
                                    <SortTh col="net_pnl" label="Player P&amp;L" />
                                    <SortTh col="total_bets" label="Bets" />
                                    <SortTh col="total_wagered" label="Wagered" />
                                    <SortTh col="total_fees_paid" label="Fees Paid" />
                                    <th scope="col" className="px-8 py-5 text-right text-xs font-black text-subtle uppercase tracking-widest">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {ledger.loading && rows.length === 0
                                    ? Array.from({ length: 5 }).map((_, i) => (
                                        <tr key={i} className="border-b border-line animate-pulse">
                                            {Array.from({ length: 11 }).map((__, j) => (
                                                <td key={j} className="px-8 py-5"><div className="h-3 rounded bg-surface" /></td>
                                            ))}
                                        </tr>
                                    ))
                                    : rows.map((p, i) => {
                                        const isWinner = p.net_pnl > 0;
                                        const isLoser = p.net_pnl < 0;
                                        const isBanned = bannedSet.has(String(p.user_address).toLowerCase());
                                        const busy = busyAddress === p.user_address;
                                        return (
                                            <tr
                                                key={`${p.user_address}:${p.currency}`}
                                                className={`hover:bg-surface transition-colors border-b border-line ${isBanned ? 'bg-down-soft' : ''}`}
                                            >
                                                <td className="px-8 py-5">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-faint font-mono text-xs w-8">#{rankBase + i + 1}</span>
                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <span className="text-ink text-sm font-bold">{p.username || 'Anonymous'}</span>
                                                                {isBanned && (
                                                                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest bg-down-soft text-down border border-down/30">
                                                                        ⊘ Banned
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <a
                                                                href={explorerAddressUrl(p.user_address)}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                title={p.user_address}
                                                                className="font-mono text-subtle text-xs hover:text-muted hover:underline transition-colors"
                                                            >
                                                                {shortenAddress(p.user_address)} ↗
                                                            </a>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-8 py-5">
                                                    <span className="text-xs font-black border border-line rounded px-2 py-1 uppercase">{p.currency}</span>
                                                </td>
                                                <td className="px-8 py-5 font-mono text-subtle text-xs whitespace-nowrap">
                                                    {p.first_deposit_at ? fmtJoinedAt(p.first_deposit_at) : '—'}
                                                </td>
                                                <td className="px-8 py-5 font-mono text-ink text-sm tabular-nums">{fmt(p.total_deposited)}</td>
                                                <td className="px-8 py-5 font-mono text-muted text-sm tabular-nums">{fmt(p.total_withdrawn)}</td>
                                                <td className="px-8 py-5">
                                                    <span className={`font-mono text-sm font-bold tabular-nums ${p.current_balance > 0 ? 'text-down' : 'text-faint'}`}>
                                                        {fmt(p.current_balance)}
                                                    </span>
                                                </td>
                                                <td className="px-8 py-5">
                                                    <span className={`font-mono text-sm font-black tabular-nums ${isWinner ? 'text-up' : isLoser ? 'text-down' : 'text-subtle'}`}>
                                                        {isWinner ? '+' : ''}{fmt(p.net_pnl)}
                                                    </span>
                                                </td>
                                                <td className="px-8 py-5 font-mono text-muted text-sm">
                                                    {p.total_bets}
                                                    {p.total_bets > 0 && (
                                                        <span className="text-faint text-xs"> ({Math.round((p.total_wins / p.total_bets) * 100)}% W)</span>
                                                    )}
                                                </td>
                                                <td className="px-8 py-5 font-mono text-muted text-sm tabular-nums">{fmt(p.total_wagered)}</td>
                                                <td className="px-8 py-5">
                                                    <span
                                                        className="font-mono text-xs font-bold text-up tabular-nums"
                                                        title="Platform fees collected (10% on deposits + withdrawals). ~ marks a historical row estimated from deposits/withdrawals."
                                                    >
                                                        {fmt(p.total_fees_paid)}
                                                        {!p._has_explicit_fee && <span className="text-faint text-[10px] ml-1">~</span>}
                                                    </span>
                                                </td>
                                                <td className="px-8 py-5 text-right">
                                                    {isBanned && (
                                                        <TypedConfirmButton
                                                            phrase="UNBAN"
                                                            label="↑ Unban"
                                                            busy={busy}
                                                            onConfirm={() => unban(p.user_address)}
                                                            buttonClassName="inline-flex items-center rounded px-2 py-1 text-[9px] font-black uppercase tracking-widest bg-up-soft text-up border border-up/30 hover:bg-up-soft transition-colors disabled:opacity-40"
                                                        />
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                            </tbody>
                        </table>
                    </div>
                    {!ledger.loading && !ledger.error && rows.length === 0 && (
                        <EmptyState
                            title="No players match"
                            hint="Player rows need at least a balance or an audit event. Clear ?q / ?currency / ?from / ?to to widen the window."
                        />
                    )}
                    <Pagination
                        offset={offset}
                        limit={filters.limit}
                        total={typeof total === 'number' ? total : null}
                        loading={ledger.loading}
                        onPage={(next) => onPatch({ offset: next })}
                    />
                </>
            )}
        </div>
    );
}
