'use client';

import { useEffect, useState } from 'react';

export interface ArkivEntity {
  key: string;
  betId?: string;
  outcome?: string;
  payout?: string;
  currency?: string;
}

export interface ArkivSeals {
  explorer: string;
  rpc: string;
  query: string;
  byBet: Map<string, ArkivEntity>;
}

export const entityUrl = (explorer: string, key: string) => `${explorer}/entity/${key}`;

/** Arkiv stores payouts at 18 decimals, the ledger at 10. */
export function matchesLedger(entity: ArkivEntity, ledgerPayout: number | string | null | undefined): boolean {
  const a = Number(entity.payout);
  const b = Number(ledgerPayout);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
}

/** One Arkiv read for exactly the bets on screen. */
export function useArkivSeals(wallet: string, betIds: string[]): { seals: ArkivSeals | null; error: string | null } {
  const [seals, setSeals] = useState<ArkivSeals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = betIds.join(',');

  useEffect(() => {
    if (!wallet || !ids) return;
    const ctrl = new AbortController();
    fetch(`/api/arkiv/bets?wallet=${encodeURIComponent(wallet)}&ids=${encodeURIComponent(ids)}`, {
      credentials: 'include',
      signal: ctrl.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { explorer: string; rpc: string; query: string; rows: ArkivEntity[] }) => {
        const byBet = new Map(body.rows.filter((r) => r.betId).map((r) => [r.betId as string, r]));
        setSeals({ explorer: body.explorer, rpc: body.rpc, query: body.query, byBet });
        setError(null);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        console.error('[arkiv] seal lookup failed', err);
        setError(String(err.message ?? err));
      });
    return () => ctrl.abort();
  }, [wallet, ids]);

  return { seals, error };
}
