"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RpContext } from "@worldcoin/idkit";
import { useAccount, useSignMessage } from "wagmi";
import { getArcConfig } from "@/lib/arc/config";
import { ensureBalanceSession } from "@/lib/balance/balanceClientHeaders";
import { useAgentFeed, type Decision } from "./agentFeed";

export type { AgentSession, Decision } from "./agentFeed";

export interface StartLimits {
  asset: string;
  mode: "normal" | "yolo";
  budget: number;
  maxPerTrade: number;
  stopLoss: number;
  minutes: number;
}

export interface WorldAttempt {
  status:
    | "pending"
    | "approved"
    | "denied"
    | "expired"
    | "mismatch"
    | "failed"
    | "unknown";
  reason: string;
  acr: string | null;
  kind?: "start" | "checkpoint";
}

export interface WorldChallenge {
  attempt: string;
  world: {
    app_id: `app_${string}`;
    action: string;
    signal: string;
    environment: "production" | "staging";
    preset: "selfie" | "orb";
    require_user_presence: boolean;
    rp_context: RpContext;
  };
}

const START_VALID_MS = 5 * 60_000;

function startMessage(
  wallet: string,
  limits: StartLimits,
  expires: number,
  nonce: string,
): string {
  return [
    "Strike agent session",
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
  ].join("\n");
}

async function errorOf(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error ?? `Request failed with ${res.status}`;
}

export async function attemptOf(res: Response): Promise<WorldAttempt> {
  if (res.status === 404) {
    return {
      status: "unknown",
      reason:
        "Open the World App link in the browser where you started, then sign again",
      acr: null,
    };
  }
  if (!res.ok)
    return { status: "failed", reason: await errorOf(res), acr: null };
  return res.json();
}

export function useAgent() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { session, decisions, connect, showSession, showDecision } =
    useAgentFeed();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<WorldChallenge | null>(null);
  const proofSession = useRef(false);

  const toWorld = useCallback(
    (res: Response, body: Partial<WorldChallenge> | null) => {
      if (res.status !== 401 || !body?.attempt || !body.world) return false;
      setChallenge({ attempt: body.attempt, world: body.world });
      return true;
    },
    [],
  );

  const settle = useCallback(
    (a: WorldAttempt) => {
      setChallenge(null);
      setBusy(false);
      if (a.status === "approved" && a.kind !== "checkpoint") connect(true);
    },
    [connect],
  );

  useEffect(() => connect(), [connect]);

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
        setError("Connect a wallet first");
        return;
      }
      setBusy(true);
      setError(null);
      let leaving = false;
      try {
        const nonce = crypto.randomUUID().replaceAll("-", "");
        const message = startMessage(
          address,
          limits,
          Date.now() + START_VALID_MS,
          nonce,
        );
        const signature = await signMessageAsync({ message });
        const res = await fetch("/api/agent/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
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
        setError(e instanceof Error ? e.message : "Signing failed");
      } finally {
        if (!leaving) setBusy(false);
      }
    },
    [address, signMessageAsync, toWorld, showSession, connect],
  );

  const checkpoint = useCallback(async () => {
    setBusy(true);
    setError(null);
    let leaving = false;
    try {
      const res = await fetch("/api/agent/checkpoint", { method: "POST" });
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

  const answer = useCallback(
    async (id: string, action: "approve" | "reject") => {
      setError(null);
      const res = await fetch(
        `/api/agent/decisions/${encodeURIComponent(id)}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const { decision } = (await res.json()) as { decision: Decision };
      showDecision(decision);
    },
    [showDecision],
  );

  return {
    session,
    decisions,
    error,
    busy,
    start,
    answer,
    checkpoint,
    challenge,
    settle,
  };
}
