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

export function isAuthorizationFresh(signedAt: unknown, now: number = Date.now()): boolean {
  const ageMs = now - Number(signedAt);
  if (!Number.isFinite(ageMs)) return false;
  return ageMs >= -MAX_CLOCK_SKEW_MS && ageMs <= MAX_INTENT_AGE_MS;
}
