'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { getArcConfig } from '@/lib/arc/config';
import { ensureBalanceSession } from '@/lib/balance/balanceClientHeaders';

export type Verdict = 'awaiting' | 'placed' | 'skipped' | 'blocked' | 'rejected';

export interface AgentSession {
  id: string;
  wallet: string;
  asset: string;
  mode: 'normal' | 'yolo';
  budget: number;
  maxPerTrade: number;
  stopLoss: number;
  startsAt: number;
  endsAt: number;
  status: 'running' | 'stopped';
  stoppedReason: string | null;
  spent: number;
  realizedPnl: number;
}

export interface Decision {
  id: string;
  sessionId: string;
  createdAt: number;
  direction: 'UP' | 'DOWN' | null;
  stake: number | null;
  verdict: Verdict;
  reason: string;
  skipCount: number;
  confidence: number | null;
  betId: string | null;
  result: string | null;
  pnl: number | null;
  expiresAt: number | null;
}

export interface StartLimits {
  asset: string;
  budget: number;
  maxPerTrade: number;
  stopLoss: number;
  minutes: number;
}

const START_VALID_MS = 5 * 60_000;
const KEEP = 100;

/** Byte for byte what `agent::start_message` in the Rust core renders. */
function startMessage(wallet: string, limits: StartLimits, expires: number, nonce: string): string {
  return [
    'Strike agent session',
    `Wallet: ${wallet}`,
    `Chain: ${getArcConfig().chainId}`,
    `Asset: ${limits.asset}`,
    'Mode: yolo',
    `Budget: ${limits.budget} USDC`,
    `Max per trade: ${limits.maxPerTrade} USDC`,
    `Stop-loss: ${limits.stopLoss} USDC`,
    `Minutes: ${limits.minutes}`,
    `Expires: ${expires}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

async function errorOf(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error ?? `Request failed with ${res.status}`;
}

/** The trader's agent session, live from the decisions feed. */
export function useAgent() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<AgentSession | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedKey, setFeedKey] = useState(0);
  const proofSession = useRef(false);

  useEffect(() => {
    const source = new EventSource('/api/agent/decisions');
    source.addEventListener('session', (e) => setSession(JSON.parse((e as MessageEvent).data)));
    source.addEventListener('decision', (e) => {
      const next: Decision = JSON.parse((e as MessageEvent).data);
      setDecisions((all) => [next, ...all.filter((d) => d.id !== next.id)].slice(0, KEEP));
    });
    // A 401 means no session yet. The browser closes and never retries it.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) source.close();
    };
    return () => source.close();
  }, [feedKey]);

  // Placed bets open a proof, and reading a proof needs the balance session.
  useEffect(() => {
    if (proofSession.current || !decisions.some((d) => d.betId)) return;
    proofSession.current = true;
    ensureBalanceSession().catch(() => {
      proofSession.current = false;
    });
  }, [decisions]);

  const start = useCallback(
    async (limits: StartLimits) => {
      if (!address) {
        setError('Connect a wallet first');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const nonce = crypto.randomUUID().replaceAll('-', '');
        const message = startMessage(address, limits, Date.now() + START_VALID_MS, nonce);
        const signature = await signMessageAsync({ message });
        const res = await fetch('/api/agent/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message, signature }),
        });
        if (!res.ok) {
          setError(await errorOf(res));
          return;
        }
        setSession((await res.json()).session);
        setDecisions([]);
        setFeedKey((k) => k + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Signing failed');
      } finally {
        setBusy(false);
      }
    },
    [address, signMessageAsync]
  );

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/stop', { method: 'POST' });
      if (res.ok) setSession((await res.json()).session);
      else setError(await errorOf(res));
    } finally {
      setBusy(false);
    }
  }, []);

  return { session, decisions, error, busy, start, stop };
}
