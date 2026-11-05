/**
 * Server-side admin session token.
 *
 * Issues a short-lived HMAC-signed token that is set as an httpOnly, Secure,
 * SameSite=Strict cookie. The actual DASHBOARD_PASSWORD is never stored on
 * the client — only this opaque token is, and only in a cookie that JavaScript
 * cannot read.
 *
 * Token format (base64url-encoded JSON envelope):
 *   { iat: <unix-seconds>, sig: <HMAC-SHA256 hex of "admin:<iat>"> }
 *
 * Expiry: ADMIN_SESSION_HOURS env var (default 8 hours).
 */

import { createHmac } from 'crypto';

const COOKIE_NAME = 'strike_admin_session';
const DEFAULT_TTL_HOURS = 8;

function signingKey(): string {
  const key = process.env.DASHBOARD_PASSWORD;
  if (!key) throw new Error('DASHBOARD_PASSWORD env var not set');
  return key;
}

function ttlSeconds(): number {
  const h = Number(process.env.ADMIN_SESSION_HOURS ?? DEFAULT_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_TTL_HOURS) * 3600;
}

function hmac(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function issueAdminToken(): string {
  const iat = Math.floor(Date.now() / 1000);
  const sig = hmac(signingKey(), `admin:${iat}`);
  const payload = JSON.stringify({ iat, sig });
  return Buffer.from(payload).toString('base64url');
}

export function verifyAdminToken(token: string | undefined | null): boolean {
  if (!token) return false;
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const { iat, sig } = payload as { iat: number; sig: string };
    if (typeof iat !== 'number' || typeof sig !== 'string') return false;

    // Check expiry
    const age = Math.floor(Date.now() / 1000) - iat;
    if (age < 0 || age > ttlSeconds()) return false;

    // Verify HMAC
    const expected = hmac(signingKey(), `admin:${iat}`);
    // Constant-time comparison to resist timing attacks
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

export { COOKIE_NAME, ttlSeconds };
