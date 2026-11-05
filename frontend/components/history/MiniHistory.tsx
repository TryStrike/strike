'use client';

import React from 'react';
import { ChartLineUp, ShareNetwork } from '@phosphor-icons/react';
import { shareWinUrl } from '@/components/game/WinBurst';
import { formatMoney } from '@/components/ui/MoneyText';
import { useStore } from '@/lib/store';
import { Badge, Label, cx } from '@/components/ui/kit';

export function isDemoBetId(id: string | null | undefined): boolean {
  return String(id ?? '').toLowerCase().startsWith('demo-');
}

export const MiniHistory: React.FC = () => {
  const bets = useStore((state) => state.bets);
  const recentBets = bets.slice(0, 10);

  return (
    <section data-tour="active-bets">
      <Label>Recent rounds</Label>
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
    </section>
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
