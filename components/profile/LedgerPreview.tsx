'use client';

/**
 * Recent settled rounds for /profile.
 *
 * Reads GET /api/bets/history directly (bounded by `limit`) instead of the
 * shared `recentTrades` store field, because that field collapses two very
 * different facts into one: `[]` because the wallet has no bets, and `[]`
 * because the request 401'd or 500'd. Here the outcome is classified
 * (lib/profile/stats.ts) and each state renders its own copy — a failure never
 * reads as "no recent activity".
 */

import { useMemo } from 'react';
import Link from 'next/link';
import {
    ArrowRight,
    ClockCounterClockwise as HistoryIcon,
    WarningCircle,
    ArrowCounterClockwise,
} from '@phosphor-icons/react';
import useServerRead from './useServerRead';
import { classifyLedgerResponse, ledgerRequestUrl, type LedgerRow } from '@/lib/profile/stats';
import { formatAgo, formatSignedUsdc, formatUsdc, ledgerRowNet, pnlClass, toAmount } from '@/lib/profile/format';

const PREVIEW_ROWS = 8;

export interface LedgerPreviewProps {
    wallet: string | null | undefined;
    /** Mint the first-party session cookie before the read. */
    ensureSession?: () => Promise<unknown>;
}

export default function LedgerPreview({ wallet, ensureSession }: LedgerPreviewProps) {
    const url = useMemo(() => (wallet ? ledgerRequestUrl(wallet, PREVIEW_ROWS) : null), [wallet]);
    const { outcome, loading, retry } = useServerRead<LedgerRow[]>(url, classifyLedgerResponse, ensureSession);

    const rows = outcome?.kind === 'ready' ? outcome.data : [];
    const failed = outcome !== null && outcome.kind !== 'ready';

    return (
        <section
            aria-label="Recent settled rounds"
            className="overflow-hidden rounded-[2rem] border border-white/5 bg-[#050505]"
            data-testid="ledger-preview"
        >
            <div className="flex items-center justify-between border-b border-white/5 p-6">
                <h2 className="flex items-center gap-3 text-[10px] font-black uppercase tracking-[0.4em] text-white/20">
                    <HistoryIcon className="h-3 w-3" /> Trading Ledger
                </h2>
                <Link
                    href="/history"
                    className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-white/40 transition-colors hover:text-white"
                >
                    Full history <ArrowRight className="h-3 w-3" />
                </Link>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left">
                    <thead>
                        <tr className="border-b border-white/5 bg-white/[0.01] text-[9px] font-black uppercase tracking-widest text-white/20">
                            <th className="px-6 py-4">Asset</th>
                            <th className="px-6 py-4">Side</th>
                            <th className="px-6 py-4">Stake</th>
                            <th className="px-6 py-4 text-right">Result</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                        {!wallet && (
                            <NoticeCell>Connect a wallet to read your ledger.</NoticeCell>
                        )}

                        {wallet && loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-6 py-10">
                                    <div className="space-y-2" aria-hidden>
                                        {[0, 1, 2].map((i) => (
                                            <div key={i} className="h-4 w-full animate-pulse rounded bg-white/5" />
                                        ))}
                                    </div>
                                    <span className="sr-only">Loading recent rounds</span>
                                </td>
                            </tr>
                        )}

                        {wallet && failed && (
                            <tr>
                                <td colSpan={4} className="px-6 py-8">
                                    <div role="alert" className="flex flex-col items-start gap-2">
                                        <p className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-rose-400">
                                            <WarningCircle className="h-3.5 w-3.5" />
                                            {outcome?.kind === 'unauthorized'
                                                ? 'Session not verified — ledger is hidden, not empty'
                                                : 'Ledger unavailable — request failed'}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={retry}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-white/50 transition-colors hover:text-white"
                                        >
                                            <ArrowCounterClockwise className="h-3 w-3" /> Retry
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        )}

                        {wallet && !loading && outcome?.kind === 'ready' && rows.length === 0 && (
                            <NoticeCell>No settled rounds yet — the server confirmed an empty ledger.</NoticeCell>
                        )}

                        {rows.map((row, idx) => {
                            const stake = toAmount(row.amount);
                            const net = ledgerRowNet(row);
                            return (
                                <tr key={row.id ?? idx} className="transition-all hover:bg-white/[0.01]">
                                    <td className="px-6 py-4 text-xs font-bold uppercase">{row.asset ?? '—'}</td>
                                    <td className="px-6 py-4">
                                        <span
                                            className={`rounded border px-2 py-0.5 text-[7px] font-black uppercase ${
                                                row.direction === 'UP'
                                                    ? 'border-emerald-400/20 text-emerald-400'
                                                    : row.direction === 'DOWN'
                                                      ? 'border-rose-400/20 text-rose-400'
                                                      : 'border-white/10 text-white/40'
                                            }`}
                                        >
                                            {row.direction ?? '—'}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 font-mono text-[10px] text-white/30">{formatUsdc(stake)}</td>
                                    <td className="px-6 py-4 text-right">
                                        <span className={`font-mono text-xs font-black tabular-nums ${pnlClass(net)}`}>
                                            {formatSignedUsdc(net)}
                                        </span>
                                        <span className="ml-3 text-[8px] font-bold uppercase tracking-widest text-white/15">
                                            {formatAgo(row.resolved_at ?? row.created_at)}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function NoticeCell({ children }: { children: React.ReactNode }) {
    return (
        <tr>
            <td colSpan={4} className="px-6 py-10 text-center text-[9px] font-black uppercase tracking-widest text-white/15">
                {children}
            </td>
        </tr>
    );
}
