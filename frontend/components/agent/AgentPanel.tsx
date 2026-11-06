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
import { WAITING_FOR_HUMAN, useAgentFeed } from "@/lib/agent/agentFeed";
import {
  useAgent,
  type Decision,
  type StartLimits,
  type WorldAttempt,
} from "@/lib/agent/useAgent";
import { useCopilot } from "@/lib/copilot/useCopilot";
import type { AssetType } from "@/lib/utils/priceFeed";

const AgentStream = dynamic(() => import("@/components/agent/AgentStream"), {
  ssr: false,
});
const WorldCheck = dynamic(() => import("@/components/agent/WorldCheck"), {
  ssr: false,
});

const MINUTES = [
  { value: 5, label: "5m" },
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
];

type Limits = Pick<StartLimits, "mode" | "minutes">;
type Amount = "budget" | "maxPerTrade" | "stopLoss";
const AMOUNT_INPUT = /^\d*\.?\d*$/;

export function AgentPanel() {
  const asset = useStore((s) => s.selectedAsset);
  const { address } = useAccount();
  const houseBalance = useHouseBalance();
  const {
    session,
    decisions,
    error,
    busy,
    start,
    answer,
    checkpoint,
    challenge,
    settle,
  } = useAgent();
  const [world, setWorld] = useState<WorldAttempt | null>(null);
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
  const sessionAsset = session?.asset;
  useEffect(() => {
    if (sessionAsset)
      useStore.getState().setSelectedAsset(sessionAsset as AssetType);
  }, [sessionAsset]);
  const newest = decisions.reduce<Decision | undefined>(
    (a, d) => (!a || d.createdAt > a.createdAt ? d : a),
    undefined,
  );
  const waiting =
    running &&
    newest?.verdict === "blocked" &&
    newest.reason === WAITING_FOR_HUMAN;
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

  const checks = (
    <>
      {challenge && (
        <WorldCheck
          key={challenge.attempt}
          challenge={challenge}
          onDone={(a) => {
            settle(a);
            setWorld(a);
          }}
        />
      )}

      {world && <HumanCheck attempt={world} />}

      {error && (
        <p
          role="alert"
          className="rounded-2xl bg-down-soft px-4 py-3 text-sm text-down"
        >
          {error}
        </p>
      )}
    </>
  );

  if (session) {
    const newSession = () => {
      useAgentFeed.getState().dismiss();
      useCopilot.getState().clear();
      setWorld(null);
    };
    const footer = (
      <div className="flex flex-col gap-2">
        {waiting && (
          <>
            <p
              role="status"
              className="rounded-2xl bg-down-soft px-3 py-2 text-xs text-down"
            >
              The agent lost half its stop-loss and paused. Confirm you are
              still here within 2 minutes or it stops.
            </p>
            <Button
              onClick={() => {
                setWorld(null);
                checkpoint();
              }}
              disabled={busy}
            >
              <Play size={16} weight="fill" /> Continue with World ID
            </Button>
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
          <Badge
            tone={running ? "up" : "neutral"}
          >{`${session.mode} on ${session.asset}`}</Badge>
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
          ? `The agent trades ${asset} on its own at up to your per trade cap. YOLO needs a fresh World ID check. One human, one YOLO agent. Budgets over 10 USDC need Orb, over 50 need Orb + face. At half the stop-loss it pauses until you check again.`
          : `You approve every trade on ${asset}, up to your per trade cap. A proposal you don't answer in 5 seconds is skipped.`}
      </p>

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

      <Button
        size="lg"
        onClick={() => {
          setWorld(null);
          start({ ...limits, budget, maxPerTrade, stopLoss, asset });
        }}
        disabled={
          busy || !address || budget <= 0 || maxPerTrade <= 0 || stopLoss <= 0
        }
      >
        <Play size={18} weight="fill" />{" "}
        {!address
          ? "Connect a wallet to start"
          : busy
            ? "Confirm in your wallet"
            : limits.mode === "yolo"
              ? "Sign and verify with World ID"
              : "Sign and start"}
      </Button>

      {checks}
    </div>
  );
}

const ACR: Record<string, string> = {
  orb: "Orb",
  selfie: "Selfie",
  "orb-face": "Orb + face",
};

const HUMAN_CHECK: Record<
  WorldAttempt["status"],
  {
    label: string;
    tone: "up" | "down" | "neutral";
    copy: (a: WorldAttempt) => string;
  }
> = {
  approved: {
    label: "human verified",
    tone: "up",
    copy: (a) => {
      const acr = a.acr?.split("/").pop() ?? "";
      return `Human verified, ${ACR[acr] ?? acr}`;
    },
  },
  denied: {
    label: "denied",
    tone: "down",
    copy: (a) => `${a.reason}. No agent started, nothing spent.`,
  },
  expired: {
    label: "expired",
    tone: "neutral",
    copy: () => "Human check expired. Nothing started.",
  },
  mismatch: {
    label: "mismatch",
    tone: "down",
    copy: () =>
      "A different human approved this. This wallet belongs to someone else.",
  },
  failed: { label: "failed", tone: "down", copy: (a) => a.reason },
  pending: {
    label: "pending",
    tone: "neutral",
    copy: () => "Waiting for World App. Finish there or sign again.",
  },
  unknown: { label: "used", tone: "neutral", copy: (a) => a.reason },
};

const RESUME_CHECK: Partial<Record<WorldAttempt["status"], string>> = {
  approved: "Human verified, the agent resumed.",
  denied: "Human check denied. The agent stopped.",
  mismatch: "A different human answered. The agent stopped.",
  expired: "Human check expired.",
};

function HumanCheck({ attempt }: { attempt: WorldAttempt }) {
  const c = HUMAN_CHECK[attempt.status];
  const resume =
    attempt.kind === "checkpoint" ? RESUME_CHECK[attempt.status] : undefined;
  return (
    <p
      role="status"
      className="-mt-3 flex items-start gap-2 text-sm text-muted"
    >
      <Badge tone={c.tone}>{c.label}</Badge>
      <span>{resume ?? c.copy(attempt)}</span>
    </p>
  );
}
