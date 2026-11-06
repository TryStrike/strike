"use client";

import { useQuery } from "@tanstack/react-query";
import type { RpContext } from "@worldcoin/idkit";
import { ensureBalanceSession } from "@/lib/balance/balanceClientHeaders";
import { errorMessage, jsonOrThrow, needsSession, readApiError } from "@/lib/api/errors";

export interface WorldAttempt {
  status: "pending" | "approved" | "denied" | "expired" | "mismatch" | "failed" | "unknown";
  reason: string;
  acr: string | null;
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

interface Caps {
  openCap: number;
  dailyLoss: number;
}

export interface WorldConfig {
  enabled: boolean;
  devBypass: boolean;
  appId: string;
  environment: string;
  action: string;
  tiers: { selfie: Caps; orb: Caps };
  cooloffMin: number;
  stepup: { withdrawOver: number; proposalOver: number };
  agentPass: { enabled: boolean };
}

export interface Human {
  verified: boolean;
  tier: "selfie" | "orb" | null;
  wallets: string[];
  open: number;
  lostToday: number;
  cooloffUntil: number | null;
  caps: Caps | null;
  agentPassLinked: boolean;
}

const STATUSES = new Set<WorldAttempt["status"]>([
  "pending",
  "approved",
  "denied",
  "expired",
  "mismatch",
  "failed",
]);

export async function attemptOf(res: Response): Promise<WorldAttempt> {
  if (res.status === 404) {
    return {
      status: "unknown",
      reason: "Open the World App link in the browser where you started, then try again",
      acr: null,
    };
  }
  const copy = res.clone();
  const body = await res.json().catch(() => null);
  if (body && STATUSES.has(body.status))
    return { status: body.status, reason: body.reason ?? "", acr: body.acr ?? null };
  const e = await readApiError(copy);
  const status: WorldAttempt["status"] =
    e.status === 410 || e.code === "attempt_expired"
      ? "expired"
      : e.code === "human_mismatch"
        ? "mismatch"
        : e.status === 403
          ? "denied"
          : "failed";
  return { status, reason: errorMessage(e), acr: null };
}

const caps = (c: Caps | null): Caps | null =>
  c && { openCap: Number(c.openCap), dailyLoss: Number(c.dailyLoss) };

export function useWorldConfig() {
  return useQuery({
    queryKey: ["world-config"],
    queryFn: () =>
      fetch("/api/world/config")
        .then((r) => jsonOrThrow<WorldConfig>(r))
        .then((c) => ({
          ...c,
          tiers: { selfie: caps(c.tiers.selfie)!, orb: caps(c.tiers.orb)! },
          stepup: {
            withdrawOver: Number(c.stepup.withdrawOver),
            proposalOver: Number(c.stepup.proposalOver),
          },
        })),
    staleTime: 5 * 60_000,
  });
}

async function withSession(send: () => Promise<Response>): Promise<Response> {
  const res = await send();
  if (res.status !== 401 || !needsSession(await readApiError(res.clone()))) return res;
  await ensureBalanceSession();
  return send();
}

export function useHuman(wallet?: string | null) {
  return useQuery({
    queryKey: ["world-human", wallet?.toLowerCase()],
    enabled: !!wallet,
    queryFn: () =>
      withSession(() =>
        fetch(`/api/world/human?wallet=${encodeURIComponent(wallet!)}`, {
          credentials: "include",
        }),
      )
        .then((r) => jsonOrThrow<Human>(r))
        .then((h) => ({
          ...h,
          open: Number(h.open),
          lostToday: Number(h.lostToday),
          caps: caps(h.caps),
        })),
  });
}

export function startHuman(wallet: string, tier?: "orb"): Promise<WorldChallenge> {
  return withSession(() =>
    fetch("/api/world/human/start", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userAddress: wallet, ...(tier ? { tier } : {}) }),
    }),
  ).then((r) => jsonOrThrow<WorldChallenge>(r));
}
