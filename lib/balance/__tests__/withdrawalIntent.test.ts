import {
  isAuthorizationFresh,
  MAX_INTENT_AGE_MS,
  MAX_CLOCK_SKEW_MS,
} from '@/lib/balance/withdrawalIntent';

const NOW = 1_800_000_000_000;

describe('isAuthorizationFresh', () => {
  it('accepts a signature made just now', () => {
    expect(isAuthorizationFresh(NOW, NOW)).toBe(true);
  });

  it('accepts one signed within the five minute window', () => {
    expect(isAuthorizationFresh(NOW - MAX_INTENT_AGE_MS + 1_000, NOW)).toBe(true);
  });

  it('rejects one older than the window', () => {
    expect(isAuthorizationFresh(NOW - MAX_INTENT_AGE_MS - 1, NOW)).toBe(false);
  });

  // The regression this file exists for: a player whose clock runs a few
  // seconds ahead of the server must still be able to withdraw.
  it('accepts a signature from a client whose clock is slightly ahead', () => {
    expect(isAuthorizationFresh(NOW + 5_000, NOW)).toBe(true);
  });

  it('rejects a timestamp further in the future than plausible skew', () => {
    expect(isAuthorizationFresh(NOW + MAX_CLOCK_SKEW_MS + 1, NOW)).toBe(false);
  });

  it('rejects values that are not usable timestamps', () => {
    expect(isAuthorizationFresh(undefined, NOW)).toBe(false);
    expect(isAuthorizationFresh('not-a-time', NOW)).toBe(false);
    expect(isAuthorizationFresh(Infinity, NOW)).toBe(false);
  });
});
