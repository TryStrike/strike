'use client';

/**
 * PriceTicker — reads live prices directly from the Zustand store's
 * `assetPrices` map (already populated by the global price feed).
 * Zero extra network requests.
 */

import React, { useRef, useEffect, useState } from 'react';
import { useStore } from '@/lib/store';

// ── Ordered list of assets to show ─────────────────────────────────────────
const TICKER_ITEMS: { key: string; label: string; category: 'crypto' | 'forex' | 'metal' | 'stock' }[] = [
  { key: 'BTC',    label: 'BTC/USD',  category: 'crypto' },
  { key: 'ETH',    label: 'ETH/USD',  category: 'crypto' },
  { key: 'SOL',    label: 'SOL/USD',  category: 'crypto' },
  { key: 'BNB',    label: 'BNB/USD',  category: 'crypto' },
  { key: 'XRP',    label: 'XRP/USD',  category: 'crypto' },
  { key: 'DOGE',   label: 'DOGE/USD', category: 'crypto' },
  { key: 'ADA',    label: 'ADA/USD',  category: 'crypto' },
  { key: 'SUI',    label: 'SUI/USD',  category: 'crypto' },
  { key: 'NEAR',   label: 'NEAR/USD', category: 'crypto' },
  { key: 'XLM',    label: 'XLM/USD',  category: 'crypto' },
  { key: 'TRX',    label: 'TRX/USD',  category: 'crypto' },
  { key: 'EUR',    label: 'EUR/USD',  category: 'forex'  },
  { key: 'GBP',    label: 'GBP/USD',  category: 'forex'  },
  { key: 'JPY',    label: 'JPY/USD',  category: 'forex'  },
  { key: 'AUD',    label: 'AUD/USD',  category: 'forex'  },
  { key: 'GOLD',   label: 'XAU/USD',  category: 'metal'  },
  { key: 'SILVER', label: 'XAG/USD',  category: 'metal'  },
  { key: 'AAPL',   label: 'AAPL',     category: 'stock'  },
  { key: 'NVDA',   label: 'NVDA',     category: 'stock'  },
  { key: 'TSLA',   label: 'TSLA',     category: 'stock'  },
  { key: 'MSFT',   label: 'MSFT',     category: 'stock'  },
  { key: 'META',   label: 'META',     category: 'stock'  },
  { key: 'AMZN',   label: 'AMZN',     category: 'stock'  },
  { key: 'NFLX',   label: 'NFLX',     category: 'stock'  },
  { key: 'GOOGL',  label: 'GOOGL',    category: 'stock'  },
];

const CATEGORY_COLOR: Record<string, string> = {
  crypto: 'text-purple-400',
  forex:  'text-blue-400',
  metal:  'text-yellow-400',
  stock:  'text-emerald-400',
};

function fmt(price: number, key: string): string {
  if (key === 'JPY')   return price.toFixed(4);
  // High-priced majors: show extra decimals so sub‑$1 moves are visible (2dp looked “frozen”).
  if (['BTC', 'ETH', 'BNB'].includes(key) && price >= 1000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  if (price >= 10000)  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1000)   return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1)      return price.toFixed(4);
  return price.toFixed(6);
}

export const PriceTicker: React.FC = () => {
  const assetPrices = useStore(state => state.assetPrices);

  // Track previous price per key to compute direction
  const prevRef = useRef<Record<string, number>>({});
  const [dirs, setDirs] = useState<Record<string, 'up' | 'down' | 'flat'>>({});

  useEffect(() => {
    const newDirs: Record<string, 'up' | 'down' | 'flat'> = {};
    for (const item of TICKER_ITEMS) {
      const curr = assetPrices[item.key];
      const prev = prevRef.current[item.key];
      if (curr !== undefined && prev !== undefined) {
        newDirs[item.key] = curr > prev ? 'up' : curr < prev ? 'down' : 'flat';
      } else {
        newDirs[item.key] = 'flat';
      }
    }
    setDirs(newDirs);
    // snapshot current as prev for next tick
    for (const item of TICKER_ITEMS) {
      if (assetPrices[item.key] !== undefined) {
        prevRef.current[item.key] = assetPrices[item.key];
      }
    }
  }, [assetPrices]);

  const items = TICKER_ITEMS.filter(item => assetPrices[item.key] !== undefined && assetPrices[item.key] > 0);

  if (items.length === 0) {
    return (
      <div className="h-8 bg-black/80 border-b border-white/5 flex items-center overflow-hidden shrink-0">
        <div className="flex gap-6 px-4 animate-pulse">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-3 bg-white/10 rounded w-28" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-8 bg-black/90 border-b border-white/5 flex items-center overflow-hidden select-none relative shrink-0">
      {/* Edge fades */}
      <div className="absolute left-0 top-0 h-full w-16 bg-gradient-to-r from-black/90 to-transparent z-10 pointer-events-none" />
      <div className="absolute right-0 top-0 h-full w-16 bg-gradient-to-l from-black/90 to-transparent z-10 pointer-events-none" />

      {/* Duplicated track for seamless loop */}
      <div className="ticker-scroll-track flex items-center whitespace-nowrap">
        {[0, 1].map(copy => (
          <div key={copy} className="flex items-center shrink-0" aria-hidden={copy === 1}>
            {items.map(item => {
              const price  = assetPrices[item.key];
              const dir    = dirs[item.key] ?? 'flat';
              const priceColor =
                dir === 'up'   ? 'text-emerald-400' :
                dir === 'down' ? 'text-rose-400'    : 'text-white/75';
              const arrow =
                dir === 'up'   ? ' ▲' :
                dir === 'down' ? ' ▼' : '';

              return (
                <span
                  key={item.key}
                  className="inline-flex items-center gap-2 px-4 border-r border-white/5 last:border-r-0"
                >
                  <span className={`text-[10px] font-bold tracking-widest uppercase ${CATEGORY_COLOR[item.category]}`}>
                    {item.label}
                  </span>
                  <span className={`text-[11px] font-mono font-semibold tabular-nums ${priceColor}`}>
                    ${fmt(price, item.key)}{arrow}
                  </span>
                </span>
              );
            })}

            {/* Separator between copies */}
            <span className="px-6 text-white/10 text-xs">◆</span>
          </div>
        ))}
      </div>

      <style jsx>{`
        .ticker-scroll-track {
          will-change: transform;
          -webkit-animation: ticker-run 55s linear infinite;
          animation: ticker-run 55s linear infinite;
        }
        .ticker-scroll-track:hover {
          -webkit-animation-play-state: paused;
          animation-play-state: paused;
        }
        @media (prefers-reduced-motion: reduce) {
          .ticker-scroll-track {
            -webkit-animation: none;
            animation: none;
          }
        }
        @-webkit-keyframes ticker-run {
          0% {
            -webkit-transform: translate3d(0, 0, 0);
          }
          100% {
            -webkit-transform: translate3d(-50%, 0, 0);
          }
        }
        @keyframes ticker-run {
          0% {
            transform: translate3d(0, 0, 0);
          }
          100% {
            transform: translate3d(-50%, 0, 0);
          }
        }
      `}</style>
    </div>
  );
};
