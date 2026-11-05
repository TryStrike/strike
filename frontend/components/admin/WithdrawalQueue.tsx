'use client';

/**
 * Pending-withdrawal queue shared by the Financials and Danger Zone panels.
 *
 * Each request carries `signed_at` (epoch ms of the signed intent). The accept
 * endpoint enforces the 10-minute window server-side; this queue shows a live
 * per-second countdown and disables Accept the moment the window closes, so an
 * admin never clicks a payout that the server will refuse.
 */

import React, { useEffect, useState } from 'react';
import { formatCountdown, intentRemainingMs } from '@/lib/admin/countdown';
import { explorerAddressUrl } from '@/lib/arc/config';
import { shortenAddress } from './AdminUi';
import type { PendingWithdrawal } from './types';

interface Props {
    requests: PendingWithdrawal[];
    onAccept: (id: number) => Promise<void> | void;
    onReject: (id: number) => Promise<void> | void;
    /** id currently mid-mutation, to disable its buttons. */
    busyId?: number | null;
    emptyHint?: string;
}

export default function WithdrawalQueue({ requests, onAccept, onReject, busyId, emptyHint }: Props) {
    const [now, setNow] = useState(() => Date.now());

    // Tick once per second while rows exist; the countdown must actually move.
    useEffect(() => {
        if (requests.length === 0) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [requests.length]);

    if (requests.length === 0) {
        return (
            <p className="px-8 py-10 text-center text-xs text-white/20 font-mono">
                {emptyHint ?? 'No pending withdrawal requests.'}
            </p>
        );
    }

    return (
        <div className="divide-y divide-white/5">
            {requests.map((w) => {
                const remaining = intentRemainingMs(w.signed_at, now);
                const expired = remaining === null || remaining <= 0;
                const busy = busyId === w.id;
                return (
                    <div
                        key={w.id}
                        className={`flex flex-wrap items-center gap-x-6 gap-y-2 px-8 py-5 hover:bg-white/[0.02] transition-colors ${
                            expired ? 'opacity-55' : ''
                        }`}
                    >
                        <div className="min-w-[180px]">
                            <p className="text-xs font-mono text-white/40">
                                {w.requested_at ? new Date(w.requested_at).toLocaleString() : '—'}
                            </p>
                            <a
                                href={explorerAddressUrl(w.user_address)}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={w.user_address}
                                className="font-mono text-xs text-white/70 hover:text-white hover:underline"
                            >
                                {shortenAddress(w.user_address)} ↗
                            </a>
                        </div>
                        <span className="text-xs font-black border border-white/10 rounded px-2 py-1 uppercase">
                            {w.currency}
                        </span>
                        <span className="font-mono text-white font-bold tabular-nums min-w-[120px]">
                            −{Number(w.amount).toFixed(4)}
                        </span>

                        {/* Live countdown to intent expiry */}
                        <span
                            className={`px-2.5 py-1 rounded font-mono text-xs font-bold tabular-nums border ${
                                expired
                                    ? 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                                    : remaining !== null && remaining < 120_000
                                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                                        : 'border-white/10 bg-white/5 text-white/50'
                            }`}
                            title={
                                expired
                                    ? 'The signed authorization window has passed — ask the user to re-request.'
                                    : 'Time left in the server-side accept window'
                            }
                            aria-label={`Accept window ${expired ? 'expired' : formatCountdown(remaining)}`}
                        >
                            {expired ? 'expired' : formatCountdown(remaining)}
                        </span>
                        {!w.signed_at && (
                            <span className="text-[10px] text-white/25 uppercase font-black">unsigned</span>
                        )}

                        <span className="ml-auto flex gap-2">
                            <button
                                type="button"
                                onClick={() => onAccept(w.id)}
                                disabled={expired || busy}
                                title={expired ? 'Intent window expired — Accept is disabled. Reject and ask the user to re-request.' : undefined}
                                className="px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded text-xs font-black uppercase hover:bg-emerald-500/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-emerald-500/10"
                            >
                                {busy ? '…' : 'Accept'}
                            </button>
                            <button
                                type="button"
                                onClick={() => onReject(w.id)}
                                disabled={busy}
                                className="px-3 py-1.5 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded text-xs font-black uppercase hover:bg-rose-500/20 transition-colors disabled:opacity-30"
                            >
                                Reject
                            </button>
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
