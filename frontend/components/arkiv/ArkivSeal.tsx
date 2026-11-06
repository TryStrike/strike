'use client';

import React, { useEffect, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import { matchesLedger, type ArkivEntity } from '@/lib/arkiv';

interface Seal {
  sealed: boolean;
  settled?: boolean;
  block?: number;
  entityUrl?: string;
  entity?: ArkivEntity | null;
}

export default function ArkivSeal({ betId, ledgerPayout }: { betId: string; ledgerPayout: number | null }) {
  const [seal, setSeal] = useState<Seal | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    const started = performance.now();
    const clock = setInterval(() => setWaited(performance.now() - started), 100);
    const ctrl = new AbortController();
    fetch(`/api/arkiv/bets/${encodeURIComponent(betId)}/seal`, { credentials: 'include', signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setSeal)
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        console.error('[arkiv] seal fetch failed', betId, err);
        setFailed(String(err.message ?? err));
      })
      .finally(() => clearInterval(clock));
    return () => {
      ctrl.abort();
      clearInterval(clock);
    };
  }, [betId]);

  const ok = seal?.entity ? matchesLedger(seal.entity, ledgerPayout) : null;

  return (
    <div data-testid="arkiv-seal" className="mt-3 flex items-center justify-between gap-3 rounded-3xl border border-line px-4 py-3">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.08em] text-subtle">Arkiv</div>
        <div className="mt-0.5 text-xs">
          {failed ? (
            <span className="text-down">Could not read the seal ({failed})</span>
          ) : !seal ? (
            <span className="font-jet text-muted">Sealing… {(waited / 1000).toFixed(1)}s</span>
          ) : !seal.sealed ? (
            <span className="text-muted">{seal.settled ? 'Queued for the next block' : 'Sealed once the round settles'}</span>
          ) : ok === false ? (
            <span className="text-down">Sealed in block #{seal.block}, does not match the ledger</span>
          ) : (
            <span className="text-ink">
              Sealed in block #{seal.block}, <span className="text-up">matches the ledger</span>
            </span>
          )}
        </div>
      </div>
      {seal?.entityUrl ? (
        <a
          href={seal.entityUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-muted ring-1 ring-line"
        >
          Verify <ArrowUpRight size={12} />
        </a>
      ) : null}
    </div>
  );
}
