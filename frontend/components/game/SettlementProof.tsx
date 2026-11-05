'use client';

/**
 * SettlementProof
 *
 * The transparency panel for one settled round: what the strike was, the exact
 * price the round settled against, the instant that price was taken at, where
 * that number came from, and the ledger references the bet left behind.
 *
 * Settlement itself happens in the game engine, which reads "the last feed tick
 * at or before the round end" (see lib/store/gameSlice.ts `priceAtOrBefore`) and
 * refunds the stake when that tick equals the strike. This panel mirrors that
 * rule for display only — it never settles or writes anything.
 *
 * Everything user-facing is assembled by the pure `buildSettlementProof()`
 * below, which is unit-tested on its own.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Copy, ShieldCheck, X } from '@phosphor-icons/react';
import { explorerTxUrl } from '@/lib/arc/config';
import { useStore } from '@/lib/store';

/** A feed tick for an asset: the shape the engine settles against. */
export interface SettlementTick {
  timestamp: number;
  price: number;
  /** True when the tick came from a fallback (last-known / cached price) instead of a live read. */
  stale?: boolean;
}

export interface SettlementLedgerRefs {
  /** Audit rows exist for this bet, i.e. it moved the house ledger. */
  touched?: boolean;
  /** The ledger itself could not be read (distinct from "no references"). */
  available?: boolean;
  betRequestId?: string | null;
  endTime?: number | null;
  operations?: string[];
  txHashes?: string[];
  settlementTokenIssued?: boolean;
  network?: string | null;
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
  /** Round end frozen at click time. */
  endTime?: number | null;
  /** `end_price` as recorded on the bet row / held by the client at resolution. */
  recordedEndPrice?: number | null;
  resolvedAt?: number | null;
  /** Feed history for this bet's asset; the engine settles from these. */
  ticks?: SettlementTick[];
  /** The feed heartbeat was stalled when this proof was built. */
  feedDelayed?: boolean;
  ledger?: SettlementLedgerRefs | null;
  /**
   * Explicit play-money marker. Demo rounds are also detected from the
   * client-generated `demo-<ts>` bet id prefix; when true the panel never
   * pretends a server proof exists for a round that never touched the ledger.
   */
  isDemoBet?: boolean;
}

export type SettlementSource = 'feed_tick' | 'recorded_row' | 'unavailable';
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
  /** Instant the settlement price was taken at (tick timestamp, else row time). */
  settlementTakenAt: number | null;
  /** True when `settlementTakenAt` is the round end rather than a real tick time. */
  takenAtIsRoundEnd: boolean;
  endTime: number | null;
  source: SettlementSource;
  sourceLabel: string;
  /** Honest flag: the settlement value came from a fallback, not a live read. */
  tickStale: boolean;
  /** How far before the round end the chosen tick actually was. */
  tickGapMs: number | null;
  delta: number | null;
  verdict: string | null;
  network: string | null;
  betRequestId: string | null;
  operations: string[];
  txHashes: string[];
  ledgerTouched: boolean;
  ledgerAvailable: boolean;
  settlementTokenIssued: boolean;
  caveats: string[];
}

/** A tick older than this relative to the round end means the feed had a gap. */
export const FEED_GAP_STALE_MS = 5000;

const finiteOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A price of 0 means "not recorded": the engine writes `strikePrice || 0` when
 * a round had no strike, and a real feed price is always positive.
 */
const priceOrNull = (v: unknown): number | null => {
  const n = finiteOrNull(v);
  return n === null || n <= 0 ? null : n;
};

/**
 * Epoch 0 means "this instant was never recorded", not 1 January 1970: the
 * engine writes `0` for a round whose settlement tick or resolution time did
 * not land. Money fields legitimately hold 0, so this guard lives only on the
 * timestamp formatters.
 */
const epochMsOrNull = (v: unknown): number | null => {
  const n = finiteOrNull(v);
  return n === null || n <= 0 ? null : n;
};

/**
 * The settlement tick, exactly as the engine picks it: the LAST history point
 * whose timestamp is at or before the round end. No endTime → no tick.
 */
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

/**
 * A round that settles exactly on its strike is a draw: the engine resolves it
 * as a win with the stake handed back untouched. Every payout multiplier is > 1,
 * so `payout === stake` on a winning row can only mean that refund.
 */
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

/**
 * Assemble everything the panel shows. Pure: same input, same proof.
 */
export function buildSettlementProof(input: SettlementProofInput): SettlementProofData {
  const stake = finiteOrNull(input.stake);
  const payout = finiteOrNull(input.payout);
  const multiplier = finiteOrNull(input.multiplier);
  const strike = priceOrNull(input.strikePrice);
  const recorded = priceOrNull(input.recordedEndPrice);
  const endTime = finiteOrNull(input.endTime);
  const resolvedAt = finiteOrNull(input.resolvedAt);
  const ledger = input.ledger ?? null;
  const ledgerEndTime = finiteOrNull(ledger?.endTime);
  const ticks = Array.isArray(input.ticks) ? input.ticks : [];

  const tick = pickSettlementTick(ticks, endTime ?? ledgerEndTime);
  const usedEndTime = endTime ?? ledgerEndTime;
  const gapMs = tick && usedEndTime !== null ? usedEndTime - tick.timestamp : null;
  // Three ways a value can be "not a fresh live read": the feed flagged the
  // tick, the tick is well older than the round end (feed gap), or the whole
  // heartbeat was stalled when the round closed.
  const tickStale =
    !!tick && (tick.stale === true || (gapMs !== null && gapMs > FEED_GAP_STALE_MS) || input.feedDelayed === true);

  let source: SettlementSource;
  let settlementPrice: number | null;
  let settlementTakenAt: number | null;
  let takenAtIsRoundEnd = false;

  if (tick) {
    source = 'feed_tick';
    settlementPrice = tick.price;
    settlementTakenAt = tick.timestamp;
  } else if (recorded !== null) {
    source = 'recorded_row';
    settlementPrice = recorded;
    settlementTakenAt = usedEndTime ?? resolvedAt;
    takenAtIsRoundEnd = usedEndTime !== null && settlementTakenAt === usedEndTime;
  } else {
    source = 'unavailable';
    settlementPrice = null;
    settlementTakenAt = usedEndTime ?? resolvedAt;
    takenAtIsRoundEnd = settlementTakenAt !== null;
  }

  const tieRefund =
    isTieRefund({ won: input.won, stake, payout, multiplier }) ||
    (strike !== null && settlementPrice !== null && Math.abs(strike - settlementPrice) <= 1e-12);

  const outcome: SettlementOutcome =
    input.won === null || input.won === undefined
      ? 'unknown'
      : tieRefund
        ? 'draw'
        : input.won
          ? 'win'
          : 'loss';
  const outcomeLabel =
    outcome === 'draw'
      ? 'Draw — stake refunded'
      : outcome === 'win'
        ? 'Win'
        : outcome === 'loss'
          ? 'Loss'
          : 'Unsettled';

  const delta = strike !== null && settlementPrice !== null ? settlementPrice - strike : null;

  const dir = (input.direction || '').toUpperCase();
  let verdict: string | null = null;
  if (strike !== null && settlementPrice !== null) {
    const diff = settlementPrice - strike;
    if (tieRefund && Math.abs(diff) <= 1e-12) {
      verdict = 'Settlement price equals the strike exactly, so the round is a draw and the stake is refunded in full.';
    } else if (dir === 'UP' || dir === 'DOWN') {
      const higher = diff > 0;
      verdict = `${dir === 'UP' ? 'Higher' : 'Lower'} called — settled ${higher ? 'higher' : 'lower'} than the strike, so the round ${
        outcome === 'win' ? 'wins' : outcome === 'draw' ? 'is a draw' : 'loses'
      }.`;
    }
  }

  const txHashes = Array.isArray(ledger?.txHashes) ? ledger!.txHashes!.filter(Boolean) : [];
  const operations = Array.isArray(ledger?.operations) ? ledger!.operations!.filter(Boolean) : [];

  const caveats: string[] = [];
  if (source === 'feed_tick') {
    if (tick!.stale === true) {
      caveats.push(
        'The price at the round end came from a fallback tick (last-known price re-stamped by the feed), not a fresh oracle read. Treat it as the house’s recorded value, not a live market print.',
      );
    } else if (gapMs !== null && gapMs > FEED_GAP_STALE_MS) {
      caveats.push(
        `No tick arrived in the last ${(gapMs / 1000).toFixed(0)}s of the round, so settlement used the newest tick BEFORE the round end (a feed gap), not a price taken exactly at expiry.`,
      );
    } else if (input.feedDelayed === true) {
      caveats.push('The price feed was reporting a delay when this round closed.');
    }
  } else if (source === 'recorded_row') {
    caveats.push(
      'The feed ticks for this round are no longer in memory, so the price shown is the value recorded on your bet row at resolution. The engine settles against the last feed tick at or before the round end, which can differ slightly.',
    );
  } else {
    caveats.push('No settlement price is available for this round — neither a feed tick at or before the round end nor a recorded end price.');
  }
  if (source === 'feed_tick' && tick!.price <= 0) {
    caveats.push('The tick the round settled against was not a positive price — that is a feed fault, not a market print. Query this bet id before trusting the outcome.');
  }
  if (strike === null) {
    caveats.push('The strike price was not recorded for this round, so the comparison above cannot be verified from the row alone.');
  }
  if (usedEndTime === null) {
    caveats.push('The round-end instant was not recorded, so the settlement instant shown here is the resolve time instead.');
  }
  if (ledger?.available === false) {
    caveats.push('The ledger could not be read for this round, so on-chain / ledger references below are unavailable rather than absent.');
  } else if (ledger && txHashes.length === 0 && operations.length === 0) {
    caveats.push(
      'No ledger entry references this bet id. Rounds inside the house ledger settle off-chain against the price feed — only deposits and withdrawals move on Arc — so there is no transaction to point at.',
    );
  }

  const proof: SettlementProofData = {
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
    takenAtIsRoundEnd,
    endTime: usedEndTime,
    source,
    sourceLabel:
      source === 'feed_tick'
        ? 'Live price feed tick (Pyth) — last value at or before the round end'
        : source === 'recorded_row'
          ? 'Price recorded on your bet row ("end_price")'
          : 'Unavailable',
    tickStale,
    tickGapMs: gapMs,
    delta,
    verdict,
    network: input.network ?? ledger?.network ?? null,
    betRequestId: ledger?.betRequestId ?? null,
    operations,
    txHashes,
    ledgerTouched: ledger?.touched === true || operations.length > 0 || txHashes.length > 0,
    ledgerAvailable: ledger?.available !== false,
    settlementTokenIssued: ledger?.settlementTokenIssued === true,
    caveats,
  };
  return proof;
}

/** Money/price formatting shared by the panel and the board. */
export function formatSettlementPrice(value: number | null | undefined): string {
  const n = finiteOrNull(value);
  if (n === null) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

export function formatSettlementTime(value: number | null | undefined): string {
  const n = epochMsOrNull(value);
  if (n === null) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
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

/** Raw millisecond stamp, so a player can diff it against their own clock. */
export function settlementEpochMs(value: number | null | undefined): string {
  const n = epochMsOrNull(value);
  return n === null ? '—' : String(Math.round(n));
}

/**
 * Match a settled round back to its history row. The engine writes the history
 * record and the `lastResult` a few milliseconds apart, so match on the money
 * and take the closest timestamp.
 */
export function matchSettledRound<T extends { id: string; timestamp: number; amount: string; payout: string; won: boolean }>(
  bets: T[],
  result: { timestamp: number; amount: number; payout: number; won: boolean } | null | undefined,
): T | null {
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

/**
 * Client-side demo bet ids are minted by the game engine as `demo-<ts>` and
 * never pass through /api/balance/bet, so there is no server row, no audit
 * trail and nothing for GET /api/bets/<id> to return. The history surface also
 * carries an explicit `isDemoBet` marker on server rows; combine both signals.
 */
export const isDemoBetId = (betId: string | null | undefined): boolean =>
  /^demo-/i.test(String(betId ?? ''));

/** The subset of the panel state a caller may want to open programmatically. */
export interface SettlementProofProps {
  bet: SettlementProofInput;
  /** Caller wallet — required for the read-only proof fetch that fills ledger refs. */
  wallet?: string | null;
  /** 'bar' = the result moment strip, 'chip' = a trigger inside the rounds list. */
  variant?: 'bar' | 'chip';
  /** Override the feed history used for the tick lookup (tests / chart-owned data). */
  ticks?: SettlementTick[];
  /** Feed was reporting a delay when this round closed. */
  feedDelayed?: boolean;
  /** Extra context read out with the trigger, e.g. "Higher · 2.15×". */
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
  ledger?: {
    available?: boolean;
    touched?: boolean;
    bet_request_id?: string | null;
    end_time?: string | null;
    operations?: string[];
    tx_hashes?: string[];
    settlement_token_issued?: boolean;
    currency?: string | null;
  };
}

const toMs = (isoish: unknown): number | null => {
  if (!isoish) return null;
  const t = new Date(String(isoish)).getTime();
  return Number.isNaN(t) ? null : t;
};

const Row: React.FC<{ label: string; children: React.ReactNode; highlight?: boolean }> = ({
  label,
  children,
  highlight,
}) => (
  <div
    className={
      highlight
        ? 'rounded-2xl bg-ink/[0.04] px-3 py-2.5'
        : 'px-3'
    }
  >
    <div className="flex items-baseline justify-between gap-3">
      <span className={`text-[11px] uppercase tracking-[0.08em] ${highlight ? 'text-ink' : 'text-subtle'}`}>{label}</span>
      <span className={`text-right font-jet text-sm ${highlight ? 'font-semibold text-ink' : 'text-ink'}`}>{children}</span>
    </div>
  </div>
);

/**
 * Compact trigger + accessible sheet with the full settlement breakdown.
 */
export const SettlementProof: React.FC<SettlementProofProps> = ({
  bet,
  wallet,
  variant = 'bar',
  ticks: ticksProp,
  feedDelayed,
  label,
}) => {
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<ServerBetProof | null>(null);
  const [serverState, setServerState] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'unavailable'>('idle');
  const [copied, setCopied] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestedRef = useRef(false);
  const titleId = `settlement-proof-title-${bet.betId}`;
  // Play-money rounds have no server row by construction: the proof degrades
  // to "unavailable" instead of firing a request that can only 404.
  const demo = bet.isDemoBet === true || isDemoBetId(bet.betId);

  const close = useCallback(() => setOpen(false), []);

  // Fetch the read-only proof (ledger refs + the row's recorded values) once,
  // the first time the sheet opens. A ref, not state, because the state update
  // below re-renders the effect's own dependency list. Without a wallet there is
  // nothing to authorise against, so the request is simply never made and the
  // panel stays silent about the ledger (asserted at render, not via setState).
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
    fetch(
      `/api/bets/${encodeURIComponent(bet.betId)}?wallet=${encodeURIComponent(wallet)}`,
      { credentials: 'include' },
    )
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((payload: { bet?: ServerBetProof }) => {
        if (cancelled) return;
        setServer(payload?.bet ?? null);
        setServerState('ready');
      })
      .catch(() => {
        if (!cancelled) setServerState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [open, wallet, bet.betId, demo]);

  // A failed read may be transient, so closing the sheet re-arms the request.
  useEffect(() => {
    if (!open && serverState === 'failed') requestedRef.current = false;
  }, [open, serverState]);

  // Feed history for this bet's asset plus the click-time round end carried by
  // the session row — read once per open, never subscribed (the store rebuilds
  // those arrays on every tick). The round end matters because it is the cutoff
  // the engine applied: without it the resolve instant has to stand in, which is
  // a hair later than the real deadline and so not exactly the engine's rule.
  const local = useMemo(() => {
    const empty = { ticks: [] as SettlementTick[], rowEndTime: null as number | null, rowAsset: null as string | null };
    if (!open) return empty;
    try {
      const state = useStore.getState() as unknown as {
        assetHistories?: Record<string, SettlementTick[]>;
        selectedAsset?: string;
        priceHistory?: SettlementTick[];
        bets?: Array<{ id?: string; endTime?: number | string | null; asset?: string | null }>;
      };
      const row = Array.isArray(state.bets) ? state.bets.find((b) => b && b.id === bet.betId) ?? null : null;
      const rawEnd = row?.endTime;
      const rowEndTime =
        typeof rawEnd === 'number' && Number.isFinite(rawEnd) ? rawEnd : rawEnd ? toMs(rawEnd) : null;
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
  const ledger: SettlementLedgerRefs = useMemo(
    () => ({
      touched: server?.ledger?.touched,
      available: server ? server?.ledger?.available !== false : undefined,
      betRequestId: server?.ledger?.bet_request_id ?? null,
      endTime: ledgerEndMs ?? bet.endTime ?? local.rowEndTime ?? null,
      operations: server?.ledger?.operations ?? [],
      txHashes: server?.ledger?.tx_hashes ?? [],
      settlementTokenIssued: server?.ledger?.settlement_token_issued ?? false,
      network: server?.ledger?.currency ?? null,
    }),
    [server, ledgerEndMs, bet.endTime, local.rowEndTime],
  );

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
        // Cutoff order: the value the caller knows, then the ledger's click-time
        // round end, then the session row's own endTime, then the server's resolve
        // time (buildSettlementProof falls back and says so in a caveat).
        endTime: bet.endTime ?? ledgerEndMs ?? local.rowEndTime ?? null,
        resolvedAt: bet.resolvedAt ?? toMs(server?.resolved_at) ?? null,
        asset: bet.asset ?? server?.asset ?? local.rowAsset ?? null,
        mode: bet.mode ?? server?.mode ?? null,
        direction: bet.direction ?? server?.direction ?? null,
        ticks: localTicks,
        feedDelayed,
        // Ledger claims only ever come from a successful read: while the proof
        // request is in flight (or failed) there is nothing to assert about it.
        ledger: serverState === 'ready' ? ledger : null,
      }),
    [bet, server, ledgerEndMs, local, localTicks, feedDelayed, ledger, serverState],
  );

  // Escape closes, focus moves in on open and back out on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusRaf = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      (first ?? dialogRef.current)?.focus();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(focusRaf);
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus();
    };
  }, [open, close]);

  const copy = useCallback(async (value: string, kind: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(`${kind} copied`);
    } catch {
      setCopied(`${kind} could not be copied — select it manually`);
    }
    window.setTimeout(() => setCopied((c) => (c && c.startsWith(kind) ? null : c)), 2500);
  }, []);

  const priceDelta = proof.delta;

  // How much may be claimed about the ledger, in plain render terms: a read in
  // flight says nothing, a read that failed (or was never possible without a
  // wallet) says "could not be loaded", and only a successful read may state
  // that no entry references this bet at all. A play-money round never had a
  // ledger entry to load: it is "proof unavailable", not "read failed".
  const ledgerNeedsWallet = open && !wallet && !demo;
  const ledgerFailed = !demo && (serverState === 'failed' || ledgerNeedsWallet);
  const ledgerLoading = open && !demo && !ledgerFailed && serverState !== 'ready';

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
            <span className="hidden text-white/50 sm:inline">
              · {proof.source === 'feed_tick' ? 'feed tick' : proof.source === 'recorded_row' ? 'row value' : 'no price'}{' '}
              {formatSettlementTime(proof.settlementTakenAt)}
            </span>
          </span>
          {trigger}
        </div>
      ) : (
        trigger
      )}

      {open && (
        <div className="fixed inset-0 z-[1000] flex items-end justify-center p-0 sm:items-center sm:p-6">
          <div className="absolute inset-0 bg-ink/25 backdrop-blur-sm" onClick={close} aria-hidden="true" />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="relative flex max-h-[92vh] w-full max-w-[460px] flex-col overflow-hidden rounded-t-[28px] bg-white font-tight text-ink ring-1 ring-line outline-none sm:rounded-[28px]"
          >
            <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-6">
              <div>
                <h2 id={titleId} className="text-[20px] font-semibold tracking-tight">
                  Settlement proof
                </h2>
                <p className="mt-0.5 text-xs text-subtle">
                  {proof.outcomeLabel}
                  {proof.asset ? ` · ${proof.asset}` : ''}
                  {proof.mode ? ` · ${proof.mode}` : ''}
                  {proof.network ? ` · ${proof.network}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close the settlement proof"
                className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:bg-surface hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
              {/* The settlement itself, front and centre. */}
              <div className="flex flex-col gap-1.5 rounded-3xl bg-surface px-1 py-2.5">
                <Row label="Strike price" highlight>
                  {formatSettlementPrice(proof.strikePrice)}
                </Row>
                <Row label="Settlement price" highlight>
                  {formatSettlementPrice(proof.settlementPrice)}
                </Row>
                <Row label="Read at" highlight>
                  <span className="flex flex-col items-end">
                    <span>{formatSettlementClock(proof.settlementTakenAt)}</span>
                    <span className="font-jet text-[11px] text-subtle">
                      {proof.settlementTakenAt === null
                        ? '—'
                        : `${settlementEpochMs(proof.settlementTakenAt)} ms${
                            proof.takenAtIsRoundEnd ? ' · round end, not a tick time' : ''
                          }`}
                    </span>
                  </span>
                </Row>
                <Row label="Round ended">
                  {proof.endTime === null ? 'not recorded' : formatSettlementClock(proof.endTime)}
                </Row>
                {proof.tickGapMs !== null && proof.tickGapMs > 0 && (
                  <Row label="Tick age at expiry">{(proof.tickGapMs / 1000).toFixed(1)}s before round end</Row>
                )}
                <Row label="Change vs strike">
                  {priceDelta === null ? '—' : `${priceDelta > 0 ? '+' : ''}${priceDelta.toFixed(Math.abs(priceDelta) >= 1 ? 4 : 6)}`}
                </Row>
              </div>

              {/* Where the number came from — the part a player actually judges. */}
              <div className="mt-3 rounded-3xl bg-ink/[0.03] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-subtle">Source</div>
                <div className={`mt-1 text-sm font-medium ${proof.source === 'feed_tick' && !proof.tickStale ? 'text-ink' : 'text-down'}`}>
                  {proof.sourceLabel}
                </div>
                <div className="mt-1 space-y-1 text-xs leading-relaxed text-muted">
                  {proof.tickStale ? (
                    <p role="status">
                      <span className="font-semibold text-down">Fallback tick.</span> The settlement value was not a fresh
                      live read — see the note below.
                    </p>
                  ) : proof.source === 'feed_tick' ? (
                    <p>Live Pyth feed tick, taken at or before the round end — the same rule the engine settles with.</p>
                  ) : (
                    <p>This value is not a re-read feed tick; it is what the round recorded at settlement time.</p>
                  )}
                </div>
              </div>

              {/* Honest degradation: no server verification — for play-money
                  rounds by construction, for real rounds when the read failed.
                  The numbers shown are then session records, nothing more. */}
              {(demo || serverState === 'failed') && (
                <p role="note" data-testid="proof-unavailable" className="mt-3 rounded-2xl bg-down-soft px-4 py-3 text-[11px] leading-relaxed text-down">
                  {demo
                    ? 'Proof unavailable: this was a play-money round. It never moved the house ledger, so there is no server row to read — every figure shown here comes from your browser’s session record, not an audited settlement.'
                    : 'Proof unavailable: the read-only server proof for this round could not be loaded. Every figure shown here is your browser’s session record until the read succeeds; nothing is ledger-verified.'}
                </p>
              )}

              {proof.verdict && (
                <p className="mt-3 rounded-2xl bg-up-soft px-4 py-3 text-xs leading-relaxed text-up">{proof.verdict}</p>
              )}

              <div className="mt-3 flex flex-col gap-1.5 rounded-3xl border border-line px-1 py-2.5">
                <Row label="Stake">
                  {proof.stake === null ? '—' : `${proof.stake.toFixed(4)} ${proof.network || 'USDC'}`}
                </Row>
                <Row label="Multiplier">{proof.multiplier === null ? '—' : `${proof.multiplier}×`}</Row>
                <Row label="Payout">
                  {proof.tieRefund
                    ? `${proof.payout === null ? '—' : proof.payout.toFixed(4)} ${proof.network || 'USDC'} (stake refunded)`
                    : `${proof.payout === null ? '—' : proof.payout.toFixed(4)} ${proof.network || 'USDC'}`}
                </Row>
                <Row label="Direction">{proof.direction ?? '—'}</Row>
              </div>

              {/* Ledger / chain references, only when they exist. */}
              <div className="mt-3 rounded-3xl border border-line px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.08em] text-subtle">
                  {demo
                    ? 'Play-money round'
                    : ledgerLoading
                    ? 'Ledger references…'
                    : ledgerFailed
                      ? 'Ledger status'
                      : proof.ledgerTouched
                        ? 'Ledger references'
                        : proof.ledgerAvailable
                          ? 'No ledger entry'
                          : 'Ledger status'}
                </div>

                {demo && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    Demo stakes never entered the house ledger — there is nothing for the proof endpoint to return.
                  </p>
                )}

                {proof.operations.length > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-muted">
                    {proof.operations.map((op) => (
                      <li key={op} className="rounded-full bg-ink/[0.05] px-2 py-0.5 font-jet">
                        {op}
                      </li>
                    ))}
                  </ul>
                )}

                {proof.settlementTokenIssued && (
                  <p className="mt-1.5 text-[11px] text-muted">
                    A signed payout token was issued for this bet and claimed exactly once — the ledger rejects a second
                    settlement of the same bet id.
                  </p>
                )}

                {proof.txHashes.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {proof.txHashes.map((hash) => (
                      <li key={hash} className="flex items-center justify-between gap-2 text-xs">
                        <a
                          href={explorerTxUrl(hash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-w-0 items-center gap-1 font-jet text-up hover:underline"
                        >
                          <span className="truncate">{`${hash.slice(0, 10)}…${hash.slice(-8)}`}</span>
                          <ArrowUpRight size={12} />
                        </a>
                        <button
                          type="button"
                          onClick={() => void copy(hash, 'Transaction hash')}
                          aria-label={`Copy transaction hash ${hash}`}
                          className="shrink-0 rounded-full p-1 text-faint hover:bg-surface hover:text-ink"
                        >
                          <Copy size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  serverState === 'ready' &&
                  proof.ledgerAvailable && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                      This round has no transaction hash: bets settle against the price feed inside the house ledger, which
                      is where the references below come from. Only deposits and withdrawals move on Arc.
                    </p>
                  )
                )}

                {proof.betRequestId && (
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-subtle">Bet request id (idempotency key)</span>
                    <span className="truncate font-jet text-ink">{proof.betRequestId}</span>
                  </div>
                )}

                {ledgerFailed && (
                  <p className="mt-1.5 text-[11px] text-down">
                    Ledger references could not be loaded for this round (
                    {wallet ? 'the proof read failed — retry or check the network' : 'no wallet is connected, so the ' +
                      'read-only proof endpoint has nothing to authorise against'}
                    ). The numbers above come from your local session record.
                  </p>
                )}
              </div>

              {proof.caveats.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5 rounded-3xl bg-down-soft px-4 py-3">
                  {proof.caveats.map((note) => (
                    <li key={note} className="flex gap-2 text-[11px] leading-relaxed text-down">
                      <span aria-hidden="true">•</span>
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex items-center justify-between gap-2 rounded-3xl bg-ink/[0.03] px-4 py-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.08em] text-subtle">Bet id</div>
                  <div className="truncate font-jet text-xs text-ink">{proof.betId}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void copy(proof.betId, 'Bet id')}
                  aria-label={`Copy bet id ${proof.betId}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-muted ring-1 ring-line hover:text-ink"
                >
                  <Copy size={12} /> Copy
                </button>
              </div>
            </div>

            <p aria-live="polite" className="sr-only">
              {copied}
            </p>

            <div className="border-t border-line px-6 py-3 text-[11px] leading-relaxed text-faint">
              Proof of what the house recorded, not an independent oracle receipt: the strike, the settlement value, the
              instant it was taken and every ledger reference this bet left behind.
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default SettlementProof;
