"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useAccount } from "wagmi";
import { Lightning, Play } from "@phosphor-icons/react";
import { useHouseBalance, useStore } from "@/lib/store";
import {
  Badge,
  Button,
  Field,
  Label,
  Segmented,
  cx,
} from "@/components/ui/kit";
import { useAgentFeed } from "@/lib/agent/agentFeed";
import { useAgent, useAgentState, type StartLimits } from "@/lib/agent/useAgent";
import { useCopilot } from "@/lib/copilot/useCopilot";
import { wait } from "@/lib/api/errors";
import { useWorldConfig } from "@/lib/world/human";
import { StepUpCard, useNow } from "@/components/world/StepUpCard";
import { HumanStatus } from "@/components/world/HumanStatus";
import type { AssetType } from "@/lib/utils/priceFeed";

const AgentStream = dynamic(() => import("@/components/agent/AgentStream"), {
  ssr: false,
});

const MINUTES = [
  { value: 5, label: "5m" },
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
];

const RETRYABLE = ["expired", "failed", "cancelled"];

type Limits = Pick<StartLimits, "mode" | "minutes">;
type Amount = "budget" | "maxPerTrade" | "stopLoss";
const AMOUNT_INPUT = /^\d*\.?\d*$/;
/** `stake_floor` in the Rust agent. A smaller limit could never place a trade. */
const MIN_AMOUNT = 0.1;

export function AgentPanel() {
  const asset = useStore((s) => s.selectedAsset);
  const { address } = useAccount();
  const houseBalance = useHouseBalance();
  const { session, error, busy, start, answer, retryApproval } = useAgent();
  const orb = useWorldConfig().data?.tiers.orb;
  const [limits, setLimits] = useState<Limits>({
    mode: "normal",
    minutes: 15,
  });
  const [amounts, setAmounts] = useState<Record<Amount, string>>({
    budget: "1",
    maxPerTrade: "0.2",
    stopLoss: "0.8",
  });
  const running = session?.status === "running";
  const state = useAgentState(running);
  const paused = running && state?.status === "paused";
  const now = useNow(paused);
  const sessionAsset = session?.asset;
  useEffect(() => {
    if (sessionAsset)
      useStore.getState().setSelectedAsset(sessionAsset as AssetType);
  }, [sessionAsset]);
  const set = <K extends keyof Limits>(k: K, v: Limits[K]) =>
    setLimits((l) => ({ ...l, [k]: v }));
  const num = (k: Amount) => ({
    value: amounts[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      if (AMOUNT_INPUT.test(value)) setAmounts((a) => ({ ...a, [k]: value }));
    },
    inputMode: "decimal" as const,
  });
  const budget = Number(amounts.budget);
  const maxPerTrade = Number(amounts.maxPerTrade);
  const stopLoss = Number(amounts.stopLoss);
  const tooSmall = [budget, maxPerTrade, stopLoss].some(
    (amount) => !(amount >= MIN_AMOUNT),
  );

  const checks = error && (
    <p
      role="alert"
      className="rounded-2xl bg-down-soft px-4 py-3 text-sm text-down"
    >
      {error}
    </p>
  );

  if (session) {
    const newSession = () => {
      useAgentFeed.getState().dismiss();
      useCopilot.getState().clear();
    };
    const footer = (
      <div className="flex flex-col gap-2">
        {paused && (
          <>
            <p
              role="status"
              className="rounded-2xl bg-down-soft px-3 py-2 text-xs text-down"
            >
              The agent paused and places no bets until you approve in World
              App.
              {state.pausedUntil
                ? ` It stops in ${wait(state.pausedUntil, now)} without an approval.`
                : " It stops if the pause ends without an approval."}
            </p>
            {state.stepup && (
              <StepUpCard key={state.stepup.id} stepup={state.stepup} />
            )}
            {(!state.stepup || RETRYABLE.includes(state.stepup.status)) && (
              <Button variant="secondary" size="sm" onClick={retryApproval}>
                Request new approval
              </Button>
            )}
          </>
        )}
        {!running && (
          <Button variant="secondary" size="sm" onClick={newSession}>
            New session
          </Button>
        )}
        {checks}
      </div>
    );
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-4">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Copilot</h1>
          <Badge tone={paused ? "down" : running ? "up" : "neutral"}>
            {`${session.mode} on ${session.asset}${paused ? ", paused" : ""}`}
          </Badge>
        </header>
        <AgentStream session={session} onAnswer={answer} footer={footer} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agent</h1>
        <Badge>idle</Badge>
      </header>

      <section className="grid grid-cols-3 gap-2">
        <div>
          <Label>Budget</Label>
          <Field unit="USDC" {...num("budget")} />
        </div>
        <div>
          <Label>Per trade</Label>
          <Field unit="max" {...num("maxPerTrade")} />
        </div>
        <div>
          <Label>Stop-loss</Label>
          <Field unit="USDC" {...num("stopLoss")} />
        </div>
      </section>

      <section className="flex items-end gap-3">
        <div className="flex-1">
          <Label>Session</Label>
          <Segmented
            options={MINUTES}
            value={limits.minutes}
            onChange={(v) => set("minutes", v)}
          />
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={limits.mode === "yolo"}
          onClick={() =>
            set("mode", limits.mode === "yolo" ? "normal" : "yolo")
          }
          className={cx(
            "flex h-[44px] items-center gap-2 rounded-full px-4 text-sm font-semibold disabled:opacity-40",
            limits.mode === "yolo"
              ? "bg-down text-white"
              : "bg-surface text-muted",
          )}
        >
          <Lightning size={16} weight="fill" />
          YOLO {limits.mode === "yolo" ? "on" : "off"}
        </button>
      </section>
      <p className="-mt-3 text-xs text-faint">
        {limits.mode === "yolo"
          ? `The agent trades ${asset} on its own at up to your per trade cap. YOLO needs an Orb-verified human and a fresh approval in World App. One human, one agent.${orb ? ` Orb limits: ${orb.openCap} USDC open and ${orb.dailyLoss} USDC daily loss, across all your wallets.` : ""} At half the stop-loss, and again at three quarters, it pauses until you approve again.`
          : `You approve every trade on ${asset}, up to your per trade cap. A proposal you don't answer in 5 seconds is skipped.`}
      </p>
      <div className="-mt-3">
        <HumanStatus />
      </div>

      {address && (
        <p
          className={cx(
            "-mt-3 text-xs",
            houseBalance < maxPerTrade ? "text-down" : "text-faint",
          )}
        >
          House balance {houseBalance.toFixed(4)} USDC.
          {houseBalance < maxPerTrade &&
            ` Trades need ${maxPerTrade} USDC, deposit on Trade first.`}
        </p>
      )}

      {tooSmall && (
        <p className="-mt-3 text-xs text-down">
          Budget, per trade and stop-loss need at least {MIN_AMOUNT} USDC each.
        </p>
      )}

      <Button
        size="lg"
        onClick={() =>
          start({ ...limits, budget, maxPerTrade, stopLoss, asset })
        }
        disabled={busy || !address || tooSmall}
      >
        <Play size={18} weight="fill" />{" "}
        {!address
          ? "Connect a wallet to start"
          : busy
            ? "Waiting for your wallet or World App"
            : limits.mode === "yolo"
              ? "Sign and approve in World App"
              : "Sign and start"}
      </Button>

      {checks}
    </div>
  );
}
