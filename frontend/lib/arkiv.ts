'use client';

import { useEffect, useState } from 'react';

export const ARKIV_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
export const ARKIV_EXPLORER = 'https://rabdi.explorer.arkiv.network';
const SCHEMAS = `arkiv.schema = str('strike.rounds')`;
const ASSET = /^[A-Z0-9]{2,10}$/;
const DAY_MS = 86_400_000;
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

interface RawEntity {
  key: string;
  creator?: string;
  attributes?: Array<{ name: string; value: string }>;
}

function flatten(raw: RawEntity): ArkivEntity {
  const row: Record<string, string> = { key: raw.key, creator: raw.creator ?? '' };
  for (const a of raw.attributes ?? []) row[a.name] = String(a.value);
  return row as unknown as ArkivEntity;
}

async function arkiv<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const res = await fetch(ARKIV_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`Arkiv RPC HTTP ${res.status}`);
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
      const query = historyQuery(wallet, list);
      const result = await arkiv<{ data: RawEntity[] }>(
        'arkiv_query',
        [query, { select: { key: true, creator: true, attributes: true }, limit: `0x${list.length.toString(16)}` }],
        ctrl.signal,
      );
      const byBet = new Map(
        result.data.map(flatten).filter((e) => e.betId).map((e) => [e.betId as string, e]),
      );
      setSeals({ query, byBet });
      setError(null);
    };
    run().catch((err) => {
      if (ctrl.signal.aborted) return;
      console.error('[arkiv] seal lookup failed', err);
      setError(String(err.message ?? err));
    });
    return () => ctrl.abort();
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

export const settledAtMs = (e: ArkivEntity) => Number(e.settledAt ?? 0);
export const isWin = (e: ArkivEntity) => e.outcome === 'won' || e.outcome === 'win';

/**
 * Every player's rounds on `asset` in the last 24 hours, read straight from Arkiv:
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
      const since = Date.now() - DAY_MS;
      const query = `${SCHEMAS} AND $creator = addr(${OPERATOR}) AND asset = str('${asset}') AND settledAt > u64(${since})`;
      const result = await arkiv<{ data: RawEntity[] }>(
        'arkiv_query',
        [query, { select: { key: true, creator: true, attributes: true }, limit: `0x${TAPE_LIMIT.toString(16)}` }],
        ctrl.signal,
      );
      const rounds = result.data.map(flatten).sort((a, b) => settledAtMs(b) - settledAtMs(a));
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
