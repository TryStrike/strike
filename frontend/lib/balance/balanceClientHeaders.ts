let inflight: Promise<void> | null = null;

/** Signs the connected wallet in once. A cookie already bound to it is reused, so reloads never prompt. */
export function ensureBalanceSession(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  inflight ??= mint().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function mint(): Promise<void> {
  const [{ getAccount, signMessage }, { config }] = await Promise.all([
    import('wagmi/actions'),
    import('@/lib/arc/wagmi'),
  ]);
  const { address } = getAccount(config);
  if (!address) return;

  const current = await fetch('/api/balance/session', { credentials: 'include' });
  if (current.ok && (await current.json()).wallet === address.toLowerCase()) return;

  const issuedAt = Date.now();
  const message = `Sign in to Strike\nWallet: ${address}\nIssued: ${issuedAt}`;
  const signature = await signMessage(config, { account: address, message });
  const res = await fetch('/api/balance/session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, issuedAt, signature }),
  });
  if (!res.ok) throw new Error(`balance session sign-in answered ${res.status}`);
}
