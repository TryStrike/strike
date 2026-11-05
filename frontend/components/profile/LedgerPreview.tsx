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
            className="overflow-hidden rounded-3xl border border-line bg-white"
            data-testid="ledger-preview"
        >
            <div className="flex items-center justify-between border-b border-line p-6">
                <h2 className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                    <HistoryIcon className="h-3 w-3" /> Trading Ledger
                </h2>
                <Link
                    href="/history"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle transition-colors hover:text-ink"
                >
                    Full history <ArrowRight className="h-3 w-3" />
                </Link>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left">
                    <thead>
                        <tr className="border-b border-line bg-surface text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                            <th className="px-6 py-4">Asset</th>
                            <th className="px-6 py-4">Side</th>
                            <th className="px-6 py-4">Stake</th>
                            <th className="px-6 py-4 text-right">Result</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                        {!wallet && (
                            <NoticeCell>Connect a wallet to read your ledger.</NoticeCell>
                        )}

                        {wallet && loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-6 py-10">
                                    <div className="space-y-2" aria-hidden>
                                        {[0, 1, 2].map((i) => (
                                            <div key={i} className="h-4 w-full animate-pulse rounded bg-surface" />
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
                                        <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-down">
                                            <WarningCircle className="h-3.5 w-3.5" />
                                            {outcome?.kind === 'unauthorized'
                                                ? 'Session not verified — ledger is hidden, not empty'
                                                : 'Ledger unavailable — request failed'}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={retry}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
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
                                <tr key={row.id ?? idx} className="transition-all hover:bg-surface">
                                    <td className="px-6 py-4 text-xs font-bold uppercase">{row.asset ?? '—'}</td>
                                    <td className="px-6 py-4">
                                        <span
                                            className={`rounded border px-2 py-0.5 text-[11px] font-semibold uppercase ${
                                                row.direction === 'UP'
                                                    ? 'border-up/20 text-up'
                                                    : row.direction === 'DOWN'
                                                      ? 'border-down/20 text-down'
                                                      : 'border-line text-subtle'
                                            }`}
                                        >
                                            {row.direction ?? '—'}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 font-mono text-[10px] text-subtle">{formatUsdc(stake)}</td>
                                    <td className="px-6 py-4 text-right">
                                        <span className={`font-mono text-xs font-semibold tabular-nums ${pnlClass(net)}`}>
                                            {formatSignedUsdc(net)}
                                        </span>
                                        <span className="ml-3 text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
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
            <td colSpan={4} className="px-6 py-10 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                {children}
            </td>
        </tr>
    );
}
