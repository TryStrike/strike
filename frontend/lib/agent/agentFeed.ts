import { create } from 'zustand';

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
  trace: Trace | null;
}

/** `agent::WAITING_FOR_HUMAN` in the Rust core. */
export const WAITING_FOR_HUMAN = 'Waiting for a human';
/** Rows `get_agent_decisions` reads, so a Why can only reach this far back. */
export const WHY_REACH = 20;
const KEEP = 100;
/** When the running session ends. Lets other pages connect without asking the server first. */
const LIVE_UNTIL = 'strike-agent-live-until';

let source: EventSource | null = null;

interface AgentFeed {
  session: AgentSession | null;
  decisions: Decision[];
  showSession: (session: AgentSession) => void;
  showDecision: (decision: Decision) => void;
  /** Follows the session on the agent cookie. A new start passes `fresh` to pick up the new cookie. */
  connect: (fresh?: boolean) => void;
  connectIfLive: () => void;
  dismiss: () => void;
}

export const useAgentFeed = create<AgentFeed>((set, get) => ({
  session: null,
  decisions: [],
  showSession: (session) => {
    if (session.status === 'running') localStorage.setItem(LIVE_UNTIL, String(session.endsAt));
    else localStorage.removeItem(LIVE_UNTIL);
    set({ session });
  },
  showDecision: (decision) =>
    set((s) => ({ decisions: [decision, ...s.decisions.filter((d) => d.id !== decision.id)].slice(0, KEEP) })),
  connect: (fresh = false) => {
    if (source && !fresh) return;
    source?.close();
    if (fresh) set({ decisions: [] });
    const opened = new EventSource('/api/agent/decisions');
    source = opened;
    opened.addEventListener('session', (e) => get().showSession(JSON.parse((e as MessageEvent).data)));
    opened.addEventListener('decision', (e) => get().showDecision(JSON.parse((e as MessageEvent).data)));
    // A 401 means no session. The browser closes and never retries it.
    opened.onerror = () => {
      if (opened.readyState !== EventSource.CLOSED) return;
      opened.close();
      if (source === opened) source = null;
      localStorage.removeItem(LIVE_UNTIL);
    };
  },
  connectIfLive: () => {
    if (Number(localStorage.getItem(LIVE_UNTIL)) > Date.now()) get().connect();
  },
  dismiss: () => {
    source?.close();
    source = null;
    localStorage.removeItem(LIVE_UNTIL);
    set({ session: null, decisions: [] });
  },
}));
