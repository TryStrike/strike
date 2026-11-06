'use client';

import React, { useState } from 'react';
import { useSignMessage } from 'wagmi';
import { entityUrl } from '@/lib/arkiv';
import { enableArkivBets, useArkivDelegation, useBetEntity } from '@/lib/arkivBets';

/** Opt in once: the wallet delegates a browser key that writes every bet to Arkiv as the player's own entity. */
export function ArkivOwnBets({ wallet }: { wallet: string }) {
  const delegation = useArkivDelegation(wallet);
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (delegation) {
    return (
      <p className="font-jet text-[11px] text-faint">
        Your bets are written to Arkiv by your key {delegation.key.slice(0, 6)}…{delegation.key.slice(-4)}, not by Strike.
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface px-3 py-2">
      <p className="text-xs text-muted">Own a public record of every bet on Arkiv. One signature, no popups after.</p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await enableArkivBets(wallet, (message) => signMessageAsync({ message }));
          } catch (err) {
            setError(err instanceof Error ? err.message.split('\n')[0] : 'Could not set up Arkiv');
          } finally {
            setBusy(false);
          }
        }}
        className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Setting up…' : 'Turn on'}
      </button>
      {error && <p className="text-[11px] text-down">{error}</p>}
    </div>
  );
}

/** Link to the player's own Arkiv entity for one bet, once their key has written it. */
export function MyBetEntityLink({ betId }: { betId: string }) {
  const key = useBetEntity(betId);
  if (!key) return null;
  return (
    <a
      href={entityUrl(key)}
      target="_blank"
      rel="noopener noreferrer"
      title="Your own record of this bet on Arkiv, written by your key"
      className="rounded-full bg-up-soft px-2 py-0.5 font-jet text-[10px] font-medium text-up"
    >
      yours on Arkiv
    </a>
  );
}
