'use client';

import React from 'react';
import { ChartLineUp } from '@phosphor-icons/react';
import { useStore } from '@/lib/store';
import { Label, cx } from '@/components/ui/kit';

/** Last 10 settled rounds, shown in the trade panel. */
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
                <div className="truncate font-medium text-ink">{bet.target.label}</div>
                <div className="font-jet text-xs text-faint">
                  {new Date(bet.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
              </div>
              <span className={cx('font-jet font-medium', bet.won ? 'text-up' : 'text-down')}>
                {bet.won ? `+${parseFloat(bet.payout).toFixed(2)}` : `−${parseFloat(bet.amount).toFixed(2)}`}
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

/** Opens the chart's indicators panel. */
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
        on ? 'bg-ink text-white ring-ink' : 'bg-white text-muted ring-line hover:text-ink'
      )}
    >
      <ChartLineUp size={16} />
      Indicators
    </button>
  );
};
