'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpContext } from '@worldcoin/idkit';
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
  mode: 'normal' | 'yolo';
  budget: number;
  maxPerTrade: number;
  stopLoss: number;
  minutes: number;
}

export interface WorldAttempt {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'mismatch' | 'failed' | 'unknown';
  reason: string;
  acr: string | null;
  kind?: 'start' | 'checkpoint';
}

/** The IDKit step-up challenge a 401 carries when the server runs World ID through IDKit. */
export interface WorldChallenge {
  attempt: string;
  world: {
    app_id: `app_${string}`;
    action: string;
    signal: string;
    environment: 'production' | 'staging';
    preset: 'selfie' | 'orb';
    require_user_presence: boolean;
    rp_context: RpContext;
  };
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
    `Mode: ${limits.mode}`,
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

/** Reads a World attempt reply. 404 means it belongs to another browser or never existed. */
export async function attemptOf(res: Response): Promise<WorldAttempt> {
  if (res.status === 404) {
    return {
      status: 'unknown',
      reason: 'Open the World App link in the browser where you started, then sign again',
      acr: null,
    };
  }
  if (!res.ok) return { status: 'failed', reason: await errorOf(res), acr: null };
  return res.json();
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
  const [challenge, setChallenge] = useState<WorldChallenge | null>(null);
  const proofSession = useRef(false);

  /** Takes a 401 step-up to World, by IDKit in place or by redirect. `false` when the reply was anything else. */
  const toWorld = useCallback((res: Response, body: (Partial<WorldChallenge> & { verifyUrl?: string }) | null) => {
    if (res.status !== 401) return false;
    if (body?.attempt && body.world) {
      setChallenge({ attempt: body.attempt, world: body.world });
      return true;
    }
    if (!body?.verifyUrl) return false;
    window.location.assign(body.verifyUrl);
    return true;
  }, []);

  /** The IDKit check settled. An approved start set the agent cookie, so the feed reconnects to pick it up. */
  const settle = useCallback((a: WorldAttempt) => {
    setChallenge(null);
    setBusy(false);
    if (a.status !== 'approved') return;
    if (a.kind === 'start') setDecisions([]);
    setFeedKey((k) => k + 1);
  }, []);

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
      let leaving = false;
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
          const body = await res.json().catch(() => null);
          if (toWorld(res, body)) {
            leaving = true;
            return;
          }
          setError(body?.error ?? `Request failed with ${res.status}`);
          return;
        }
        setSession((await res.json()).session);
        setDecisions([]);
        setFeedKey((k) => k + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Signing failed');
      } finally {
        if (!leaving) setBusy(false);
      }
    },
    [address, signMessageAsync, toWorld]
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

  /** A paused YOLO agent resumes only after the same human steps up in World App. */
  const checkpoint = useCallback(async () => {
    setBusy(true);
    setError(null);
    let leaving = false;
    try {
      const res = await fetch('/api/agent/checkpoint', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (toWorld(res, body)) {
        leaving = true;
        return;
      }
      setError(body?.error ?? `Request failed with ${res.status}`);
    } finally {
      if (!leaving) setBusy(false);
    }
  }, [toWorld]);

  /** Approve or reject a proposal. The feed carries the result to every tab. */
  const answer = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setError(null);
    const res = await fetch(`/api/agent/decisions/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const { decision } = (await res.json()) as { decision: Decision };
    setDecisions((all) => all.map((d) => (d.id === decision.id ? decision : d)));
  }, []);

  return { session, decisions, error, busy, start, stop, answer, checkpoint, challenge, settle };
}

/** Outcome of the World ID check the callback redirected back with as `?world=<attempt>`. Read once, never polled. */
export function useWorldAttempt() {
  const [attempt, setAttempt] = useState<WorldAttempt | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const id = url.searchParams.get('world');
    if (!id) return;
    url.searchParams.delete('world');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (id === 'unknown') {
      setAttempt({ status: 'unknown', reason: 'This approval link was already used', acr: null });
      return;
    }
    fetch(`/api/world/attempts/${encodeURIComponent(id)}`)
      .then(attemptOf)
      .then(setAttempt)
      .catch((e) => setAttempt({ status: 'failed', reason: `Could not read the human check: ${e.message}`, acr: null }));
  }, []);

  return [attempt, setAttempt] as const;
}
