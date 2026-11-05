'use client';

/**
 * Wallet intelligence panel: one address, everything the house knows about it.
 * The queried address lives in the URL (?address=0x…) so a lookup is
 * shareable/reloadable and the fetch is driven by the shared polling nonce.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { isDemoBetHistoryRow } from '@/lib/admin/walletAddressVariants';
import { type DashFilters } from './dashQuery';
import { EmptyState, ErrorState } from './AdminUi';
import { useAdminFetch } from './useAdminFetch';

interface WalletIntel {
    query: string;
    bannedGlobally?: boolean;
    profile?: { username?: string | null };
    referral?: { referral_code: string; referral_count: number; referred_by?: string | null };
    balances?: any[];
    timeOnPlatform?: any;
    aggregates?: any;
    recentAudit?: any[];
    recentBets?: any[];
}

/** Missing / non-finite values render as '—', never as a fake 0 or $NaN. */
const num = (v: unknown, digits = 6) => {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
};

/** Net of one bet row (payout - stake) with the same missing-value guard. */
const betNet = (row: { payout?: unknown; amount?: unknown }): string => {
    const payout = Number(row?.payout ?? 0);
    const amount = Number(row?.amount ?? 0);
    if (!Number.isFinite(payout) || !Number.isFinite(amount)) return '—';
    return (payout - amount).toLocaleString(undefined, { maximumFractionDigits: 6 });
};

export default function WalletIntelPanel({
    filters, nonce, onUnauthorized, onPatch,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
}) {
    const [draft, setDraft] = useState(filters.address);
    // Keep the input in sync when the URL changes (back button / shared link).
    useEffect(() => setDraft(filters.address), [filters.address]);

    const url = useMemo(
        () => (filters.address ? `/api/admin/wallet-insights?address=${encodeURIComponent(filters.address)}` : null),
        [filters.address],
    );
    const intel = useAdminFetch<WalletIntel>(url, { nonce, onUnauthorized });

    const submit = () => {
        const q = draft.trim();
        if (!q) {
            onPatch({ address: '' });
            return;
        }
        onPatch({ address: q.slice(0, 128) });
    };

    const data = intel.data;
    const betting = data?.aggregates?.betting;

    return (
        <div className="p-8 space-y-8 text-left">
            <div className="space-y-2">
                <p className="text-xs font-black uppercase tracking-widest text-white/35">Wallet intelligence</p>
                <p className="text-sm text-white/60 max-w-3xl leading-relaxed">
                    Enter any address. We match stored variants (e.g. EVM checksum) and aggregate{' '}
                    <span className="text-white/70">house balances</span>,{' '}
                    <span className="text-white/70">audit log</span>,{' '}
                    <span className="text-white/70">bets</span>, and{' '}
                    <span className="text-white/70">withdrawal requests</span>.
                    Amounts are <span className="text-amber-200/90">native units per currency</span>, not USD.
                </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center max-w-4xl">
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                    placeholder="e.g. 0x…"
                    aria-label="Wallet address to investigate"
                    className="flex-1 px-5 py-3 rounded-xl bg-black/50 border border-white/10 text-white text-sm font-mono placeholder:text-white/25 focus:outline-none focus:border-white/30 transition-all"
                />
                <button
                    type="button"
                    onClick={submit}
                    disabled={intel.loading}
                    className="px-8 py-3 rounded-xl bg-white text-black font-black uppercase text-xs tracking-widest hover:bg-white/90 disabled:opacity-50"
                >
                    {intel.loading ? 'Scanning…' : 'Analyze wallet'}
                </button>
                {filters.address && (
                    <button
                        type="button"
                        onClick={() => { setDraft(''); onPatch({ address: '' }); }}
                        className="px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white/60 font-black uppercase text-xs tracking-widest hover:text-white transition-all"
                    >
                        Clear
                    </button>
                )}
            </div>

            {!filters.address && (
                <EmptyState
                    title="No address selected"
                    hint="Paste a wallet above, or open /dashboard?address=0x… directly — the link is shareable."
                />
            )}

            {intel.error && filters.address ? (
                <ErrorState message={intel.error} onRetry={intel.reload} retrying={intel.loading} />
            ) : null}

            {filters.address && intel.loading && !data && (
                <div className="space-y-4 border-t border-white/10 pt-8" role="status" aria-label="Loading wallet">
                    <div className="h-8 w-96 rounded bg-white/[0.04] animate-pulse" />
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="h-44 rounded-2xl bg-white/[0.03] animate-pulse" />
                        <div className="h-44 rounded-2xl bg-white/[0.03] animate-pulse" />
                    </div>
                </div>
            )}

            {data && !intel.error && (
                <div className="space-y-8 border-t border-white/10 pt-8">
                    <div className="flex flex-wrap gap-3 text-sm items-center">
                        <span className="px-3 py-1 rounded-lg bg-white/5 border border-white/10 font-mono text-white/80">
                            Query: <span className="text-white">{data.query}</span>
                        </span>
                        {data.bannedGlobally && (
                            <span className="px-3 py-1 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300 font-black uppercase text-xs">
                                Globally banned
                            </span>
                        )}
                        {data.aggregates?.audit?.auditTruncated && (
                            <span className="text-amber-400/90 text-xs">Audit log truncated (cap {data.aggregates.audit.cappedAt})</span>
                        )}
                        {data.aggregates?.betting?.betsTruncated && (
                            <span className="text-amber-400/90 text-xs">Bets truncated (cap {data.aggregates.betting.betsCappedAt})</span>
                        )}
                    </div>

                    {data.timeOnPlatform && (
                        <div className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.04] p-6 space-y-4">
                            <p className="text-xs font-black uppercase tracking-widest text-violet-300/60">Time on platform</p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <div>
                                    <p className="text-xs uppercase text-white/35">Total dwell time</p>
                                    <p className="font-mono text-2xl text-violet-300 font-black">{data.timeOnPlatform.formatted || '0s'}</p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase text-white/35">Sessions</p>
                                    <p className="font-mono text-2xl text-white tabular-nums">{data.timeOnPlatform.totalSessions}</p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase text-white/35">First seen</p>
                                    <p className="font-mono text-xs text-white/70 mt-1">
                                        {data.timeOnPlatform.firstSeen ? new Date(data.timeOnPlatform.firstSeen).toLocaleString() : '—'}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase text-white/35">Last seen</p>
                                    <p className="font-mono text-xs text-white/70 mt-1">
                                        {data.timeOnPlatform.lastSeen ? new Date(data.timeOnPlatform.lastSeen).toLocaleString() : '—'}
                                    </p>
                                </div>
                            </div>
                            {data.timeOnPlatform.recentSessions?.length > 0 && (
                                <details className="mt-2">
                                    <summary className="text-xs text-white/40 uppercase cursor-pointer hover:text-white/60 transition-colors">
                                        Session history ({data.timeOnPlatform.recentSessions.length} shown)
                                    </summary>
                                    <div className="mt-3 space-y-1 max-h-64 overflow-y-auto">
                                        {data.timeOnPlatform.recentSessions.map((s: any) => (
                                            <div key={s.id} className="flex flex-wrap gap-2 text-xs font-mono border-b border-white/5 pb-1 text-white/50">
                                                <span className="text-violet-300/70">{s.network}</span>
                                                <span>{new Date(s.started_at).toLocaleString()}</span>
                                                <span className="text-white/30">→</span>
                                                <span>{s.ended_at ? new Date(s.ended_at).toLocaleString() : <span className="text-emerald-400">active</span>}</span>
                                                <span className="ml-auto text-violet-200/60">{s.durationSeconds}s</span>
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            )}
                            {data.timeOnPlatform.totalSessions === 0 && (
                                <p className="text-xs text-white/25">No session data yet. Sessions are recorded once the user connects their wallet.</p>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
                            <p className="text-xs font-black uppercase tracking-widest text-white/40">House balances (per currency)</p>
                            {(!data.balances || data.balances.length === 0) && (
                                <p className="text-white/30 text-sm">No balance rows for this address.</p>
                            )}
                            <div className="space-y-2">
                                {(data.balances ?? []).map((b: any) => (
                                    <div key={b.currency + (b.status || '')} className="flex flex-wrap justify-between gap-2 text-sm border-b border-white/5 pb-2">
                                        <span className="font-mono text-white/70">{b.currency}</span>
                                        <span className="font-mono text-white">Balance {num(b.balance)}</span>
                                        <span className={`text-xs font-black uppercase ${b.status === 'active' ? 'text-emerald-400' : 'text-rose-400'}`}>{b.status}</span>
                                        <span className="text-xs text-white/40 w-full sm:w-auto">
                                            Withdrawable now:{' '}
                                            <span className="text-emerald-300/90 font-mono">{num(b.withdrawableNow)}</span>
                                            {data.bannedGlobally && ' (0 if banned)'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
                            <p className="text-xs font-black uppercase tracking-widest text-white/40">Deposits &amp; withdrawals (audit log)</p>
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <div>
                                    <p className="text-xs uppercase text-white/35">Deposits count</p>
                                    <p className="font-mono text-lg text-emerald-400 tabular-nums">{data.aggregates?.audit?.depositCount ?? 0}</p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase text-white/35">Withdrawals count</p>
                                    <p className="font-mono text-lg text-rose-300 tabular-nums">{data.aggregates?.audit?.withdrawalCount ?? 0}</p>
                                </div>
                            </div>
                            {(['totalDepositsByCurrency', 'totalWithdrawalsByCurrency'] as const).map((field) => (
                                <div key={field} className="space-y-1 text-xs font-mono">
                                    <p className="text-xs text-white/40 uppercase">
                                        {field === 'totalDepositsByCurrency' ? 'Σ deposits by currency' : 'Σ withdrawals by currency'}
                                    </p>
                                    {Object.entries(data.aggregates?.audit?.[field] || {}).map(([c, v]) => (
                                        <div key={c} className={`flex justify-between ${field.startsWith('totalDeposits') ? 'text-emerald-300/90' : 'text-rose-300/90'}`}>
                                            <span>{c}</span>
                                            <span>{field.startsWith('totalDeposits') ? '+' : '-'}{num(v)}</span>
                                        </div>
                                    ))}
                                    {Object.keys(data.aggregates?.audit?.[field] || {}).length === 0 && (
                                        <span className="text-white/25">—</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-6">
                        <p className="text-xs font-black uppercase tracking-widest text-white/40">Betting performance</p>
                        {['real', 'demo'].map((mode) => {
                            const b = betting?.[mode];
                            if (!b) return null;
                            return (
                                <div key={mode} className="border border-white/5 rounded-xl p-4 space-y-2">
                                    <p className="text-xs font-black uppercase text-white/50">
                                        {mode === 'real' ? 'Real money bets only (demo play excluded)' : 'Demo play-money bets (never real)'}
                                    </p>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                                        <div><span className="text-white/35 text-xs uppercase block">Bets</span><span className="font-mono text-white tabular-nums">{b.totalBets}</span></div>
                                        <div><span className="text-white/35 text-xs uppercase block">Wins</span><span className="font-mono text-emerald-400 tabular-nums">{b.wins}</span></div>
                                        <div><span className="text-white/35 text-xs uppercase block">Losses</span><span className="font-mono text-rose-400 tabular-nums">{b.losses}</span></div>
                                        <div><span className="text-white/35 text-xs uppercase block">Win rate</span><span className="font-mono text-white tabular-nums">{(Number(b.winRate) * 100).toFixed(1)}%</span></div>
                                        <div><span className="text-white/35 text-xs uppercase block">Total wagered</span><span className="font-mono text-white tabular-nums">{num(b.totalWagered, 4)}</span></div>
                                        <div><span className="text-white/35 text-xs uppercase block">Total payout</span><span className="font-mono text-white tabular-nums">{num(b.totalPayoutReceived, 4)}</span></div>
                                        <div>
                                            <span className="text-white/35 text-xs uppercase block">User net (payout−wager)</span>
                                            <span className={`font-mono tabular-nums ${Number(b.netBettingPLUser) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                                                {num(b.netBettingPLUser, 4)}
                                            </span>
                                        </div>
                                    </div>
                                    {b.byNetwork && Object.keys(b.byNetwork).length > 0 && (
                                        <div className="mt-3 pt-3 border-t border-white/5 text-sm font-mono space-y-1">
                                            <p className="text-xs uppercase text-white/30 mb-1">By network</p>
                                            {Object.entries(b.byNetwork).map(([net, row]: [string, any]) => (
                                                <div key={net} className="flex flex-wrap gap-x-4 justify-between text-white/70">
                                                    <span className="text-white">{net}</span>
                                                    <span className="tabular-nums">net {num(row.net, 4)}</span>
                                                    <span className="text-white/40">{row.bets} bets · {row.wins}W/{row.losses}L</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {betting?.real == null && betting?.demo == null && (
                            <p className="text-xs text-white/25">No settled rounds recorded for this wallet.</p>
                        )}
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
                            <p className="text-xs font-black uppercase tracking-widest text-white/40 mb-4">Withdrawal requests</p>
                            <p className="text-xs text-white/50 mb-2">
                                Pending: {data.aggregates?.withdrawals?.pending?.length ?? 0} ·{' '}
                                Accepted: {data.aggregates?.withdrawals?.accepted?.length ?? 0} ·{' '}
                                Rejected: {data.aggregates?.withdrawals?.rejected?.length ?? 0}
                            </p>
                            <div className="text-xs font-mono space-y-1">
                                <p className="text-xs uppercase text-white/35">Pending amount by currency</p>
                                {Object.entries(data.aggregates?.withdrawals?.pendingTotalByCurrency || {}).map(([c, v]) => (
                                    <div key={c} className="flex justify-between text-amber-200/90">
                                        <span>{c}</span>
                                        <span className="tabular-nums">{num(v)}</span>
                                    </div>
                                ))}
                                {Object.keys(data.aggregates?.withdrawals?.pendingTotalByCurrency || {}).length === 0 && (
                                    <span className="text-white/25">No pending withdrawals</span>
                                )}
                            </div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-2">
                            <p className="text-xs font-black uppercase tracking-widest text-white/40">Profile &amp; referrals</p>
                            <p className="text-sm text-white/60">
                                Username: <span className="text-white font-mono">{data.profile?.username || '—'}</span>
                            </p>
                            {data.referral && (
                                <p className="text-xs text-white/50 font-mono">
                                    Code {data.referral.referral_code} · {data.referral.referral_count} referrals
                                    {data.referral.referred_by ? ` · referred by ${data.referral.referred_by}` : ''}
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 overflow-x-auto">
                        <p className="text-xs font-black uppercase tracking-widest text-white/40 mb-4">Recent audit (latest 80)</p>
                        {(data.recentAudit ?? []).length === 0 ? (
                            <p className="text-xs text-white/25">No audit rows for this wallet.</p>
                        ) : (
                            <table className="w-full text-left text-sm font-mono">
                                <thead>
                                    <tr className="text-white/35 border-b border-white/10">
                                        <th className="py-2 pr-4 text-left">Time</th>
                                        <th className="py-2 pr-4 text-left">Type</th>
                                        <th className="py-2 pr-4 text-left">CCY</th>
                                        <th className="py-2 pr-4 text-left">Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(data.recentAudit ?? []).map((r: any) => (
                                        <tr key={r.id} className="border-b border-white/5 text-white/70">
                                            <td className="py-2 pr-4 whitespace-nowrap">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                                            <td className="py-2 pr-4">{r.operation_type}</td>
                                            <td className="py-2 pr-4">{r.currency}</td>
                                            <td className="py-2 pr-4 tabular-nums">{num(r.amount)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 overflow-x-auto">
                        <p className="text-xs font-black uppercase tracking-widest text-white/40 mb-4">Recent bets (latest 80)</p>
                        {(data.recentBets ?? []).length === 0 ? (
                            <p className="text-xs text-white/25">No rounds recorded for this wallet.</p>
                        ) : (
                            <table className="w-full text-left text-sm font-mono">
                                <thead>
                                    <tr className="text-white/35 border-b border-white/10">
                                        <th className="py-2 pr-4 text-left">Time</th>
                                        <th className="py-2 pr-4 text-left">Asset</th>
                                        <th className="py-2 pr-4 text-left">Net</th>
                                        <th className="py-2 pr-4 text-left">Won</th>
                                        <th className="py-2 pr-4 text-left">Network</th>
                                        <th className="py-2 pr-4 text-left">Account</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(data.recentBets ?? []).map((r: any) => (
                                        <tr key={r.id} className="border-b border-white/5 text-white/70">
                                            <td className="py-2 pr-4 whitespace-nowrap">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                                            <td className="py-2 pr-4">{r.asset}</td>
                                            <td className="py-2 pr-4 tabular-nums">{betNet(r)}</td>
                                            <td className="py-2 pr-4">{r.won ? 'yes' : 'no'}</td>
                                            <td className="py-2 pr-4">{r.network}</td>
                                            <td className="py-2 pr-4">
                                                {isDemoBetHistoryRow(r) ? (
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase bg-amber-500/10 text-amber-500 border border-amber-500/20">Demo</span>
                                                ) : (
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Real</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
