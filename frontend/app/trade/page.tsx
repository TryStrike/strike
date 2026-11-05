'use client';

import { GameBoard } from '@/components/game';
import { QuickTour } from '@/components/tour/QuickTour';
import { SiteNav } from '@/components/SiteNav';
import { WalletConnect } from '@/components/wallet';
import { useStore } from '@/lib/store';

export default function Trade() {
  const isTourOpen = useStore((state) => state.isTourOpen);
  const setIsTourOpen = useStore((state) => state.setIsTourOpen);
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-white font-tight text-ink">
      <SiteNav
        wide
        right={
          <>
            <button
              type="button"
              onClick={() => setIsTourOpen(true)}
              className="hidden h-9 rounded-full px-3.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-ink sm:block"
            >
              How to play
            </button>
            <WalletConnect />
          </>
        }
      />
      <div className="min-h-0 flex-1">
        <GameBoard />
      </div>
      <QuickTour isOpen={isTourOpen} onClose={() => setIsTourOpen(false)} />
    </div>
  );
}
