'use client';


import { useMemo } from 'react';
import { apiListQuery, type DashFilters } from './dashQuery';
import { EmptyState, ErrorState, Pagination, Table, THead } from './AdminUi';
import { useAdminFetch } from './useAdminFetch';
import { MARKET_CATEGORY_ORDER, type MarketToken } from './types';

interface CurrencyApi {
    tokens?: MarketToken[];
    totalTokens?: number;
}

export default function MarketsPanel({
    filters, nonce, onUnauthorized, onPatch,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
}) {
    const url = useMemo(() => `/api/admin/currencies?${apiListQuery(filters)}`, [filters]);
    const list = useAdminFetch<CurrencyApi>(url, { nonce, onUnauthorized });

    const tokens = list.data?.tokens ?? [];

    const { summary, visible, total } = useMemo(() => {
        const counts = Object.fromEntries(MARKET_CATEGORY_ORDER.map((c) => [c, 0])) as Record<string, number>;
        for (const t of tokens) {
            const cat = (MARKET_CATEGORY_ORDER as readonly string[]).includes(t.category) ? t.category : 'Crypto';
            counts[cat] = (counts[cat] ?? 0) + 1;
        }
        const q = filters.q.toLowerCase();
        const matched = q
            ? tokens.filter((t) => t.symbol.toLowerCase().includes(q) || String(t.category).toLowerCase().includes(q))
            : tokens;
        const window = matched.slice(filters.offset, filters.offset + filters.limit);
        return { summary: counts, visible: window, total: matched.length };
    }, [tokens, filters.q, filters.offset, filters.limit]);

    const fmtPrice = (n: number) => {
        const v = Number(n);
        if (!Number.isFinite(v) || v === 0) return '—';
        return v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 2 : 6 });
    };

    return (
        <div className="text-left">
            {list.error ? (
                <ErrorState message={list.error} onRetry={list.reload} retrying={list.loading} />
            ) : (
                <>
                    {!list.loading && tokens.length === 0 ? (
                        <EmptyState title="No price feeds resolved" hint="The feed registry returned empty — check the price-feed configuration." />
                    ) : (
                        <>
                            <div className="p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                                {list.loading && tokens.length === 0
                                    ? Array.from({ length: 5 }).map((_, i) => (
                                        <div key={i} className="h-36 rounded-[2rem] bg-surface animate-pulse" />
                                    ))
                                    : Object.entries(summary).map(([cat, count]) => (
                                        <div key={cat} className="p-8 bg-surface border border-line rounded-[2rem] space-y-4">
                                            <p className="text-xs font-black uppercase tracking-widest text-subtle">{cat}</p>
                                            <div className="flex items-end justify-between">
                                                <h4 className="text-5xl font-black text-ink tracking-tight tabular-nums">{count}</h4>
                                                <p className="text-xs font-bold text-faint uppercase pb-2">Active Feeds</p>
                                            </div>
                                            <div className="w-full h-1 bg-surface rounded-full">
                                                <div
                                                    className="h-full bg-white rounded-full"
                                                    style={{ width: `${tokens.length ? (count / tokens.length) * 100 : 0}%` }}
                                                />
                                            </div>
                                        </div>
                                    ))}
                                <div className="p-8 bg-surface border border-line rounded-[2rem] flex flex-col justify-center">
                                    <p className="text-xs font-bold text-ink uppercase tracking-widest text-center mb-1">Total Inventory</p>
                                    <p className="text-4xl font-black text-ink text-center tracking-tight tabular-nums">{tokens.length || '—'}</p>
                                </div>
                            </div>

                            <div className="overflow-x-auto border-t border-line">
                                <Table>
                                    <THead labels={['Symbol', 'Category', 'Last Price']} />
                                    <tbody>
                                        {visible.map((t) => (
                                            <tr key={`${t.symbol}-${t.category}`} className="border-b border-line hover:bg-surface transition-colors">
                                                <td className="px-8 py-4 font-mono text-ink text-sm">{t.symbol}</td>
                                                <td className="px-8 py-4">
                                                    <span className="text-xs font-black border border-line rounded px-2 py-1 uppercase text-muted">{t.category}</span>
                                                </td>
                                                <td className="px-8 py-4 text-right font-mono text-ink tabular-nums">{fmtPrice(t.price)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </Table>
                            </div>
                            {visible.length === 0 && !list.loading && (
                                <EmptyState title="No feed matches this search" hint={`Current search: "${filters.q || '—'}".`} />
                            )}
                            <Pagination
                                offset={filters.offset}
                                limit={filters.limit}
                                total={total}
                                loading={list.loading}
                                onPage={(offset) => onPatch({ offset })}
                            />
                        </>
                    )}
                </>
            )}
        </div>
    );
}
