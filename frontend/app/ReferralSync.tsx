'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';

const syncInFlight = new Set<string>();

const REFERRAL_PARAMS = ['ref', 'r'] as const;

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
    } catch {}
}

function ReferralSyncInner() {
    const searchParams = useSearchParams();
    const { setReferredBy, address, isConnected } = useStore(
        useShallow((s) => ({ setReferredBy: s.setReferredBy, address: s.address, isConnected: s.isConnected }))
    );

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

    useEffect(() => {
        if (!isConnected || !address) return;
        if (syncInFlight.has(address)) return;
        syncInFlight.add(address);
        (async () => {
            try {
                await useStore.getState().syncOnConnect(address);
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

export function __resetReferralSyncInFlightForTests(): void {
    syncInFlight.clear();
}
