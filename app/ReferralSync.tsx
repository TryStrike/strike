'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStore } from '@/lib/store';
import { useShallow } from 'zustand/react/shallow';

function ReferralSyncInner() {
    const searchParams = useSearchParams();
    const { setReferredBy, fetchReferralInfo, address, isConnected } = useStore(useShallow((s) => ({ setReferredBy: s.setReferredBy, fetchReferralInfo: s.fetchReferralInfo, address: s.address, isConnected: s.isConnected })));

    useEffect(() => {
        const ref = searchParams.get('ref');
        if (ref) {
            setReferredBy(ref);
        }
    }, [searchParams, setReferredBy]);

    useEffect(() => {
        if (isConnected && address) {
            fetchReferralInfo(address);
            useStore.getState().fetchRecentTrades(address);
        }
    }, [isConnected, address, fetchReferralInfo]);

    return null;
}

export function ReferralSync() {
    return (
        <Suspense fallback={null}>
            <ReferralSyncInner />
        </Suspense>
    );
}
