/**
 * Freshness rule for the signed withdrawal intent.
 *
 * A signature is good for five minutes. Clocks are not synchronised: a browser
 * running slightly ahead of the server produces a `signedAt` in the server's
 * future, so a small negative age has to be accepted or that player can never
 * withdraw their own funds.
 */

export const MAX_INTENT_AGE_MS = 5 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * A signature sitting in the manual approval queue is a standing instruction to
 * move money. Admins work the queue hours after the request, so the acceptance
 * window is wider than the request window — but it is not unbounded: an old
 * captured intent must not be executable forever.
 */
export const MAX_ACCEPT_INTENT_AGE_MS = 10 * 60 * 1000;

export function isAuthorizationFresh(signedAt: unknown, now: number = Date.now()): boolean {
  const ageMs = now - Number(signedAt);
  if (!Number.isFinite(ageMs)) return false;
  return ageMs >= -MAX_CLOCK_SKEW_MS && ageMs <= MAX_INTENT_AGE_MS;
}

/** True when a stored `signed_at` is still young enough to be paid out. */
export function isAuthorizationWithinAcceptWindow(
  signedAt: unknown,
  now: number = Date.now(),
  maxAgeMs: number = MAX_ACCEPT_INTENT_AGE_MS
): boolean {
  const ts = Number(signedAt);
  if (!Number.isFinite(ts)) return false;
  const ageMs = now - ts;
  return ageMs >= -MAX_CLOCK_SKEW_MS && ageMs <= maxAgeMs;
}
