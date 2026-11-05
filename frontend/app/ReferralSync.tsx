'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';

/**
 * Addresses with a sync already running. Module scope, not component scope, so
 * StrictMode's second mount — or a remount after a route change — still sees the
 * first request and does not fire a duplicate POST /api/referral.
 */
const syncInFlight = new Set<string>();

/** Shared-link query params we accept for a referrer code. */
const REFERRAL_PARAMS = ['ref', 'r'] as const;

/**
 * Once captured, the ref param is dropped from the address bar. Leaving it there
 * means every refresh re-presents a code that has already been consumed (and, in a
 * different browser session, re-captures a code the visitor never meant to re-use);
 * it also copies the code into navigation history and server access logs.
 * `history.replaceState` keeps the React tree — and the in-flight sync — untouched.
 */
function stripReferralParams(): void {
    if (typeof window === 'undefined') return;
    try {
        const url = new URL(window.location.href);
        let changed = false;
        for (const key of REFERRAL_PARAMS) {
            if (url.searchParams.has(key)) {
                url.searchParams.delete(key);
                changed = true;
            }
        }
        if (!changed) return;
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
        /* opaque origin / history unavailable — the store copy already saved the claim */
    }
}

function ReferralSyncInner() {
    const searchParams = useSearchParams();
    const { setReferredBy, address, isConnected } = useStore(
        useShallow((s) => ({ setReferredBy: s.setReferredBy, address: s.address, isConnected: s.isConnected }))
    );

    // Capture the incoming code as soon as the URL is known — BEFORE any wallet is
    // connected. Privy embedded wallets arrive asynchronously, so the code has to
    // be persisted to the store/localStorage here; the attach below happens later.
    useEffect(() => {
        let captured = false;
        for (const key of REFERRAL_PARAMS) {
            const code = searchParams.get(key);
            if (code) {
                setReferredBy(code);
                captured = true;
                break;
            }
        }
        if (captured) stripReferralParams();
    }, [searchParams, setReferredBy]);

    // Once a wallet is available, run the one connect-time pass: load/create the
    // record, late-attach a still-pending referrer only if that step did not
    // already speak for it, then pull the referred-node list. The whole run is
    // guarded per address, and the slice remembers claims this session already
    // landed, so a StrictMode double-mount or a remount never re-POSTs an
    // attribution that has been credited.
    useEffect(() => {
        if (!isConnected || !address) return;
        if (syncInFlight.has(address)) return;
        syncInFlight.add(address);
        (async () => {
            const state = useStore.getState();
            try {
                await state.syncOnConnect(address);
                await useStore.getState().fetchRecentTrades(address);
            } finally {
                syncInFlight.delete(address);
            }
        })();
    }, [isConnected, address]);

    return null;
}

export function ReferralSync() {
    return (
        <Suspense fallback={null}>
            <ReferralSyncInner />
        </Suspense>
    );
}

/** Test seam: forget which addresses have a sync running (used by the remount tests). */
export function __resetReferralSyncInFlightForTests(): void {
    syncInFlight.clear();
}
