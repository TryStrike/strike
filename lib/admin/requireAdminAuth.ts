import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminToken, COOKIE_NAME } from './adminToken';

/**
 * Server-side admin authentication guard.
 *
 * Validates the httpOnly session cookie set by POST /api/admin/auth.
 * The cookie is signed and short-lived — the password itself is never
 * stored on the client.
 *
 * Usage in any route handler:
 *   const deny = requireAdminAuth(request);
 *   if (deny) return deny;
 */
export function requireAdminAuth(request: NextRequest): NextResponse | null {
  if (!process.env.DASHBOARD_PASSWORD) {
    return NextResponse.json(
      { error: 'Admin auth not configured on server. Set DASHBOARD_PASSWORD.' },
      { status: 503 },
    );
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!verifyAdminToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null; // authenticated — continue
}
