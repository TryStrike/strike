
export async function ensureBalanceSession(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const res = await fetch('/api/balance/session', { method: 'POST', credentials: 'include' });
    if (!res.ok) console.error(`[session] balance session mint answered ${res.status}`);
  } catch (err) {
    console.error('[session] balance session mint failed', err);
  }
}

