'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import type { Hex } from 'viem';
import { explorerAddressUrl, explorerTxUrl, getArcConfig } from '@/lib/arc/config';
import { arcPublicClient } from '@/lib/arc/client';
import { roundLeaf, type RoundFields } from '@/lib/proofs/leaf';
import { Badge } from '@/components/ui/kit';
import { entityUrl } from '@/lib/arkiv';

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

interface BetProof {
  epoch: number;
  end_ms: number;
  leaf: Hex | null;
  round: RoundFields | null;
  proof: Hex[] | null;
  house_root: Hex | null;
  commit_tx: Hex | null;
  epoch_entity?: Hex | null;
  swarm_ref?: string | null;
  status: 'pending' | 'committed' | 'off';
}

type State = { kind: 'loading' } | { kind: 'error'; reason: string } | { kind: 'ready'; data: BetProof; at: number };

const VERIFY_ROUND_ABI = [
  {
    type: 'function',
    name: 'verifyRound',
    stateMutability: 'view',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'leaf', type: 'bytes32' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

type Verdict = { kind: 'checking' } | { kind: 'done'; leafOk: boolean; onchain: boolean } | { kind: 'error'; reason: string };
type Keyed = Verdict & { key: string };

/**
 * Rebuilds the leaf from the round's own fields, then asks StrikeTreasury on Arc
 * whether it is in the committed root. Neither step takes our server's word for it.
 */
function useArcVerdict(data: BetProof): Verdict {
  const key = `${data.epoch}:${data.leaf}:${data.proof?.join(',')}`;
  const [verdict, setVerdict] = useState<Keyed>({ kind: 'checking', key: '' });
  useEffect(() => {
    if (data.status !== 'committed' || !data.round || !data.proof) return;
    let cancelled = false;
    (async () => {
      const leaf = roundLeaf(data.round as RoundFields);
      const onchain = await arcPublicClient().readContract({
        address: getArcConfig().treasuryAddress as Hex,
        abi: VERIFY_ROUND_ABI,
        functionName: 'verifyRound',
        args: [BigInt(data.epoch), leaf, data.proof as Hex[]],
      });
      if (!cancelled) setVerdict({ kind: 'done', leafOk: leaf === data.leaf, onchain, key });
    })().catch((err: Error) => {
      console.error('[proof] verifyRound on Arc failed', err);
      if (!cancelled) setVerdict({ kind: 'error', reason: err.message, key });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, data.status]);
  return verdict.key === key ? verdict : { kind: 'checking' };
}

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

/** Reads raw bytes by reference; the web gateway answers 200 for any address, so it cannot tell a miss. */
const SWARM_GATEWAY = 'https://api.gateway.ethswarm.org';

const ArchiveLink: React.FC<{ href: string; label: string; id: string }> = ({ href, label, id }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 font-jet text-up">
    <span className="text-subtle">{label}</span>
    <span className="truncate">{`${id.slice(0, 8)}…${id.slice(-4)}`}</span>
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
  const { epoch, status, commit_tx } = data;
  const epochLine = <span className="font-jet text-subtle">epoch {epoch}</span>;

  if (status === 'off') {
    return (
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        Onchain proofs are off on this server, so {epochLine} will not be committed to Arc.
      </p>
    );
  }

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

  return (
    <>
      <ArcVerdict data={data} />
      {commit_tx && (
        <div className="mt-2 text-xs">
          <TxLink hash={commit_tx} label="House commit" />
        </div>
      )}
      {data.epoch_entity && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
          <ArchiveLink href={entityUrl(data.epoch_entity)} label="Epoch on Arkiv" id={data.epoch_entity} />
          {data.swarm_ref && (
            <ArchiveLink href={`${SWARM_GATEWAY}/bytes/${data.swarm_ref}`} label="Every round + proof on Swarm" id={data.swarm_ref} />
          )}
        </div>
      )}
    </>
  );
};

const ArcVerdict: React.FC<{ data: BetProof }> = ({ data }) => {
  const verdict = useArcVerdict(data);
  const treasury = getArcConfig().treasuryAddress;
  const epochLine = <span className="font-jet text-subtle">epoch {data.epoch}</span>;
  if (verdict.kind === 'checking') {
    return <p className="mt-1.5 text-[11px] text-muted">Asking StrikeTreasury on Arc to verify this round…</p>;
  }
  if (verdict.kind === 'error') {
    return <p className="mt-1.5 text-[11px] text-down">Could not reach Arc to verify: {verdict.reason}</p>;
  }
  const ok = verdict.leafOk && verdict.onchain;
  return (
    <p className={`mt-1.5 text-[11px] leading-relaxed ${ok ? 'text-up' : 'text-down'}`}>
      {ok ? (
        <>
          Verified on Arc: your browser rebuilt this round&apos;s leaf and{' '}
          <a href={explorerAddressUrl(treasury)} target="_blank" rel="noopener noreferrer" className="underline">
            StrikeTreasury.verifyRound
          </a>{' '}
          returned true for {epochLine}.
        </>
      ) : !verdict.leafOk ? (
        <>This round&apos;s fields do not hash to the leaf the server sent. Do not trust this record.</>
      ) : (
        <>StrikeTreasury on Arc says this round is not in the root committed for {epochLine}.</>
      )}
    </p>
  );
};
