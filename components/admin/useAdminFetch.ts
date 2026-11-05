'use client';

/**
 * Small fetch hook shared by every admin panel: GETs `url` (or does nothing
 * when url is null), exposes { data, loading, error, reload, lastFetched },
 * aborts stale requests, reports 401 upward (session expired) and never
 * renders without an inline error + retry path.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AdminFetchState<T> {
    data: T | null;
    loading: boolean;
    error: string | null;
    lastFetched: number | null;
    reload: () => void;
}

export interface AdminFetchOptions {
    /** Bump this to force a refetch (auto-refresh / manual Sync). */
    nonce?: number;
    /** Called when the API answers 401 — the dashboard flips to the login gate. */
    onUnauthorized?: () => void;
    /** Extra fetch options, e.g. POST. When provided, `url` must be stable. */
    method?: 'GET';
    skip?: boolean;
}

export function useAdminFetch<T = any>(
    url: string | null,
    opts: AdminFetchOptions = {},
): AdminFetchState<T> {
    const { nonce = 0, onUnauthorized, skip = false } = opts;
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(!skip && url !== null);
    const [error, setError] = useState<string | null>(null);
    const [lastFetched, setLastFetched] = useState<number | null>(null);
    const [manualTick, setManualTick] = useState(0);
    const abortRef = useRef<AbortController | null>(null);
    const unauthorizedRef = useRef(onUnauthorized);
    unauthorizedRef.current = onUnauthorized;

    const reload = useCallback(() => setManualTick((t) => t + 1), []);

    useEffect(() => {
        if (skip || url === null) {
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        abortRef.current?.abort();
        abortRef.current = controller;
        let alive = true;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const res = await fetch(url, {
                    credentials: 'include',
                    signal: controller.signal,
                });
                if (res.status === 401) {
                    if (alive) unauthorizedRef.current?.();
                    return;
                }
                const body = await res.json().catch(() => ({}));
                if (!alive) return;
                if (!res.ok) {
                    setError(typeof body?.error === 'string' ? body.error : `Request failed (HTTP ${res.status})`);
                    setData(null);
                } else {
                    setData(body as T);
                    setLastFetched(Date.now());
                }
            } catch (e) {
                if (!alive || (e as Error)?.name === 'AbortError') return;
                setError(e instanceof Error && e.message ? e.message : 'Network error');
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, nonce, manualTick, skip]);

    return { data, loading, error, lastFetched, reload };
}

/** POST/DELETE helper that surfaces the sanitized { error } string. */
export async function adminMutation(
    url: string,
    init: RequestInit,
    onUnauthorized?: () => void,
): Promise<{ ok: boolean; error: string | null; body: any }> {
    try {
        const res = await fetch(url, { credentials: 'include', ...init });
        if (res.status === 401) {
            onUnauthorized?.();
            return { ok: false, error: 'Session expired', body: null };
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            return {
                ok: false,
                error: typeof body?.error === 'string' ? body.error : `Request failed (HTTP ${res.status})`,
                body,
            };
        }
        return { ok: true, error: null, body };
    } catch {
        return { ok: false, error: 'Network error — please retry.', body: null };
    }
}
