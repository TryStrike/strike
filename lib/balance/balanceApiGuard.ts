import { NextRequest, NextResponse } from 'next/server';
import {
  BALANCE_SESSION_COOKIE,
  verifyBalanceSessionCookieValue,
} from '@/lib/balance/balanceSession';

const HEADER = 'x-strike-balance-key';

/**
 * When `BALANCE_INTERNAL_SECRET` is set in production, balance mutation routes require one of:
 * 1) Valid HttpOnly cookie from POST /api/balance/session (signed with the secret — never shipped to the client), or
 * 2) `Authorization: Bearer <BALANCE_INTERNAL_SECRET>` for trusted server-side / automation callers.
 */
export function assertBalanceApiAuthorized(request: NextRequest): NextResponse | null {
  const secret = process.env.BALANCE_INTERNAL_SECRET?.trim();

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: 'Balance API auth is not configured on server.' },
        { status: 503 },
      );
    }
    return null;
  }

  const bearerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearerToken && bearerToken === secret) {
    return null;
  }

  const cookieVal = request.cookies.get(BALANCE_SESSION_COOKIE)?.value;
  if (verifyBalanceSessionCookieValue(cookieVal)) {
    return null;
  }

  const browserKey = request.headers.get(HEADER)?.trim();
  if (browserKey && browserKey === secret) {
    return NextResponse.json(
      { error: 'Use POST /api/balance/session for browser auth or Bearer for server callers.' },
      { status: 401 },
    );
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
