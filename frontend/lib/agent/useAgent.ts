'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpContext } from '@worldcoin/idkit';
import { useAccount, useSignMessage } from 'wagmi';
import { getArcConfig } from '@/lib/arc/config';
import { ensureBalanceSession } from '@/lib/balance/balanceClientHeaders';
import { useAgentFeed, type Decision } from './agentFeed';

export type { AgentSession, Decision } from './agentFeed';

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
  const { session, decisions, connect, showSession, showDecision } = useAgentFeed();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<WorldChallenge | null>(null);
  const proofSession = useRef(false);

  /** Takes a 401 step-up to the IDKit widget. `false` when the reply was anything else. */
  const toWorld = useCallback((res: Response, body: Partial<WorldChallenge> | null) => {
    if (res.status !== 401 || !body?.attempt || !body.world) return false;
    setChallenge({ attempt: body.attempt, world: body.world });
    return true;
  }, []);

  /** The IDKit check settled. An approved start set the agent cookie, so the feed reconnects to pick it up. */
  const settle = useCallback((a: WorldAttempt) => {
    setChallenge(null);
    setBusy(false);
    if (a.status === 'approved') connect(true);
  }, [connect]);

  useEffect(() => connect(), [connect]);

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
        showSession((await res.json()).session);
        connect(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Signing failed');
      } finally {
        if (!leaving) setBusy(false);
      }
    },
    [address, signMessageAsync, toWorld, showSession, connect]
  );

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
    showDecision(decision);
  }, [showDecision]);

  return { session, decisions, error, busy, start, answer, checkpoint, challenge, settle };
}

