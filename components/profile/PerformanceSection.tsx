'use client';

/**
 * Performance section for the profile hub.
 *
 * Pulls the server-computed aggregate from GET /api/bets/stats (never the raw
 * bet rows) and renders volume, net PnL, win rate, streaks, a cumulative-PnL
 * sparkline, best/worst trades and the per-asset table.
 *
 * The load-bearing rule: `empty` is only ever derived from a successful,
 * well-formed payload (lib/profile/stats.ts). A 500, a dropped request, a
 * half-populated body or a 401 renders the unavailable panel with a retry —
 * never zeroed metrics, because zeroed metrics is exactly what "this player has
 * never bet" looks like. When a refresh fails while older numbers are on
 * screen they stay visible, dimmed and marked stale, and are never rewritten as
 * a result.
 */

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import Sparkline from './Sparkline';
import useServerRead from './useServerRead';
import {
    classifyStatsResponse,
    statsHasActivity,
    statsRequestUrl,
    statsUnavailableCopy,
    windowCaption,
    type Outcome,
    type StatsWindow,
    type WalletStats,
} from '@/lib/profile/stats';
import { loadStatsWindow, saveStatsWindow } from '@/lib/profile/uiState';
import { formatPercent, formatShortDay, formatSignedUsdc, formatUsdc, pnlClass, winLossLabel } from '@/lib/profile/format';
import { Pulse as ActivityIcon, ClockCounterClockwise as HistoryIcon, WarningCircle, ArrowCounterClockwise, Info } from '@phosphor-icons/react';

const WINDOWS: { id: StatsWindow; label: string }[] = [
    { id: '7d', label: '7D' },
    { id: '30d', label: '30D' },
    { id: 'all', label: 'ALL' },
];

export interface PerformanceSectionProps {
    wallet: string | null | undefined;
    /** Demo wallets have no on-chain record: bet_history stats exclude demo rows. */
    accountType?: 'real' | 'demo';
    /** Mint the first-party session cookie before a read (lib/balance/balanceClientHeaders). */
    ensureSession?: () => Promise<unknown>;
}

export default function PerformanceSection({ wallet, accountType = 'real', ensureSession }: PerformanceSectionProps) {
    const [windowSel, setWindowSel] = useState<StatsWindow>(() => loadStatsWindow());
    const url = useMemo(
        () => (wallet && accountType === 'real' ? statsRequestUrl(wallet, windowSel) : null),
        [wallet, windowSel, accountType],
    );
    const { outcome, lastReady, loading, retry } = useServerRead<WalletStats>(url, classifyStatsResponse, ensureSession);

    const pickWindow = useCallback((next: StatsWindow) => {
        setWindowSel(next);
        saveStatsWindow(next);
    }, []);

    const stats = outcome?.kind === 'ready' ? outcome.data : lastReady;
    const failed = outcome !== null && outcome.kind !== 'ready';
    const skeleton = loading && stats === null && !failed;
    const stale = failed && stats !== null;
    const empty = !skeleton && !failed && stats !== null && !statsHasActivity(stats);

    const sparkValues = stats ? stats.series.map((p) => p.cumNet) : [];
    const sparkPositive = !!stats && stats.netPnl >= 0;

    if (accountType === 'demo') {
        return (
            <Shell windowSel={windowSel} loading={false} showTabs={false} onPick={() => {}} onRetry={() => {}}>
                <p className="flex items-start gap-2 text-[10px] font-bold uppercase leading-relaxed tracking-widest text-white/30">
                    <Info className="mt-px h-3 w-3 shrink-0" />
                    Practice mode has no official record — demo bets are excluded from /api/bets/stats by design.
                    Switch to a funded account to see win rate, PnL and streaks.
                </p>
            </Shell>
        );
    }

    return (
        <Shell
            windowSel={windowSel}
            loading={loading}
            showTabs={!!wallet}
            onPick={pickWindow}
            onRetry={retry}
        >
            {failed && (
                <UnavailableBanner
                    outcome={outcome}
                    onRetry={retry}
                    staleNote={stale ? 'Showing the last figures that did load — marked stale, not your current record.' : undefined}
                />
            )}

            {!wallet && (
                <p className="text-[10px] font-black uppercase tracking-widest text-white/25">
                    Connect a wallet to read your record.
                </p>
            )}

            {/* Stats grid — fixed cell heights so a zero wallet and a loaded
                wallet share one layout. Unavailable reads render dashes. */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <Metric loading={skeleton} label="Volume" value={stat(stats, (s) => formatUsdc(s.volume), stale)} sub="USDC staked" />
                <Metric
                    loading={skeleton}
                    label="Net PnL"
                    value={stat(stats, (s) => formatSignedUsdc(s.netPnl), stale)}
                    sub="USDC"
                    valueClass={stats && !stale ? pnlClass(stats.netPnl) : 'text-white/40'}
                />
                <Metric
                    loading={skeleton}
                    label="Win Rate"
                    value={stat(stats, (s) => formatPercent(s.winRate), stale)}
                    sub={stats ? winLossLabel(stats.wins, stats.losses) : undefined}
                />
                <Metric loading={skeleton} label="Bets" value={stat(stats, (s) => String(s.totalBets), stale)} sub="settled" />
                <Metric
                    loading={skeleton}
                    label="Win Streak"
                    value={stat(stats, (s) => String(s.longestWinStreak), stale)}
                    sub="longest"
                    valueClass="text-emerald-400"
                />
                <Metric
                    loading={skeleton}
                    label="Loss Streak"
                    value={stat(stats, (s) => String(s.longestLossStreak), stale)}
                    sub="longest"
                    valueClass="text-rose-400"
                />
            </div>

            {/* Sparkline + best/worst */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 bg-white/[0.02] border border-white/5 rounded-2xl p-4 min-h-[132px]">
                    <div className="flex items-center justify-between mb-2">
                        <p className="text-[8px] font-black uppercase tracking-[0.25em] text-white/25">Cumulative Net PnL</p>
                        <span className="text-[8px] font-mono text-white/20">{windowCaption(windowSel)}</span>
                    </div>
                    {skeleton ? (
                        <div className="h-16 animate-pulse rounded bg-white/5" aria-hidden />
                    ) : failed && stats === null ? (
                        <div className="flex h-16 items-center text-[9px] font-black uppercase tracking-widest text-white/25">
                            Trend unavailable — request failed
                        </div>
                    ) : (
                        <Sparkline
                            values={sparkValues}
                            height={64}
                            stroke={sparkPositive ? '#00ff88' : '#fb7185'}
                            fill={sparkPositive ? 'rgba(0,255,136,0.10)' : 'rgba(251,113,133,0.10)'}
                            ariaLabel={`Net PnL trend, ${windowCaption(windowSel)}`}
                        />
                    )}
                </div>

                <div className="grid grid-cols-1 gap-4">
                    {(
                        [
                            { label: 'Best Trade', t: stats?.bestTrade ?? null, tone: 'text-emerald-400' },
                            { label: 'Worst Trade', t: stats?.worstTrade ?? null, tone: 'text-rose-400' },
                        ] as const
                    ).map(({ label, t, tone }) => (
                        <div
                            key={label}
                            className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 min-h-[64px] flex items-center justify-between"
                        >
                            <div className="min-w-0">
                                <p className="text-[8px] font-black uppercase tracking-[0.25em] text-white/25 mb-1">{label}</p>
                                {skeleton ? (
                                    <div className="h-4 w-20 animate-pulse rounded bg-white/10" aria-hidden />
                                ) : (
                                    <p className="truncate text-[11px] font-bold uppercase text-white/60">
                                        {t ? t.asset : '—'}
                                        {t && (
                                            <span className="ml-2 text-[9px] font-normal normal-case text-white/20">
                                                {formatShortDay(t.at)}
                                            </span>
                                        )}
                                    </p>
                                )}
                            </div>
                            {!skeleton && (
                                <span className={`font-mono text-sm font-black tabular-nums ${t ? tone : 'text-white/15'}`}>
                                    {t ? formatSignedUsdc(t.net) : '—'}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* Genuinely empty wallet: an explicit statement, not a field of zeros. */}
            {empty ? (
                <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-6 text-center">
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/35">
                        No settled bets in the {windowSel.toUpperCase()} window
                    </p>
                    <p className="mx-auto mt-2 max-w-md text-[9px] font-bold uppercase leading-relaxed tracking-widest text-white/20">
                        The server confirmed an empty record — that is different from a failed request. Full ledger and
                        per-round proofs live in bet history.
                    </p>
                    <Link
                        href="/history"
                        className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-white/60 hover:text-white"
                    >
                        <HistoryIcon className="h-3.5 w-3.5" /> Open bet history
                    </Link>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="border-b border-white/5 text-[9px] uppercase font-black tracking-widest text-white/20">
                                <th className="py-3 pr-4">Asset</th>
                                <th className="py-3 pr-4">Bets</th>
                                <th className="py-3 pr-4">Volume</th>
                                <th className="py-3 pr-4">Win Rate</th>
                                <th className="py-3 text-right">Net PnL</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {skeleton ? (
                                <tr>
                                    <td colSpan={5} className="py-8">
                                        <div className="h-4 w-full animate-pulse rounded bg-white/5" aria-hidden />
                                    </td>
                                </tr>
                            ) : stats && stats.perAsset.length > 0 ? (
                                stats.perAsset.slice(0, 6).map((a) => (
                                    <tr key={a.asset} className="hover:bg-white/[0.01] transition-colors">
                                        <td className="py-3 pr-4 text-xs font-bold uppercase">
                                            <ActivityIcon className="mr-2 inline h-3 w-3 text-white/20" />
                                            {a.asset}
                                        </td>
                                        <td className="py-3 pr-4 font-mono text-[10px] tabular-nums text-white/40">{a.bets}</td>
                                        <td className="py-3 pr-4 font-mono text-[10px] tabular-nums text-white/40">{formatUsdc(a.volume)}</td>
                                        <td className="py-3 pr-4 font-mono text-[10px] tabular-nums text-white/60">{formatPercent(a.winRate)}</td>
                                        <td className={`py-3 text-right font-mono text-xs font-black tabular-nums ${pnlClass(a.netPnl)}`}>
                                            {formatSignedUsdc(a.netPnl)}
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={5} className="py-8 text-center text-[9px] uppercase font-black text-white/15">
                                        {failed ? 'Per-asset breakdown unavailable' : 'No settled bets in this window'}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {stats?.truncated && !failed && (
                <p className="text-[8px] font-bold uppercase tracking-widest text-white/20">
                    Activity exceeds the analysis cap — showing most recent bets.
                </p>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
                <Link
                    href="/history"
                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-[9px] font-black uppercase tracking-widest text-white/55 transition-colors hover:text-white"
                >
                    <HistoryIcon className="h-3.5 w-3.5" /> Full bet history
                </Link>
                <Link
                    href="/withdrawals"
                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-[9px] font-black uppercase tracking-widest text-white/55 transition-colors hover:text-white"
                >
                    Withdrawals ledger
                </Link>
            </div>
        </Shell>
    );
}

/** Value formatter that yields a dash instead of a zero when the read failed. */
function stat(stats: WalletStats | null, pick: (s: WalletStats) => string, stale: boolean): string {
    if (!stats) return '—';
    return stale ? `${pick(stats)} (stale)` : pick(stats);
}

function Shell({
    windowSel,
    loading,
    showTabs,
    onPick,
    onRetry,
    children,
}: {
    windowSel: StatsWindow;
    loading: boolean;
    showTabs: boolean;
    onPick: (w: StatsWindow) => void;
    onRetry: () => void;
    children: React.ReactNode;
}) {
    return (
        <section
            aria-label="Trading performance"
            aria-busy={loading || undefined}
            className="bg-[#050505] border border-white/5 rounded-[2rem] overflow-hidden"
            data-testid="performance-section"
        >
            <div className="px-6 py-5 border-b border-white/5 flex flex-wrap items-center justify-between gap-4">
                <h2 className="flex items-center gap-3 text-[10px] font-black uppercase tracking-[0.4em] text-white/20">
                    <ActivityIcon className="h-3 w-3" /> Performance
                    {loading && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-label="Refreshing" />}
                    <span className="text-white/10">{windowSel.toUpperCase()}</span>
                </h2>
                <div className="flex items-center gap-1.5">
                    {showTabs && (
                        <div role="tablist" aria-label="Stats window" className="flex items-center gap-1.5">
                            {WINDOWS.map((w) => (
                                <button
                                    key={w.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={windowSel === w.id}
                                    onClick={() => onPick(w.id)}
                                    className={`rounded-lg px-3 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${
                                        windowSel === w.id
                                            ? 'bg-white text-black'
                                            : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white'
                                    }`}
                                >
                                    {w.label}
                                </button>
                            ))}
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={onRetry}
                        disabled={!showTabs}
                        aria-label="Reload performance"
                        className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/35 transition-colors hover:text-white disabled:opacity-30"
                    >
                        <ArrowCounterClockwise className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
            <div className="p-6 space-y-6">{children}</div>
        </section>
    );
}

function UnavailableBanner({
    outcome,
    onRetry,
    staleNote,
}: {
    outcome: Outcome<WalletStats> | null;
    onRetry: () => void;
    staleNote?: string;
}) {
    const copy = statsUnavailableCopy(outcome);
    return (
        <div
            role="alert"
            data-testid="stats-unavailable"
            className="rounded-2xl border border-rose-500/15 bg-rose-500/[0.04] p-4"
        >
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.25em] text-rose-400">
                <WarningCircle className="h-4 w-4" />
                {copy.title}
            </p>
            <p className="mt-1.5 text-[9px] font-bold uppercase leading-relaxed tracking-widest text-white/30">{copy.hint}</p>
            {staleNote && (
                <p className="mt-1.5 text-[9px] font-bold uppercase leading-relaxed tracking-widest text-amber-400/70">{staleNote}</p>
            )}
            {copy.retry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-white/60 transition-colors hover:text-white"
                >
                    <ArrowCounterClockwise className="h-3 w-3" /> Retry
                </button>
            )}
        </div>
    );
}

function Metric({
    label,
    value,
    sub,
    valueClass,
    loading,
}: {
    label: string;
    value: string;
    sub?: string;
    valueClass?: string;
    loading: boolean;
}) {
    return (
        <div
            className="flex min-h-[86px] flex-col justify-center rounded-2xl border border-white/5 bg-white/[0.02] p-4"
            data-testid={`metric-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
        >
            <p className="mb-1.5 text-[8px] font-black uppercase tracking-[0.25em] text-white/25">{label}</p>
            {loading ? (
                <div className="space-y-1.5 animate-pulse" aria-hidden>
                    <div className="h-5 w-16 rounded bg-white/10" />
                    {sub !== undefined && <div className="h-2.5 w-10 rounded bg-white/5" />}
                </div>
            ) : (
                <>
                    <p className={`font-mono text-lg font-black tabular-nums tracking-tight ${valueClass || 'text-white'}`}>{value}</p>
                    {sub !== undefined && <p className="mt-0.5 text-[8px] font-bold uppercase tracking-widest text-white/20">{sub}</p>}
                </>
            )}
        </div>
    );
}
