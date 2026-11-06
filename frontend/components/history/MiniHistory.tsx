'use client';

import React, { useState } from 'react';
import { ArrowUpRight, ChartLineUp, ShareNetwork } from '@phosphor-icons/react';
import { shareWinUrl } from '@/components/game/WinBurst';
import { formatMoney } from '@/components/ui/MoneyText';
import { useStore } from '@/lib/store';
import { Badge, Label, cx } from '@/components/ui/kit';
import { entityUrl, isWin, settledAtMs, useArkivTape } from '@/lib/arkiv';

export function isDemoBetId(id: string | null | undefined): boolean {
  return String(id ?? '').toLowerCase().startsWith('demo-');
}

export const MiniHistory: React.FC = () => {
  const [view, setView] = useState<'mine' | 'everyone'>('mine');
  return (
    <section data-tour="active-bets">
      <div className="flex items-center justify-between">
        <Label>Recent rounds</Label>
        <div className="flex gap-1 text-xs font-medium" role="tablist" aria-label="Whose rounds">
          {(['mine', 'everyone'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cx('rounded-full px-2.5 py-1 transition-colors', view === v ? 'bg-surface text-ink' : 'text-faint hover:text-ink')}
            >
              {v === 'mine' ? 'Mine' : 'Everyone'}
            </button>
          ))}
        </div>
      </div>
      {view === 'mine' ? <MyRounds /> : <EveryoneRounds />}
    </section>
  );
};

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Every player's settled rounds on the asset on screen, read from Arkiv, not from our server. */
const EveryoneRounds: React.FC = () => {
  const asset = useStore((state) => state.selectedAsset);
  const me = useStore((state) => state.address)?.toLowerCase();
  const { tape, error } = useArkivTape(asset);
  const rounds = (tape?.rounds ?? []).filter((r) => r.asset === asset);
  const won = rounds.filter(isWin).length;

  if (error) return <p className="text-sm text-down">Could not read Arkiv: {error}</p>;
  if (!tape) return <p className="font-jet text-xs text-faint">Reading Arkiv…</p>;
  return (
    <>
      <p className="mb-1 font-jet text-[11px] text-faint">
        {rounds.length} {asset} round{rounds.length === 1 ? '' : 's'} in 24h
        {rounds.length > 0 && ` · ${Math.round((won / rounds.length) * 100)}% won`} · read from Arkiv
      </p>
      {rounds.length === 0 ? (
        <p className="text-sm text-faint">No {asset} rounds settled in the last 24 hours.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rounds.slice(0, 10).map((r) => {
            const win = isWin(r);
            return (
              <li key={r.key} className="flex items-center justify-between py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink">
                    {r.direction} · {r.wallet === me ? 'you' : `${r.wallet?.slice(0, 6)}…${r.wallet?.slice(-4)}`}
                  </div>
                  <div className="font-jet text-xs text-faint">{time(settledAtMs(r))}</div>
                </div>
                <span className="flex items-center gap-2">
                  <span className={cx('font-jet font-medium', win ? 'text-up' : 'text-down')}>
                    {win ? formatMoney(r.payout ?? '0', 2, { sign: true }) : `−${formatMoney(r.stake ?? '0', 2)}`}
                  </span>
                  <a
                    href={entityUrl(r.key)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Verify this round on Arkiv"
                    className="text-faint hover:text-ink"
                  >
                    <ArrowUpRight size={14} />
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};

const MyRounds: React.FC = () => {
  const bets = useStore((state) => state.bets);
  const recentBets = bets.slice(0, 10);
  return (
    <>
      {recentBets.length > 0 ? (
        <ul className="divide-y divide-line">
          {recentBets.map((bet) => (
            <li key={bet.id} className="flex items-center justify-between py-2.5 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium text-ink">
                  {bet.target.label}
                  {isDemoBetId(bet.id) && (
                    <span className="ml-2 align-middle">
                      <Badge tone="neutral">Practice</Badge>
                    </span>
                  )}
                </div>
                <div className="font-jet text-xs text-faint">
                  {new Date(bet.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
              </div>
              <span className="flex items-center gap-2">
                <span className={cx('font-jet font-medium', bet.won ? 'text-up' : 'text-down')}>
                  {bet.won ? formatMoney(bet.payout, 2, { sign: true }) : `−${formatMoney(bet.amount, 2)}`}
                </span>
                {bet.won && (
                  <a
                    href={shareWinUrl(parseFloat(bet.payout) || 0, bet.target.label)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Share this win on X"
                    className="text-faint hover:text-ink"
                  >
                    <ShareNetwork size={14} />
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-faint">Your rounds will show up here.</p>
      )}
    </>
  );
};

export const IndicatorsToggle: React.FC = () => {
  const isIndicatorsOpen = useStore((state) => state.isIndicatorsOpen);
  const setIsIndicatorsOpen = useStore((state) => state.setIsIndicatorsOpen);
  const activeIndicators = useStore((state) => state.activeIndicators);
  const on = isIndicatorsOpen || Object.values(activeIndicators).some(Boolean);

  return (
    <button
      type="button"
      onClick={() => setIsIndicatorsOpen(!isIndicatorsOpen)}
      data-tour="indicators-trigger"
      aria-pressed={isIndicatorsOpen}
      className={cx(
        'inline-flex h-9 items-center gap-2 rounded-full px-3.5 font-tight text-sm font-medium ring-1 transition-colors',
        on ? 'bg-up/[0.08] text-up ring-up/20 backdrop-blur-xl' : 'bg-white/70 text-muted ring-ink/[0.06] backdrop-blur-xl hover:text-ink'
      )}
    >
      <ChartLineUp size={16} />
      Indicators
    </button>
  );
};
