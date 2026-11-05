import { NextRequest, NextResponse } from 'next/server';
import { issueAdminToken, COOKIE_NAME, ttlSeconds } from '@/lib/admin/adminToken';

/**
 * Admin dashboard authentication.
 *
 * On success issues a short-lived HMAC-signed session token stored in an
 * httpOnly, Secure, SameSite=Strict cookie — the password itself is never
 * sent back to the client or stored in localStorage.
 */
export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();

    const stored = process.env.DASHBOARD_PASSWORD;
    if (!stored) {
      return NextResponse.json(
        { ok: false, error: 'Auth not configured on server.' },
        { status: 503 },
      );
    }

    if (!password || typeof password !== 'string') {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
    // Hash both values to a fixed-length digest before comparing, so the
    // response timing reveals nothing about the stored password's length.
    const { createHmac, timingSafeEqual } = await import('crypto');
    const hmacKey = Buffer.from(stored, 'utf-8');
    const a = createHmac('sha256', hmacKey).update(password).digest();
    const b = createHmac('sha256', hmacKey).update(stored).digest();
    if (!timingSafeEqual(a, b)) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const token = issueAdminToken();
    const ttl = ttlSeconds();

    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: ttl,
      path: '/',
    });
    return res;
  } catch {
    return NextResponse.json({ ok: false, error: 'Bad request' }, { status: 400 });
  }
}
