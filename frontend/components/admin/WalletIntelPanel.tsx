'use client';


import { useEffect, useMemo, useState } from 'react';
import { isDemoBetHistoryRow } from '@/lib/admin/walletAddressVariants';
import { type DashFilters } from './dashQuery';
import { EmptyState, ErrorState } from './AdminUi';
import { useAdminFetch } from './useAdminFetch';

interface WalletIntel {
    query: string;
    bannedGlobally?: boolean;
    referral?: { referral_code: string; referral_count: number; referred_by?: string | null };
    balances?: any[];
    timeOnPlatform?: any;
    aggregates?: any;
    recentAudit?: any[];
    recentBets?: any[];
}

const num = (v: unknown, digits = 6) => {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
};

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
                <p className="text-xs font-black uppercase tracking-widest text-subtle">Wallet intelligence</p>
                <p className="text-sm text-muted max-w-3xl leading-relaxed">
                    Enter any address. We match stored variants (e.g. EVM checksum) and aggregate{' '}
                    <span className="text-muted">house balances</span>,{' '}
                    <span className="text-muted">audit log</span>,{' '}
                    <span className="text-muted">bets</span>, and{' '}
                    <span className="text-muted">withdrawal requests</span>.
                    Amounts are <span className="text-down">native units per currency</span>, not USD.
                </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center max-w-4xl">
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                    placeholder="e.g. 0x…"
                    aria-label="Wallet address to investigate"
                    className="flex-1 px-5 py-3 rounded-xl bg-ink/50 border border-line text-ink text-sm font-mono placeholder:text-faint focus:outline-none focus:border-ink/20 transition-all"
                />
                <button
                    type="button"
                    onClick={submit}
                    disabled={intel.loading}
                    className="px-8 py-3 rounded-xl bg-ink text-white font-black uppercase text-xs tracking-widest disabled:opacity-50"
                >
                    {intel.loading ? 'Scanning…' : 'Analyze wallet'}
                </button>
                {filters.address && (
                    <button
                        type="button"
                        onClick={() => { setDraft(''); onPatch({ address: '' }); }}
                        className="px-4 py-3 rounded-xl bg-surface border border-line text-muted font-black uppercase text-xs tracking-widest hover:text-ink transition-all"
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
                <div className="space-y-4 border-t border-line pt-8" role="status" aria-label="Loading wallet">
                    <div className="h-8 w-96 rounded bg-surface animate-pulse" />
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="h-44 rounded-2xl bg-surface animate-pulse" />
                        <div className="h-44 rounded-2xl bg-surface animate-pulse" />
                    </div>
                </div>
            )}

            {data && !intel.error && (
                <div className="space-y-8 border-t border-line pt-8">
                    <div className="flex flex-wrap gap-3 text-sm items-center">
                        <span className="px-3 py-1 rounded-lg bg-surface border border-line font-mono text-ink">
                            Query: <span className="text-ink">{data.query}</span>
                        </span>
                        {data.bannedGlobally && (
                            <span className="px-3 py-1 rounded-lg bg-down-soft border border-down/30 text-down font-black uppercase text-xs">
                                Globally banned
                            </span>
                        )}
                        {data.aggregates?.audit?.auditTruncated && (
                            <span className="text-down text-xs">Audit log truncated (cap {data.aggregates.audit.cappedAt})</span>
                        )}
                        {data.aggregates?.betting?.betsTruncated && (
                            <span className="text-down text-xs">Bets truncated (cap {data.aggregates.betting.betsCappedAt})</span>
                        )}
                    </div>

                    {data.timeOnPlatform && (
                        <div className="rounded-2xl border border-up/30 bg-up-soft p-6 space-y-4">
                            <p className="text-xs font-black uppercase tracking-widest text-up">Time on platform</p>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <div>
                                    <p className="text-xs uppercase text-subtle">Total dwell time</p>
                                    <p className="font-mono text-2xl text-up font-black">{data.timeOnPlatform.formatted || '0s'}</p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase text-subtle">Sessions</p>
                                    <p className="font-mono text-2xl text-ink tabular-nums">{data.timeOnPlatform.totalSessions}</p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase text-subtle">First seen</p>
                                    <p className="font-mono text-xs text-muted mt-1">
                                        {data.timeOnPlatform.firstSeen ? new Date(data.timeOnPlatform.firstSeen).toLocaleString() : '—'}
                                    </p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase text-subtle">Last seen</p>
                                    <p className="font-mono text-xs text-muted mt-1">
                                        {data.timeOnPlatform.lastSeen ? new Date(data.timeOnPlatform.lastSeen).toLocaleString() : '—'}
                                    </p>
                                </div>
                            </div>
                            {data.timeOnPlatform.recentSessions?.length > 0 && (
                                <details className="mt-2">
                                    <summary className="text-xs text-subtle uppercase cursor-pointer hover:text-muted transition-colors">
                                        Session history ({data.timeOnPlatform.recentSessions.length} shown)
                                    </summary>
                                    <div className="mt-3 space-y-1 max-h-64 overflow-y-auto">
                                        {data.timeOnPlatform.recentSessions.map((s: any) => (
                                            <div key={s.id} className="flex flex-wrap gap-2 text-xs font-mono border-b border-line pb-1 text-muted">
                                                <span className="text-up">{s.network}</span>
                                                <span>{new Date(s.started_at).toLocaleString()}</span>
                                                <span className="text-subtle">→</span>
                                                <span>{s.ended_at ? new Date(s.ended_at).toLocaleString() : <span className="text-up">active</span>}</span>
                                                <span className="ml-auto text-up">{s.durationSeconds}s</span>
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            )}
                            {data.timeOnPlatform.totalSessions === 0 && (
                                <p className="text-xs text-faint">No session data yet. Sessions are recorded once the user connects their wallet.</p>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="rounded-2xl border border-line bg-surface p-6 space-y-4">
                            <p className="text-xs font-black uppercase tracking-widest text-subtle">House balances (per currency)</p>
                            {(!data.balances || data.balances.length === 0) && (
                                <p className="text-subtle text-sm">No balance rows for this address.</p>
                            )}
                            <div className="space-y-2">
                                {(data.balances ?? []).map((b: any) => (
                                    <div key={b.currency + (b.status || '')} className="flex flex-wrap justify-between gap-2 text-sm border-b border-line pb-2">
                                        <span className="font-mono text-muted">{b.currency}</span>
                                        <span className="font-mono text-ink">Balance {num(b.balance)}</span>
                                        <span className={`text-xs font-black uppercase ${b.status === 'active' ? 'text-up' : 'text-down'}`}>{b.status}</span>
                                        <span className="text-xs text-subtle w-full sm:w-auto">
                                            Withdrawable now:{' '}
                                            <span className="text-up font-mono">{num(b.withdrawableNow)}</span>
                                            {data.bannedGlobally && ' (0 if banned)'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="rounded-2xl border border-line bg-surface p-6 space-y-4">
                            <p className="text-xs font-black uppercase tracking-widest text-subtle">Deposits &amp; withdrawals (audit log)</p>
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <div>
                                    <p className="text-xs uppercase text-subtle">Deposits count</p>
                                    <p className="font-mono text-lg text-up tabular-nums">{data.aggregates?.audit?.depositCount ?? 0}</p>
                                </div>
                                <div>
                                    <p className="text-xs uppercase text-subtle">Withdrawals count</p>
                                    <p className="font-mono text-lg text-down tabular-nums">{data.aggregates?.audit?.withdrawalCount ?? 0}</p>
                                </div>
                            </div>
                            {(['totalDepositsByCurrency', 'totalWithdrawalsByCurrency'] as const).map((field) => (
                                <div key={field} className="space-y-1 text-xs font-mono">
                                    <p className="text-xs text-subtle uppercase">
                                        {field === 'totalDepositsByCurrency' ? 'Σ deposits by currency' : 'Σ withdrawals by currency'}
                                    </p>
                                    {Object.entries(data.aggregates?.audit?.[field] || {}).map(([c, v]) => (
                                        <div key={c} className={`flex justify-between ${field.startsWith('totalDeposits') ? 'text-up' : 'text-down'}`}>
                                            <span>{c}</span>
                                            <span>{field.startsWith('totalDeposits') ? '+' : '-'}{num(v)}</span>
                                        </div>
                                    ))}
                                    {Object.keys(data.aggregates?.audit?.[field] || {}).length === 0 && (
                                        <span className="text-faint">—</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-line bg-surface p-6 space-y-6">
                        <p className="text-xs font-black uppercase tracking-widest text-subtle">Betting performance</p>
                        {['real', 'demo'].map((mode) => {
                            const b = betting?.[mode];
                            if (!b) return null;
                            return (
                                <div key={mode} className="border border-line rounded-xl p-4 space-y-2">
                                    <p className="text-xs font-black uppercase text-muted">
                                        {mode === 'real' ? 'Real money bets only (demo play excluded)' : 'Demo play-money bets (never real)'}
                                    </p>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                                        <div><span className="text-subtle text-xs uppercase block">Bets</span><span className="font-mono text-ink tabular-nums">{b.totalBets}</span></div>
                                        <div><span className="text-subtle text-xs uppercase block">Wins</span><span className="font-mono text-up tabular-nums">{b.wins}</span></div>
                                        <div><span className="text-subtle text-xs uppercase block">Losses</span><span className="font-mono text-down tabular-nums">{b.losses}</span></div>
                                        <div><span className="text-subtle text-xs uppercase block">Win rate</span><span className="font-mono text-ink tabular-nums">{(Number(b.winRate) * 100).toFixed(1)}%</span></div>
                                        <div><span className="text-subtle text-xs uppercase block">Total wagered</span><span className="font-mono text-ink tabular-nums">{num(b.totalWagered, 4)}</span></div>
                                        <div><span className="text-subtle text-xs uppercase block">Total payout</span><span className="font-mono text-ink tabular-nums">{num(b.totalPayoutReceived, 4)}</span></div>
                                        <div>
                                            <span className="text-subtle text-xs uppercase block">User net (payout−wager)</span>
                                            <span className={`font-mono tabular-nums ${Number(b.netBettingPLUser) >= 0 ? 'text-up' : 'text-down'}`}>
                                                {num(b.netBettingPLUser, 4)}
                                            </span>
                                        </div>
                                    </div>
                                    {b.byNetwork && Object.keys(b.byNetwork).length > 0 && (
                                        <div className="mt-3 pt-3 border-t border-line text-sm font-mono space-y-1">
                                            <p className="text-xs uppercase text-subtle mb-1">By network</p>
                                            {Object.entries(b.byNetwork).map(([net, row]: [string, any]) => (
                                                <div key={net} className="flex flex-wrap gap-x-4 justify-between text-muted">
                                                    <span className="text-ink">{net}</span>
                                                    <span className="tabular-nums">net {num(row.net, 4)}</span>
                                                    <span className="text-subtle">{row.bets} bets · {row.wins}W/{row.losses}L</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {betting?.real == null && betting?.demo == null && (
                            <p className="text-xs text-faint">No settled rounds recorded for this wallet.</p>
                        )}
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="rounded-2xl border border-line bg-surface p-6">
                            <p className="text-xs font-black uppercase tracking-widest text-subtle mb-4">Withdrawal requests</p>
                            <p className="text-xs text-muted mb-2">
                                Pending: {data.aggregates?.withdrawals?.pending?.length ?? 0} ·{' '}
                                Accepted: {data.aggregates?.withdrawals?.accepted?.length ?? 0} ·{' '}
                                Rejected: {data.aggregates?.withdrawals?.rejected?.length ?? 0}
                            </p>
                            <div className="text-xs font-mono space-y-1">
                                <p className="text-xs uppercase text-subtle">Pending amount by currency</p>
                                {Object.entries(data.aggregates?.withdrawals?.pendingTotalByCurrency || {}).map(([c, v]) => (
                                    <div key={c} className="flex justify-between text-down">
                                        <span>{c}</span>
                                        <span className="tabular-nums">{num(v)}</span>
                                    </div>
                                ))}
                                {Object.keys(data.aggregates?.withdrawals?.pendingTotalByCurrency || {}).length === 0 && (
                                    <span className="text-faint">No pending withdrawals</span>
                                )}
                            </div>
                        </div>
                        <div className="rounded-2xl border border-line bg-surface p-6 space-y-2">
                            <p className="text-xs font-black uppercase tracking-widest text-subtle">Referrals</p>
                            {data.referral && (
                                <p className="text-xs text-muted font-mono">
                                    Code {data.referral.referral_code} · {data.referral.referral_count} referrals
                                    {data.referral.referred_by ? ` · referred by ${data.referral.referred_by}` : ''}
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-line bg-surface p-6 overflow-x-auto">
                        <p className="text-xs font-black uppercase tracking-widest text-subtle mb-4">Recent audit (latest 80)</p>
                        {(data.recentAudit ?? []).length === 0 ? (
                            <p className="text-xs text-faint">No audit rows for this wallet.</p>
                        ) : (
                            <table className="w-full text-left text-sm font-mono">
                                <thead>
                                    <tr className="text-subtle border-b border-line">
                                        <th className="py-2 pr-4 text-left">Time</th>
                                        <th className="py-2 pr-4 text-left">Type</th>
                                        <th className="py-2 pr-4 text-left">CCY</th>
                                        <th className="py-2 pr-4 text-left">Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(data.recentAudit ?? []).map((r: any) => (
                                        <tr key={r.id} className="border-b border-line text-muted">
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

                    <div className="rounded-2xl border border-line bg-surface p-6 overflow-x-auto">
                        <p className="text-xs font-black uppercase tracking-widest text-subtle mb-4">Recent bets (latest 80)</p>
                        {(data.recentBets ?? []).length === 0 ? (
                            <p className="text-xs text-faint">No rounds recorded for this wallet.</p>
                        ) : (
                            <table className="w-full text-left text-sm font-mono">
                                <thead>
                                    <tr className="text-subtle border-b border-line">
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
                                        <tr key={r.id} className="border-b border-line text-muted">
                                            <td className="py-2 pr-4 whitespace-nowrap">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                                            <td className="py-2 pr-4">{r.asset}</td>
                                            <td className="py-2 pr-4 tabular-nums">{betNet(r)}</td>
                                            <td className="py-2 pr-4">{r.won ? 'yes' : 'no'}</td>
                                            <td className="py-2 pr-4">{r.network}</td>
                                            <td className="py-2 pr-4">
                                                {isDemoBetHistoryRow(r) ? (
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase bg-down-soft text-down border border-down/30">Demo</span>
                                                ) : (
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase bg-up-soft text-up border border-up/30">Real</span>
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
