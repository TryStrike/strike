import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** HttpOnly cookie name — verified in assertBalanceApiAuthorized. */
export const BALANCE_SESSION_COOKIE = 'strike_balance_gate';

const SESSION_VERSION = 1;
const TTL_SECONDS = 60 * 60 * 12;

function signingSecret(): string {
  return process.env.BALANCE_INTERNAL_SECRET?.trim() ?? '';
}

interface BalanceSessionPayload {
  v: number;
  exp: number;
  n: string;
}

/**
 * Mint a signed session value (server-only). Caller sets it as HttpOnly cookie.
 */
export function mintBalanceSessionCookieValue(): string | null {
  const secret = signingSecret();
  if (!secret) return null;

  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const n = randomBytes(16).toString('hex');
  const payloadObj: BalanceSessionPayload = { v: SESSION_VERSION, exp, n };
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify cookie value was signed with BALANCE_INTERNAL_SECRET and not expired.
 */
export function verifyBalanceSessionCookieValue(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const secret = signingSecret();
  if (!secret) return false;

  const parts = raw.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!payload || !sig) return false;

  const expectedSig = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as BalanceSessionPayload;
    if (decoded.v !== SESSION_VERSION || typeof decoded.exp !== 'number') return false;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}
