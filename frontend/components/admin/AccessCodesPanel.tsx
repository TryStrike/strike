'use client';

/**
 * Access codes panel: mint codes, list them, and export the active filtered
 * view as CSV. Both the list (?status=ready|consumed, ?q=, pagination) and the
 * export are backed by server routes, so a download can never be silently
 * limited to the page currently in memory, and the RFC-4180 / injection-safe
 * escaping lives in one place (/api/admin/export).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { adminMutation, useAdminFetch } from './useAdminFetch';
import { apiExportQuery, apiListQuery, type DashFilters } from './dashQuery';
import { EmptyState, ErrorState, Pagination, PanelHeader, Table, THead, shortenAddress } from './AdminUi';

interface AccessCodeRow {
    code: string;
    is_used: boolean;
    wallet_address: string | null;
    used_at: string | null;
    created_at?: string;
}

interface CodesApi {
    codes?: AccessCodeRow[];
    total?: number;
    limit?: number;
    offset?: number;
}

export default function AccessCodesPanel({
    filters, nonce, onUnauthorized, onPatch,
}: {
    filters: DashFilters;
    nonce: number;
    onUnauthorized: () => void;
    onPatch: (patch: Partial<DashFilters>) => void;
}) {
    const url = useMemo(() => `/api/admin/access-codes?${apiListQuery(filters)}`, [filters]);
    const list = useAdminFetch<CodesApi>(url, { nonce, onUnauthorized });

    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionOk, setActionOk] = useState<string | null>(null);

    // The route applies q/status/limit/offset server-side; the page it returns
    // is shown verbatim — no client-side re-slicing (that would drop rows of
    // every page after the first).
    const page = useMemo(() => list.data?.codes ?? [], [list.data]);

    // Server-side CSV over the same active filters (whole dataset up to the
    // route's row cap; unknown statuses fall back to "any" so the link can't 400).
    const exportHref = `/api/admin/export?dataset=access_codes&${apiExportQuery(filters, ['ready', 'consumed'])}`;

    const generate = useCallback(async (count: number) => {
        setBusy(true);
        setActionError(null);
        setActionOk(null);
        const res = await adminMutation(
            '/api/admin/access-codes',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ count }),
            },
            onUnauthorized,
        );
        setBusy(false);
        if (!res.ok) {
            setActionError(res.error ?? 'Failed to generate codes');
            return;
        }
        const created = Array.isArray(res.body?.codes) ? res.body.codes.length : count;
        setActionOk(`Minted ${created} code${created === 1 ? '' : 's'}.`);
        list.reload();
    }, [list, onUnauthorized]);

    return (
        <div className="text-left">
            <PanelHeader
                eyebrow="Code generator"
                title="Invitation codes are single-use and bound to the wallet that redeems them."
                right={(
                    <>
                        <a
                            href={exportHref}
                            className="px-4 py-2 bg-up-soft border border-up/30 text-up font-black uppercase text-[10px] tracking-widest rounded-lg hover:bg-up-soft transition-all"
                        >
                            Export CSV
                        </a>
                        <button
                            type="button"
                            onClick={() => generate(5)}
                            disabled={busy}
                            className="px-4 py-2 bg-ink text-white font-black uppercase text-[10px] tracking-widest rounded-lg transition-all disabled:opacity-50"
                        >
                            {busy ? 'Minting…' : 'Generate 5 Codes'}
                        </button>
                    </>
                )}
            />

            {list.error ? (
                <ErrorState message={list.error} onRetry={list.reload} retrying={list.loading} />
            ) : (
                <>
                    {actionError && (
                        <p className="px-8 pt-4 text-xs font-mono text-down" role="alert">{actionError}</p>
                    )}
                    {actionOk && !actionError && (
                        <p className="px-8 pt-4 text-xs font-mono text-up" role="status">{actionOk}</p>
                    )}
                    <div className="overflow-x-auto">
                        <Table>
                            <THead labels={['Access Code', 'Status', 'Wallet Link', 'Authorized At']} />
                            <tbody>
                                {list.loading && page.length === 0
                                    ? Array.from({ length: 5 }).map((_, i) => (
                                        <tr key={i} className="border-b border-line animate-pulse">
                                            {[0, 1, 2, 3].map((j) => (
                                                <td key={j} className="px-8 py-6"><div className="h-3 rounded bg-surface" /></td>
                                            ))}
                                        </tr>
                                    ))
                                    : page.map((c) => (
                                        <tr key={c.code} className="hover:bg-surface transition-colors border-b border-line">
                                            <td className="px-8 py-6 font-mono font-black text-ink text-lg tracking-widest uppercase">{c.code}</td>
                                            <td className="px-8 py-6">
                                                <span className={`px-3 py-1 rounded text-sm font-black uppercase ${c.is_used ? 'bg-down-soft text-down border border-down/30' : 'bg-up-soft text-up border border-up/30'}`}>
                                                    {c.is_used ? 'Consumed' : 'Ready'}
                                                </span>
                                            </td>
                                            <td className="px-8 py-6 font-mono text-xs text-subtle">
                                                {c.wallet_address ? shortenAddress(c.wallet_address) : 'UNLINKED'}
                                            </td>
                                            <td className="px-8 py-6 text-right text-faint text-xs font-mono whitespace-nowrap">
                                                {c.used_at ? new Date(c.used_at).toLocaleString() : '—'}
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </Table>
                    </div>
                    {!list.loading && page.length === 0 && (
                        <EmptyState
                            title="No codes in this view"
                            hint="Generate a batch, or clear ?q / ?status (ready | consumed) to see everything."
                        />
                    )}
                    <Pagination
                        offset={filters.offset}
                        limit={filters.limit}
                        total={list.data?.total}
                        loading={list.loading}
                        onPage={(offset) => onPatch({ offset })}
                    />
                </>
            )}
        </div>
    );
}
