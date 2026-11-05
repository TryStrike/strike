import {
  mintBalanceSessionCookieValue,
  verifyBalanceSessionCookieValue,
} from '../balanceSession';

describe('balanceSession', () => {
  const prev = process.env.BALANCE_INTERNAL_SECRET;

  afterEach(() => {
    if (prev !== undefined) process.env.BALANCE_INTERNAL_SECRET = prev;
    else delete process.env.BALANCE_INTERNAL_SECRET;
  });

  it('mints a verifiable cookie value', () => {
    process.env.BALANCE_INTERNAL_SECRET = 'unit-test-balance-internal-secret-value';
    const v = mintBalanceSessionCookieValue();
    expect(v).toBeTruthy();
    expect(verifyBalanceSessionCookieValue(v)).toBe(true);
  });

  it('rejects tampered or garbage values', () => {
    process.env.BALANCE_INTERNAL_SECRET = 'unit-test-balance-internal-secret-value';
    expect(verifyBalanceSessionCookieValue(undefined)).toBe(false);
    expect(verifyBalanceSessionCookieValue('not.valid')).toBe(false);
    const v = mintBalanceSessionCookieValue();
    expect(verifyBalanceSessionCookieValue(`${v}x`)).toBe(false);
  });
});
