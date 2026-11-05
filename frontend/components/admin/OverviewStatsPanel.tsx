'use client';

/**
 * Top-of-dashboard overview: real/demo betting economics (per-chain native
 * token tables — never a mixed-$ total), asset count and dwell-time stats.
 * Fetches /api/admin/stats + /api/admin/currencies itself so it can render
 * skeletons / errors independently of the tabs.
 */

import React from 'react';
import { isArcAsset } from '@/lib/arc/config';
import { EmptyState, ErrorState, fmtPnL, SkeletonRows, StatBox } from './AdminUi';
import { useAdminFetch } from './useAdminFetch';
import { type NetworkPnLRow, type Stats } from './types';

interface CurrencyApi {
    tokens?: { symbol: string; price: number; category: string }[];
    totalTokens?: number;
}

/** Human-readable mean session length for terminal stats. */
function fmtAvgSession(seconds: number | undefined, sampleCount: number | undefined): string {
    if (!sampleCount || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '—';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
}

/** Ledger token ticker for bet_history.network. */
function tokenSymbolForNetwork(net: string): string {
    const u = (net ?? '').trim().toUpperCase();
    return isArcAsset(u) ? u : 'USDC';
}

function NetworkTokenEconomicsTable({ rows, title }: { rows?: Record<string, NetworkPnLRow>; title: string }) {
    if (!rows || Object.keys(rows).length === 0) {
        return (
            <div className="rounded-2xl border border-line bg-surface px-4 py-6 text-sm text-subtle">
                No per-chain betting data yet.
            </div>
        );
    }
    const sorted = Object.entries(rows).sort(
        (a, b) => Math.abs(b[1].platformPnL) - Math.abs(a[1].platformPnL),
    );
    return (
        <div className="rounded-2xl border border-line bg-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-line space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-subtle">{title}</p>
                <p className="text-sm text-subtle leading-relaxed">
                    Each row is one chain. Amounts are in that row's <span className="text-muted">native token</span> (not dollars).{' '}
                    <span className="text-down">Do not sum numbers down the column across different tokens.</span>
                </p>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm min-w-[640px]">
                    <thead>
                        <tr className="text-xs font-black uppercase tracking-wider text-subtle border-b border-line bg-surface">
                            <th className="px-4 py-3">Chain</th>
                            <th className="px-4 py-3">Token</th>
                            <th className="px-4 py-3 text-right">Staked</th>
                            <th className="px-4 py-3 text-right">Paid to players</th>
                            <th className="px-4 py-3 text-right">Net (house)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map(([net, row]) => {
                            const sym = tokenSymbolForNetwork(net);
                            const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
                            return (
                                <tr key={net} className="border-b border-line font-mono text-ink">
                                    <td className="px-4 py-2.5">{net}</td>
                                    <td className="px-4 py-2.5 text-muted">{sym}</td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                        {fmt(row.volume)} <span className="text-xs text-subtle">{sym}</span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                        {fmt(row.payout)} <span className="text-xs text-subtle">{sym}</span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                        <span className={row.platformPnL >= 0 ? 'text-up' : 'text-down'}>
                                            {fmt(row.platformPnL)} <span className="text-xs opacity-70">{sym}</span>
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default function OverviewStatsPanel({
    nonce, onUnauthorized,
}: {
    nonce: number;
    onUnauthorized: () => void;
}) {
    const stats = useAdminFetch<Stats>('/api/admin/stats', { nonce, onUnauthorized });
    const currencies = useAdminFetch<CurrencyApi>('/api/admin/currencies', { nonce, onUnauthorized });

    const s = stats.data;
    // A failed/pending currencies fetch must not render as "0 market assets" —
    // show the em-dash placeholder so the number is visibly unavailable.
    const marketCount = currencies.data?.tokens
        ? currencies.data.tokens.length.toLocaleString()
        : '—';

    if (stats.error) return <ErrorState message={stats.error} onRetry={stats.reload} retrying={stats.loading} />;

    if (stats.loading && !s) {
        return (
            <div className="space-y-6" aria-busy="true">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-36 rounded-[2.5rem] bg-surface animate-pulse" />
                    ))}
                </div>
                <SkeletonRows rows={3} />
            </div>
        );
    }

    if (!s) return <EmptyState title="No platform stats yet" hint="Numbers appear once the first rounds settle." />;

    const modeBlock = (mode: 'real' | 'demo') => {
        const m = s[mode];
        // Present-but-zero renders as 0; missing/failed renders as '—'.
        const count = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—');
        return (
            <div className="space-y-6">
                <div className="text-xs font-black uppercase tracking-wider text-subtle">{mode === 'real' ? 'Real Mode Stats' : 'Demo Mode Stats'}</div>
                <NetworkTokenEconomicsTable
                    rows={m?.platformPnLByNetwork}
                    title={mode === 'real' ? 'Betting economics by chain (native tokens)' : 'Demo — betting economics by chain (native tokens)'}
                />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    <StatBox title={`Total bets (${mode})`} value={count(m?.totalBets)} label="Settled bets in history" />
                    <StatBox
                        title="Σ staked (mixed)"
                        value={fmtPnL(m?.totalVolume)}
                        label="Raw sum of stake amounts — mixed tokens, not one currency"
                    />
                    <StatBox title="Registered Nodes" value={count(m?.totalUsers)} label="Unique Wallet Addresses" />
                    <StatBox title="Total Referrals" value={count(m?.totalReferrals)} label="Network Growth" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <StatBox title="Market Assets" value={marketCount} label="Active Price Feeds" />
                    <StatBox
                        title="Avg. time spent"
                        value={fmtAvgSession(m?.averageSessionSeconds, m?.sessionSampleCount)}
                        label={`Mean dwell per session (last 7d) · ${(m?.sessionSampleCount ?? 0).toLocaleString()} sessions · ${
                            mode === 'demo' ? 'demo wallets only' : '30s pings + 90s idle tail'
                        }`}
                    />
                </div>
            </div>
        );
    };

    return (
        <div className="space-y-10">
            {modeBlock('real')}
            {modeBlock('demo')}
        </div>
    );
}
