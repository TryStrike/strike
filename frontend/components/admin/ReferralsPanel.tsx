'use client';


import { useMemo } from 'react';
import { explorerAddressUrl } from '@/lib/arc/config';
import { apiListQuery, type DashFilters } from './dashQuery';
import { EmptyState, ErrorState, Pagination, Table, THead, shortenAddress } from './AdminUi';
import { useAdminFetch } from './useAdminFetch';
import type { UserRow } from './types';

interface UsersApi {
    users?: UserRow[];
    total?: number;
}

function tierFor(count: number): { label: string; cls: string } {
    if (count > 10) return { label: 'Ambassador', cls: 'text-up bg-up-soft' };
    if (count > 0) return { label: 'Pro', cls: 'text-up bg-up-soft' };
    return { label: 'Starter', cls: 'text-faint bg-surface' };
}

export default function ReferralsPanel({
    filters, nonce, onUnauthorized, onPatch,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
}) {
    const url = useMemo(
        () => `/api/admin/users?${apiListQuery(filters)}&referrers=1`,
        [filters],
    );
    const list = useAdminFetch<UsersApi>(url, { nonce, onUnauthorized });

    const rows = useMemo(() => {
        const page = [...(list.data?.users ?? [])];
        page.sort((a, b) => (b.referral?.referral_count || 0) - (a.referral?.referral_count || 0));
        return page;
    }, [list.data]);

    return (
        <div className="text-left">
            {list.error ? (
                <ErrorState message={list.error} onRetry={list.reload} retrying={list.loading} />
            ) : (
                <>
                    <div className="overflow-x-auto">
                        <Table>
                            <THead labels={['Identity', 'Personal Code', 'Referred By', 'Network Size', 'Status']} />
                            <tbody>
                                {list.loading && rows.length === 0
                                    ? Array.from({ length: 4 }).map((_, i) => (
                                        <tr key={i} className="border-b border-line animate-pulse">
                                            {[0, 1, 2, 3, 4].map((j) => (
                                                <td key={j} className="px-8 py-6"><div className="h-3 rounded bg-surface" /></td>
                                            ))}
                                        </tr>
                                    ))
                                    : rows.map((u) => {
                                        const count = u.referral?.referral_count || 0;
                                        const tier = tierFor(count);
                                        return (
                                            <tr key={u.user_address + u.currency} className="hover:bg-surface transition-colors border-b border-line">
                                                <td className="px-8 py-6">
                                                    <a
                                                        href={explorerAddressUrl(u.user_address)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        title={u.user_address}
                                                        className="font-mono text-ink text-sm hover:text-muted hover:underline transition-colors"
                                                    >
                                                        {shortenAddress(u.user_address)} ↗
                                                    </a>
                                                </td>
                                                <td className="px-8 py-6 font-black text-ink uppercase tracking-widest">{u.referral?.referral_code}</td>
                                                <td className="px-8 py-6 text-subtle font-mono text-xs">
                                                    {u.referral?.referred_by ? shortenAddress(String(u.referral.referred_by)) : 'DIRECT'}
                                                </td>
                                                <td className="px-8 py-6">
                                                    <span className="text-xl font-black text-ink tabular-nums">{count}</span>
                                                </td>
                                                <td className="px-8 py-6 text-right">
                                                    <span className={`px-3 py-1 rounded text-sm font-black uppercase ${tier.cls}`}>
                                                        {tier.label}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                            </tbody>
                        </Table>
                    </div>
                    {!list.loading && !list.error && rows.length === 0 && (
                        <EmptyState
                            title="No referrers in this window"
                            hint="Only wallets holding a personal referral code appear here. Clear ?q / ?status to widen the search."
                        />
                    )}
                    <Pagination
                        offset={filters.offset}
                        limit={filters.limit}
                        total={list.data?.total}
                        loading={list.loading}
                        onPage={(offset) => onPatch({ offset })}
                    />
                </>
            )}
        </div>
    );
}
