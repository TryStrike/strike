
import { MAX_ACCEPT_INTENT_AGE_MS, MAX_CLOCK_SKEW_MS } from '@/lib/balance/withdrawalIntent';

export type IntentWindowState = 'open' | 'expired' | 'unknown';

export interface IntentWindow {
  state: IntentWindowState;
  signedAtMs: number | null;
  expiresAtMs: number | null;
  remainingMs: number;
  maxAgeMs: number;
}

export function describeIntentWindow(
  signedAt: unknown,
  now: number = Date.now(),
  maxAgeMs: number = MAX_ACCEPT_INTENT_AGE_MS,
): IntentWindow {
  const ts = Number(signedAt);
  if (signedAt == null || signedAt === '' || !Number.isFinite(ts) || !Number.isFinite(now)) {
    return { state: 'unknown', signedAtMs: null, expiresAtMs: null, remainingMs: 0, maxAgeMs };
  }

  const ageMs = now - ts;
  if (ageMs <= maxAgeMs && ageMs >= -MAX_CLOCK_SKEW_MS) {
    return {
      state: 'open',
      signedAtMs: ts,
      expiresAtMs: ts + maxAgeMs,
      remainingMs: Math.max(0, ts + maxAgeMs - now),
      maxAgeMs,
    };
  }
  if (ageMs < -MAX_CLOCK_SKEW_MS) {
    return { state: 'unknown', signedAtMs: ts, expiresAtMs: ts + maxAgeMs, remainingMs: 0, maxAgeMs };
  }

  return { state: 'expired', signedAtMs: ts, expiresAtMs: ts + maxAgeMs, remainingMs: 0, maxAgeMs };
}

export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function windowMinutes(maxAgeMs: number = MAX_ACCEPT_INTENT_AGE_MS): number {
  return Math.max(1, Math.round(maxAgeMs / 60_000));
}
