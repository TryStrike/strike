'use client';

/**
 * Financials panel: pending-withdrawal review queue (live intent countdown,
 * Accept disabled after the window) above the deposit/withdrawal audit list
 * with server-side filtering, pagination and CSV export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { explorerTxUrl } from '@/lib/arc/config';
import { adminMutation } from './useAdminFetch';
import { useAdminFetch } from './useAdminFetch';
import { apiExportQuery, apiListQuery, type DashFilters } from './dashQuery';
import { EmptyState, ErrorState, Pagination, PanelHeader, Table, THead, shortenAddress } from './AdminUi';
import WithdrawalQueue from './WithdrawalQueue';
import type { PendingWithdrawal, Transaction, UnresolvedWithdrawal } from './types';

interface PendingApi {
    requests?: PendingWithdrawal[];
    unresolved?: UnresolvedWithdrawal[];
    total?: number;
}

/** How often to look again while a payout is running. */
const UNRESOLVED_POLL_MS = 5000;

interface TxApi {
    transactions?: Transaction[];
    total?: number;
    limit?: number;
    offset?: number;
}

export default function FinancialPanel({
    filters, nonce, onUnauthorized, onPatch, onQueueChanged,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
    /** Called after accept/reject so sibling panels can re-sync. */
    onQueueChanged: () => void;
}) {
    const pendingUrl = useMemo(
        () => `/api/admin/withdrawal-requests/pending?${apiListQuery(filters, { status: '' })}`,
        [filters],
    );
    const txUrl = useMemo(
        () => `/api/admin/transactions?${apiListQuery(filters)}`,
        [filters],
    );

    const pending = useAdminFetch<PendingApi>(pendingUrl, { nonce, onUnauthorized });
    const txs = useAdminFetch<TxApi>(txUrl, { nonce, onUnauthorized });

    const [busyId, setBusyId] = useState<number | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [settledNotice, setSettledNotice] = useState<string | null>(null);

    const refreshAll = useCallback(() => {
        pending.reload();
        txs.reload();
        onQueueChanged();
    }, [pending, txs, onQueueChanged]);

    const accept = useCallback(async (id: number) => {
        setBusyId(id);
        setActionError(null);
        const res = await adminMutation(`/api/admin/withdrawal-requests/${id}/accept`, { method: 'POST' }, onUnauthorized);
        setBusyId(null);
        if (!res.ok) {
            // A proxy or a dropped connection answers without our JSON. That says
            // nothing about the payout, which keeps running on the server.
            setActionError(typeof res.body?.error === 'string'
                ? res.error
                : 'No answer from the server. The payout may still be running: check the list below before acting again.');
            refreshAll();
        } else {
            refreshAll();
        }
    }, [onUnauthorized, refreshAll]);

    const reject = useCallback(async (id: number) => {
        setBusyId(id);
        setActionError(null);
        const res = await adminMutation(`/api/admin/withdrawal-requests/${id}/reject`, { method: 'POST' }, onUnauthorized);
        setBusyId(null);
        if (!res.ok) {
            setActionError(res.error ?? 'Reject failed');
            refreshAll();
        } else {
            refreshAll();
        }
    }, [onUnauthorized, refreshAll]);

    const requests = pending.data?.requests ?? [];
    const rows = txs.data?.transactions ?? [];
    const unresolved = useMemo(() => pending.data?.unresolved ?? [], [pending.data]);
    const running = unresolved.some((w) => w.status === 'accepted');

    // A payout outlives the request that started it, so its end is read from here.
    const { reload: reloadPending } = pending;
    const { reload: reloadTxs } = txs;
    useEffect(() => {
        if (!running) return;
        const t = setInterval(() => { reloadPending(); reloadTxs(); }, UNRESOLVED_POLL_MS);
        return () => clearInterval(t);
    }, [running, reloadPending, reloadTxs]);

    const runningIds = useRef<number[]>([]);
    useEffect(() => {
        if (!pending.data) return;
        const finished = runningIds.current.filter((id) => !unresolved.some((w) => w.id === id));
        if (finished.length > 0) {
            setActionError(null);
            setSettledNotice(`Withdrawal ${finished.map((id) => `#${id}`).join(', ')} paid: the hash is in the list below.`);
        }
        runningIds.current = unresolved.filter((w) => w.status === 'accepted').map((w) => w.id);
    }, [pending.data, unresolved]);

    // CSV export reuses the exact filter state; filename comes from the server whitelist.
    // The pending route only understands status=pending, so its fetch pins status=''.
    // The export route *does* accept deposit/withdrawal — pass the active filter
    // through (anything else falls back to "any") so the CSV matches the table.
    const exportHref = `/api/admin/export?dataset=transactions&${apiExportQuery(filters, ['deposit', 'withdrawal'])}`;

    return (
        <div className="text-left space-y-0">
            <PanelHeader
                eyebrow="Manual review queue"
                title={
                    <>
                        House withdrawals. Each request carries the user&apos;s signed intent — valid for{' '}
                        <span className="text-down font-mono">10:00</span> from signing, then Accept locks out.
                    </>
                }
                right={(
                    <a
                        href={exportHref}
                        className="px-4 py-2 bg-up-soft border border-up/30 text-up font-black uppercase text-[10px] tracking-widest rounded-lg hover:bg-up-soft transition-all"
                    >
                        Export CSV
                    </a>
                )}
            />

            {/* Pending queue */}
            <div className="border-b border-line">
                {pending.error ? (
                    <ErrorState message={pending.error} onRetry={pending.reload} retrying={pending.loading} />
                ) : (
                    <WithdrawalQueue
                        requests={requests}
                        onAccept={accept}
                        onReject={reject}
                        busyId={busyId}
                        emptyHint={pending.loading ? 'Loading queue…' : 'No pending withdrawal requests.'}
                    />
                )}
                {actionError && (
                    <p className="px-8 pb-4 text-xs font-mono text-down" role="alert">{actionError}</p>
                )}
                {settledNotice && (
                    <p className="px-8 pb-4 text-xs font-mono text-up" role="status">{settledNotice}</p>
                )}
                {unresolved.length > 0 && (
                    <div className="divide-y divide-line border-t border-line">
                        {unresolved.map((w) => (
                            <div key={w.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-8 py-4">
                                <span className="font-mono text-xs text-muted">#{w.id} {shortenAddress(w.user_address)}</span>
                                <span className="font-mono text-ink font-bold tabular-nums">
                                    −{Number(w.amount).toFixed(4)} {w.currency}
                                </span>
                                {w.status === 'accepted' ? (
                                    <span className="px-2.5 py-1 rounded font-mono text-xs font-bold border border-down/30 bg-down-soft text-down">
                                        paying
                                    </span>
                                ) : (
                                    <span className="px-2.5 py-1 rounded font-mono text-xs font-bold border border-down/30 bg-down-soft text-down">
                                        needs reconciliation
                                    </span>
                                )}
                                {w.notes && <span className="font-mono text-xs text-subtle break-all">{w.notes}</span>}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Audit log transactions */}
            {txs.error ? (
                <ErrorState message={txs.error} onRetry={txs.reload} retrying={txs.loading} />
            ) : (
                <>
                    <div className="overflow-x-auto">
                        <Table>
                            <THead labels={['Time', 'Identity', 'Operation', 'Amount', 'Ref']} />
                            <tbody>
                                {txs.loading && rows.length === 0
                                    ? Array.from({ length: 4 }).map((_, i) => (
                                        <tr key={i} className="border-b border-line animate-pulse">
                                            {[0, 1, 2, 3, 4].map((j) => (
                                                <td key={j} className="px-8 py-6"><div className="h-3 rounded bg-surface" /></td>
                                            ))}
                                        </tr>
                                    ))
                                    : rows.map((t) => {
                                        const explorerUrl = t.transaction_hash && t.transaction_hash !== 'INTERNAL'
                                            ? explorerTxUrl(t.transaction_hash)
                                            : null;
                                        return (
                                            <tr key={t.id} className="hover:bg-surface transition-colors border-b border-line last:border-0">
                                                <td className="px-8 py-6 text-xs font-mono whitespace-nowrap">{new Date(t.created_at).toLocaleString()}</td>
                                                <td className="px-8 py-6 font-mono text-xs">{shortenAddress(t.user_address)}</td>
                                                <td className="px-8 py-6">
                                                    <span className={`${t.operation_type === 'deposit' ? 'text-up bg-up-soft' : 'text-down bg-down-soft'} px-2 py-0.5 rounded uppercase text-xs font-black`}>
                                                        {t.operation_type}
                                                    </span>
                                                </td>
                                                <td className="px-8 py-6 text-ink font-mono font-bold tabular-nums">
                                                    {t.operation_type === 'deposit' ? '+' : '-'}{Number(t.amount).toFixed(4)} {t.currency}
                                                </td>
                                                <td className="px-8 py-6 text-right">
                                                    {explorerUrl ? (
                                                        <a
                                                            href={explorerUrl}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="font-mono text-xs text-up hover:text-up underline underline-offset-4 decoration-up"
                                                        >
                                                            {String(t.transaction_hash).slice(0, 10)}...
                                                        </a>
                                                    ) : (
                                                        <span className="font-mono text-xs text-faint">{t.transaction_hash || 'INTERNAL'}</span>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                            </tbody>
                        </Table>
                    </div>
                    {!txs.loading && !txs.error && rows.length === 0 && (
                        <EmptyState title="No matching transactions" hint="Deposits and withdrawals appear here as they settle. Try clearing filters." />
                    )}
                    <Pagination
                        offset={filters.offset}
                        limit={filters.limit}
                        total={txs.data?.total}
                        loading={txs.loading}
                        onPage={(offset) => onPatch({ offset })}
                    />
                </>
            )}
        </div>
    );
}
