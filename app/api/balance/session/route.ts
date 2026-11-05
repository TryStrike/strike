import { NextResponse } from 'next/server';
import {
  BALANCE_SESSION_COOKIE,
  mintBalanceSessionCookieValue,
} from '@/lib/balance/balanceSession';

/**
 * Issues an HttpOnly, signed cookie so the browser can call balance mutation APIs
 * without embedding BALANCE_INTERNAL_SECRET (or any NEXT_PUBLIC copy) in the client bundle.
 *
 * POST from the first-party app with credentials; same-origin fetch sends the cookie on later requests.
 */
export async function POST() {
  const value = mintBalanceSessionCookieValue();
  const res = NextResponse.json({ ok: true as const });

  if (value) {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookies.set(BALANCE_SESSION_COOKIE, value, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
  }

  return res;
}
