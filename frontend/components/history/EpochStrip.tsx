'use client';

import React, { useEffect, useState } from 'react';
import { Badge, Label } from '@/components/ui/kit';
import { TxLink, solvencyLabel } from '@/components/game/OnchainProof';

interface EpochSummary {
  epoch: number;
  count: number;
  commit_tx: string;
  status: 'committed' | 'verified' | 'mismatch';
  checked: number | null;
  mismatches: number | null;
  skipped: number | null;
  solvency_bps: number | null;
}

type State = { kind: 'loading' } | { kind: 'error'; reason: string } | { kind: 'ready'; epochs: EpochSummary[] };

const TONE = { committed: 'neutral', verified: 'up', mismatch: 'down' } as const;

export default function EpochStrip() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/proofs/epochs?limit=10')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as EpochSummary[];
      })
      .then((epochs) => !cancelled && setState({ kind: 'ready', epochs }))
      .catch((err: Error) => {
        console.error('[proof] epoch strip fetch failed', err);
        if (!cancelled) setState({ kind: 'error', reason: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="Onchain epochs" className="rounded-3xl bg-white/70 p-5 ring-1 ring-ink/[0.06] backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Label>Onchain epochs</Label>
        <span className="font-jet text-[11px] text-faint">House roots on Arc, re-settled by Chainlink CRE</span>
      </div>
      {state.kind === 'loading' && <div className="h-3 w-1/2 animate-pulse rounded-full bg-ink/[0.06]" />}
      {state.kind === 'error' && <p className="text-[11px] text-down">Epoch proofs unavailable: {state.reason}</p>}
      {state.kind === 'ready' && state.epochs.length === 0 && (
        <p className="text-[11px] text-muted">No epoch committed yet. Roots land about 10 min after a round settles.</p>
      )}
      {state.kind === 'ready' && state.epochs.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {state.epochs.map((e) => (
            <li key={e.epoch} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-xs">
              <span className="flex items-center gap-2">
                <span className="font-jet text-ink">#{e.epoch}</span>
                <Badge tone={TONE[e.status]}>{e.status}</Badge>
              </span>
              <span className="font-jet text-[11px] text-muted">
                {e.status === 'committed'
                  ? `${e.count} rounds · Chainlink check pending`
                  : `${e.count} rounds · ${e.checked} checked · ${e.mismatches} mismatches · ${e.skipped} skipped · solvency ${solvencyLabel(e.solvency_bps)}`}
              </span>
              <TxLink hash={e.commit_tx} label="commit" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
