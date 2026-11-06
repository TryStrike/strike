'use client';

import React, { useEffect, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import { concat, keccak256, type Hex } from 'viem';
import { explorerTxUrl } from '@/lib/arc/config';
import { Badge } from '@/components/ui/kit';

const CLOSE_GRACE_MS = 60_000;

interface BetProof {
  epoch: number;
  end_ms: number;
  leaf: Hex | null;
  proof: Hex[] | null;
  house_root: Hex | null;
  commit_tx: Hex | null;
  status: 'pending' | 'committed';
}

type State = { kind: 'loading' } | { kind: 'error'; reason: string } | { kind: 'ready'; data: BetProof };

const foldsToRoot = (leaf: Hex, proof: Hex[], root: Hex): boolean =>
  proof.reduce<Hex>((node, sib) => {
    const [a, b] = node.toLowerCase() < sib.toLowerCase() ? [node, sib] : [sib, node];
    return keccak256(concat([a, b]));
  }, leaf).toLowerCase() === root.toLowerCase();

export const TxLink: React.FC<{ hash: string; label: string }> = ({ hash, label }) => (
  <a
    href={explorerTxUrl(hash)}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex min-w-0 items-center gap-1 font-jet text-up underline-offset-2"
  >
    <span className="text-subtle">{label}</span>
    <span className="truncate">{`${hash.slice(0, 10)}…${hash.slice(-6)}`}</span>
    <ArrowUpRight size={12} />
  </a>
);

const Countdown: React.FC<{ target: number }> = ({ target }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((target - now) / 1000));
  return <span className="font-jet tabular-nums">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</span>;
};

export default function OnchainProof({ betId }: { betId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/proofs/bet/${encodeURIComponent(betId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
        return (await res.json()) as BetProof;
      })
      .then((data) => !cancelled && setState({ kind: 'ready', data }))
      .catch((err: Error) => {
        console.error('[proof] onchain proof fetch failed', betId, err);
        if (!cancelled) setState({ kind: 'error', reason: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [betId]);

  return (
    <div data-testid="onchain-proof" className="mt-3 rounded-3xl border border-line px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-[0.08em] text-subtle">Onchain proof</div>
        {state.kind === 'ready' && <Badge>{state.data.status}</Badge>}
      </div>
      {state.kind === 'loading' && <div className="mt-2 h-3 w-2/3 animate-pulse rounded-full bg-ink/[0.06]" />}
      {state.kind === 'error' && (
        <p className="mt-1.5 text-[11px] text-down">Onchain proof unavailable: {state.reason}</p>
      )}
      {state.kind === 'ready' && <ProofBody data={state.data} />}
    </div>
  );
}

const ProofBody: React.FC<{ data: BetProof }> = ({ data }) => {
  const { epoch, status, commit_tx, house_root } = data;
  const [now] = useState(Date.now);
  const epochLine = <span className="font-jet text-subtle">epoch {epoch}</span>;
  const closeAt = data.end_ms + CLOSE_GRACE_MS;

  if (status === 'pending' && now > closeAt) {
    return <p className="mt-1.5 text-[11px] leading-relaxed text-muted">Not committed onchain yet for {epochLine}.</p>;
  }

  if (status === 'pending') {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        Committed onchain after the epoch closes, about 10 min. {epochLine} closes in{' '}
        <Countdown target={closeAt} />.
      </p>
    );
  }

  const included =
    house_root && data.leaf && data.proof ? foldsToRoot(data.leaf, data.proof, house_root) : false;
  return (
    <>
      <p className={`mt-1.5 text-[11px] leading-relaxed ${included ? 'text-muted' : 'text-down'}`}>
        {included
          ? <>Your bet is in the house root for {epochLine}: the Merkle proof folds to the committed root.</>
          : <>The Merkle proof for this bet does not fold to the root committed for {epochLine}.</>}
      </p>
      {commit_tx && (
        <div className="mt-2 text-xs">
          <TxLink hash={commit_tx} label="House commit" />
        </div>
      )}
    </>
  );
};
