
import {
    MAX_ACCEPT_INTENT_AGE_MS,
    MAX_CLOCK_SKEW_MS,
} from '@/lib/balance/withdrawalIntent';

export function intentExpiresAtMs(signedAt: unknown): number | null {
    if (signedAt === null || signedAt === undefined || signedAt === '') return null;
    const ts = Number(signedAt);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return ts + MAX_ACCEPT_INTENT_AGE_MS;
}

export function intentRemainingMs(
    signedAt: unknown,
    now: number = Date.now(),
    graceMs: number = MAX_CLOCK_SKEW_MS,
): number | null {
    const expires = intentExpiresAtMs(signedAt);
    if (expires === null || !Number.isFinite(now)) return null;
    return expires + graceMs - now;
}

export function isIntentExpired(signedAt: unknown, now: number = Date.now()): boolean {
    const remaining = intentRemainingMs(signedAt, now);
    if (remaining === null) return true;
    return remaining <= 0;
}

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
