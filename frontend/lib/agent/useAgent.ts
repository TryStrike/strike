"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { getArcConfig } from "@/lib/arc/config";
import { useStore } from "@/lib/store";
import { errorMessage, readApiError, type StepUp } from "@/lib/api/errors";
import { sendGuarded } from "@/lib/world/gate";
import { useAgentFeed, type AgentSession, type Decision } from "./agentFeed";

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

const START_VALID_MS = 9 * 60_000;
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

export function sameWallet(a: string, b: string): boolean {
  return isAddressEqual(a as Address, b as Address);
}

/** The feed's session, unless it belongs to a wallet other than the connected one. */
export function useOwnSession() {
  const { address } = useAccount();
  const session = useAgentFeed((s) => s.session);
  return session && address && !sameWallet(session.wallet, address)
    ? null
    : session;
}

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
        if (stop) return;
        // The cookie is gone, so this browser can no longer follow the session.
        if (res.status === 401) useAgentFeed.getState().dismiss();
        if (!res.ok) return;
        const next: AgentState = await res.json();
        setState(next);
        // A feed can hang without an error, and a new one replays the stop.
        if (next.status === "stopped") useAgentFeed.getState().reconnect();
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
  const { session, checking, decisions, connect, showSession, showDecision } =
    useAgentFeed();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const starting = useRef(false);
  const probed = useRef<string | null>(null);

  useEffect(() => connect(), [connect]);

  const follow = useCallback(
    (next: AgentSession) => {
      showSession(next);
      connect(true);
    },
    [showSession, connect],
  );

  /** Moves this browser onto the wallet's running session, if it has one. */
  const reattach = useCallback(
    async (wallet: string, guarded: boolean) => {
      const send = () => fetch("/api/agent/resume", json({ wallet }));
      const res = await (guarded ? sendGuarded(send) : send());
      if (res.ok) follow((await res.json()).session);
      return res.ok;
    },
    [follow],
  );

  const mine = !session || !address || sameWallet(session.wallet, address);
  const covered = Boolean(session) && mine;
  useEffect(() => {
    if (!address || checking || covered || probed.current === address) return;
    probed.current = address;
    reattach(address, false).catch(() => {});
  }, [address, checking, covered, reattach]);

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
          const refused = await readApiError(res);
          if (refused.code === "agent_running" && (await reattach(address, true)))
            return;
          setError(errorMessage(refused));
          return;
        }
        follow((await res.json()).session);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Signing failed");
      } finally {
        starting.current = false;
        setBusy(false);
      }
    },
    [address, signMessageAsync, follow, reattach],
  );

  const setMode = useCallback(
    async (mode: AgentSession["mode"]) => {
      setError(null);
      setSwitching(true);
      try {
        const res = await sendGuarded(
          (stepupId) => fetch("/api/agent/mode", json({ mode, stepupId })),
          { session: false },
        );
        if (!res.ok) {
          setError(errorMessage(await readApiError(res)));
          return;
        }
        showSession((await res.json()).session);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not switch the mode");
      } finally {
        setSwitching(false);
      }
    },
    [showSession],
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

  return {
    session,
    checking,
    decisions,
    error,
    busy,
    switching,
    start,
    answer,
    retryApproval,
    setMode,
  };
}
