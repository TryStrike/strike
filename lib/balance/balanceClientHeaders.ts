/**
 * Balance mutation APIs are authorized via an HttpOnly cookie minted by POST /api/balance/session
 * (see lib/balance/balanceSession.ts). No server secret is placed in NEXT_PUBLIC_*.
 *
 * Call `ensureBalanceSession()` once after the app shell loads so subsequent same-origin fetches
 * include the cookie (fetch defaults to same-origin credentials).
 */

export async function ensureBalanceSession(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await fetch('/api/balance/session', {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Non-fatal; user may retry on next navigation. Balance calls will 401 until cookie exists.
  }
}

