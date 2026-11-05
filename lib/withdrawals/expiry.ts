/**
 * Acceptance-window math for stored withdrawal intents.
 *
 * A pending request is only payable while its signature sits inside the
 * acceptance window enforced by the admin accept route
 * (lib/balance/withdrawalIntent.ts, MAX_ACCEPT_INTENT_AGE_MS = 10 minutes).
 * Once that window elapses the ledger row stays 'pending' but no operator can
 * pay it any more — the player must re-request. This helper turns
 * `signed_at` into an honest, testable view state; it NEVER invents a paid
 * state from elapsed time and NEVER treats an unreadable timestamp as expired
 * (unknown degrades to the ordinary pending view).
 */

import { MAX_ACCEPT_INTENT_AGE_MS, MAX_CLOCK_SKEW_MS } from '@/lib/balance/withdrawalIntent';

export type IntentWindowState = 'open' | 'expired' | 'unknown';

export interface IntentWindow {
  state: IntentWindowState;
  /** Parsed `signed_at` in ms epoch, when readable. */
  signedAtMs: number | null;
  /** Last instant the accept route can still pay this intent. */
  expiresAtMs: number | null;
  /** Ms left in the acceptance window; 0 once expired. */
  remainingMs: number;
  /** The window the server applies, for honest copy ("10 minutes"). */
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
  // A slightly future timestamp is clock skew, not a free pass to expiry:
  // mirror the accept route and only expire once the age exceeds the window.
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
    // Too far in the future to trust: the server would reject it as unsignable,
    // but the player-facing truth is "we cannot evaluate this yet".
    return { state: 'unknown', signedAtMs: ts, expiresAtMs: ts + maxAgeMs, remainingMs: 0, maxAgeMs };
  }

  return { state: 'expired', signedAtMs: ts, expiresAtMs: ts + maxAgeMs, remainingMs: 0, maxAgeMs };
}

/** Compact "m remaining" copy, e.g. 252_000ms -> "4m 12s". */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Minutes as whole numbers, for window copy ("10-minute"). */
export function windowMinutes(maxAgeMs: number = MAX_ACCEPT_INTENT_AGE_MS): number {
  return Math.max(1, Math.round(maxAgeMs / 60_000));
}
