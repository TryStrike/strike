'use client';

/**
 * Ledger (users) panel — server-side filtering + pagination via /api/admin/users.
 */

import React, { useMemo } from 'react';
import { explorerAddressUrl } from '@/lib/arc/config';
import type { DashFilters } from './dashQuery';
import { apiListQuery } from './dashQuery';
import { EmptyState, ErrorState, Pagination, PanelHeader, Table, THead, shortenAddress } from './AdminUi';
import { useAdminFetch } from './useAdminFetch';
import type { UserRow } from './types';

interface UsersApi {
    users?: UserRow[];
    total?: number;
    limit?: number;
    offset?: number;
}

export default function UsersPanel({
    filters, nonce, onUnauthorized, onPatch,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
}) {
    const url = useMemo(
        () => `/api/admin/users?${apiListQuery(filters)}`,
        [filters],
    );
    const { data, loading, error, reload } = useAdminFetch<UsersApi>(url, { nonce, onUnauthorized });

    const rows = data?.users ?? [];
    const total = data?.total;

    return (
        <div className="text-left">
            <PanelHeader
                eyebrow="House ledger"
                title="Balance rows per wallet + currency, filtered and paged server-side"
                right={(
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/20 border border-white/10 rounded px-2 py-1">
                        {typeof total === 'number' ? `${total.toLocaleString()} rows` : `${rows.length} rows`}
                    </span>
                )}
            />
            {error ? (
                <ErrorState message={error} onRetry={reload} retrying={loading} />
            ) : (
                <>
                    <div className="overflow-x-auto">
                        <Table>
                            <THead labels={['Identity', 'Protocol', 'Status', 'Liquidity', 'Volume']} />
                            <tbody>
                                {loading && rows.length === 0
                                    ? Array.from({ length: 5 }).map((_, i) => (
                                        <tr key={i} className="border-b border-white/5 animate-pulse">
                                            {[0, 1, 2, 3, 4].map((j) => (
                                                <td key={j} className="px-8 py-6">
                                                    <div className="h-3 rounded bg-white/[0.05]" />
                                                </td>
                                            ))}
                                        </tr>
                                    ))
                                    : rows.map((u) => (
                                        <tr key={u.user_address + u.currency} className="hover:bg-white/[0.02] transition-colors border-b border-white/5">
                                            <td className="px-8 py-6">
                                                <div className="flex flex-col">
                                                    <span className="text-white text-sm font-bold">{u.username || 'Anonymous'}</span>
                                                    <a
                                                        href={explorerAddressUrl(u.user_address)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        title={u.user_address}
                                                        className="font-mono text-white/30 text-xs hover:text-white/70 hover:underline transition-colors"
                                                    >
                                                        {shortenAddress(u.user_address)} ↗
                                                    </a>
                                                </div>
                                            </td>
                                            <td className="px-8 py-6">
                                                <span className="text-xs font-black border border-white/10 rounded px-2 py-1 uppercase">{u.currency}</span>
                                            </td>
                                            <td className="px-8 py-6">
                                                <span className={`text-xs font-black uppercase px-2 py-1 rounded ${
                                                    (u.status ?? 'active') === 'active'
                                                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                                        : (u.status ?? '') === 'frozen'
                                                            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                                            : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                                }`}>
                                                    {u.status || 'active'}
                                                </span>
                                            </td>
                                            <td className="px-8 py-6 text-white font-mono font-bold">{Number(u.balance).toFixed(4)}</td>
                                            <td className="px-8 py-6 text-white font-mono font-black">
                                                {(u.activity?.totalVolume ?? 0).toLocaleString()}{' '}
                                                <span className="text-xs font-bold text-white/30 uppercase">mixed native</span>
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </Table>
                    </div>
                    {!loading && !error && rows.length === 0 && (
                        <EmptyState
                            title="No ledger rows match"
                            hint="Adjust the global search or status/currency filters — or wait for the first players."
                        />
                    )}
                    <Pagination
                        offset={filters.offset}
                        limit={filters.limit}
                        total={total}
                        loading={loading}
                        onPage={(offset) => onPatch({ offset })}
                    />
                </>
            )}
        </div>
    );
}
