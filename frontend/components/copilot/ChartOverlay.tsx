'use client';

import { Modal } from '@/components/ui/Modal';
import { useCopilotView } from '@/lib/copilot/actions';

const W = 320;
const H = 120;

export default function ChartOverlay() {
  const chart = useCopilotView((s) => s.chart);
  const close = useCopilotView((s) => s.closeChart);
  if (!chart || chart.points.length < 2) return null;
  const prices = chart.points.map((p) => p.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const span = high - low || 1;
  const first = chart.points[0];
  const last = chart.points[chart.points.length - 1];
  const line = chart.points
    .map((p) => {
      const x = ((p.at - first.at) / (last.at - first.at || 1)) * W;
      const y = H - ((p.price - low) / span) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const change = ((last.price - first.price) / first.price) * 100;
  return (
    <Modal isOpen onClose={close} title={`${chart.symbol}, last 15 minutes`}>
      <p className="font-jet text-lg font-semibold tabular-nums">
        {last.price.toLocaleString(undefined, { maximumFractionDigits: 8 })}{' '}
        <span className={change >= 0 ? 'text-up' : 'text-down'}>
          {change >= 0 ? '+' : ''}
          {change.toFixed(2)}%
        </span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 h-32 w-full" preserveAspectRatio="none" role="img" aria-label={`${chart.symbol} price line`}>
        <polyline points={line} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" className={change >= 0 ? 'stroke-up' : 'stroke-down'} />
      </svg>
      <div className="mt-1 flex justify-between font-jet text-xs text-faint tabular-nums">
        <span>low {low.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>
        <span>high {high.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>
      </div>
    </Modal>
  );
}
