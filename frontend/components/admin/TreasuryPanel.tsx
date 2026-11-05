'use client';

/**
 * On-chain treasury EOA balances (read-only RPC snapshot) with skeleton,
 * empty and error+retry states.
 */

import { EmptyState, ErrorState, SkeletonRows } from './AdminUi';
import { useAdminFetch } from './useAdminFetch';
import type { TreasuryBalanceApiRow } from './types';

interface TreasuryApi {
    generatedAt: string;
    rows: TreasuryBalanceApiRow[];
    usdNote?: string;
    error?: string;
}

export default function TreasuryPanel({
    nonce, onUnauthorized,
}: {
    nonce: number;
    onUnauthorized: () => void;
}) {
    const { data, loading, error, reload } = useAdminFetch<TreasuryApi>(
        '/api/admin/treasury-balances',
        { nonce, onUnauthorized },
    );

    return (
        <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-line pb-6">
                <div className="space-y-2">
                    <div className="text-xs font-black uppercase tracking-wider text-subtle">Liquidity rails</div>
                    <h2 className="text-2xl font-black text-ink tracking-tight">Treasury EOA balances</h2>
                    <p className="text-sm text-subtle max-w-3xl leading-relaxed">
                        Player-deposit treasury addresses from your public env (mainnet only — testnet rows are omitted). Native (or configured) units plus an{' '}
                        <span className="text-up">approximate USD</span> column (see note below).
                    </p>
                    {data?.usdNote && (
                        <p className="text-[11px] text-subtle leading-relaxed max-w-3xl border-l border-line pl-3">
                            {data.usdNote}
                        </p>
                    )}
                    {data?.generatedAt && (
                        <p className="text-[10px] font-mono text-faint">
                            Snapshot: {new Date(data.generatedAt).toLocaleString()}
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    onClick={reload}
                    disabled={loading}
                    className="shrink-0 px-6 py-3 bg-up-soft hover:bg-up-soft border border-up/30 rounded-full text-xs font-black text-up uppercase tracking-widest transition-all disabled:opacity-50"
                >
                    {loading ? 'Querying chains…' : 'Refresh balances'}
                </button>
            </div>

            {error && <ErrorState message={error} onRetry={reload} retrying={loading} />}
            {loading && !data && !error && <SkeletonRows rows={3} />}
            {data && (data.rows?.length ?? 0) === 0 && !loading && !error && (
                <EmptyState
                    title="No treasury addresses resolved"
                    hint="Check the NEXT_PUBLIC_* treasury variables in the deployment environment."
                />
            )}

            {data && (data.rows?.length ?? 0) > 0 && (
                <div className="rounded-2xl border border-line bg-surface overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm min-w-[820px]">
                            <thead>
                                <tr className="text-[10px] font-black uppercase tracking-wider text-subtle border-b border-line bg-surface">
                                    <th className="px-4 py-3">Chain</th>
                                    <th className="px-4 py-3">Label</th>
                                    <th className="px-4 py-3">Address</th>
                                    <th className="px-4 py-3">Asset</th>
                                    <th className="px-4 py-3 text-right">Balance</th>
                                    <th className="px-4 py-3 text-right">≈ USD</th>
                                    <th className="px-4 py-3">Explorer</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.rows.map((r, i) => {
                                    const short =
                                        r.address.length > 18
                                            ? `${r.address.slice(0, 10)}…${r.address.slice(-8)}`
                                            : r.address;
                                    return (
                                        <tr
                                            key={`${r.label}-${r.address}-${i}`}
                                            className="border-b border-line font-mono text-ink"
                                        >
                                            <td className="px-4 py-2.5">{r.chain}</td>
                                            <td className="px-4 py-2.5 text-xs text-muted max-w-[220px]">{r.label}</td>
                                            <td className="px-4 py-2.5 text-[11px] text-muted" title={r.address}>
                                                {short}
                                            </td>
                                            <td className="px-4 py-2.5 text-subtle">{r.asset}</td>
                                            <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                                                {r.error ? '—' : r.formatted}
                                            </td>
                                            <td
                                                className="px-4 py-2.5 text-right tabular-nums text-up"
                                                title={
                                                    r.unitUsd != null && Number.isFinite(r.unitUsd)
                                                        ? `~$${r.unitUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })} / unit`
                                                        : undefined
                                                }
                                            >
                                                {r.error ? '—' : r.formattedUsd}
                                            </td>
                                            <td className="px-4 py-2.5">
                                                {r.explorerUrl ? (
                                                    <a
                                                        href={r.explorerUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-[10px] font-bold uppercase tracking-wider text-up hover:text-up"
                                                    >
                                                        View
                                                    </a>
                                                ) : (
                                                    <span className="text-faint">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
