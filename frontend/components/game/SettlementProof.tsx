'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, ShieldCheck } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { Modal } from '@/components/ui/Modal';
import dynamic from 'next/dynamic';

const ArkivSeal = dynamic(() => import('@/components/arkiv/ArkivSeal'), {
  ssr: false,
});

const OnchainProof = dynamic(() => import('./OnchainProof'), { ssr: false });

export interface SettlementTick {
  timestamp: number;
  price: number;
  stale?: boolean;
}

export interface SettlementProofInput {
  betId: string;
  asset?: string | null;
  mode?: string | null;
  direction?: string | null;
  stake?: number | null;
  multiplier?: number | null;
  payout?: number | null;
  won?: boolean | null;
  network?: string | null;
  strikePrice?: number | null;
  endTime?: number | null;
  recordedEndPrice?: number | null;
  resolvedAt?: number | null;
  ticks?: SettlementTick[];
  isDemoBet?: boolean;
}

export type SettlementOutcome = 'win' | 'loss' | 'draw' | 'unknown';

export interface SettlementProofData {
  betId: string;
  asset: string | null;
  mode: string | null;
  direction: string | null;
  stake: number | null;
  multiplier: number | null;
  payout: number | null;
  outcome: SettlementOutcome;
  outcomeLabel: string;
  tieRefund: boolean;
  strikePrice: number | null;
  settlementPrice: number | null;
  settlementTakenAt: number | null;
  delta: number | null;
  verdict: string | null;
  network: string | null;
}

const finiteOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const priceOrNull = (v: unknown): number | null => {
  const n = finiteOrNull(v);
  return n === null || n <= 0 ? null : n;
};

const epochMsOrNull = priceOrNull;

export function pickSettlementTick(
  ticks: SettlementTick[] | undefined,
  endTime: number | null | undefined,
): SettlementTick | null {
  if (!Array.isArray(ticks) || ticks.length === 0) return null;
  if (endTime === null || endTime === undefined || !Number.isFinite(endTime)) return null;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i];
    if (t && Number.isFinite(t.timestamp) && Number.isFinite(t.price) && t.timestamp <= endTime) {
      return t;
    }
  }
  return null;
}

export function isTieRefund(input: {
  won?: boolean | null;
  stake?: number | null;
  payout?: number | null;
  multiplier?: number | null;
}): boolean {
  const { won, stake, payout, multiplier } = input;
  if (won !== true) return false;
  const s = finiteOrNull(stake);
  const p = finiteOrNull(payout);
  if (s === null || p === null || s <= 0) return false;
  if (Math.abs(p - s) > 1e-9) return false;
  const m = finiteOrNull(multiplier);
  return m === null || m > 1;
}

export function buildSettlementProof(input: SettlementProofInput): SettlementProofData {
  const stake = finiteOrNull(input.stake);
  const payout = finiteOrNull(input.payout);
  const multiplier = finiteOrNull(input.multiplier);
  const strike = priceOrNull(input.strikePrice);
  const endTime = finiteOrNull(input.endTime);
  const tick = pickSettlementTick(input.ticks, endTime);
  const settlementPrice = tick ? tick.price : priceOrNull(input.recordedEndPrice);
  const settlementTakenAt = tick ? tick.timestamp : (endTime ?? finiteOrNull(input.resolvedAt));

  const tieRefund =
    isTieRefund({ won: input.won, stake, payout, multiplier }) ||
    (strike !== null && settlementPrice !== null && Math.abs(strike - settlementPrice) <= 1e-12);

  const outcome: SettlementOutcome =
    input.won === null || input.won === undefined ? 'unknown' : tieRefund ? 'draw' : input.won ? 'win' : 'loss';
  const outcomeLabel = {
    draw: 'Draw, stake refunded',
    win: 'Won',
    loss: 'Lost',
    unknown: 'Unsettled',
  }[outcome];

  const delta = strike !== null && settlementPrice !== null ? settlementPrice - strike : null;
  const dir = (input.direction || '').toUpperCase();
  let verdict: string | null = null;
  if (delta !== null && tieRefund && Math.abs(delta) <= 1e-12) {
    verdict = 'It settled exactly at the strike, so your stake comes back.';
  } else if (delta !== null && (dir === 'UP' || dir === 'DOWN')) {
    verdict = `You called ${dir === 'UP' ? 'higher' : 'lower'} and it settled ${delta > 0 ? 'higher' : 'lower'}, so you ${
      outcome === 'win' ? 'won' : outcome === 'draw' ? 'drew' : 'lost'
    }.`;
  }

  return {
    betId: input.betId,
    asset: input.asset ?? null,
    mode: input.mode ?? null,
    direction: input.direction ?? null,
    stake,
    multiplier,
    payout,
    outcome,
    outcomeLabel,
    tieRefund,
    strikePrice: strike,
    settlementPrice,
    settlementTakenAt,
    delta,
    verdict,
    network: input.network ?? null,
  };
}

export function formatSettlementPrice(value: number | null | undefined): string {
  const n = finiteOrNull(value);
  if (n === null) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

export function formatSettlementClock(value: number | null | undefined): string {
  const n = epochMsOrNull(value);
  if (n === null) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function matchSettledRound<
  T extends {
    id: string;
    timestamp: number;
    amount: string;
    payout: string;
    won: boolean;
  },
>(bets: T[], result: { timestamp: number; amount: number; payout: number; won: boolean } | null | undefined): T | null {
  if (!result || !Array.isArray(bets)) return null;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const bet of bets) {
    const distance = Math.abs(bet.timestamp - result.timestamp);
    if (distance > 10_000) continue;
    if (Number(bet.amount) !== result.amount) continue;
    if (Number(bet.payout) !== result.payout) continue;
    if (bet.won !== result.won) continue;
    if (distance < bestDistance) {
      best = bet;
      bestDistance = distance;
    }
  }
  return best;
}

export const isDemoBetId = (betId: string | null | undefined): boolean => /^demo-/i.test(String(betId ?? ''));

export interface SettlementProofProps {
  bet: SettlementProofInput;
  wallet?: string | null;
  variant?: 'bar' | 'chip';
  ticks?: SettlementTick[];
  label?: string;
}

interface ServerBetProof {
  stake?: number | null;
  multiplier?: number | null;
  payout?: number | null;
  won?: boolean | null;
  tie_refund?: boolean;
  strike_price?: number | null;
  recorded_end_price?: number | null;
  network?: string | null;
  asset?: string | null;
  mode?: string | null;
  direction?: string | null;
  resolved_at?: string | null;
  settlement?: { price?: number | null; taken_at?: string | null };
  ledger?: { end_time?: string | null };
}

const toMs = (isoish: unknown): number | null => {
  if (!isoish) return null;
  const t = new Date(String(isoish)).getTime();
  return Number.isNaN(t) ? null : t;
};

const formatMoney = (v: number | null, network: string | null) =>
  v === null ? '—' : `${v.toFixed(2)} ${network || 'USDC'}`;

const Row: React.FC<{
  label: string;
  children: React.ReactNode;
  highlight?: boolean;
}> = ({ label, children, highlight }) => (
  <div className={highlight ? 'rounded-2xl bg-ink/[0.04] px-3 py-2.5' : 'px-3'}>
    <div className="flex items-baseline justify-between gap-3">
      <span className={`text-[11px] uppercase tracking-[0.08em] ${highlight ? 'text-ink' : 'text-subtle'}`}>
        {label}
      </span>
      <span className={`text-right font-jet text-sm ${highlight ? 'font-semibold text-ink' : 'text-ink'}`}>
        {children}
      </span>
    </div>
  </div>
);

export const SettlementProof: React.FC<SettlementProofProps> = ({
  bet,
  wallet,
  variant = 'bar',
  ticks: ticksProp,
  label,
}) => {
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<ServerBetProof | null>(null);
  const [serverState, setServerState] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'unavailable'>('idle');
  const [copied, setCopied] = useState<string | null>(null);
  const requestedRef = useRef(false);
  const demo = bet.isDemoBet === true || isDemoBetId(bet.betId);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    if (demo) {
      setServerState((s) => (s === 'unavailable' ? s : 'unavailable'));
      return;
    }
    if (!wallet || requestedRef.current) return;
    requestedRef.current = true;
    let cancelled = false;
    setServerState('loading');
    fetch(`/api/bets/${encodeURIComponent(bet.betId)}?wallet=${encodeURIComponent(wallet)}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((payload: { bet?: ServerBetProof }) => {
        if (cancelled) return;
        setServer(payload?.bet ?? null);
        setServerState('ready');
      })
      .catch((err) => {
        console.error('[proof] settlement proof fetch failed', bet.betId, err);
        if (!cancelled) setServerState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [open, wallet, bet.betId, demo]);

  useEffect(() => {
    if (!open && serverState === 'failed') requestedRef.current = false;
  }, [open, serverState]);

  const local = useMemo(() => {
    const empty = {
      ticks: [] as SettlementTick[],
      rowEndTime: null as number | null,
      rowAsset: null as string | null,
    };
    if (!open) return empty;
    try {
      const state = useStore.getState() as unknown as {
        assetHistories?: Record<string, SettlementTick[]>;
        selectedAsset?: string;
        priceHistory?: SettlementTick[];
        bets?: Array<{
          id?: string;
          endTime?: number | string | null;
          asset?: string | null;
        }>;
      };
      const row = Array.isArray(state.bets) ? (state.bets.find((b) => b && b.id === bet.betId) ?? null) : null;
      const rawEnd = row?.endTime;
      const rowEndTime = typeof rawEnd === 'number' && Number.isFinite(rawEnd) ? rawEnd : rawEnd ? toMs(rawEnd) : null;
      const key = bet.asset ?? row?.asset ?? state.selectedAsset;
      const history = (key && state.assetHistories?.[key]) || state.priceHistory || [];
      return {
        ticks: Array.isArray(history) ? history : [],
        rowEndTime,
        rowAsset: typeof row?.asset === 'string' && row.asset ? row.asset : null,
      };
    } catch {
      return empty;
    }
  }, [open, bet.betId, bet.asset]);

  const localTicks = Array.isArray(ticksProp) ? ticksProp : local.ticks;

  const ledgerEndMs = toMs(server?.ledger?.end_time);
  const proof = useMemo(
    () =>
      buildSettlementProof({
        ...bet,
        strikePrice: bet.strikePrice ?? server?.strike_price ?? null,
        recordedEndPrice: bet.recordedEndPrice ?? server?.recorded_end_price ?? server?.settlement?.price ?? null,
        stake: bet.stake ?? server?.stake ?? null,
        payout: bet.payout ?? server?.payout ?? null,
        multiplier: bet.multiplier ?? server?.multiplier ?? null,
        won: bet.won ?? server?.won ?? null,
        network: bet.network ?? server?.network ?? null,
        endTime: bet.endTime ?? ledgerEndMs ?? local.rowEndTime ?? null,
        resolvedAt: bet.resolvedAt ?? toMs(server?.resolved_at) ?? null,
        asset: bet.asset ?? server?.asset ?? local.rowAsset ?? null,
        mode: bet.mode ?? server?.mode ?? null,
        direction: bet.direction ?? server?.direction ?? null,
        ticks: localTicks,
      }),
    [bet, server, ledgerEndMs, local, localTicks],
  );

  const copy = useCallback(async (value: string, kind: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(`${kind} copied`);
    } catch {
      setCopied(`${kind} could not be copied, select it manually`);
    }
    window.setTimeout(() => setCopied((c) => (c && c.startsWith(kind) ? null : c)), 2500);
  }, []);

  const priceDelta = proof.delta;

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`Open the settlement proof for bet ${proof.betId}${label ? ` — ${label}` : ''}`}
      className={
        variant === 'chip'
          ? 'inline-flex h-7 items-center gap-1 rounded-full bg-ink/[0.04] px-2.5 text-[11px] font-medium text-muted transition-colors hover:bg-ink/[0.07] hover:text-ink'
          : 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[12px] font-medium text-white ring-1 ring-white/25 backdrop-blur-xl transition-colors hover:bg-white/15'
      }
    >
      <ShieldCheck size={14} weight={variant === 'chip' ? 'regular' : 'bold'} />
      {variant === 'chip' ? (
        <>
          <span className="font-jet tabular-nums text-ink/80">
            {formatSettlementClock(bet.resolvedAt ?? proof.settlementTakenAt ?? null)}
          </span>
          <span className="text-muted/70">{label ?? 'Proof'}</span>
        </>
      ) : (
        'Settlement proof'
      )}
    </button>
  );

  return (
    <>
      {variant === 'bar' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-full bg-ink/80 px-3 py-1.5 text-[12px] text-white backdrop-blur-xl">
          <span className="flex items-center gap-2 font-jet tabular-nums">
            <span className="text-white/60">Strike</span>
            {formatSettlementPrice(proof.strikePrice)}
            <span className="text-white/40">→</span>
            <span className="text-white/60">Settled</span>
            {formatSettlementPrice(proof.settlementPrice)}
            {priceDelta !== null && (
              <span className={priceDelta > 0 ? 'text-[#9BE7B4]' : priceDelta < 0 ? 'text-[#FFB4A2]' : 'text-white/60'}>
                ({priceDelta > 0 ? '+' : ''}
                {priceDelta.toFixed(Math.abs(priceDelta) >= 1 ? 2 : 6)})
              </span>
            )}
          </span>
          {trigger}
        </div>
      ) : (
        trigger
      )}

      <Modal isOpen={open} onClose={close} title={`${proof.asset ?? 'Round'} ${proof.outcomeLabel.toLowerCase()}`}>
        <p className="-mt-4 mb-4 text-xs text-subtle">{formatSettlementClock(proof.settlementTakenAt)}</p>
        <div>
          {proof.verdict && (
            <p
              className={`rounded-2xl px-4 py-3 text-sm ${proof.outcome === 'loss' ? 'bg-down-soft text-down' : 'bg-up-soft text-up'}`}
            >
              {proof.verdict}
            </p>
          )}

          {(demo || serverState === 'failed') && (
            <p
              role="note"
              data-testid="proof-unavailable"
              className="mt-3 rounded-2xl bg-down-soft px-4 py-3 text-xs text-down"
            >
              {demo
                ? 'Practice round with play money. It never touched the ledger.'
                : 'Could not load this round from the server. Showing what this browser recorded.'}
            </p>
          )}

          <div className="mt-3 flex flex-col gap-2.5 rounded-3xl bg-surface px-1 py-3">
            <Row label="Called">{proof.direction === 'UP' ? 'Higher' : proof.direction === 'DOWN' ? 'Lower' : '—'}</Row>
            <Row label="Strike">{formatSettlementPrice(proof.strikePrice)}</Row>
            <Row label="Settled at">{formatSettlementPrice(proof.settlementPrice)}</Row>
            <Row label="Stake">{formatMoney(proof.stake, proof.network)}</Row>
            <Row label="Multiplier">{proof.multiplier === null ? '—' : `${proof.multiplier}×`}</Row>
            <Row label="Payout" highlight>
              {formatMoney(proof.payout, proof.network)}
            </Row>
          </div>

          {!demo ? <ArkivSeal betId={bet.betId} ledgerPayout={proof.payout} /> : null}
          {!demo && <OnchainProof betId={bet.betId} />}

          <div className="mt-3 flex items-center justify-between gap-2 rounded-3xl bg-ink/[0.03] px-4 py-3">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.08em] text-subtle">Bet id</div>
              <div className="truncate font-jet text-xs text-ink">{proof.betId}</div>
            </div>
            <button
              type="button"
              onClick={() => void copy(proof.betId, 'Bet id')}
              aria-label={`Copy bet id ${proof.betId}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-muted ring-1 ring-line"
            >
              <Copy size={12} /> Copy
            </button>
          </div>
        </div>

        <p aria-live="polite" className="sr-only">
          {copied}
        </p>
      </Modal>
    </>
  );
};

export default SettlementProof;
