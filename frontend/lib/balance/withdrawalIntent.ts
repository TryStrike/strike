
export const MAX_INTENT_AGE_MS = 5 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 60 * 1000;

export const MAX_ACCEPT_INTENT_AGE_MS = 10 * 60 * 1000;

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
