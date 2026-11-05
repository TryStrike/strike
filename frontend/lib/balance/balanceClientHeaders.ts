/**
 * Balance mutation APIs are authorized via an HttpOnly cookie minted by POST /api/balance/session
 * (see backend/crates/core/src/crypto.rs). No server secret is placed in NEXT_PUBLIC_*.
 *
 * Call `ensureBalanceSession()` once after the app shell loads so subsequent same-origin fetches
 * include the cookie (fetch defaults to same-origin credentials).
 */

export async function ensureBalanceSession(): Promise<void> {
  if (typeof window === 'undefined') return;
  // Without this cookie every bet, deposit and withdrawal answers 401, so a failure is loud.
  try {
    const res = await fetch('/api/balance/session', { method: 'POST', credentials: 'include' });
    if (!res.ok) console.error(`[session] balance session mint answered ${res.status}`);
  } catch (err) {
    console.error('[session] balance session mint failed', err);
  }
}

