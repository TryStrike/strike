import { create } from "zustand";
import type { ActiveBet } from "@/lib/store/gameSlice";
import type { AssetType } from "@/lib/utils/priceFeed";
import type { StepUp } from "@/lib/api/errors";

export type Verdict =
  "awaiting" | "placed" | "skipped" | "blocked" | "rejected";

export interface AgentSession {
  id: string;
  wallet: string;
  asset: string;
  mode: "normal" | "yolo";
  budget: number;
  maxPerTrade: number;
  stopLoss: number;
  startsAt: number;
  endsAt: number;
  status: "running" | "stopped";
  stoppedReason: string | null;
  spent: number;
  realizedPnl: number;
  wins: number;
  losses: number;
  pausedUntil: number | null;
  pauseStepupId: string | null;
  checksPassed: number;
  roundSeconds: number;
}

export interface Trace {
  signal: string;
  jevNeeded: number | null;
  budgetLeft: number;
  stopLossRoom: number;
}

export interface Decision {
  id: string;
  sessionId: string;
  createdAt: number;
  direction: "UP" | "DOWN" | null;
  stake: number | null;
  verdict: Verdict;
  reason: string;
  skipCount: number;
  confidence: number | null;
  betId: string | null;
  result: string | null;
  pnl: number | null;
  expiresAt: number | null;
  trace: Trace | null;
  strike: number | null;
  roundEndsAt: number | null;
}

export interface ToolStep {
  label: string;
  ok: boolean;
  error?: string;
}

export interface Thought {
  id: string;
  at: number;
  thinking: string;
  text: string;
  steps: ToolStep[];
}

interface ThoughtFrame {
  id: string;
  at: number;
  thinking?: string;
  text?: string;
  step?: ToolStep;
}

export interface SignalStep {
  stage: "signal";
  at: number;
  price: number | null;
  movePct: number | null;
  rangeShare: number | null;
  needed: number;
  skip: string | null;
  stake: number;
  room: number;
}

export interface AiStep {
  stage: "ai";
  status: "running" | "pass" | "block" | "failed" | "off";
  score?: number | null;
  needed?: number | null;
  why?: string | null;
  ms?: number;
}

export interface ResultStep {
  stage: "result";
  outcome: "proposed" | "placed" | "refused";
}

/** The check happening now. It arrives live and is never stored. */
export interface Activity {
  signal?: SignalStep;
  ai?: AiStep;
  result?: ResultStep;
}

/** Agent rounds still open, in the shape the chart draws a bet. */
export function agentChartBets(): ActiveBet[] {
  const { session, decisions } = useAgentFeed.getState();
  if (!session) return [];
  return decisions.flatMap((d) =>
    d.betId &&
    !d.result &&
    d.direction &&
    d.stake !== null &&
    d.strike !== null &&
    d.roundEndsAt !== null
      ? [
          {
            id: d.betId,
            mode: "binomo" as const,
            asset: session.asset as AssetType,
            amount: d.stake,
            multiplier: 1,
            direction: d.direction,
            timestamp: d.createdAt,
            strikePrice: d.strike,
            startTime: d.roundEndsAt - session.roundSeconds * 1000,
            endTime: d.roundEndsAt,
          },
        ]
      : [],
  );
}

/** `agent::WAITING_FOR_HUMAN` in the Rust core. */
export const WAITING_FOR_HUMAN = "Waiting for a human";
/** `jev::BLOCKED` in the Rust core. The AI gate turning down a trade is routine. */
export const AI_BLOCKED = "jev confidence was too low";
export const WHY_REACH = 20;
const KEEP = 100;
const KEEP_THOUGHTS = 30;
const LIVE_UNTIL = "strike-agent-live-until";

let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

interface AgentFeed {
  session: AgentSession | null;
  /** Until the server says whether this browser has a session. */
  checking: boolean;
  decisions: Decision[];
  thoughts: Thought[];
  activity: Activity;
  showStep: (step: SignalStep | AiStep | ResultStep) => void;
  stepup: StepUp | null;
  showSession: (session: AgentSession) => void;
  showDecision: (decision: Decision) => void;
  showThought: (frame: ThoughtFrame) => void;
  connect: (fresh?: boolean) => void;
  reconnect: () => void;
  connectIfLive: () => void;
  dismiss: () => void;
}

export const useAgentFeed = create<AgentFeed>((set, get) => ({
  session: null,
  checking: true,
  decisions: [],
  thoughts: [],
  activity: {},
  showStep: (step) =>
    set((s) => ({
      activity:
        step.stage === "signal"
          ? { signal: step }
          : { ...s.activity, [step.stage]: step },
    })),
  stepup: null,
  showSession: (session) => {
    if (session.status === "running")
      localStorage.setItem(LIVE_UNTIL, String(session.endsAt));
    else localStorage.removeItem(LIVE_UNTIL);
    if (session.status === "running" || get().session) set({ session });
  },
  showDecision: (decision) =>
    set((s) => ({
      decisions: [
        decision,
        ...s.decisions.filter((d) => d.id !== decision.id),
      ].slice(0, KEEP),
    })),
  showThought: ({ id, at, thinking, text, step }) =>
    set((s) => {
      const known = s.thoughts.find((t) => t.id === id) ?? {
        id,
        at,
        thinking: "",
        text: "",
        steps: [],
      };
      const next = {
        ...known,
        thinking: known.thinking + (thinking ?? ""),
        text: known.text + (text ?? ""),
        steps: step ? [...known.steps, step] : known.steps,
      };
      return {
        thoughts: [...s.thoughts.filter((t) => t.id !== id), next].slice(
          -KEEP_THOUGHTS,
        ),
      };
    }),
  connect: (fresh = false) => {
    if (source && !fresh) return;
    source?.close();
    clearTimeout(retryTimer);
    if (fresh)
      set({ decisions: [], thoughts: [], activity: {}, stepup: null });
    set({ checking: !get().session });
    const opened = new EventSource("/api/agent/decisions");
    source = opened;
    opened.addEventListener("session", (e) => {
      get().showSession(JSON.parse((e as MessageEvent).data));
      set({ checking: false });
    });
    opened.addEventListener("decision", (e) =>
      get().showDecision(JSON.parse((e as MessageEvent).data)),
    );
    opened.addEventListener("check", (e) =>
      get().showStep(JSON.parse((e as MessageEvent).data)),
    );
    opened.addEventListener("stepup", (e) =>
      set({ stepup: JSON.parse((e as MessageEvent).data) }),
    );
    opened.addEventListener("thought", (e) =>
      get().showThought(JSON.parse((e as MessageEvent).data)),
    );
    opened.onopen = () => {
      failures = 0;
    };
    opened.onerror = () => {
      set({ checking: false });
      // The browser retries by itself until the server answers non-200; after that it gives up, so we do.
      if (opened.readyState !== EventSource.CLOSED) return;
      opened.close();
      if (source !== opened) return;
      source = null;
      const wait = Math.min(1_000 * 2 ** failures++, 30_000);
      retryTimer = setTimeout(() => get().connectIfLive(), wait);
    };
  },
  reconnect: () => {
    clearTimeout(retryTimer);
    source?.close();
    source = null;
    get().connect();
  },
  connectIfLive: () => {
    if (Number(localStorage.getItem(LIVE_UNTIL)) > Date.now()) get().connect();
  },
  dismiss: () => {
    clearTimeout(retryTimer);
    source?.close();
    source = null;
    localStorage.removeItem(LIVE_UNTIL);
    set({
      session: null,
      checking: false,
      decisions: [],
      thoughts: [],
      activity: {},
      stepup: null,
    });
  },
}));
