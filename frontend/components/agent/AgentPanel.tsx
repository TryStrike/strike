'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useAccount } from 'wagmi';
import { Play, Stop } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { Badge, Button, Field, Label, Segmented, cx } from '@/components/ui/kit';
import { useAgent, type AgentSession, type Decision, type StartLimits } from '@/lib/agent/useAgent';

const SettlementProof = dynamic(() => import('@/components/game/SettlementProof'), { ssr: false });

const MINUTES = [
  { value: 5, label: '5m' },
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
];

type Limits = Omit<StartLimits, 'asset'>;

export function AgentPanel() {
  const asset = useStore((s) => s.selectedAsset);
  const { address } = useAccount();
  const { session, decisions, error, busy, start, stop } = useAgent();
  const [limits, setLimits] = useState<Limits>({ budget: 20, maxPerTrade: 2, stopLoss: 5, minutes: 15 });
  const running = session?.status === 'running';
  const shown: Limits = running
    ? { budget: session.budget, maxPerTrade: session.maxPerTrade, stopLoss: session.stopLoss, minutes: Math.round((session.endsAt - session.startsAt) / 60_000) }
    : limits;
  const set = <K extends keyof Limits>(k: K, v: Limits[K]) => setLimits((l) => ({ ...l, [k]: v }));
  const num = (k: 'budget' | 'maxPerTrade' | 'stopLoss') => ({
    value: String(shown[k]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Math.max(0, Number(e.target.value) || 0)),
    inputMode: 'decimal' as const,
    disabled: running,
  });

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agent</h1>
        <Badge tone={running ? 'up' : 'neutral'}>{running ? `running on ${session.asset}` : 'idle'}</Badge>
      </header>

      <section className="grid grid-cols-3 gap-2">
        <div>
          <Label>Budget</Label>
          <Field unit="USDC" {...num('budget')} />
        </div>
        <div>
          <Label>Per trade</Label>
          <Field unit="max" {...num('maxPerTrade')} />
        </div>
        <div>
          <Label>Stop-loss</Label>
          <Field unit="USDC" {...num('stopLoss')} />
        </div>
      </section>

      <section>
        <Label>Session</Label>
        <Segmented options={MINUTES} value={shown.minutes} onChange={(v) => set('minutes', v)} disabled={running} />
      </section>
      <p className="-mt-3 text-xs text-faint">
        YOLO: one signature approves the budget. The agent trades {running ? session.asset : asset} on its own at up to your
        per trade cap. Limits stay on.
      </p>

      {running ? (
        <Button variant="secondary" size="lg" onClick={stop} disabled={busy}>
          <Stop size={18} weight="fill" /> Stop agent
        </Button>
      ) : (
        <Button
          size="lg"
          onClick={() => start({ ...limits, asset })}
          disabled={busy || !address || limits.budget <= 0 || limits.maxPerTrade <= 0 || limits.stopLoss <= 0}
        >
          <Play size={18} weight="fill" /> {address ? 'Sign and start' : 'Connect a wallet to start'}
        </Button>
      )}

      {error && (
        <p role="alert" className="rounded-2xl bg-down-soft px-4 py-3 text-sm text-down">
          {error}
        </p>
      )}

      {session && <SessionStats session={session} />}

      {session?.status === 'stopped' && session.stoppedReason && (
        <p role="status" className="rounded-2xl bg-surface px-4 py-3 text-sm text-muted">
          Stopped: {session.stoppedReason}
        </p>
      )}

      <section>
        <Label>Decisions</Label>
        {decisions.length === 0 ? (
          <p className="py-8 text-center text-sm text-faint">Start the agent to see every decision and why.</p>
        ) : (
          <ol className="space-y-2">
            {decisions.map((d) => (
              <DecisionRow key={d.id} d={d} session={session} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function SessionStats({ session }: { session: AgentSession }) {
  const [now, setNow] = useState(() => Date.now());
  const running = session.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const left = running ? Math.max(0, session.endsAt - now) : 0;
  const pnl = session.realizedPnl;
  return (
    <section className="grid grid-cols-3 gap-2 rounded-3xl bg-surface px-4 py-3 text-center">
      <Stat label="Spent" value={`${session.spent.toFixed(2)}/${session.budget}`} />
      <Stat label="PnL" value={`${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`} tone={pnl > 0 ? 'up' : pnl < 0 ? 'down' : undefined} />
      <Stat
        label="Time left"
        value={`${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`}
      />
    </section>
  );
}

const VERDICT: Record<Decision['verdict'], { label: string; tone: 'up' | 'down' | 'neutral' }> = {
  placed: { label: 'placed', tone: 'up' },
  awaiting: { label: 'needs you', tone: 'neutral' },
  skipped: { label: 'skipped', tone: 'neutral' },
  blocked: { label: 'blocked', tone: 'down' },
  rejected: { label: 'rejected', tone: 'down' },
};

function DecisionRow({ d, session }: { d: Decision; session: AgentSession | null }) {
  const v = VERDICT[d.verdict];
  return (
    <li className="rounded-2xl px-4 py-3 ring-1 ring-ink/[0.06]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-jet text-sm font-semibold">
          {d.direction ? `${d.direction === 'UP' ? '↑' : '↓'} ` : ''}
          {session?.asset}
          {d.stake !== null && ` · ${d.stake.toFixed(2)}`}
        </span>
        <span className="flex items-center gap-1.5">
          {d.skipCount > 1 && <Badge>{`×${d.skipCount}`}</Badge>}
          <Badge tone={v.tone}>{v.label}</Badge>
          {d.pnl !== null && <Badge tone={d.pnl >= 0 ? 'up' : 'down'}>{`${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}`}</Badge>}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{d.reason}</p>
      <p className="mt-1 font-jet text-xs text-faint">
        {d.confidence !== null && `confidence ${(d.confidence * 100).toFixed(0)}% · `}
        {d.result && `${d.result} · `}
        {new Date(d.createdAt).toLocaleTimeString()}
      </p>
      {d.betId && (
        <div className="mt-2">
          <SettlementProof
            variant="chip"
            wallet={session?.wallet}
            bet={{ betId: d.betId, asset: session?.asset, mode: 'binomo', direction: d.direction, stake: d.stake }}
          />
        </div>
      )}
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <p className="font-jet text-[11px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <p className={cx('font-jet text-sm font-semibold tabular-nums', tone === 'up' && 'text-up', tone === 'down' && 'text-down')}>{value}</p>
    </div>
  );
}
