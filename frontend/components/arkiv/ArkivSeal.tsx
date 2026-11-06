'use client';

import React, { useEffect, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import { entityUrl, matchesLedger, readSealedEntity, type ArkivEntity } from '@/lib/arkiv';

interface Seal {
  sealed: boolean;
  off?: boolean;
  settled?: boolean;
  block?: number;
  key?: string;
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
    // The server holds each ask up to 25 s; a round still settling or queued gets asked again.
    const ask = (): Promise<void> =>
      fetch(`/api/arkiv/bets/${encodeURIComponent(betId)}/seal`, { credentials: 'include', signal: ctrl.signal })
        .then((res) => {
          if (res.status === 503) return { sealed: false, off: true };
          return res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`));
        })
        .then(async (s: Seal) => {
          if (!s.sealed && !s.off && !ctrl.signal.aborted) {
            setSeal(s);
            return ask();
          }
          setSeal(s.sealed && s.key ? { ...s, entity: await readSealedEntity(s.key, ctrl.signal) } : s);
        });
    ask()
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
        <div className="text-[11px] uppercase tracking-[0.08em] text-subtle">Public record</div>
        <div className="mt-0.5 text-xs">
          {failed ? (
            <span className="text-down">Could not read the public record ({failed})</span>
          ) : !seal ? (
            <span className="text-muted">Verifying… <span className="font-jet">{(waited / 1000).toFixed(1)}s</span></span>
          ) : seal.off ? (
            <span className="text-muted">Public records are off on this server</span>
          ) : !seal.sealed ? (
            <span className="text-muted">{seal.settled ? 'Publishing in the next block' : 'Published once the round settles'}</span>
          ) : !seal.entity ? (
            <span className="text-down">Our server says published, but the record is missing on Arkiv</span>
          ) : ok === false ? (
            <span className="text-down">The public record does not match your payout</span>
          ) : (
            <span className="text-ink">
              <span className="text-up">Verified.</span> Your payout matches the public record on Arkiv, block #{seal.block}
            </span>
          )}
        </div>
      </div>
      {seal?.key ? (
        <a
          href={entityUrl(seal.key)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-muted ring-1 ring-line"
        >
          View record <ArrowUpRight size={12} />
        </a>
      ) : null}
    </div>
  );
}
