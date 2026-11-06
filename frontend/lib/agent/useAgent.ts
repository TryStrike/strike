"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { getArcConfig } from "@/lib/arc/config";
import { useStore } from "@/lib/store";
import { errorMessage, readApiError, type StepUp } from "@/lib/api/errors";
import { sendGuarded } from "@/lib/world/gate";
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

export interface AgentState {
  sessionId: string;
  status: "running" | "paused" | "stopped";
  stoppedReason: string | null;
  pausedUntil: number | null;
  checksPassed: number;
  stepup: StepUp | null;
}

const START_VALID_MS = 5 * 60_000;
/** A reconnect replays many rows at once, and they need one balance fetch. */
const BALANCE_SETTLE_MS = 300;
const STATE_POLL_MS = 3_000;

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

const json = (body: object) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function useAgentState(active: boolean) {
  const [state, setState] = useState<AgentState | null>(null);
  const pushed = useAgentFeed(
    (s) => `${s.session?.pausedUntil}:${s.session?.pauseStepupId}:${s.stepup?.id}:${s.stepup?.status}`,
  );
  useEffect(() => {
    if (!active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(null);
      return;
    }
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/agent/state", { cache: "no-store" });
        if (!stop && res.ok) setState(await res.json());
      } catch {}
    };
    void tick();
    const t = setInterval(tick, STATE_POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [active, pushed]);
  return state;
}

export function useAgent() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { session, decisions, connect, showSession, showDecision } =
    useAgentFeed();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const starting = useRef(false);

  useEffect(() => connect(), [connect]);

  const balanceMoves = decisions.reduce(
    (moves, d) => moves + (d.betId ? 1 : 0) + (d.result ? 1 : 0),
    0,
  );
  useEffect(() => {
    if (!address || !balanceMoves) return;
    const timer = setTimeout(
      () => useStore.getState().fetchBalance(address),
      BALANCE_SETTLE_MS,
    );
    return () => clearTimeout(timer);
  }, [address, balanceMoves]);

  const start = useCallback(
    async (limits: StartLimits) => {
      if (!address) {
        setError("Connect a wallet first");
        return;
      }
      if (starting.current) return;
      starting.current = true;
      setBusy(true);
      setError(null);
      try {
        const nonce = crypto.randomUUID().replaceAll("-", "");
        const message = startMessage(
          address,
          limits,
          Date.now() + START_VALID_MS,
          nonce,
        );
        const signature = await signMessageAsync({ message });
        const res = await sendGuarded(
          (stepupId) =>
            fetch("/api/agent/start", json({ message, signature, stepupId })),
          { session: false },
        );
        if (!res.ok) {
          setError(errorMessage(await readApiError(res)));
          return;
        }
        showSession((await res.json()).session);
        connect(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Signing failed");
      } finally {
        starting.current = false;
        setBusy(false);
      }
    },
    [address, signMessageAsync, showSession, connect],
  );

  const retryApproval = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/agent/checkpoint", { method: "POST" });
      if (res.ok) return;
      const e = await readApiError(res);
      if (e.stepup) return;
      setError(
        res.status === 404 || res.status === 405
          ? "A new approval can't be requested. The agent stops when the pause ends."
          : errorMessage(e),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not request a new approval");
    }
  }, []);

  const answer = useCallback(
    async (id: string, action: "approve" | "reject") => {
      setError(null);
      const url = `/api/agent/decisions/${encodeURIComponent(id)}/${action}`;
      try {
        const res = await sendGuarded(
          (stepupId) =>
            fetch(url, stepupId ? json({ stepupId }) : { method: "POST" }),
          { session: false },
        );
        if (!res.ok) {
          const e = await readApiError(res);
          setError(
            e.status === 409 && !e.code && /expired/i.test(e.error)
              ? errorMessage({ ...e, code: "proposal_expired" })
              : errorMessage(e),
          );
          return;
        }
        const { decision } = (await res.json()) as { decision: Decision };
        showDecision(decision);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
      }
    },
    [showDecision],
  );

  return { session, decisions, error, busy, start, answer, retryApproval };
}
