'use client';

/**
 * Gameplay panel: per-mode house analytics cards (real wallets only) plus the
 * bet history list. History filtering/pagination moved server-side; the
 * real/demo account split and the global filters deep-link via URL params.
 */

import { useMemo } from 'react';
import { apiExportQuery, apiListQuery, type DashFilters } from './dashQuery';
import { EmptyState, ErrorState, Pagination, Table, THead, shortenAddress } from './AdminUi';
import { useAdminFetch } from './useAdminFetch';
import { isDemoBetHistoryRow } from '@/lib/admin/walletAddressVariants';
import type { BetHistory } from './types';
import { tokenSymbolForNetwork } from './types';

interface ModeStatRow {
    mode: string;
    label: string;
    totalBets: number;
    wins: number;
    losses: number;
    winRate: number;
    totalWagered: number;
    totalPaidOut: number;
    housePnL: number;
    avgMultiplier: number;
    byChain: Record<string, { totalBets: number; wins: number; wagered: number; paid: number; housePnL: number }>;
    topAssets: { asset: string; count: number }[];
}

interface ModeAnalyticsApi {
    real?: ModeStatRow[];
    combined?: ModeStatRow[];
    totalRealBets?: number;
    error?: string;
}

interface GameHistoryApi {
    bets?: BetHistory[];
    total?: number;
    limit?: number;
    offset?: number;
    scanTruncated?: boolean;
}

const BREAK_EVEN_AT_190 = 52.6;

function ModeCards({ modes }: { modes: ModeStatRow[] | undefined }) {
    const modeLabels: Record<string, string> = { binomo: 'Classic', box: 'Box', draw: 'Draw' };
    const known = (['binomo', 'box', 'draw'] as const).map((modeKey) => ({
        modeKey,
        m: (modes ?? []).find((x) => x.mode === modeKey),
    }));
    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {known.map(({ modeKey, m }) => {
                if (!m) {
                    return (
                        <div key={modeKey} className="rounded-2xl border border-line bg-surface p-6 flex flex-col gap-2">
                            <p className="text-xs font-black uppercase tracking-widest text-subtle">{modeLabels[modeKey]}</p>
                            <p className="text-xs text-faint">No rounds recorded yet</p>
                        </div>
                    );
                }
                const housePnLPositive = m.housePnL >= 0;
                return (
                    <div key={modeKey} className="rounded-2xl border border-line bg-surface p-6 space-y-5">
                        <div className="flex items-center justify-between border-b border-line pb-4">
                            <p className="text-xs font-black uppercase tracking-widest text-muted">{modeLabels[modeKey]}</p>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${housePnLPositive ? 'border-up/30 text-up bg-up-soft' : 'border-down/30 text-down bg-down-soft'}`}>
                                {housePnLPositive ? '▲ House profit' : '▼ House loss'}
                            </span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-faint mb-1">Rounds</p>
                                <p className="text-2xl font-black tabular-nums text-ink">{m.totalBets.toLocaleString()}</p>
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-faint mb-1">Win Rate</p>
                                <p className={`text-2xl font-black tabular-nums ${m.winRate > BREAK_EVEN_AT_190 ? 'text-down' : 'text-up'}`}>{m.winRate}%</p>
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-faint mb-1">Wins / Losses</p>
                                <p className="text-sm font-bold tabular-nums">
                                    <span className="text-up">{m.wins.toLocaleString()}</span>
                                    <span className="text-faint"> / </span>
                                    <span className="text-down">{m.losses.toLocaleString()}</span>
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-faint mb-1">Avg Multiplier</p>
                                <p className="text-sm font-bold tabular-nums text-muted">{m.avgMultiplier}×</p>
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <div className="flex justify-between text-[10px] text-faint">
                                <span className="font-black uppercase tracking-widest">User win rate</span>
                                <span className={`font-bold ${m.winRate > BREAK_EVEN_AT_190 ? 'text-down' : 'text-up'}`}>
                                    {m.winRate > BREAK_EVEN_AT_190
                                        ? `+${(m.winRate - BREAK_EVEN_AT_190).toFixed(1)}% above break-even`
                                        : `${(BREAK_EVEN_AT_190 - m.winRate).toFixed(1)}% below break-even`}
                                </span>
                            </div>
                            <div className="relative h-1 w-full bg-surface rounded-full overflow-visible">
                                <div
                                    className={`h-full rounded-full ${m.winRate > BREAK_EVEN_AT_190 ? 'bg-down-soft' : 'bg-up-soft'}`}
                                    style={{ width: `${Math.min(m.winRate, 100)}%` }}
                                />
                                <div className="absolute top-0 h-full w-px bg-surface" style={{ left: `${BREAK_EVEN_AT_190}%` }} />
                            </div>
                        </div>
                        {Object.keys(m.byChain ?? {}).length > 0 && (
                            <div className="space-y-2 pt-1 border-t border-line">
                                <p className="text-[10px] font-black uppercase tracking-widest text-faint">House P&amp;L by Chain (native units)</p>
                                {Object.entries(m.byChain as Record<string, any>)
                                    .sort((a, b) => Math.abs(b[1].housePnL) - Math.abs(a[1].housePnL))
                                    .slice(0, 4)
                                    .map(([chain, c]) => (
                                        <div key={chain} className="flex items-center justify-between">
                                            <span className="text-xs font-mono text-subtle">{chain}</span>
                                            <span className="font-mono text-xs font-bold tabular-nums">
                                                <span className={c.housePnL >= 0 ? 'text-up' : 'text-down'}>
                                                    {c.housePnL >= 0 ? '+' : ''}{c.housePnL.toFixed(4)}
                                                </span>
                                                <span className="text-faint text-[10px] ml-1.5">({c.wins}/{c.totalBets} wins)</span>
                                            </span>
                                        </div>
                                    ))}
                            </div>
                        )}
                        {m.topAssets && m.topAssets.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-1 border-t border-line">
                                {m.topAssets.map((a) => (
                                    <span key={a.asset} className="text-[10px] font-bold px-2 py-0.5 rounded border border-line text-subtle">
                                        {a.asset} <span className="text-faint">{a.count}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export default function GameplayPanel({
    filters, nonce, onUnauthorized, onPatch,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
}) {
    const historyUrl = useMemo(() => `/api/admin/game-history?${apiListQuery(filters)}`, [filters]);
    const modes = useAdminFetch<ModeAnalyticsApi>('/api/admin/mode-analytics', { nonce, onUnauthorized });
    const history = useAdminFetch<GameHistoryApi>(historyUrl, { nonce, onUnauthorized });

    const bets = history.data?.bets ?? [];
    const exportHref = `/api/admin/export?dataset=game_history&${apiExportQuery(filters, ['won', 'lost'])}`;

    return (
        <div className="text-left space-y-6">
            {/* Mode analytics */}
            <div className="px-8 pt-8 pb-6 space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="space-y-1">
                        <p className="text-xs font-black uppercase tracking-widest text-subtle">Game Mode P&amp;L</p>
                        <p className="text-muted text-sm">Real wallets only — per-mode house performance</p>
                    </div>
                    <div className="flex gap-2 items-center">
                        {typeof modes.data?.totalRealBets === 'number' && (
                            <span className="text-[10px] font-bold uppercase tracking-widest text-faint border border-line rounded px-2 py-1">
                                {modes.data.totalRealBets.toLocaleString()} rounds
                            </span>
                        )}
                        <a
                            href={exportHref}
                            className="px-4 py-2 bg-up-soft border border-up/30 text-up font-black uppercase text-[10px] tracking-widest rounded-lg hover:bg-up-soft transition-all"
                        >
                            Export CSV
                        </a>
                    </div>
                </div>
                {modes.error && <ErrorState message={modes.error} onRetry={modes.reload} retrying={modes.loading} />}
                {modes.loading && !modes.data && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="h-64 rounded-2xl bg-surface animate-pulse" />
                        ))}
                    </div>
                )}
                {modes.data && !modes.error && <ModeCards modes={modes.data.real} />}
                <p className="text-[10px] text-faint leading-relaxed">
                    Break-even win rate at 1.9× multiplier is {BREAK_EVEN_AT_190}%. Rates <span className="text-down">above</span> this mean the house loses money on that mode.
                    P&amp;L values are in each chain&apos;s native token — <span className="text-subtle">do not sum across chains.</span>
                </p>
            </div>

            {/* Account filter — writes ?account= so the view is shareable */}
            <div className="p-6 border-b border-line flex flex-wrap gap-6 items-center bg-surface">
                <div className="flex gap-2 bg-ink/40 p-1 rounded-xl border border-line" role="tablist" aria-label="Account filter">
                    {(['all', 'real', 'demo'] as const).map((mode) => (
                        <button
                            key={mode}
                            role="tab"
                            aria-selected={filters.account === mode}
                            onClick={() => onPatch({ account: mode, offset: 0 })}
                            className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${
                                filters.account === mode
                                    ? mode === 'all'
                                        ? 'bg-ink text-white'
                                        : mode === 'real'
                                            ? 'bg-up text-white'
                                            : 'bg-down text-white'
                                    : 'text-subtle hover:text-ink'
                            }`}
                        >
                            {mode === 'all' ? 'All Modes' : mode === 'real' ? 'Real Wallet' : 'Demo Mode'}
                        </button>
                    ))}
                </div>
                {history.data?.scanTruncated && (
                    <span className="text-[11px] text-down font-mono">Result scan hit its cap — narrow with q / from / to.</span>
                )}
            </div>

            {history.error ? (
                <ErrorState message={history.error} onRetry={history.reload} retrying={history.loading} />
            ) : (
                <>
                    <div className="overflow-x-auto">
                        <Table>
                            <THead labels={['Time', 'Asset', 'Direction', 'Wager (native)', 'Outcome (native)', 'Node', 'Account']} />
                            <tbody>
                                {history.loading && bets.length === 0
                                    ? Array.from({ length: 5 }).map((_, i) => (
                                        <tr key={i} className="border-b border-line animate-pulse">
                                            {[0, 1, 2, 3, 4, 5, 6].map((j) => (
                                                <td key={j} className="px-8 py-6"><div className="h-3 rounded bg-surface" /></td>
                                            ))}
                                        </tr>
                                    ))
                                    : bets.map((b) => {
                                        // Demo rows are `demo-` ids OR `0xDEMO` wallets
                                        // (isDemoBetHistoryRow) — id-prefix alone mislabels
                                        // demo-wallet rows as Real money.
                                        const isDemo = isDemoBetHistoryRow(b);
                                        const net = String(b.network || 'USDC');
                                        const tok = tokenSymbolForNetwork(net);
                                        return (
                                            <tr key={b.id} className="hover:bg-surface transition-colors border-b border-line">
                                                <td className="px-8 py-6 text-xs font-mono whitespace-nowrap">{new Date(b.created_at).toLocaleString()}</td>
                                                <td className="px-8 py-6 font-black text-ink">{b.asset}</td>
                                                <td className="px-8 py-6">
                                                    <span className={b.direction === 'UP' ? 'text-up' : 'text-down'}>{b.direction}</span>
                                                </td>
                                                <td className="px-8 py-6 text-ink font-mono tabular-nums">
                                                    {Number(b.amount).toFixed(4)} <span className="text-xs text-subtle">{tok}</span>
                                                </td>
                                                <td className="px-8 py-6">
                                                    <span className={b.won ? 'text-up font-bold' : 'text-faint'}>
                                                        {b.won
                                                            ? `+${Number(b.payout).toFixed(4)} ${tok}`
                                                            : `−${Number(b.amount).toFixed(4)} ${tok}`}
                                                    </span>
                                                </td>
                                                <td className="px-8 py-6 font-mono text-xs">{shortenAddress(b.wallet_address)}</td>
                                                <td className="px-8 py-6 text-right">
                                                    <span className={`px-3 py-1 rounded text-xs font-black uppercase ${isDemo ? 'bg-down-soft text-down border border-down/30' : 'bg-up-soft text-up border border-up/30'}`}>
                                                        {isDemo ? 'Demo' : 'Real'}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                            </tbody>
                        </Table>
                    </div>
                    {!history.loading && !history.error && bets.length === 0 && (
                        <EmptyState title="No rounds match" hint="Game history appears once rounds settle. Try clearing filters or switching the account tab." />
                    )}
                    <Pagination
                        offset={filters.offset}
                        limit={filters.limit}
                        total={history.data?.total}
                        loading={history.loading}
                        onPage={(offset) => onPatch({ offset })}
                    />
                </>
            )}
        </div>
    );
}
