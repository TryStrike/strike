'use client';

import { Badge } from '@/components/ui/kit';
import { useStore } from '@/lib/store';
import { requireHuman } from '@/lib/world/gate';
import { useHuman } from '@/lib/world/human';

export function HumanStatus({ nudge = false }: { nudge?: boolean }) {
  const address = useStore((s) => s.address);
  const { data: h, isError } = useHuman(address);
  if (!address || (!h && !isError)) return null;
  if (h?.verified) {
    if (nudge) return null;
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-faint">
        <Badge tone="up">human · {h.tier}</Badge>
        {h.caps && `${h.open.toFixed(2)}/${h.caps.openCap} USDC open · ${h.lostToday.toFixed(2)}/${h.caps.dailyLoss} USDC lost today`}
        {h.tier === 'selfie' && (
          <button type="button" className="underline hover:text-ink" onClick={() => void requireHuman('orb')}>
            Upgrade to Orb
          </button>
        )}
      </p>
    );
  }
  return (
    <p className="text-xs text-faint">
      {nudge ? 'Deposits work right away. ' : ''}
      <button type="button" className="font-semibold text-up underline" onClick={() => void requireHuman()}>
        Verify with World ID
      </button>{' '}
      to start trading.
    </p>
  );
}
