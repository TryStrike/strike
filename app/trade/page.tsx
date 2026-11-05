'use client';

import { GameBoard } from '@/components/game';
import { MiniHistory } from '@/components/history';
import { QuickTour } from '@/components/tour/QuickTour';
import { PriceTicker } from '@/components/ui/PriceTicker';
import { useStore } from '@/lib/store';

export default function Home() {
  const isTourOpen = useStore((state) => state.isTourOpen);
  const setIsTourOpen = useStore((state) => state.setIsTourOpen);
  return (
    <div className="h-full w-full bg-[#02040A] overflow-hidden relative flex flex-col">
      {/* Live price ticker strip */}
      <PriceTicker />

      {/* Game board fills remaining height */}
      <div className="flex-1 relative overflow-hidden min-h-0">
        <GameBoard />
        <MiniHistory />
      </div>

      {/* Tour Component */}
      <QuickTour isOpen={isTourOpen} onClose={() => setIsTourOpen(false)} />
    </div>
  );
}
