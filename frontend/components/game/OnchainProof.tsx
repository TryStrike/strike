'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import { concat, keccak256, type Hex } from 'viem';
import { explorerTxUrl } from '@/lib/arc/config';
import { Badge } from '@/components/ui/kit';

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

interface BetProof {
  epoch: number;
  end_ms: number;
  leaf: Hex | null;
  proof: Hex[] | null;
  house_root: Hex | null;
  commit_tx: Hex | null;
  status: 'pending' | 'committed';
}

type State = { kind: 'loading' } | { kind: 'error'; reason: string } | { kind: 'ready'; data: BetProof; at: number };

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
  const [reload, setReload] = useState(0);
  const pendingReplies = useRef(0);

  useEffect(() => {
    pendingReplies.current = 0;
  }, [betId]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    fetch(`/api/proofs/bet/${encodeURIComponent(betId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
        return (await res.json()) as BetProof;
      })
      .then((data) => {
        if (cancelled) return;
        const at = Date.now();
        setState({ kind: 'ready', data, at });
        if (data.status !== 'pending') return;
        const backoff = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** pendingReplies.current);
        if (at >= data.end_ms) pendingReplies.current += 1;
        timer = window.setTimeout(() => setReload((n) => n + 1), Math.max(data.end_ms - at, backoff));
      })
      .catch((err: Error) => {
        console.error('[proof] onchain proof fetch failed', betId, err);
        if (!cancelled) setState({ kind: 'error', reason: err.message });
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [betId, reload]);

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
      {state.kind === 'ready' && <ProofBody data={state.data} at={state.at} />}
    </div>
  );
}

const ProofBody: React.FC<{ data: BetProof; at: number }> = ({ data, at }) => {
  const { epoch, status, commit_tx, house_root } = data;
  const epochLine = <span className="font-jet text-subtle">epoch {epoch}</span>;

  if (status === 'pending' && at >= data.end_ms) {
    return <p className="mt-1.5 text-[11px] leading-relaxed text-muted">Not committed onchain yet for {epochLine}.</p>;
  }

  if (status === 'pending') {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        Committed onchain after the epoch closes, about 10 min. {epochLine} closes in{' '}
        <Countdown target={data.end_ms} />.
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
