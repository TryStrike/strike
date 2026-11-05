import { useCallback, useEffect, useRef, useState } from 'react';

export type Strategy = 'momentum' | 'reversion' | 'breakout';
export type Verdict = 'placed' | 'awaiting' | 'skipped' | 'blocked' | 'rejected';

export interface AgentConfig {
  strategy: Strategy;
  budget: number;
  maxPerTrade: number;
  stopLoss: number;
  minutes: number;
  yolo: boolean;
}

export interface Decision {
  id: string;
  at: number;
  asset: string;
  direction: 'UP' | 'DOWN';
  size: number;
  confidence: number;
  verdict: Verdict;
  reason: string;
  result: 'won' | 'lost' | null;
  pnl: number;
}

export interface AgentSession {
  running: boolean;
  startedAt: number | null;
  endsAt: number | null;
  spent: number;
  pnl: number;
  stoppedReason: string | null;
  decisions: Decision[];
}

export const BREAKEVEN = 1 / 1.9;
const PAYOUT = 0.9;
const TICK_MS = 2500;
const SETTLE_MS = 5000;

const REASONS: Record<Strategy, string[]> = {
  momentum: ['three higher closes in a row', 'price broke the 30s high', 'trend steepening on rising ticks'],
  reversion: ['stretched 2 sigma above the 1m mean', 'sharp drop into support', 'overextended after a fast spike'],
  breakout: ['range compressing for 40s', 'pushing through the session high', 'volatility expanding off a tight base'],
};

const EMPTY: AgentSession = { running: false, startedAt: null, endsAt: null, spent: 0, pnl: 0, stoppedReason: null, decisions: [] };

export function useMockAgent(config: AgentConfig, asset: string) {
  const [session, setSession] = useState<AgentSession>(EMPTY);
  const cfg = useRef(config);
  cfg.current = config;
  const assetRef = useRef(asset);
  assetRef.current = asset;

  const stop = useCallback((reason: string) => {
    setSession((s) => (s.running ? { ...s, running: false, stoppedReason: reason } : s));
  }, []);

  const start = useCallback(() => {
    const now = Date.now();
    setSession({ ...EMPTY, running: true, startedAt: now, endsAt: now + cfg.current.minutes * 60_000 });
  }, []);

  const settle = useCallback((id: string) => {
    setTimeout(() => {
      setSession((s) => {
        const d = s.decisions.find((x) => x.id === id);
        if (!d || d.verdict !== 'placed' || d.result) return s;
        const won = Math.random() < d.confidence - 0.04;
        const pnl = won ? d.size * PAYOUT : -d.size;
        const total = s.pnl + pnl;
        const hitStop = total <= -cfg.current.stopLoss;
        return {
          ...s,
          pnl: total,
          running: hitStop ? false : s.running,
          stoppedReason: hitStop ? `Stop-loss hit at ${total.toFixed(2)} USDC` : s.stoppedReason,
          decisions: s.decisions.map((x) => (x.id === id ? { ...x, result: won ? 'won' : 'lost', pnl } : x)),
        };
      });
    }, SETTLE_MS);
  }, []);

  const resolve = useCallback(
    (id: string, approve: boolean) => {
      setSession((s) => ({
        ...s,
        spent: approve ? s.spent + (s.decisions.find((d) => d.id === id)?.size ?? 0) : s.spent,
        decisions: s.decisions.map((d) =>
          d.id === id ? { ...d, verdict: approve ? 'placed' : 'rejected', reason: approve ? d.reason : 'You skipped it' } : d
        ),
      }));
      if (approve) settle(id);
    },
    [settle]
  );

  useEffect(() => {
    if (!session.running) return;
    const timer = setInterval(() => {
      const c = cfg.current;
      setSession((s) => {
        if (!s.running) return s;
        if (s.endsAt && Date.now() >= s.endsAt) return { ...s, running: false, stoppedReason: 'Session time is up' };
        const confidence = 0.45 + Math.random() * 0.45;
        const threshold = c.yolo ? 0.6 : 0.8;
        const size = Math.max(1, Math.round((c.yolo ? c.maxPerTrade * (0.4 + Math.random() * 0.6) : Math.min(1, c.maxPerTrade)) * 100) / 100);
        const pick = REASONS[c.strategy][Math.floor(Math.random() * REASONS[c.strategy].length)];
        let verdict: Verdict = c.yolo ? 'placed' : 'awaiting';
        let reason = pick;
        if (confidence < threshold) {
          verdict = 'skipped';
          reason = `Confidence ${(confidence * 100).toFixed(0)}% under the ${(threshold * 100).toFixed(0)}% bar`;
        } else if (confidence <= BREAKEVEN) {
          verdict = 'skipped';
          reason = 'Not above the 52.6% breakeven';
        } else if (s.spent + size > c.budget) {
          verdict = 'blocked';
          reason = 'Would go over the session budget';
        }
        const d: Decision = {
          id: `${Date.now()}`,
          at: Date.now(),
          asset: assetRef.current,
          direction: Math.random() > 0.5 ? 'UP' : 'DOWN',
          size,
          confidence,
          verdict,
          reason,
          result: null,
          pnl: 0,
        };
        if (verdict === 'placed') settle(d.id);
        return {
          ...s,
          spent: verdict === 'placed' ? s.spent + size : s.spent,
          decisions: [d, ...s.decisions].slice(0, 60),
        };
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [session.running, settle]);

  return { session, start, stop, resolve };
}
