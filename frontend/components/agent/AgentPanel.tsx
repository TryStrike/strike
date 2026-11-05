'use client';

import { useState } from 'react';
import { Lightning, Play, Stop } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { Badge, Button, Field, Label, Segmented, cx } from '@/components/ui/kit';
import { BREAKEVEN, useMockAgent, type AgentConfig, type Decision, type Strategy } from './mockAgent';

const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: 'momentum', label: 'Momentum' },
  { value: 'reversion', label: 'Reversion' },
  { value: 'breakout', label: 'Breakout' },
];

const MINUTES = [
  { value: 5, label: '5m' },
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
];

export function AgentPanel() {
  const asset = useStore((s) => s.selectedAsset);
  const [config, setConfig] = useState<AgentConfig>({
    strategy: 'momentum',
    budget: 20,
    maxPerTrade: 2,
    stopLoss: 5,
    minutes: 15,
    yolo: false,
  });
  const { session, start, stop, resolve } = useMockAgent(config, asset);
  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) => setConfig((c) => ({ ...c, [k]: v }));
  const num = (k: 'budget' | 'maxPerTrade' | 'stopLoss') => ({
    value: String(config[k]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Math.max(0, Number(e.target.value) || 0)),
    inputMode: 'decimal' as const,
    disabled: session.running,
  });

  const placed = session.decisions.filter((d) => d.verdict === 'placed');
  const wins = placed.filter((d) => d.result === 'won').length;
  const losses = placed.filter((d) => d.result === 'lost').length;

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agent</h1>
        <div className="flex items-center gap-2">
          <Badge>mock data</Badge>
          <Badge tone={session.running ? 'up' : 'neutral'}>{session.running ? 'running' : 'idle'}</Badge>
        </div>
      </header>

      <section>
        <Label>Strategy</Label>
        <Segmented options={STRATEGIES} value={config.strategy} onChange={(v) => set('strategy', v)} disabled={session.running} />
      </section>

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

      <section className="flex items-end gap-3">
        <div className="flex-1">
          <Label>Session</Label>
          <Segmented options={MINUTES} value={config.minutes} onChange={(v) => set('minutes', v)} disabled={session.running} />
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.yolo}
          disabled={session.running}
          onClick={() => set('yolo', !config.yolo)}
          className={cx(
            'flex h-[44px] items-center gap-2 rounded-full px-4 text-sm font-semibold disabled:opacity-40',
            config.yolo ? 'bg-down text-white' : 'bg-surface text-muted'
          )}
        >
          <Lightning size={16} weight="fill" />
          YOLO {config.yolo ? 'on' : 'off'}
        </button>
      </section>
      <p className="-mt-3 text-xs text-faint">
        {config.yolo
          ? 'No approval per trade. Bar drops to 60% and size goes up to your cap. Limits stay on.'
          : 'You approve every trade. Agent needs 80% confidence and trades the smallest size.'}
      </p>

      {session.running ? (
        <Button variant="secondary" size="lg" onClick={() => stop('You stopped the agent')}>
          <Stop size={18} weight="fill" /> Stop agent
        </Button>
      ) : (
        <Button size="lg" onClick={start} disabled={config.budget <= 0 || config.maxPerTrade <= 0}>
          <Play size={18} weight="fill" /> Start agent
        </Button>
      )}

      {(session.startedAt || session.stoppedReason) && (
        <section className="grid grid-cols-3 gap-2 rounded-3xl bg-surface px-4 py-3 text-center">
          <Stat label="Spent" value={`${session.spent.toFixed(2)}/${config.budget}`} />
          <Stat label="PnL" value={`${session.pnl >= 0 ? '+' : ''}${session.pnl.toFixed(2)}`} tone={session.pnl >= 0 ? 'up' : 'down'} />
          <Stat label="Record" value={`${wins}W ${losses}L`} />
        </section>
      )}

      {session.stoppedReason && !session.running && (
        <p role="status" className="rounded-2xl bg-down-soft px-4 py-3 text-sm text-down">
          {session.stoppedReason}
        </p>
      )}

      <section>
        <Label>Decisions</Label>
        {session.decisions.length === 0 ? (
          <p className="py-8 text-center text-sm text-faint">Start the agent to see every decision and why.</p>
        ) : (
          <ol className="space-y-2">
            {session.decisions.map((d) => (
              <DecisionRow key={d.id} d={d} onResolve={resolve} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

const VERDICT: Record<Decision['verdict'], { label: string; tone: 'up' | 'down' | 'neutral' }> = {
  placed: { label: 'placed', tone: 'up' },
  awaiting: { label: 'needs you', tone: 'neutral' },
  skipped: { label: 'skipped', tone: 'neutral' },
  blocked: { label: 'blocked', tone: 'down' },
  rejected: { label: 'rejected', tone: 'neutral' },
};

function DecisionRow({ d, onResolve }: { d: Decision; onResolve: (id: string, approve: boolean) => void }) {
  const v = VERDICT[d.verdict];
  const edge = d.confidence - BREAKEVEN;
  return (
    <li className="rounded-2xl px-4 py-3 ring-1 ring-ink/[0.06]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-jet text-sm font-semibold">
          {d.direction === 'UP' ? '↑' : '↓'} {d.asset} · {d.size.toFixed(2)}
        </span>
        <span className="flex items-center gap-1.5">
          <Badge tone={v.tone}>{v.label}</Badge>
          {d.result && <Badge tone={d.result === 'won' ? 'up' : 'down'}>{`${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}`}</Badge>}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{d.reason}</p>
      <p className="mt-1 font-jet text-xs text-faint">
        conf {(d.confidence * 100).toFixed(0)}% · edge {edge >= 0 ? '+' : ''}
        {(edge * 100).toFixed(1)}pt · {new Date(d.at).toLocaleTimeString()}
      </p>
      {d.verdict === 'awaiting' && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => onResolve(d.id, true)}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onResolve(d.id, false)}>
            Skip
          </Button>
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
