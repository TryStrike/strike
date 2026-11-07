'use client';

import { useEffect, useState } from 'react';

export const ARKIV_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
export const ARKIV_EXPLORER = 'https://rabdi.explorer.arkiv.network';
export const SWARM_GATEWAY = (process.env.NEXT_PUBLIC_SWARM_GATEWAY?.trim() || 'https://api-strike.fastship.studio/swarm').replace(/\/+$/, '');
const SCHEMAS = `arkiv.schema = str('strike.rounds')`;
const ASSET = /^[A-Z0-9]{2,10}$/;
const OPERATOR = process.env.NEXT_PUBLIC_ARKIV_OPERATOR?.trim().toLowerCase() ?? '';
const BET_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;

export interface ArkivEntity {
  key: string;
  creator?: string;
  betId?: string;
  outcome?: string;
  payout?: string;
  currency?: string;
  asset?: string;
  wallet?: string;
  direction?: string;
  stake?: string;
  settledAt?: string;
}

export interface ArkivSeals {
  query: string;
  byBet: Map<string, ArkivEntity>;
}

export const entityUrl = (key: string) => `${ARKIV_EXPLORER}/entity/${key}`;

export function matchesLedger(entity: ArkivEntity, ledgerPayout: number | string | null | undefined): boolean {
  const a = Number(entity.payout);
  const b = Number(ledgerPayout);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
}

export interface RawEntity {
  key: string;
  creator?: string;
  attributes?: Array<{ name: string; value: string }>;
}

export function flatten(raw: RawEntity): ArkivEntity {
  const row: Record<string, string> = { key: raw.key, creator: raw.creator ?? '' };
  for (const a of raw.attributes ?? []) row[a.name] = String(a.value);
  return row as unknown as ArkivEntity;
}

/** A rate limit or node error; `retryAfterMs` comes from the Retry-After header when sent. */
export class ArkivHttpError extends Error {
  constructor(public status: number, public retryAfterMs?: number) {
    super(`Arkiv RPC HTTP ${status}`);
  }
}

export async function arkiv<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const call = () =>
    fetch(ARKIV_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal,
    });
  let res = await call();
  // The public node rate-limits bursts; back off twice before giving up.
  for (let wait = 1_000; res.status === 429 && wait <= 2_000; wait *= 2) {
    const secs = Number(res.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(secs) && secs > 0 ? secs * 1_000 : wait, 5_000)));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    res = await call();
  }
  if (!res.ok) {
    const secs = Number(res.headers.get('retry-after'));
    throw new ArkivHttpError(res.status, Number.isFinite(secs) && secs > 0 ? secs * 1_000 : undefined);
  }
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`Arkiv RPC: ${body.error.message}`);
  return body.result as T;
}

export async function readSealedEntity(key: string, signal?: AbortSignal): Promise<ArkivEntity | null> {
  if (!OPERATOR) throw new Error('NEXT_PUBLIC_ARKIV_OPERATOR is not set');
  const raw = await arkiv<RawEntity | null>('arkiv_getEntity', [key], signal);
  if (!raw) return null;
  const entity = flatten(raw);
  if (entity.creator?.toLowerCase() !== OPERATOR) throw new Error(`entity ${key} was not created by the Strike operator`);
  return entity;
}

const SEAL_BATCH = 20;

function historyQuery(wallet: string, betIds: string[]): string {
  const ids = betIds.map((id) => `betId = str('${id}')`).join(' OR ');
  return `${SCHEMAS} AND $creator = addr(${OPERATOR}) AND wallet = addr(${wallet.toLowerCase()}) AND (${ids})`;
}

export function useArkivSeals(wallet: string, betIds: string[]): { seals: ArkivSeals | null; error: string | null } {
  const [seals, setSeals] = useState<ArkivSeals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = betIds.join(',');

  useEffect(() => {
    if (!wallet || !ids) return;
    const list = ids.split(',');
    const ctrl = new AbortController();
    const run = async () => {
      if (!OPERATOR) throw new Error('NEXT_PUBLIC_ARKIV_OPERATOR is not set');
      if (!WALLET.test(wallet)) throw new Error(`not a wallet: ${wallet}`);
      const bad = list.find((id) => !BET_ID.test(id));
      if (bad) throw new Error(`bet id cannot be queried on Arkiv: ${bad}`);
      // The node refuses a long OR list, so ask in small batches and merge.
      const batches: string[][] = [];
      for (let i = 0; i < list.length; i += SEAL_BATCH) batches.push(list.slice(i, i + SEAL_BATCH));
      const query = batches.map((b) => historyQuery(wallet, b)).join('\n');
      const results = await Promise.all(
        batches.map((b) =>
          arkiv<{ data: RawEntity[] }>(
            'arkiv_query',
            [historyQuery(wallet, b), { select: { key: true, creator: true, attributes: true }, limit: `0x${b.length.toString(16)}` }],
            ctrl.signal,
          ),
        ),
      );
      const byBet = new Map(
        results.flatMap((r) => r.data.map(flatten)).filter((e) => e.betId).map((e) => [e.betId as string, e]),
      );
      setSeals({ query, byBet });
      setError(null);
      return byBet.size >= list.length;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      run()
        .then((done) => {
          // A round settles seconds before its seal lands, so look again until every row has one.
          if (!done && !ctrl.signal.aborted) timer = setTimeout(poll, 10_000);
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          console.error('[arkiv] seal lookup failed', err);
          setError(String(err.message ?? err));
        });
    void poll();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [wallet, ids]);

  return { seals, error };
}

export interface ArkivTape {
  /** Newest first. */
  rounds: ArkivEntity[];
  won: number;
  query: string;
}

const TAPE_REFRESH_MS = 20_000;
// The public node refuses limits above 100.
const TAPE_LIMIT = 100;
const TAPE_WINDOWS_MS = [15 * 60_000, 2 * 3_600_000, 24 * 3_600_000];

export const settledAtMs = (e: ArkivEntity) => Number(e.settledAt ?? 0);
export const isWin = (e: ArkivEntity) => e.outcome === 'won' || e.outcome === 'win';

/**
 * Every player's newest rounds on `asset` (last 15 minutes, widening to 24 hours if empty), read straight from Arkiv:
 * filtered by schema, our operator as `$creator`, the asset and a `settledAt` range.
 * Arkiv has no ORDER BY, so the window bounds the scan and the sort happens here.
 */
export function useArkivTape(asset: string): { tape: ArkivTape | null; error: string | null } {
  const [tape, setTape] = useState<ArkivTape | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      if (!OPERATOR) throw new Error('NEXT_PUBLIC_ARKIV_OPERATOR is not set');
      if (!ASSET.test(asset)) throw new Error(`asset cannot be queried on Arkiv: ${asset}`);
      // Newest rounds only: a wide window with a 100 row cap can return the oldest 100. Widen while empty.
      let rounds: ArkivEntity[] = [];
      let query = '';
      for (const window of TAPE_WINDOWS_MS) {
        query = `${SCHEMAS} AND $creator = addr(${OPERATOR}) AND asset = str('${asset}') AND settledAt > u64(${Date.now() - window})`;
        const result = await arkiv<{ data: RawEntity[] }>(
          'arkiv_query',
          [query, { select: { key: true, creator: true, attributes: true }, limit: `0x${TAPE_LIMIT.toString(16)}` }],
          ctrl.signal,
        );
        rounds = result.data.map(flatten);
        if (rounds.length) break;
      }
      rounds.sort((a, b) => settledAtMs(b) - settledAtMs(a));
      setTape({ rounds, won: rounds.filter(isWin).length, query });
      setError(null);
    };
    const run = () =>
      load().catch((err) => {
        if (ctrl.signal.aborted) return;
        console.error('[arkiv] tape query failed', asset, err);
        setError(String(err.message ?? err));
      });
    void run();
    const timer = setInterval(run, TAPE_REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [asset]);

  return { tape, error };
}
