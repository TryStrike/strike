'use client';

import { GameBoard } from '@/components/game';
import { QuickTour } from '@/components/tour/QuickTour';
import { SiteNav } from '@/components/SiteNav';
import { WalletConnect } from '@/components/wallet';
import { useEffect } from 'react';
import { useStore } from '@/lib/store';
import { PRICE_FEED_IDS, type AssetType } from '@/lib/utils/priceFeed';

export default function Trade() {
  const isTourOpen = useStore((state) => state.isTourOpen);
  const setIsTourOpen = useStore((state) => state.setIsTourOpen);
  const setSelectedAsset = useStore((state) => state.setSelectedAsset);

  // `/trade?asset=NVDA` (the Markets Predict link) opens on that asset, then
  // drops the param so a later reload keeps whatever the player picked.
  useEffect(() => {
    const asset = new URLSearchParams(window.location.search).get('asset')?.toUpperCase();
    if (!asset) return;
    if (asset in PRICE_FEED_IDS) setSelectedAsset(asset as AssetType);
    window.history.replaceState(null, '', window.location.pathname);
  }, [setSelectedAsset]);
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
