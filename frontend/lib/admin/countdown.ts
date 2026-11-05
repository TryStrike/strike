/**
 * Pure countdown helpers for the admin withdrawal queue.
 *
 * A pending withdrawal carries `signed_at` — the epoch-ms timestamp baked into
 * the signed intent. The accept endpoint refuses intents older than
 * MAX_ACCEPT_INTENT_AGE_MS, so the UI shows a live countdown to that deadline
 * and disables Accept once the window has passed. These helpers keep the
 * formatting/arithmetic testable and free of React.
 */

import {
    MAX_ACCEPT_INTENT_AGE_MS,
    MAX_CLOCK_SKEW_MS,
} from '@/lib/balance/withdrawalIntent';

/** Expiry instant for a signed intent, or null when signedAt is missing/invalid. */
export function intentExpiresAtMs(signedAt: unknown): number | null {
    // Number(null) is 0 and Number('') is 0 — both are "missing", not epoch 0.
    if (signedAt === null || signedAt === undefined || signedAt === '') return null;
    const ts = Number(signedAt);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return ts + MAX_ACCEPT_INTENT_AGE_MS;
}

/**
 * Milliseconds remaining in the accept window (may be negative — past due).
 * `MAX_CLOCK_SKEW_MS` of grace is added so the UI does not disable Accept while
 * the server would still honour the intent (browser clocks run ahead).
 */
export function intentRemainingMs(
    signedAt: unknown,
    now: number = Date.now(),
    graceMs: number = MAX_CLOCK_SKEW_MS,
): number | null {
    const expires = intentExpiresAtMs(signedAt);
    if (expires === null || !Number.isFinite(now)) return null;
    return expires + graceMs - now;
}

/** True when the countdown has run out and Accept must be disabled. */
export function isIntentExpired(signedAt: unknown, now: number = Date.now()): boolean {
    const remaining = intentRemainingMs(signedAt, now);
    if (remaining === null) return true; // no signed intent → never acceptable server-side
    return remaining <= 0;
}

/** m:ss (h:mm:ss past an hour); 'expired' at/past zero; '—' for unknown input. */
export function formatCountdown(remainingMs: number | null | undefined): string {
    if (remainingMs === null || remainingMs === undefined || !Number.isFinite(remainingMs)) {
        return '—';
    }
    if (remainingMs <= 0) return 'expired';
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
