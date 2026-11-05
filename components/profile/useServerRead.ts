'use client';

/**
 * Out-of-band read for one wallet-scoped endpoint.
 *
 * Shares the lifecycle every /profile panel needs:
 *   - the page never blocks on it (loading is a per-panel state),
 *   - a new request supersedes an in-flight one (request ids + AbortController),
 *   - the last good payload stays on screen while a refresh runs, and is marked
 *     stale rather than replaced if the refresh fails,
 *   - a failed or unauthorised response is kept as `outcome`, never coerced
 *     into an empty data set.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Outcome } from '@/lib/profile/stats';

export interface ServerRead<T> {
    /** Settled outcome of the most recent attempt for the current url. */
    outcome: Outcome<T> | null;
    /** Payload from the most recent successful attempt (stale-while-revalidate). */
    lastReady: T | null;
    loading: boolean;
    retry: () => void;
}

export function useServerRead<T>(
    url: string | null,
    classify: (status: number, body: unknown) => Outcome<T>,
    /** Runs before the request: mints the first-party session cookie if needed. */
    prepare?: () => Promise<unknown>,
): ServerRead<T> {
    const [outcome, setOutcome] = useState<Outcome<T> | null>(null);
    const [lastReady, setLastReady] = useState<T | null>(null);
    const [loading, setLoading] = useState<boolean>(!!url);
    const [nonce, setNonce] = useState(0);

    const requestRef = useRef(0);
    const classifyRef = useRef(classify);
    classifyRef.current = classify;
    const prepareRef = useRef(prepare);
    prepareRef.current = prepare;
    /** url the settled outcome belongs to, so a new wallet cannot show the old panel state. */
    const outcomeUrlRef = useRef<string | null>(null);

    const retry = useCallback(() => setNonce((n) => n + 1), []);

    useEffect(() => {
        const id = ++requestRef.current;
        outcomeUrlRef.current = null;
        if (!url) {
            setOutcome(null);
            setLastReady(null);
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        setLoading(true);

        void (async () => {
            try {
                await prepareRef.current?.();
                const res = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
                let body: unknown = null;
                try {
                    body = await res.json();
                } catch {
                    body = null; // non-JSON body: classify() treats it as a payload failure
                }
                if (requestRef.current !== id) return;
                const next = classifyRef.current(res.status, body);
                outcomeUrlRef.current = url;
                setOutcome(next);
                if (next.kind === 'ready') setLastReady(next.data);
            } catch (err) {
                if ((err as Error)?.name === 'AbortError' || requestRef.current !== id) return;
                console.warn('[profile] read failed', url, err);
                outcomeUrlRef.current = url;
                setOutcome({ kind: 'failed', status: null, reason: 'network', message: 'Could not reach the service.' });
            } finally {
                if (requestRef.current === id) setLoading(false);
            }
        })();

        return () => controller.abort();
    }, [url, nonce]);

    return { outcome, lastReady, loading, retry };
}

export default useServerRead;
