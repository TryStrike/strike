'use client';

import React, { useCallback, useLayoutEffect, useMemo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { line, curveMonotoneX } from 'd3-shape';
import { useStore } from '@/lib/store';
import { resolveHouseLedgerCurrency } from '@/lib/balance/houseLedgerCurrency';
import { AssetType } from '@/lib/utils/priceFeed';
import { motion, AnimatePresence } from 'framer-motion';
import { playWinSound, playLoseSound } from '@/lib/utils/sounds';
import { useToast } from '@/lib/hooks/useToast';
import { CaretDown, X, MagnifyingGlass, Star, TrendUp, Waveform, ArrowsDownUp, Pulse } from '@phosphor-icons/react';


/** React refresh rate for the chart; motion between renders runs at full frame rate. */
const RENDER_MS = 100;
/** How fast the tip catches up to a new tick. */
const TIP_EASE_MS = 90;
const OVERLAY = 'bg-white rounded-2xl ring-1 ring-line shadow-xl font-tight';

interface LiveChartProps {
  betAmount: string;
}

// Track which cells have active bets
interface CellBet {
  cellId: string;
  betId: string;
  amount: number;
  multiplier: number;
  direction: 'UP' | 'DOWN';
}

// Component to safely display asset logos with fallback
const ASSET_CONFIG: Record<AssetType, { name: string; symbol: string; pair: string; logo: string; category: 'Crypto' | 'Metals' | 'Forex' | 'Stocks' | 'Commodities'; decimals: number }> = {
  BTC: { name: 'Bitcoin', symbol: 'BTC', pair: 'BTC/USD', logo: '/logos/bitcoin-btc-logo.png', category: 'Crypto', decimals: 2 },
  ETH: { name: 'Ethereum', symbol: 'ETH', pair: 'ETH/USD', logo: '/logos/ethereum-eth-logo.png', category: 'Crypto', decimals: 2 },
  SOL: { name: 'Solana', symbol: 'SOL', pair: 'SOL/USD', logo: '/logos/solana-sol-logo.png', category: 'Crypto', decimals: 2 },
  SUI: { name: 'Sui', symbol: 'SUI', pair: 'SUI/USD', logo: '/logos/sui-logo.png', category: 'Crypto', decimals: 3 },
  TRX: { name: 'Tron', symbol: 'TRX', pair: 'TRX/USD', logo: '/logos/tron-trx-logo.png', category: 'Crypto', decimals: 4 },
  XRP: { name: 'Ripple', symbol: 'XRP', pair: 'XRP/USD', logo: '/logos/xrp-xrp-logo.png', category: 'Crypto', decimals: 4 },
  DOGE: { name: 'Dogecoin', symbol: 'DOGE', pair: 'DOGE/USD', logo: '/logos/dogecoin-doge-logo.png', category: 'Crypto', decimals: 5 },
  ADA: { name: 'Cardano', symbol: 'ADA', pair: 'ADA/USD', logo: '/logos/cardano-ada-logo.png', category: 'Crypto', decimals: 4 },
  BCH: { name: 'Bitcoin Cash', symbol: 'BCH', pair: 'BCH/USD', logo: '/logos/bitcoin-cash-bch-logo.png', category: 'Crypto', decimals: 2 },
  BNB: { name: 'Binance Coin', symbol: 'BNB', pair: 'BNB/USD', logo: '/logos/bnb-bnb-logo.png', category: 'Crypto', decimals: 2 },
  XLM: { name: 'Stellar', symbol: 'XLM', pair: 'XLM/USD', logo: '/logos/stellar-xlm-logo.png', category: 'Crypto', decimals: 4 },
  XTZ: { name: 'Tezos', symbol: 'XTZ', pair: 'XTZ/USD', logo: '/logos/tezos-xtz-logo.png', category: 'Crypto', decimals: 3 },
  NEAR: { name: 'Near Protocol', symbol: 'NEAR', pair: 'NEAR/USD', logo: '/logos/near.png', category: 'Crypto', decimals: 3 },
  APT: { name: 'Aptos', symbol: 'APT', pair: 'APT/USD', logo: '/logos/aptos-logo.png', category: 'Crypto', decimals: 2 },
  
  // Metals
  GOLD: { name: 'Gold', symbol: 'GOLD', pair: 'XAU/USD', logo: '/logos/gold.jpg', category: 'Metals', decimals: 2 },
  SILVER: { name: 'Silver', symbol: 'SILVER', pair: 'XAG/USD', logo: '/logos/silver.avif', category: 'Metals', decimals: 3 },
  
  // Forex
  EUR: { name: 'Euro', symbol: 'EUR', pair: 'EUR/USD', logo: '/logos/euro.png', category: 'Forex', decimals: 4 },
  GBP: { name: 'British Pound', symbol: 'GBP', pair: 'GBP/USD', logo: '/logos/uk.png', category: 'Forex', decimals: 4 },
  JPY: { name: 'Japanese Yen', symbol: 'JPY', pair: 'USD/JPY', logo: '/logos/japan.jpg', category: 'Forex', decimals: 2 },
  AUD: { name: 'Australian Dollar', symbol: 'AUD', pair: 'AUD/USD', logo: '/logos/australia.png', category: 'Forex', decimals: 4 },
  CAD: { name: 'Canadian Dollar', symbol: 'CAD', pair: 'USD/CAD', logo: '/logos/canada.png', category: 'Forex', decimals: 4 },
  
  // Stocks
  AAPL: { name: 'Apple Inc.', symbol: 'AAPL', pair: 'AAPL/USD', logo: '/logos/stock-AAPL-logo.png', category: 'Stocks', decimals: 2 },
  GOOGL: { name: 'Alphabet Inc.', symbol: 'GOOGL', pair: 'GOOGL/USD', logo: '/logos/stock-GOOGL-logo.png', category: 'Stocks', decimals: 2 },
  AMZN: { name: 'Amazon.com', symbol: 'AMZN', pair: 'AMZN/USD', logo: '/logos/stock-AMZN-logo.png', category: 'Stocks', decimals: 2 },
  MSFT: { name: 'Microsoft', symbol: 'MSFT', pair: 'MSFT/USD', logo: '/logos/stock-MSFT-logo.png', category: 'Stocks', decimals: 2 },
  NVDA: { name: 'NVIDIA', symbol: 'NVDA', pair: 'NVDA/USD', logo: '/logos/stock-NVDA-logo.png', category: 'Stocks', decimals: 2 },
  TSLA: { name: 'Tesla Inc.', symbol: 'TSLA', pair: 'TSLA/USD', logo: '/logos/stock-TSLA-logo.png', category: 'Stocks', decimals: 2 },
  META: { name: 'Meta Platforms', symbol: 'META', pair: 'META/USD', logo: '/logos/stock-META-logo.png', category: 'Stocks', decimals: 2 },
  NFLX: { name: 'Netflix', symbol: 'NFLX', pair: 'NFLX/USD', logo: '/logos/stock-NFLX-logo.png', category: 'Stocks', decimals: 2 },
  AMD: { name: 'AMD', symbol: 'AMD', pair: 'AMD/USD', logo: '/logos/stock-AMD-logo.png', category: 'Stocks', decimals: 2 },
  BABA: { name: 'Alibaba', symbol: 'BABA', pair: 'BABA/USD', logo: '/logos/stock-BABA-logo.png', category: 'Stocks', decimals: 2 },
  DIS: { name: 'Walt Disney', symbol: 'DIS', pair: 'DIS/USD', logo: '/logos/stock-DIS-logo.png', category: 'Stocks', decimals: 2 },
  JPM: { name: 'JP Morgan', symbol: 'JPM', pair: 'JPM/USD', logo: '/logos/stock-JPM-logo.png', category: 'Stocks', decimals: 2 },
  V: { name: 'Visa Inc.', symbol: 'V', pair: 'V/USD', logo: '/logos/stock-V-logo.png', category: 'Stocks', decimals: 2 },
  MA: { name: 'Mastercard', symbol: 'MA', pair: 'MA/USD', logo: '/logos/stock-MA-logo.png', category: 'Stocks', decimals: 2 },
  PYPL: { name: 'PayPal', symbol: 'PYPL', pair: 'PYPL/USD', logo: '/logos/stock-PYPL-logo.png', category: 'Stocks', decimals: 2 },
  COIN: { name: 'Coinbase', symbol: 'COIN', pair: 'COIN/USD', logo: '/logos/stock-COIN-logo.png', category: 'Stocks', decimals: 2 },
  MSTR: { name: 'MicroStrategy', symbol: 'MSTR', pair: 'MSTR/USD', logo: '/logos/stock-MSTR-logo.png', category: 'Stocks', decimals: 2 },
  UBER: { name: 'Uber Tech', symbol: 'UBER', pair: 'UBER/USD', logo: '/logos/stock-UBER-logo.png', category: 'Stocks', decimals: 2 },
  PLTR: { name: 'Palantir', symbol: 'PLTR', pair: 'PLTR/USD', logo: '/logos/stock-PLTR-logo.png', category: 'Stocks', decimals: 2 },
  CRM: { name: 'Salesforce', symbol: 'CRM', pair: 'CRM/USD', logo: '/logos/stock-CRM-logo.png', category: 'Stocks', decimals: 2 },
  INTC: { name: 'Intel', symbol: 'INTC', pair: 'INTC/USD', logo: '/logos/stock-INTC-logo.png', category: 'Stocks', decimals: 2 },
  TSM: { name: 'TSMC', symbol: 'TSM', pair: 'TSM/USD', logo: '/logos/stock-TSM-logo.png', category: 'Stocks', decimals: 2 },
  SPX: { name: 'S&P 500', symbol: 'SPX', pair: 'SPX/USD', logo: '/logos/stock-SPX-logo.png', category: 'Stocks', decimals: 2 },
  NDX: { name: 'Nasdaq 100', symbol: 'NDX', pair: 'NDX/USD', logo: '/logos/stock-NDX-logo.png', category: 'Stocks', decimals: 2 },
  DJI: { name: 'Dow Jones', symbol: 'DJI', pair: 'DJI/USD', logo: '/logos/stock-DJI-logo.png', category: 'Stocks', decimals: 2 },
  
  // Custom

  // Added Assets — all using local files, no external CDN dependencies
  LINK: { name: 'Chainlink', symbol: 'LINK', pair: 'LINK/USD', logo: '/logos/chainlink-link-logo.png', category: 'Crypto', decimals: 3 },
  AVAX: { name: 'Avalanche', symbol: 'AVAX', pair: 'AVAX/USD', logo: '/logos/avalanche-avax-logo.png', category: 'Crypto', decimals: 2 },
  DOT: { name: 'Polkadot', symbol: 'DOT', pair: 'DOT/USD', logo: '/logos/polkadot-dot-logo.png', category: 'Crypto', decimals: 2 },
  LTC: { name: 'Litecoin', symbol: 'LTC', pair: 'LTC/USD', logo: '/logos/litecoin-ltc-logo.png', category: 'Crypto', decimals: 2 },
  UNI: { name: 'Uniswap', symbol: 'UNI', pair: 'UNI/USD', logo: '/logos/uniswap-uni-logo.png', category: 'Crypto', decimals: 2 },
  PEPE: { name: 'Pepe', symbol: 'PEPE', pair: 'PEPE/USD', logo: '/logos/pepe-logo.png', category: 'Crypto', decimals: 8 },
  SHIB: { name: 'Shiba Inu', symbol: 'SHIB', pair: 'SHIB/USD', logo: '/logos/shiba-inu-shib-logo.png', category: 'Crypto', decimals: 8 },
  ATOM: { name: 'Cosmos', symbol: 'ATOM', pair: 'ATOM/USD', logo: '/logos/cosmos-atom-logo.png', category: 'Crypto', decimals: 2 },
  RENDER: { name: 'Render', symbol: 'RENDER', pair: 'RENDER/USD', logo: '/logos/render-rndr-logo.png', category: 'Crypto', decimals: 2 },
  TAO: { name: 'Bittensor', symbol: 'TAO', pair: 'TAO/USD', logo: '/logos/bittensor-tao-logo.png', category: 'Crypto', decimals: 2 },
  INJ: { name: 'Injective', symbol: 'INJ', pair: 'INJ/USD', logo: '/logos/injective-inj-logo.png', category: 'Crypto', decimals: 2 },
  KAS: { name: 'Kaspa', symbol: 'KAS', pair: 'KAS/USD', logo: '/logos/kaspa-kas-logo.png', category: 'Crypto', decimals: 4 },
  FET: { name: 'Fetch.ai', symbol: 'FET', pair: 'FET/USD', logo: '/logos/artificial-superintelligence-alliance-fet-logo.png', category: 'Crypto', decimals: 3 },
  FIL: { name: 'Filecoin', symbol: 'FIL', pair: 'FIL/USD', logo: '/logos/filecoin-fil-logo.png', category: 'Crypto', decimals: 2 },
  AR: { name: 'Arweave', symbol: 'AR', pair: 'AR/USD', logo: '/logos/arweave-ar-logo.png', category: 'Crypto', decimals: 2 },
  STX: { name: 'Stacks', symbol: 'STX', pair: 'STX/USD', logo: '/logos/stacks-stx-logo.png', category: 'Crypto', decimals: 2 },
  HBAR: { name: 'Hedera', symbol: 'HBAR', pair: 'HBAR/USD', logo: '/logos/hedera-hbar-logo.png', category: 'Crypto', decimals: 4 },
  ICP: { name: 'Internet Computer', symbol: 'ICP', pair: 'ICP/USD', logo: '/logos/internet-computer-icp-logo.png', category: 'Crypto', decimals: 2 },
  VET: { name: 'VeChain', symbol: 'VET', pair: 'VET/USD', logo: '/logos/vechain-vet-logo.png', category: 'Crypto', decimals: 4 },
  OP: { name: 'Optimism', symbol: 'OP', pair: 'OP/USD', logo: '/logos/optimism-ethereum-op-logo.png', category: 'Crypto', decimals: 3 },
  BONK: { name: 'Bonk', symbol: 'BONK', pair: 'BONK/USD', logo: '/logos/bonk-logo.png', category: 'Crypto', decimals: 8 },
  ARB: { name: 'Arbitrum', symbol: 'ARB', pair: 'ARB/USD', logo: '/logos/arbitrum-arb-logo.png', category: 'Crypto', decimals: 3 },
  SNX: { name: 'Synthetix', symbol: 'SNX', pair: 'SNX/USD', logo: '/logos/synthetix-snx-logo.png', category: 'Crypto', decimals: 2 },
  AAVE: { name: 'Aave', symbol: 'AAVE', pair: 'AAVE/USD', logo: '/logos/aave-logo.png', category: 'Crypto', decimals: 2 },
  GRT: { name: 'The Graph', symbol: 'GRT', pair: 'GRT/USD', logo: '/logos/the-graph-grt-logo.png', category: 'Crypto', decimals: 4 },
  THETA: { name: 'Theta Network', symbol: 'THETA', pair: 'THETA/USD', logo: '/logos/theta-network-theta-logo.png', category: 'Crypto', decimals: 3 },
  ALGO: { name: 'Algorand', symbol: 'ALGO', pair: 'ALGO/USD', logo: '/logos/algorand-algo-logo.png', category: 'Crypto', decimals: 4 },
  EGLD: { name: 'MultiversX', symbol: 'EGLD', pair: 'EGLD/USD', logo: '/logos/multiversx-egld-egld-logo.png', category: 'Crypto', decimals: 2 },
  FLOW: { name: 'Flow', symbol: 'FLOW', pair: 'FLOW/USD', logo: '/logos/flow-logo.png', category: 'Crypto', decimals: 3 },
  
  // Commodities
  WTI: { name: 'Crude Oil WTI', symbol: 'WTI', pair: 'WTI/USD', logo: 'OIL', category: 'Commodities', decimals: 2 },
  BRENT: { name: 'Crude Oil Brent', symbol: 'BRENT', pair: 'BRENT/USD', logo: 'OIL', category: 'Commodities', decimals: 2 },
};


// Stock logo sources with fallback order
const LOGO_SOURCES = {
  // Clearbit API (primary - high quality company logos)
  CLEARBIT: (domain: string) => `https://logo.clearbit.com/${domain}`,
  
  // Google Favicon service (reliable fallback)
  GOOGLE: (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
  
  // CoinCap CDN (Very stable for crypto)
  COINCAP: (symbol: string) => `https://assets.coincap.io/assets/icons/${symbol.toLowerCase()}@2x.png`,

  // Binance CDN
  BINANCE: (symbol: string) => `https://bin.bnbstatic.com/static/images/coins/icon/${symbol.toLowerCase()}.png`,

  // Local logos
  LOCAL: (symbol: string) => `/logos/${symbol.toLowerCase()}.png`,
};

// Enhanced stock domain mapping
const STOCK_DOMAIN_MAP: Record<string, string> = {
  // Individual Stocks
  AAPL: 'apple.com',
  GOOGL: 'abc.xyz',
  AMZN: 'amazon.com',
  MSFT: 'microsoft.com',
  NVDA: 'nvidia.com',
  TSLA: 'tesla.com',
  META: 'meta.com',
  NFLX: 'netflix.com',
  AMD: 'amd.com',
  BABA: 'alibaba.com',
  DIS: 'disney.com',
  JPM: 'jpmorgan.com',
  V: 'visa.com',
  MA: 'mastercard.com',
  PYPL: 'paypal.com',
  COIN: 'coinbase.com',
  MSTR: 'microstrategy.com',
  UBER: 'uber.com',
  PLTR: 'palantir.com',
  CRM: 'salesforce.com',
  INTC: 'intel.com',
  TSM: 'tsmc.com',
  
  // Market Indices
  SPX: 'spglobal.com',           // S&P 500 - managed by S&P Global
  NDX: 'nasdaq.com',             // NASDAQ 100 - managed by NASDAQ
  DJI: 'spglobal.com',           // Dow Jones - managed by S&P Global (CME Group also)
  VIX: 'spglobal.com',           // VIX Volatility Index
  DAX: 'deutsche-boerse.com',    // German DAX Index
  N225: 'nikkei.com',            // Nikkei 225
  HSI: 'hkex.com.hk',            // Hang Seng Index
  FTSE: 'ftserussell.com',       // FTSE 100
  CAC: 'euronext.com',           // CAC 40
};

// ── Y-domain math, pure ─────────────────────────────────────────────────────
// The "no jumping of graph on changing the token" rule: on an asset switch the
// domain SNAPS to the new asset's own data; it never lerps from the previous
// asset's domain, because two unrelated price domains have nothing to
// interpolate between. Within one asset the domain eases toward its target so
// the axis follows real moves smoothly.

export interface YDomainBounds {
  min: number;
  max: number;
}

/** Fit a domain to one asset's own visible points (padding + a zoom floor). */
export function computeYDomainTarget(
  points: readonly { price: number }[],
  price: number,
  tick: number,
  paddingFactor = 0.35,
): YDomainBounds {
  let low = price;
  let high = price;
  for (const p of points) {
    if (p.price < low) low = p.price;
    if (p.price > high) high = p.price;
  }
  const spread = high - low;
  const padding = spread > 0 ? spread * paddingFactor : Math.max(price * 0.0002, 1e-8);
  let min = low - padding;
  let max = high + padding;
  // Floor: 3 bps of price or 20 price ticks, whichever is wider. A one-tick bounce
  // must read as a wiggle, never as a full-height swing, and a box cell must span real ticks.
  const minSpan = Math.max(price * 0.0003, tick * 20);
  if (max - min < minSpan) {
    const mid = (max + min) / 2;
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
  }
  return { min, max };
}

/**
 * Next domain given the previous one and this frame's target. `assetChanged`
 * (or a missing previous) snaps to the target; otherwise ease by `lerpFactor`.
 */
export function nextYDomain(
  prev: YDomainBounds | null,
  target: YDomainBounds,
  assetChanged: boolean,
  lerpFactor = 0.25,
): YDomainBounds {
  if (!prev || assetChanged) return { min: target.min, max: target.max };
  return {
    min: prev.min + (target.min - prev.min) * lerpFactor,
    max: prev.max + (target.max - prev.max) * lerpFactor,
  };
}

// Component to safely display asset logos with multiple fallback sources
const AssetIcon = ({ src, asset, className }: { src: string; asset: string; className: string }) => {

  const [currentSrc, setCurrentSrc] = useState(src);
  const [attemptIndex, setAttemptIndex] = useState(0);
  const [showFallback, setShowFallback] = useState(false);

  // Reset state when asset or src changes
  useEffect(() => {
    setCurrentSrc(src);
    setAttemptIndex(0);
    setShowFallback(false);
  }, [src, asset]);

  // Generate all possible logo sources for this asset
  const getAllSources = (): string[] => {
    const sources: string[] = [];

    // 1. Original src (if not already a fallback)
    if (src && !src.includes('clearbit') && !src.includes('google.com')) {
      sources.push(src);
    }

    // 2. Crypto CDNs before Clearbit domain guesses — wrong guesses (e.g. apt.com for APT)
    //    often return a generic 200 image so onError never fires and the real logo is never tried.
    const cryptoMapping: Record<string, string> = {
      RENDER: 'rndr',
      EGLD: 'egld',
      KAS: 'kas',
    };
    const cryptoSymbol = cryptoMapping[asset] || asset;
    sources.push(LOGO_SOURCES.COINCAP(cryptoSymbol));
    sources.push(LOGO_SOURCES.BINANCE(cryptoSymbol));

    // 3. Clearbit + Google when we have a known company domain (stocks / indices)
    const domain = STOCK_DOMAIN_MAP[asset];
    if (domain) {
      sources.push(LOGO_SOURCES.CLEARBIT(domain));
      sources.push(LOGO_SOURCES.GOOGLE(domain));
    }

    // 4. Speculative domains last (stocks without a map entry; avoid intercepting crypto tickers above)
    if (!domain) {
      const variations = [
        `${asset.toLowerCase()}.com`,
        `${asset.toLowerCase()}.io`,
        `${asset.toLowerCase()}.co`,
        `${asset.toLowerCase()}.org`,
      ];
      variations.forEach((d) => {
        sources.push(LOGO_SOURCES.CLEARBIT(d));
        sources.push(LOGO_SOURCES.GOOGLE(d));
      });
    }

    // 5. Local filename convention
    sources.push(LOGO_SOURCES.LOCAL(asset));

    return sources;
  };

  const allSources = getAllSources();

  // Handle image load error - try next source
  const handleImageError = () => {
    const nextIndex = attemptIndex + 1;
    
    if (nextIndex < allSources.length) {
      // Try next source
      setCurrentSrc(allSources[nextIndex]);
      setAttemptIndex(nextIndex);
    } else {
      // All sources failed - show first letter fallback
      setShowFallback(true);
    }
  };

  // Show first letter as final fallback
  if (showFallback || allSources.length === 0) {
    return (
      <div className={`relative flex items-center justify-center w-full h-full ${className}`}>
        <span className="font-semibold text-sm text-ink">{asset[0]}</span>
      </div>
    );
  }

  // Special handling for different asset types
  const isMetal = asset === 'GOLD' || asset === 'SILVER';
  const isCommodity = ['WTI', 'BRENT'].includes(asset);
  const isNear = asset === 'NEAR';
  const isForex = ['EUR', 'GBP', 'JPY', 'AUD', 'CAD'].includes(asset);

  if (isCommodity) {
    const text = asset === 'WTI' || asset === 'BRENT' ? 'OIL' : asset;
    return (
      <div className={`relative flex items-center justify-center overflow-hidden w-full h-full rounded-full bg-surface ring-1 ring-line ${className}`}>
        <span className="font-jet font-semibold text-[9px] text-muted">{text}</span>
      </div>
    );
  }

  const finalImageClass = (isMetal || isForex)
    ? className.replace('object-contain', '').trim() + ' scale-[1.5] object-cover'
    : `${className} object-contain`;

  return (
    <div className={`relative flex items-center justify-center overflow-hidden w-full h-full rounded-full bg-white ring-1 ring-line ${isNear ? 'scale-90' : ''}`}>
      <img
        key={`${asset}-${attemptIndex}`}
        src={currentSrc}
        alt={asset}
        className={finalImageClass}
        onError={handleImageError}
      />
    </div>
  );
};

// Memoised: it animates on its own clock, so parent re-renders shouldn't redraw it.
export const LiveChart = React.memo(function LiveChart({ betAmount }: LiveChartProps) {
  const priceHistory = useStore((state) => state.priceHistory);
  const currentPrice = useStore((state) => state.currentPrice);
  const selectedAsset = useStore((state) => state.selectedAsset);
  const toast = useToast();
  const setSelectedAsset = useStore((state) => state.setSelectedAsset);
  const placeBetFromHouseBalance = useStore((state) => state.placeBetFromHouseBalance);
  const activeBets = useStore((state) => state.activeBets);
  const resolveBet = useStore((state) => state.resolveBet);
  const fetchBalance = useStore((state) => state.fetchBalance);
  const userAddress = useStore((state) => state.address);
  const houseBalance = useStore((state) => state.houseBalance);
  const isPlacingBet = useStore((state) => state.isPlacingBet);

  const gameMode = useStore((state) => state.gameMode);
  const timeframeSeconds = useStore((state) => state.timeframeSeconds);
  const isBlitzActive = useStore((state) => state.isBlitzActive);
  const hasBlitzAccess = useStore((state) => state.hasBlitzAccess);
  const blitzMultiplier = useStore((state) => state.blitzMultiplier);
  const lastResult = useStore((state) => state.lastResult);
  const selectedCurrency = useStore((state) => state.selectedCurrency);

  // The app-wide feed (app/providers.tsx) fills the store; this only reads its state for the badge.
  const { mode: feedMode, connected: streamLive } = useStore((state) => state.priceFeed);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [now, setNow] = useState(Date.now());
  // Display-only price for the chart tip: always the latest real tick (snapped, no easing).
  // Tagged with the asset it belongs to — after a token switch a stale tip from the
  // previous asset must never be drawn on the new domain (that read as a jump).
  // Settlement always uses the real store price.
  const [tip, setTip] = useState<{ asset: AssetType | null; price: number }>({ asset: null, price: 0 });
  const tipPrice = tip.asset === selectedAsset && tip.price > 0 ? tip.price : currentPrice;

  // Motion. React re-renders the chart at RENDER_MS; between renders every time-positioned
  // layer slides on a GPU transform at full frame rate, and the tip eases to each new tick.
  const nowRef = useRef(now);
  const ppsRef = useRef(0);
  const reducedRef = useRef(false);
  const tipPriceRef = useRef(tipPrice);
  const easedTipRef = useRef(0);
  const easedAssetRef = useRef(selectedAsset);
  const lastPointRef = useRef<{ timestamp: number; price: number } | null>(null);
  const tipGroupRef = useRef<SVGGElement>(null);
  const tailRef = useRef<SVGLineElement>(null);
  const scrollEls = useRef(new Set<HTMLElement | SVGElement>());
  const scrollLayer = useCallback((el: HTMLElement | SVGElement | null) => {
    if (!el) return;
    scrollEls.current.add(el);
    return () => {
      scrollEls.current.delete(el);
    };
  }, []);
  const [isAssetDropdownOpen, setIsAssetDropdownOpen] = useState(false);
  const assetSelectorRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  // Loading state for price feed
  const [isLoadingPrice, setIsLoadingPrice] = useState(true);

  // Track resolved (past) cells
  const resolvedDrawBetIdsRef = useRef<Set<string>>(new Set());

  // Local state for tracking cell bets
  const [cellBets, setCellBets] = useState<Map<string, CellBet>>(new Map());

  // --- Draw mode state ---
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);

  interface PendingDrawBox {
    x: number;
    y: number;
    width: number;
    height: number;
    priceTop: number;
    priceBottom: number;
    durationSeconds: number;
    multiplier: number;
    startTime: number;
  }
  const [pendingBox, setPendingBox] = useState<PendingDrawBox | null>(null);

  // Warning state for insufficient funds
  const [showInsufficientFunds, setShowInsufficientFunds] = useState(false);

  // Asset search and category filtering
  const [assetSearchQuery, setAssetSearchQuery] = useState('');
  const [watchlist, setWatchlist] = useState<AssetType[]>([]);
  const [activeAssetCategory, setActiveAssetCategory] = useState<'All' | 'Crypto' | 'Metals' | 'Forex' | 'Stocks' | 'Commodities'>('All');

  // Bet results for visual feedback
  interface BetResult {
    id: string;
    won: boolean;
    amount: number;
    payout: number;
    multiplier: number;
    timestamp: number;
    x: number;
    y: number;
  }
  const [betResults, setBetResults] = useState<BetResult[]>([]);
  
  const activeIndicators = useStore((state) => state.activeIndicators);
  const isIndicatorsOpen = useStore((state) => state.isIndicatorsOpen);
  const setIsIndicatorsOpen = useStore((state) => state.setIsIndicatorsOpen);
  const toggleIndicator = useStore((state) => state.toggleIndicator);

  // Bets settle in BOT or USDT; the chart labels whichever the player selected.
  const currencySymbol = useMemo(
    () => resolveHouseLedgerCurrency({ selectedCurrency }),
    [selectedCurrency]
  );

  const currentAssetConfig = ASSET_CONFIG[selectedAsset] || ASSET_CONFIG.BTC;

  // Filtered assets based on search and category
  const filteredAssets = useMemo(() => {
    return (Object.keys(ASSET_CONFIG) as AssetType[]).filter(assetId => {
      const asset = ASSET_CONFIG[assetId];
      const matchesSearch = asset.name.toLowerCase().includes(assetSearchQuery.toLowerCase()) ||
        asset.symbol.toLowerCase().includes(assetSearchQuery.toLowerCase()) ||
        asset.pair.toLowerCase().includes(assetSearchQuery.toLowerCase());

      const matchesCategory = activeAssetCategory === 'All' || asset.category === activeAssetCategory;

      return matchesSearch && matchesCategory;
    });
  }, [assetSearchQuery, activeAssetCategory]);


  // Stable Y-Axis Domain. Tagged with the asset it was computed for: when the
  // traded asset changes, the next scales computation SNAPS to the new asset's
  // own domain inside the render (before paint) — see nextYDomain. The old
  // asset's domain is never blended in.
  const yDomain = useRef<{ min: number; max: number } | null>(null);
  const yDomainAsset = useRef<AssetType | null>(null);

  // Asset switch: clear overlays and re-seed the tip from the new asset's own
  // data. `setSelectedAsset` updates selectedAsset, priceHistory and
  // currentPrice atomically, so this render already carries the new asset's
  // values; reading them from the closure (deps = selectedAsset only) is
  // intentional. The y-domain itself is re-seeded during the next scales
  // computation so no frame between render and effect can show a mixed domain.
  useEffect(() => {
    setBetResults([]); // Clear bet results
    setCellBets(new Map()); // Clear cell bets

    const lastPoint = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1] : null;
    const assetPrice = currentPrice > 0 ? currentPrice : (lastPoint?.price ?? 0);

    // Tip shows the new asset's own last value (or nothing), never the old
    // asset's eased tip.
    setTip({ asset: selectedAsset, price: assetPrice });

    // Show the loading overlay only when the new asset has no history to render yet.
    setIsLoadingPrice(priceHistory.length === 0 || assetPrice <= 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAsset]);

  // Box mode: map active bets onto grid cells so crossing / settlement runs (cellBets was never filled after placement).
  useEffect(() => {
    if (gameMode !== 'box') {
      setCellBets(new Map());
      return;
    }
    const next = new Map<string, CellBet>();
    for (const bet of activeBets as Array<{
      mode: string;
      status: string;
      cellId?: string;
      id: string;
      amount: number;
      multiplier: number;
      direction: 'UP' | 'DOWN';
      asset: AssetType;
    }>) {
      if (
        bet.mode === 'box' &&
        bet.status === 'active' &&
        bet.cellId &&
        bet.asset === selectedAsset
      ) {
        next.set(bet.cellId, {
          cellId: bet.cellId,
          betId: bet.id,
          amount: bet.amount,
          multiplier: bet.multiplier,
          direction: bet.direction,
        });
      }
    }
    setCellBets(next);
  }, [activeBets, gameMode, selectedAsset]);

  // Persisted watchlist for quick switching.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('strike_watchlist_assets');
      if (raw) {
        const parsed = JSON.parse(raw) as AssetType[];
        if (Array.isArray(parsed)) {
          const valid = new Set(Object.keys(ASSET_CONFIG) as AssetType[]);
          setWatchlist(parsed.filter((a): a is AssetType => valid.has(a)));
        }
      }
    } catch (e) {
      console.error('Failed to load watchlist', e);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('strike_watchlist_assets', JSON.stringify(watchlist));
    } catch (e) {
      console.error('Failed to save watchlist', e);
    }
  }, [watchlist]);

  const toggleWatchlist = (asset: AssetType) => {
    setWatchlist((prev) => prev.includes(asset) ? prev.filter((a) => a !== asset) : [...prev, asset]);
  };

  // Auto-remove bet results after 3 seconds
  useEffect(() => {
    if (betResults.length === 0) return;
    const interval = setInterval(() => {
      const nowTime = Date.now();
      setBetResults(prev => {
        const filtered = prev.filter((r: BetResult) => nowTime - r.timestamp < 3000);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [betResults.length]);

  // Hide loading when price data arrives
  useEffect(() => {
    if (currentPrice > 0 && priceHistory.length >= 2) {
      setIsLoadingPrice(false);
    }
  }, [currentPrice, priceHistory]);

  // Update dimensions
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight
        });
      }
    };
    updateDimensions();
    // The chart sits beside the trade panel, so its size changes without a window resize.
    const observer = new ResizeObserver(updateDimensions);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Reduced motion: no idle RAF loop. New ticks still render IMMEDIATELY —
  // the currentPrice effect below snaps the tip the moment a tick lands — and
  // the scrolling x-axis clock only needs a slow 1s heartbeat.
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setPrefersReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // The tip must show the LATEST real tick immediately (snap, no easing) in both modes.
  useEffect(() => {
    if (currentPrice > 0) setTip({ asset: selectedAsset, price: currentPrice });
  }, [currentPrice, selectedAsset]);

  // Feed stall detection for the dimmed-line treatment. Polled from getState()
  // rather than subscribed: lastTickAt changes every second and must not
  // rerender the chart.
  const [feedStalled, setFeedStalled] = useState(false);
  useEffect(() => {
    const check = () => {
      const t = useStore.getState().lastTickAt;
      setFeedStalled(t > 0 && Date.now() - t > 8000);
    };
    check();
    const id = setInterval(check, 2000);
    return () => clearInterval(id);
  }, []);

  // Feed state for the header badge: live = SSE ticks flowing, polling = the
  // 1s fallback owns the feed, stale = neither produced a fresh tick (the
  // same condition that dims the chart line).
  const feedState = feedStalled ? 'stale' : feedMode === 'stream' && streamLive ? 'live' : 'polling';

  // Writes the between-render motion straight to the DOM: no React work per frame.
  const applyMotion = useCallback((dt: number) => {
    const s = scalesRef.current;
    if (!s) return;
    const dx = reducedRef.current ? 0 : (-(Date.now() - nowRef.current) * ppsRef.current) / 1000;
    for (const el of scrollEls.current) {
      if (el instanceof SVGElement) el.setAttribute('transform', `translate(${dx},0)`);
      else el.style.transform = `translate3d(${dx}px,0,0)`;
    }
    const target = tipPriceRef.current;
    const eased = easedTipRef.current;
    easedTipRef.current =
      reducedRef.current || !eased || dt <= 0 ? target : eased + (target - eased) * (1 - Math.exp(-dt / TIP_EASE_MS));
    const y = s.yScale(easedTipRef.current);
    tipGroupRef.current?.setAttribute('transform', `translate(0,${y})`);
    const tail = tailRef.current;
    const last = lastPointRef.current;
    if (tail) {
      tail.setAttribute('x1', String(last ? s.xScale(last.timestamp) + dx : s.tipX));
      tail.setAttribute('y1', String(last ? s.yScale(last.price) : y));
      tail.setAttribute('x2', String(s.tipX));
      tail.setAttribute('y2', String(y));
    }
  }, []);

  useEffect(() => {
    reducedRef.current = prefersReducedMotion;
    if (prefersReducedMotion) {
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
    }
    let frameId = 0;
    let last = performance.now();
    let lastRender = Date.now();
    const animate = (t: number) => {
      const wall = Date.now();
      if (wall - lastRender >= RENDER_MS) {
        lastRender = wall;
        setNow(wall);
      }
      applyMotion(t - last);
      last = t;
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [prefersReducedMotion, applyMotion]);

  // Configuration - Responsive + Timeframe
  const isMobile = dimensions.width < 640;
  const historyWidthRatio = isMobile ? 0.35 : 0.50;
  const targetColWidthPx = isMobile ? 100 : 250;
  const gridInterval = ((gameMode === 'box' || gameMode === 'draw') ? timeframeSeconds : 30) * 1000; // ms per column
  const pixelsPerSecond = (gameMode === 'box' || gameMode === 'draw')
    ? Math.max(2, targetColWidthPx / (gridInterval / 1000))
    : (isMobile ? 35 : 50);

  // Scales
  const scales = useMemo(() => {
    if (dimensions.width === 0 || currentPrice === 0) return null;

    // Scale to what the price actually did, not to a fixed percentage of its
    // level. A flat +/-0.15% window on a 78,000 BTC is roughly 234 dollars
    // wide, while a second of real movement is about a dollar — so the line
    // sat dead flat no matter how much the market moved. Fitting the window to
    // the visible high and low makes real volatility fill the chart, and a
    // quiet market still reads as quiet because the line stays near the middle.
    // priceHistory timestamps are milliseconds, same clock as `now`.
    const windowMs = (dimensions.width / Math.max(pixelsPerSecond, 0.0001)) * 1000;
    const cutoff = now - windowMs;

    // Fit the domain to what THIS asset's price actually did inside the
    // visible window (headroom + zoom floor live in computeYDomainTarget, the
    // same function the switch re-seed uses).
    const visiblePoints: { price: number }[] = [];
    for (const point of priceHistory) {
      if (point.timestamp >= cutoff) visiblePoints.push(point);
    }
    let { min: targetMin, max: targetMax } = computeYDomainTarget(visiblePoints, currentPrice, 10 ** -currentAssetConfig.decimals);

    const mobileZoomFactor = isMobile ? 0.75 : 1.0;
    if (mobileZoomFactor !== 1) {
      const mid = (targetMax + targetMin) / 2;
      const half = ((targetMax - targetMin) / 2) * mobileZoomFactor;
      targetMin = mid - half;
      targetMax = mid + half;
    }

    // DYNAMIC Y-axis. Asset switch: snap to this asset's own domain — the
    // switch never lerps from the previous asset's prices (that interpolation
    // was the visible "jump on changing the token"). Same asset: ease toward
    // the target so the axis follows real moves without jarring steps.
    const assetChanged = yDomainAsset.current !== selectedAsset;
    if (assetChanged) yDomainAsset.current = selectedAsset;
    yDomain.current = nextYDomain(
      assetChanged ? null : yDomain.current,
      { min: targetMin, max: targetMax },
      assetChanged,
    );

    const { min: minY, max: maxY } = yDomain.current;

    const yScale = (price: number) => {
      return dimensions.height - ((price - minY) / (maxY - minY)) * dimensions.height;
    };

    const tipX = dimensions.width * historyWidthRatio;

    const xScale = (timestamp: number) => {
      const diffMs = timestamp - now;
      const diffSeconds = diffMs / 1000;
      return tipX + (diffSeconds * pixelsPerSecond);
    };

    return { yScale, xScale, tipX, minY, maxY };
  }, [dimensions, priceHistory, currentPrice, now, selectedAsset]);

  const scalesRef = useRef(scales);
  const currentPriceRef = useRef(currentPrice);

  // Same commit as the new positions, so a render never shows one frame of stale offset.
  useLayoutEffect(() => {
    scalesRef.current = scales;
    currentPriceRef.current = currentPrice;
    nowRef.current = now;
    ppsRef.current = pixelsPerSecond;
    tipPriceRef.current = tipPrice;
    // A new asset snaps; easing from the old asset's price would sweep across the chart.
    if (easedAssetRef.current !== selectedAsset) {
      easedAssetRef.current = selectedAsset;
      easedTipRef.current = 0;
    }
    applyMotion(0);
  });



  // --- Draw mode helpers ---
  const getRelativePos = (e: React.MouseEvent): { x: number; y: number } => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /**
   * Box geometry for a drag. Boxes live in the future, so a drag over the history side
   * keeps its width and height but is projected to start just past the price tip.
   */
  const drawBoxGeometry = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const tip = (scales?.tipX ?? 0) + 2;
    const width = Math.min(Math.abs(b.x - a.x), pixelsPerSecond * 20);
    const height = Math.min(Math.abs(b.y - a.y), dimensions.height * 0.2);
    const top = b.y >= a.y ? a.y : a.y - height;
    return { x: Math.max(Math.min(a.x, b.x), tip), y: top, width, height };
  };

  const handleDrawMouseDown = (e: React.MouseEvent) => {
    if (gameMode !== 'draw' || !scales || e.button !== 0) return;
    const pos = getRelativePos(e);

    setPendingBox(null);
    setDrawStart(pos);
    setDrawCurrent(pos);
    setIsDrawing(true);
    e.preventDefault();
  };

  const handleDrawMouseMove = (e: React.MouseEvent) => {
    if (gameMode !== 'draw' || !scales) return;
    if (!isDrawing || !drawStart) return;

    setDrawCurrent(getRelativePos(e));
  };

  const finalizeDrawBox = () => {
    if (!drawStart || !drawCurrent || !scales || dimensions.height === 0) {
      setIsDrawing(false);
      setDrawStart(null);
      setDrawCurrent(null);
      return;
    }

    setIsDrawing(false);

    const box = drawBoxGeometry(drawStart, drawCurrent);
    const minX = box.x;
    const maxX = box.x + box.width;
    const minY = box.y;
    const maxY = box.y + box.height;

    const minBoxHeightPx = 2;
    const maxBoxHeightPx = dimensions.height * 0.20;
    const minBoxWidthPx = pixelsPerSecond * 0.3;
    const maxBoxWidthPx = pixelsPerSecond * 20;

    if (maxX - minX < minBoxWidthPx || maxY - minY < minBoxHeightPx) {
      setDrawStart(null);
      setDrawCurrent(null);
      return;
    }

    const constrainedHeight = Math.min(maxY - minY, maxBoxHeightPx);
    const constrainedWidth = Math.min(maxX - minX, maxBoxWidthPx);

    const priceRange = scales.maxY - scales.minY;
    const priceTop = scales.minY + (1 - minY / dimensions.height) * priceRange;
    const priceBottom =
      scales.minY + (1 - (minY + constrainedHeight) / dimensions.height) * priceRange;

    const startOffsetSeconds = (minX - scales.tipX) / pixelsPerSecond;
    const durationSeconds = constrainedWidth / pixelsPerSecond;
    const startTime = Date.now() + startOffsetSeconds * 1000;

    const sizeRatio = constrainedHeight / dimensions.height;
    const priceInsideBox =
      currentPriceRef.current >= priceBottom && currentPriceRef.current <= priceTop;

    let multiplier: number;
    if (priceInsideBox) {
      multiplier = 1.01;
    } else {
      const distFromEdge = Math.min(
        Math.abs(currentPriceRef.current - priceTop),
        Math.abs(currentPriceRef.current - priceBottom)
      );
      const distNormalized = Math.min(distFromEdge / Math.max(priceRange, 0.0001), 1);
      const distFactor = Math.pow(distNormalized, 0.7) * 6;
      const sizeFactor = Math.min(1 / Math.max(sizeRatio * 15, 0.5), 2);
      const durationBonus = Math.min(durationSeconds / 60, 1) * 0.3;
      const rawMult = (1 + distFactor) * sizeFactor + durationBonus;
      multiplier = Math.max(1.02, Math.min(rawMult, 15));
    }

    setPendingBox({
      x: minX,
      y: minY,
      width: constrainedWidth,
      height: constrainedHeight,
      priceTop,
      priceBottom,
      durationSeconds,
      multiplier,
      startTime,
    });

    setDrawStart(null);
    setDrawCurrent(null);
  };

  const handleDrawMouseUp = () => {
    if (isDrawing) finalizeDrawBox();
  };

  const handleDrawMouseLeave = () => {
    if (isDrawing) finalizeDrawBox();
  };

  const handlePlaceDrawBet = async () => {
    if (!pendingBox || !userAddress || !betAmount) return;
    const requiredAmount = parseFloat(betAmount);
    if (isNaN(requiredAmount) || requiredAmount <= 0) return;

    const currentBalance = houseBalance || 0;
    if (currentBalance < requiredAmount) {
      setShowInsufficientFunds(true);
      setTimeout(() => setShowInsufficientFunds(false), 2000);
      setPendingBox(null);
      return;
    }

    const endTime = pendingBox.startTime + Math.round(pendingBox.durationSeconds) * 1000;
    const targetId = `UP-${pendingBox.multiplier}-${Math.round(pendingBox.durationSeconds)}`;

    try {
      await placeBetFromHouseBalance(
        betAmount,
        targetId,
        userAddress,
        undefined,
        {
          priceTop: pendingBox.priceTop,
          priceBottom: pendingBox.priceBottom,
          startTime: pendingBox.startTime,
          endTime,
        }
      );
    } catch (error) {
      console.error('Failed to place draw bet:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to place bet');
    } finally {
      setPendingBox(null);
    }
  };

  // Handle classic (binomo) mode bet results at the graph tip
  const lastProcessedResultRef = useRef<number>(0);
  useEffect(() => {
    if (lastResult && gameMode === 'binomo' && scales && lastResult.timestamp > lastProcessedResultRef.current) {
      lastProcessedResultRef.current = lastResult.timestamp;

      const multiplier = lastResult.amount > 0 ? lastResult.payout / lastResult.amount : 0;

      const result: BetResult = {
        id: `classic-${lastResult.timestamp}`,
        won: lastResult.won,
        amount: lastResult.amount,
        payout: lastResult.payout,
        multiplier: Number(multiplier.toFixed(2)),
        timestamp: Date.now(),
        x: scales.tipX,
        y: scales.yScale(currentPrice)
      };

      setBetResults(prev => [...prev, result]);

      // Play sound effects
      if (lastResult.won) {
        playWinSound();
      } else {
        playLoseSound();
      }
    }
  }, [lastResult, gameMode, scales, currentPrice, playWinSound, playLoseSound]);

  const chartPath = useMemo(() => {
    // Don't render if no scales or no price data yet
    if (!scales || currentPrice <= 0) return '';

    const pixelsPerSec = pixelsPerSecond;
    const thresholdMs = ((-100 - scales.tipX) / pixelsPerSec) * 1000;
    const minTimestamp = now + thresholdMs;

    // Filter points that are actually visible on screen to speed up rendering
    // Optimized: Calculate timestamp thresholds once instead of calling xScale for every point
    const visiblePoints = priceHistory.filter((p: any) => {
      return p.timestamp > minTimestamp && p.timestamp <= now + 1000; // Buffer for tip
    });


    // Ensure we have at least history or current point
    // Upstream feeds repeat the last price between real updates; keeping only the points
    // where the price actually changed lets the curve flow instead of stepping.
    const pointsToRender = visiblePoints.filter((p, i) => i === 0 || p.price !== visiblePoints[i - 1].price);

    // The path ends at the last real tick. The live tail from there to the eased tip dot
    // is drawn every frame by applyMotion.
    lastPointRef.current = pointsToRender.length > 0 ? pointsToRender[pointsToRender.length - 1] : null;
    if (pointsToRender.length < 2) return '';

    try {
      const lineGenerator = line<{ timestamp: number, price: number }>()
        .x((d) => scales.xScale(d.timestamp))
        .y((d) => scales.yScale(d.price))
        .curve(curveMonotoneX);

      return lineGenerator(pointsToRender) || '';
    } catch (err) {
      console.error("Chart line generation error:", err);
      return '';
    }
  }, [scales, priceHistory, currentPrice, now]);


  // TECHNICAL INDICATORS CALCULATION
  const indicatorPaths = useMemo(() => {
    if (!scales) return null;

    const paths: Record<string, any> = {};
    const points = [...priceHistory, { timestamp: now, price: currentPrice }];

    // 1. Moving Average (SMA 20)
    if (activeIndicators['ma'] && points.length >= 2) {
      const maPoints = [];
      const period = 20;
      for (let i = 1; i < points.length; i++) {
        const currentPeriod = Math.min(i + 1, period);
        const slice = points.slice(Math.max(0, i + 1 - currentPeriod), i + 1);
        const avg = slice.reduce((sum, p) => sum + p.price, 0) / slice.length;
        maPoints.push({ timestamp: points[i].timestamp, price: avg });
      }
      const lineGen = line<{ timestamp: number, price: number }>()
        .x(d => scales.xScale(d.timestamp))
        .y(d => scales.yScale(d.price))
        .curve(curveMonotoneX);
      paths.ma = lineGen(maPoints) || '';
    }

    // 2. Bollinger Bands (20, 2)
    if (activeIndicators['bollinger'] && points.length >= 2) {
      const topPoints = [];
      const bottomPoints = [];
      const midPoints = [];
      const period = 20;

      for (let i = 1; i < points.length; i++) {
        const currentPeriod = Math.min(i + 1, period);
        const slice = points.slice(Math.max(0, i + 1 - currentPeriod), i + 1).map(p => p.price);
        const avg = slice.reduce((a, b) => a + b, 0) / slice.length;

        let stdDev = 0;
        if (slice.length > 1) {
          stdDev = Math.sqrt(slice.map(x => Math.pow(x - avg, 2)).reduce((a, b) => a + b, 0) / slice.length);
        }

        topPoints.push({ timestamp: points[i].timestamp, price: avg + 2 * stdDev });
        bottomPoints.push({ timestamp: points[i].timestamp, price: avg - 2 * stdDev });
        midPoints.push({ timestamp: points[i].timestamp, price: avg });
      }

      const lineGen = line<{ timestamp: number, price: number }>()
        .x(d => scales.xScale(d.timestamp))
        .y(d => scales.yScale(d.price))
        .curve(curveMonotoneX);

      paths.bollinger = [
        lineGen(topPoints) || '',
        lineGen(bottomPoints) || '',
        lineGen(midPoints) || ''
      ];
    }

    // 3. Alligator
    if (activeIndicators['alligator'] && points.length >= 2) {
      const calculateDynamicSMA = (period: number) => {
        const sma = [];
        for (let i = 1; i < points.length; i++) {
          const currentPeriod = Math.min(i + 1, period);
          const slice = points.slice(Math.max(0, i + 1 - currentPeriod), i + 1);
          const avg = slice.reduce((sum, p) => sum + p.price, 0) / slice.length;
          sma.push({ timestamp: points[i].timestamp, price: avg });
        }
        return sma;
      };

      const lineGen = line<{ timestamp: number, price: number }>()
        .x(d => scales.xScale(d.timestamp))
        .y(d => scales.yScale(d.price))
        .curve(curveMonotoneX);

      paths.alligator = [
        lineGen(calculateDynamicSMA(13)) || '', // Jaw
        lineGen(calculateDynamicSMA(8)) || '',  // Teeth
        lineGen(calculateDynamicSMA(5)) || '',  // Lips
      ];
    }

    // 4. RSI (14) - Refined Wilder's Smoothing
    if (activeIndicators['rsi'] && points.length >= 2) {
      const rsiPoints = [];
      let avgGain = 0;
      let avgLoss = 0;
      const period = 14;

      for (let i = 1; i < points.length; i++) {
        const change = points[i].price - points[i - 1].price;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        if (i <= period) {
          avgGain += gain;
          avgLoss += loss;
          if (i === period) {
            avgGain /= period;
            avgLoss /= period;
            const rs = avgGain / (avgLoss || 0.00001);
            rsiPoints.push({ timestamp: points[i].timestamp, rsi: 100 - (100 / (1 + rs)) });
          } else {
            rsiPoints.push({ timestamp: points[i].timestamp, rsi: 50 });
          }
        } else {
          // Precise Wilder's Smoothing
          avgGain = (avgGain * (period - 1) + gain) / period;
          avgLoss = (avgLoss * (period - 1) + loss) / period;
          const rs = avgGain / (avgLoss || 0.00001);
          const rsiValue = 100 - (100 / (1 + rs));
          rsiPoints.push({ timestamp: points[i].timestamp, rsi: rsiValue });
        }
      }
      paths.rsi = rsiPoints;
    }


    return paths;
  }, [scales, priceHistory, now, currentPrice, activeIndicators]);

  // Continuous Grid Generation
  // Cells are now positioned based on PRICE LEVELS, not fixed pixels
  const betCells = useMemo(() => {
    if (!scales || dimensions.height === 0) return [];

    const cells = [];
    const colWidth = (gridInterval / 1000) * pixelsPerSecond;

    // Calculate a stable price step based on the current range to ensure the grid "slides" correctly
    const rawStep = (scales.maxY - scales.minY) / 10;
    // Safety check: rawStep must be positive and meaningful
    if (isNaN(rawStep) || rawStep <= 0) return [];
    
    // Snap to "nice" numbers (e.g., 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100...)
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalized = rawStep / magnitude;
    let priceStep;
    if (normalized < 1.5) priceStep = 1 * magnitude;
    else if (normalized < 3) priceStep = 2 * magnitude;
    else if (normalized < 7) priceStep = 5 * magnitude;
    else priceStep = 10 * magnitude;


    // Calculate visible price range with buffer (0.8x viewport)
    const viewPadding = (scales.maxY - scales.minY) * 0.8;


    const gridMaxY = scales.maxY + viewPadding;
    const gridMinY = scales.minY - viewPadding;

    // Stable snap points
    const startPrice = Math.floor(gridMaxY / priceStep) * priceStep;
    const endPrice = Math.ceil(gridMinY / priceStep) * priceStep;

    const priceRange = scales.maxY - scales.minY;

    // Time-based generation for stable keys
    const startTime = Math.floor(now / gridInterval) * gridInterval - gridInterval;
    const endTime = now + ((dimensions.width - scales.tipX) / pixelsPerSecond) * 1000 + gridInterval * 2;

    for (let colTimestamp = startTime; colTimestamp <= endTime; colTimestamp += gridInterval) {
      const colX = scales.xScale(colTimestamp);

      if (colX + colWidth < 0) continue;
      if (colX > dimensions.width + 100) continue;

      const isCrossing = colX <= scales.tipX && colX + colWidth > scales.tipX;
      const isPast = colX + colWidth <= scales.tipX;


      // Loop through price levels
      for (let rowPriceTop = startPrice; rowPriceTop >= endPrice; rowPriceTop -= priceStep) {
        const rowPriceBottom = rowPriceTop - priceStep;
        const rowPriceCenter = (rowPriceTop + rowPriceBottom) / 2;
        const priceLevelIndex = Math.round(rowPriceTop / priceStep);

        const y = scales.yScale(rowPriceTop);

        const cellBottom = scales.yScale(rowPriceBottom);
        const rowHeight = cellBottom - y;

        // Skip if completely off screen vertically to save performance
        if (y > dimensions.height + 50 || cellBottom < -50) continue;

        // Determine win/loss for cells crossing or past
        let status: 'future' | 'active' | 'won' | 'lost' = 'future';

        if (isCrossing) {
          if (currentPrice <= rowPriceTop && currentPrice >= rowPriceBottom) {
            status = 'won';
          } else {
            status = 'active';
          }
        } else if (isPast) {
          status = 'lost';
        }


        const isUp = rowPriceCenter > currentPrice;
        const priceInRow = currentPrice <= rowPriceTop && currentPrice >= rowPriceBottom;

        let baseMultiplier: number;
        if (priceInRow) {
          baseMultiplier = 1.01;
        } else {
          // Distance from CURRENT PRICE in price terms
          const priceDist = Math.abs(rowPriceCenter - currentPrice);
          const normalizedDist = Math.min(priceDist / (priceRange * 0.8), 1);
          baseMultiplier = 1.05 + Math.pow(normalizedDist, 1.3) * 3.95;
        }

        const timeBonus = Math.max(0, (colX - scales.tipX) / 800) * 0.25;
        let calculatedMultiplier = Math.min(baseMultiplier + timeBonus, 10.0);

        // BLITZ MODE BOOST (x2 Multiplier) - Reduced density as requested
        const colIndex = Math.floor(colTimestamp / gridInterval);
        const isHighStake = baseMultiplier > 2.2; // Only very high risk cells
        const isLuckyDiagonal = (priceLevelIndex + colIndex) % 5 === 0; // Less frequent (1 in 5 instead of 1 in 3)
        const isBlitzBoosted = isBlitzActive && hasBlitzAccess && (isHighStake || isLuckyDiagonal);



        if (isBlitzBoosted) {
          calculatedMultiplier = calculatedMultiplier * blitzMultiplier;
        }

        const multiplier = Math.min(calculatedMultiplier, 20).toFixed(2);

        // Visual properties
        const distFromCenter = Math.abs(rowPriceCenter - currentPrice) / priceRange;
        const intensity = Math.min(distFromCenter * 1.5, 1);

        // Orange hue for Blitz, Purple otherwise
        const hue = isBlitzBoosted ? 25 : 270;
        const saturation = isBlitzBoosted ? 80 + intensity * 15 : 50 + intensity * 30;
        const lightness = isBlitzBoosted ? 55 : 45;
        const alpha = isBlitzBoosted ? 0.5 - intensity * 0.2 : 0.4 - intensity * 0.35;

        const cellColor = `hsla(${hue}, ${saturation}%, ${lightness}%, ${Math.max(0.05, alpha)})`;
        const borderColor = isBlitzBoosted
          ? `hsla(${hue}, 90%, 60%, ${0.7 - intensity * 0.3})`
          : `hsla(${hue}, 70%, 55%, ${Math.max(0.1, 0.5 - intensity * 0.4)})`;

        cells.push({
          id: `cell-${colTimestamp}-${priceLevelIndex}`,
          colTimestamp,
          x: colX,
          y,
          // Flush cells: neighbours share a hairline instead of leaving a gutter.
          width: colWidth,
          height: Math.max(rowHeight, 5),
          multiplier,
          isUp,
          status,
          color: cellColor,
          borderColor: borderColor,
          priceTop: rowPriceTop,
          priceBottom: rowPriceBottom,
          isBlitzBoosted
        });
      }
    }

    return cells;
  }, [scales, currentPrice, dimensions, gameMode, timeframeSeconds, selectedAsset, isBlitzActive, hasBlitzAccess, blitzMultiplier]);




  // Handle bet resolution when chart crosses cells with active bets
  useEffect(() => {
    if (!scales || cellBets.size === 0 || gameMode !== 'box') return;

    betCells.forEach((cell: any) => {
      const bet = cellBets.get(cell.id);
      if (!bet) return;

      // Check if this cell is being crossed or has been passed
      const isCrossing = cell.status === 'active' || cell.status === 'won' || cell.status === 'lost';

      if (isCrossing) {
        // Determine if bet won or lost based on current price
        const won = currentPrice <= cell.priceTop && currentPrice >= cell.priceBottom;
        const payout = won ? bet.amount * bet.multiplier : 0;

        // Remove from cellBets
        setCellBets(prev => {
          const newMap = new Map(prev);
          newMap.delete(cell.id);
          return newMap;
        });

        // Resolve the bet in the store
        resolveBet(bet.betId, won, payout);

        // Add bet result notification
        setBetResults(prev => [...prev, {
          id: `result-${bet.betId}`,
          won,
          amount: bet.amount,
          payout,
          multiplier: bet.multiplier,
          timestamp: Date.now(),
          x: cell.x,
          y: cell.y
        }]);

        // Play sound effect
        if (won) {
          playWinSound();
        } else {
          playLoseSound();
        }

        // Balance settlement is handled centrally by resolveBet in the store.
        // Avoid duplicate /api/balance/win calls from the chart layer.
        if (userAddress) {
          fetchBalance(userAddress);
        }

      }
    });
  }, [betCells, cellBets, scales, currentPrice, resolveBet, userAddress, fetchBalance, playWinSound, playLoseSound, gameMode]);

  // Draw mode settlement: resolve when `now >= endTime` and price stays inside [priceBottom, priceTop]
  useEffect(() => {
    if (!scales || gameMode !== 'draw') return;

    const drawBets = activeBets.filter((bet: any) =>
      bet.mode === 'draw' &&
      bet.asset === selectedAsset &&
      bet.status === 'active' &&
      typeof bet.endTime === 'number' &&
      typeof bet.priceTop === 'number' &&
      typeof bet.priceBottom === 'number'
    );

    drawBets.forEach((bet: any) => {
      if (now < bet.endTime) return;
      if (resolvedDrawBetIdsRef.current.has(bet.id)) return;
      resolvedDrawBetIdsRef.current.add(bet.id);
      setTimeout(() => resolvedDrawBetIdsRef.current.delete(bet.id), 5000);

      const won = currentPrice <= bet.priceTop && currentPrice >= bet.priceBottom;
      const payout = won ? bet.amount * bet.multiplier : 0;

      resolveBet(bet.id, won, payout);

      setBetResults(prev => [
        ...prev,
        {
          id: `draw-${bet.id}`,
          won,
          amount: bet.amount,
          payout,
          multiplier: bet.multiplier,
          timestamp: Date.now(),
          x: scales.tipX,
          y: (scales.yScale(bet.priceTop) + scales.yScale(bet.priceBottom)) / 2,
        },
      ]);

      if (won) playWinSound();
      else playLoseSound();
    });
  }, [scales, gameMode, activeBets, selectedAsset, now, currentPrice, resolveBet, playWinSound, playLoseSound]);

  return (
    <div ref={containerRef} className="absolute inset-0 z-0 bg-white font-tight text-ink overflow-hidden select-none">
      {/* Loading State */}
      {isLoadingPrice && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/80">
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 rounded-full border-2 border-line border-t-up animate-spin" />
            <div className="text-center">
              <p className="text-ink text-sm font-medium">Loading {currentAssetConfig.name}</p>
              <p className="text-subtle text-xs mt-0.5">Connecting to price feed…</p>
            </div>
          </div>
        </div>
      )}

      {/* Box Mode: Grid Cells layer */}
      {gameMode === 'box' && (
        <div className="absolute inset-0 z-5 overflow-hidden pointer-events-none">
          <div ref={scrollLayer} className="absolute inset-0 will-change-transform">
          {betCells.map((cell: any) => {
            // Visual styling based on status
            let opacity = 0.9;
            let canBet = cell.status === 'future';
            let tone = cell.isBlitzBoosted
              ? 'bg-down-soft border-down/30 text-down'
              : 'bg-white border-line text-faint';

            if (cell.status === 'won') {
              return (
                <div
                  key={cell.id}
                  className="absolute flex items-center justify-center bg-up pointer-events-none"
                  style={{ left: 0, top: 0, transform: `translate3d(${cell.x}px,${cell.y}px,0)`, width: cell.width, height: cell.height }}
                >
                  <span className="font-jet text-[10px] font-medium text-white">
                    {cell.multiplier}x
                  </span>
                </div>
              );
            } else if (cell.status === 'lost') {
              // Keep the slot so the grid never gets holes.
              return (
                <div
                  key={cell.id}
                  className="absolute border-b border-r border-line bg-white pointer-events-none"
                  style={{ left: 0, top: 0, transform: `translate3d(${cell.x}px,${cell.y}px,0)`, width: cell.width, height: cell.height }}
                />
              );
            } else if (cell.status === 'active') {
              opacity = 1;
              tone = 'bg-surface border-ink/15 text-subtle';
            }

            const handleClick = async () => {
              if (canBet && betAmount && userAddress) {
                const requiredAmount = parseFloat(betAmount);
                const currentBalance = houseBalance || 0;

                if (currentBalance < requiredAmount) {
                  setShowInsufficientFunds(true);
                  setTimeout(() => setShowInsufficientFunds(false), 2000);
                  return;
                }

                try {
                  const targetId = `${cell.isUp ? 'UP' : 'DOWN'}-${cell.multiplier}-${timeframeSeconds}`;

                  // House balance only — deduct via /api/balance/bet (no per-bet wallet signature).
                  // Users fund the treasury once via Deposit; stakes are not sent on-chain each click.
                  const result = await placeBetFromHouseBalance(
                    betAmount,
                    targetId,
                    userAddress,
                    cell.id,
                    // The server settles a cell at the moment the tip enters it.
                    {
                      priceTop: cell.priceTop,
                      priceBottom: cell.priceBottom,
                      startTime: cell.colTimestamp,
                      endTime: cell.colTimestamp,
                    },
                  );

                  if (result && result.bet) {
                    // cellBets will be automatically updated by the useEffect watching activeBets
                  }
                } catch (error) {
                  console.error('Failed to place box bet:', error);
                  toast.error(error instanceof Error ? error.message : 'Failed to place bet');
                }
              }
            };

            const hasBet = cellBets.has(cell.id);
            if (hasBet) {
              tone = 'bg-up-soft border-up/40 text-up';
            }

            return (
              <div
                key={cell.id}
                onClick={handleClick}
                className={`absolute border-b border-r flex items-center justify-center ${tone} ${canBet ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'}`}
                style={{
                  left: 0,
                  top: 0,
                  transform: `translate3d(${cell.x}px,${cell.y}px,0)`,
                  width: cell.width,
                  height: cell.height,
                  opacity
                }}
              >
                <div className="flex flex-col items-center justify-center h-full w-full pointer-events-none">
                  {hasBet ? (
                    <div className="flex flex-col items-center leading-none">
                      <span className="font-jet text-[13px] font-medium text-up">
                        {(parseFloat(cellBets.get(cell.id)?.amount as any || '0') * parseFloat(cellBets.get(cell.id)?.multiplier as any || '1')).toFixed(2)}
                        <span className="ml-1 text-[9px] text-up/70">{currencySymbol}</span>
                      </span>
                      <span className="font-jet text-[9px] text-up/70 mt-1">
                        {cellBets.get(cell.id)?.multiplier}x
                      </span>
                    </div>
                  ) : (
                    <span className="font-jet text-[10px]">
                      {cell.multiplier}x
                    </span>
                  )}
                </div>
              </div>
            );

          })}
          </div>
        </div>
      )}

      {/* Draw mode: interaction overlay + active draw rectangles */}
      {gameMode === 'draw' && scales && (
        <>
          {/* Mouse capture overlay (prevents placing new bets while confirming) */}
          <div
            className="absolute inset-0 z-30"
            style={{ cursor: 'crosshair', pointerEvents: pendingBox ? 'none' : 'auto' }}
            onMouseDown={handleDrawMouseDown}
            onMouseMove={handleDrawMouseMove}
            onMouseUp={handleDrawMouseUp}
            onMouseLeave={handleDrawMouseLeave}
          />

          {/* Preview while dragging */}
          {isDrawing && drawStart && drawCurrent && (
            <div
              className="absolute z-25 pointer-events-none"
              style={{
                left: drawBoxGeometry(drawStart, drawCurrent).x,
                top: drawBoxGeometry(drawStart, drawCurrent).y,
                width: drawBoxGeometry(drawStart, drawCurrent).width,
                height: drawBoxGeometry(drawStart, drawCurrent).height,
                border: '1px dashed var(--up)',
                backgroundColor: 'color-mix(in srgb, var(--up) 6%, transparent)',
                borderRadius: 6,
              }}
            />
          )}

          {/* Pending placement preview + confirm panel */}
          {pendingBox && !isDrawing && (
            <>
              <div
                className="absolute z-25 pointer-events-none"
                style={{
                  left: pendingBox.x,
                  top: pendingBox.y,
                  width: pendingBox.width,
                  height: pendingBox.height,
                  border: '1px dashed var(--up)',
                  backgroundColor: 'var(--up-soft)',
                  borderRadius: 6,
                }}
              />

              <div
                className="absolute z-[35]"
                style={{
                  left: Math.min(pendingBox.x + pendingBox.width + 10, Math.max(16, dimensions.width - 220)),
                  top: Math.max(10, pendingBox.y - 10),
                  width: 200,
                }}
              >
                <div className={`${OVERLAY} p-3`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="text-subtle text-[11px]">Multiplier</div>
                      <div className="font-jet text-ink text-sm">
                        {pendingBox.multiplier.toFixed(2)}x
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-subtle text-[11px]">Range</div>
                      <div className="font-jet text-ink text-[11px]">
                        {pendingBox.priceBottom.toFixed(4)} – {pendingBox.priceTop.toFixed(4)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 mb-3 pt-2 border-t border-line">
                    <div className="text-subtle text-[11px]">Payout</div>
                    <div className="font-jet text-up text-[13px]">
                      {(parseFloat(betAmount) * pendingBox.multiplier).toFixed(2)} {currencySymbol}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={handlePlaceDrawBet}
                      disabled={isPlacingBet || !userAddress}
                      className="flex-1 py-2 rounded-full bg-up hover:bg-up/90 text-white text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isPlacingBet ? 'Placing…' : `Bet ${betAmount} ${currencySymbol}`}
                    </button>
                    <button
                      onClick={() => setPendingBox(null)}
                      disabled={isPlacingBet}
                      className="py-2 px-3 rounded-full bg-white ring-1 ring-line hover:bg-surface text-muted text-xs font-medium disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Active draw bet rectangles */}
          <svg className="absolute inset-0 w-full h-full z-20 pointer-events-none" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}>
            <g ref={scrollLayer}>
            {activeBets
              .filter((bet: any) =>
                bet.mode === 'draw' &&
                bet.asset === selectedAsset &&
                bet.status === 'active' &&
                typeof bet.startTime === 'number' &&
                typeof bet.endTime === 'number' &&
                typeof bet.priceTop === 'number' &&
                typeof bet.priceBottom === 'number'
              )
              .map((bet: any) => {
                const bStartX = scales.xScale(bet.startTime);
                const bEndX = scales.xScale(bet.endTime);
                if (bEndX <= bStartX) return null;

                const clampedStartX = Math.max(scales.tipX, bStartX);
                const width = bEndX - clampedStartX;
                if (width <= 0) return null;

                const tY = scales.yScale(bet.priceTop);
                const bY = scales.yScale(bet.priceBottom);
                const height = bY - tY;
                if (height <= 0) return null;

                const isWinning = currentPrice <= bet.priceTop && currentPrice >= bet.priceBottom;
                const fill = isWinning ? 'var(--up-soft)' : 'color-mix(in srgb, var(--ink) 3%, transparent)';
                const stroke = isWinning ? 'var(--up)' : 'var(--faint)';

                return (
                  <g key={bet.id}>
                    <rect
                      x={clampedStartX}
                      y={tY}
                      width={width}
                      height={height}
                      rx={6}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={1}
                    />
                    <text
                      x={clampedStartX + 6}
                      y={tY + 16}
                      fill={isWinning ? 'var(--up)' : 'var(--muted)'}
                      fontSize={10}
                      className="font-jet"
                    >
                      x{Number(bet.multiplier).toFixed(2)}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </>
      )}

      {/* Classic mode: Active Bets SVG Overlay - Strike and Expiration lines */}
      <svg className="absolute inset-0 w-full h-full z-20 pointer-events-none">
        <g ref={scrollLayer}>
        {gameMode === 'binomo' && scales && activeBets.map((bet: any) => {
          if (bet.status !== 'active') return null;

          const strikeY = scales.yScale(bet.strikePrice);
          const expirationX = scales.xScale(bet.endTime);
          const nowX = scales.tipX;

          // Only show if expiration is in the future
          if (expirationX < 0) return null;

          const isUp = bet.direction === 'UP';
          const color = isUp ? 'var(--up)' : 'var(--down)';

          return (
            <g key={bet.id}>
              {/* Strike Line (Horizontal) */}
              <line
                x1={nowX}
                y1={strikeY}
                x2={Math.max(nowX, expirationX)}
                y2={strikeY}
                stroke={color}
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />

              {/* Expiration Line (Vertical) */}
              {expirationX > nowX && (
                <line
                  x1={expirationX}
                  y1={0}
                  x2={expirationX}
                  y2={dimensions.height}
                  stroke="var(--ink)"
                  strokeWidth="1"
                  strokeOpacity="0.2"
                  strokeDasharray="4 4"
                />
              )}

              {/* Price Filling Area */}
              {expirationX > nowX && (
                <rect
                  x={nowX}
                  y={isUp ? Math.min(strikeY, scales.yScale(currentPrice)) : strikeY}
                  width={expirationX - nowX}
                  height={Math.abs(strikeY - scales.yScale(currentPrice))}
                  fill={color}
                  fillOpacity="0.05"
                />
              )}

              {/* Label at Strike Price */}
              <text
                x={nowX + 5}
                y={strikeY - 5}
                fill={color}
                fontSize="10"
                className="font-jet"
              >
                {bet.direction} {bet.amount} {currencySymbol} {bet.strikePrice && `@ $${bet.strikePrice.toFixed(2)}`}
              </text>
            </g>
          );
        })}
        </g>
      </svg>

      {/* SVG Layer for Chart - ON TOP (no asset-switch remount: the switch re-seeds
          tip/overlays in the effect and the y-domain snaps to the new asset inside the
          scales computation itself, and nothing here holds stale DOM state) */}
      <svg
        className="absolute inset-0 w-full h-full z-10 pointer-events-none"
      >
        {scales && (
          <>
            {/* Y-Axis Price Ticks */}
            <g className="y-axis">
              {[0.1, 0.3, 0.5, 0.7, 0.9].map((tick) => {
                const price = scales.minY + (scales.maxY - scales.minY) * tick;
                const y = scales.yScale(price);
                return (
                  <g key={`y-tick-${tick}`}>
                    <line x1={0} y1={y} x2={dimensions.width} y2={y} stroke="var(--ink)" strokeOpacity="0.05" strokeWidth="1" />
                    <text
                      x={dimensions.width - 8}
                      y={y - 5}
                      fill="var(--faint)"
                      fontSize="10"
                      textAnchor="end"
                      className="font-jet"
                    >
                      {price.toLocaleString('en-US', { minimumFractionDigits: currentAssetConfig.decimals })}
                    </text>
                  </g>
                );
              })}
            </g>

            {/* X-Axis Time Ticks: anchored to wall-clock times so they scroll with the chart */}
            <g className="x-axis" ref={scrollLayer}>
              {(() => {
                // Dynamic tick interval based on pixelsPerSecond
                // We want at least 120px between time labels to prevent overlap
                const minSpacing = 120;
                let tickInterval = 10;

                if (pixelsPerSecond < minSpacing / 10) tickInterval = 30;
                if (pixelsPerSecond < minSpacing / 30) tickInterval = 60;
                if (pixelsPerSecond < minSpacing / 60) tickInterval = 120;
                if (pixelsPerSecond < minSpacing / 120) tickInterval = 300;
                if (pixelsPerSecond < minSpacing / 300) tickInterval = 600;

                // Calculate range of seconds to show based on visible dimensions
                const secondsPast = scales.tipX / pixelsPerSecond;
                const secondsFuture = (dimensions.width - scales.tipX) / pixelsPerSecond;

                const stepMs = tickInterval * 1000;
                const first = Math.floor((now - secondsPast * 1000) / stepMs) * stepMs;
                const lastTs = now + (secondsFuture + tickInterval) * 1000;

                const ticks: number[] = [];
                for (let ts = first; ts <= lastTs; ts += stepMs) ticks.push(ts);

                return ticks.map((ts) => {
                  const x = scales.xScale(ts);
                  if (x < -120 || x > dimensions.width + 120) return null;
                  return (
                    <g key={`x-tick-${ts}`}>
                      <line x1={x} y1={0} x2={x} y2={dimensions.height} stroke="var(--ink)" strokeOpacity="0.05" strokeWidth="1" />
                      <text
                        x={x + 5}
                        y={dimensions.height - 10}
                        fill="var(--faint)"
                        fontSize="10"
                        className="font-jet"
                      >
                        {new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </text>
                    </g>
                  );
                });
              })()}
            </g>

            {currentPrice > 0 && (
              <>
                {/* Main line — dimmed (opacity only, no layout shift) while the feed is stalled */}
                <g
                  ref={scrollLayer}
                  opacity={feedStalled ? 0.35 : 1}
                  style={{ transition: 'opacity 0.4s ease' }}
                >
                  {chartPath && (
                    <path d={chartPath} fill="none" stroke="var(--up)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </g>
                <line
                  ref={tailRef}
                  stroke="var(--up)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity={feedStalled ? 0.35 : 1}
                />

                {/* Current price: dashed guide, tip dot, right-axis tag. Positioned by applyMotion. */}
                <g ref={tipGroupRef}>
                  <line
                    x1={0}
                    y1={0}
                    x2={dimensions.width - 84}
                    y2={0}
                    stroke="var(--up)"
                    strokeOpacity="0.4"
                    strokeWidth="1"
                    strokeDasharray="3 4"
                  />
                  <circle
                    cx={scales.tipX}
                    cy={0}
                    r="4"
                    fill="var(--up)"
                    stroke="var(--paper)"
                    strokeWidth="2"
                  />
                  <rect x={dimensions.width - 84} y={-11} width={80} height={22} rx={11} fill="var(--up)" />
                  <text x={dimensions.width - 44} y={4} fill="var(--paper)" fontSize="11" textAnchor="middle" className="font-jet">
                    {currentPrice.toLocaleString('en-US', { minimumFractionDigits: currentAssetConfig.decimals, maximumFractionDigits: currentAssetConfig.decimals })}
                  </text>
                </g>

                {/* TECHNICAL INDICATORS RENDER */}
                {indicatorPaths && (
                  <g className="indicators-layer" ref={scrollLayer}>
                    {/* Moving Average */}
                    {activeIndicators['ma'] && indicatorPaths.ma && (
                      <path
                        d={indicatorPaths.ma as string}
                        fill="none"
                        stroke="var(--down)"
                        strokeWidth="1.5"
                        strokeDasharray="4 2"
                        opacity="0.7"
                      />
                    )}

                    {/* Bollinger Bands */}
                    {activeIndicators['bollinger'] && indicatorPaths.bollinger && (
                      <g>
                        <path
                          d={(indicatorPaths.bollinger as string[])[0]}
                          fill="none"
                          stroke="var(--subtle)"
                          strokeWidth="1.5"
                          opacity="0.5"
                        />
                        <path
                          d={(indicatorPaths.bollinger as string[])[1]}
                          fill="none"
                          stroke="var(--subtle)"
                          strokeWidth="1.5"
                          opacity="0.5"
                        />
                        <path
                          d={(indicatorPaths.bollinger as string[])[2]}
                          fill="none"
                          stroke="var(--subtle)"
                          strokeWidth="1"
                          strokeDasharray="2 2"
                          opacity="0.3"
                        />
                      </g>
                    )}

                    {/* Alligator */}
                    {activeIndicators['alligator'] && indicatorPaths.alligator && (
                      <g>
                        <path d={(indicatorPaths.alligator as string[])[0]} fill="none" stroke="var(--ink)" strokeWidth="1.5" opacity="0.5" />
                        <path d={(indicatorPaths.alligator as string[])[1]} fill="none" stroke="var(--subtle)" strokeWidth="1.5" opacity="0.5" />
                        <path d={(indicatorPaths.alligator as string[])[2]} fill="none" stroke="var(--faint)" strokeWidth="1.5" opacity="0.6" />
                      </g>
                    )}

                    {/* RSI Advanced Visualization */}
                    {activeIndicators['rsi'] && indicatorPaths.rsi && (() => {
                      try {
                        const rsiPoints = indicatorPaths.rsi as any[];


                        const panelHeight = 100;
                        const panelY = dimensions.height - panelHeight - 20;

                        return (
                          <g transform={`translate(0, ${panelY})`}>
                            {/* Panel Background */}
                            <rect x={0} y={0} width={dimensions.width} height={panelHeight} fill="var(--paper)" fillOpacity="0.92" />
                            <line x1={0} y1={0} x2={dimensions.width} y2={0} stroke="var(--line)" strokeWidth="1" />

                            {/* Zones (70-30) */}
                            <line x1={0} y1={30} x2={dimensions.width} y2={30} stroke="var(--line)" strokeWidth="1" strokeDasharray="4 4" />
                            <line x1={0} y1={70} x2={dimensions.width} y2={70} stroke="var(--line)" strokeWidth="1" strokeDasharray="4 4" />

                            {/* Labels */}
                            <text x={10} y={26} fill="var(--faint)" fontSize="10" className="font-jet">70</text>
                            <text x={10} y={66} fill="var(--faint)" fontSize="10" className="font-jet">30</text>

                            {/* RSI Line */}
                            <path
                              d={line<{ timestamp: number, rsi: number }>()
                                .x(d => scales.xScale(d.timestamp))
                                .y(d => panelHeight - (d.rsi / 100) * panelHeight)
                                .curve(curveMonotoneX)(rsiPoints) || ''}
                              fill="none"
                              stroke="var(--ink)"
                              strokeOpacity="0.7"
                              strokeWidth="1.5"
                            />

                            <text x={dimensions.width - 12} y={16} fill="var(--subtle)" fontSize="10" textAnchor="end" className="font-jet">RSI 14</text>
                          </g>
                        );
                      } catch (e) { return null; }
                    })()}

                  </g>
                )}
              </>
            )}
          </>
        )}
      </svg>

      {/* Price Header with Asset Selector */}
      <div className="absolute top-4 left-4 pointer-events-auto z-40">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            ref={assetSelectorRef}
            onClick={() => {
              if (!isAssetDropdownOpen && assetSelectorRef.current) {
                const rect = assetSelectorRef.current.getBoundingClientRect();
                setDropdownPos({ top: rect.bottom + 8, left: rect.left });
              }
              setIsAssetDropdownOpen(!isAssetDropdownOpen);
            }}
            data-tour="asset-selector"
            className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 bg-white ring-1 ring-line rounded-full hover:bg-surface transition-colors"
          >
            <div className="w-6 h-6 rounded-full flex items-center justify-center overflow-hidden">
              <AssetIcon
                src={currentAssetConfig.logo}
                asset={selectedAsset}
                className="w-6 h-6 object-contain"
              />
            </div>
            <span className="text-ink text-sm font-medium">{currentAssetConfig.name}</span>
            <span className="font-jet text-faint text-[11px]">{currentAssetConfig.pair}</span>
            <CaretDown
              size={12}
              weight="bold"
              className={`text-subtle transition-transform duration-200 ${isAssetDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {/* Price Display */}
          <div className="pointer-events-none flex items-baseline gap-2" data-tour="price-display">
            <p className="font-jet text-ink text-[28px] leading-none tracking-tight">
              {currentPrice > 0 ? currentPrice.toLocaleString('en-US', {
                minimumFractionDigits: currentAssetConfig.decimals,
                maximumFractionDigits: currentAssetConfig.decimals
              }) : '---'}
            </p>
            {(() => {
              const first = priceHistory[0]?.price;
              if (!first || currentPrice <= 0) return null;
              // Round first so a tiny negative move doesn't render as "-0.00%".
              const pct = Number((((currentPrice - first) / first) * 100).toFixed(2)) || 0;
              return (
                <span className={`font-jet text-[13px] ${pct > 0 ? 'text-up' : pct < 0 ? 'text-down' : 'text-faint'}`}>
                  {pct > 0 ? '+' : ''}{pct.toFixed(2)}%
                </span>
              );
            })()}
            {/* Feed-state badge: inline in the existing price row — no layout churn. */}
            <span
              data-testid="feed-state"
              title={
                feedState === 'live'
                  ? 'Streaming live ticks'
                  : feedState === 'stale'
                    ? 'Price feed delayed'
                    : 'Polling price feed (1s)'
              }
              className="self-center flex items-center gap-1 font-jet text-[10px] uppercase tracking-wide text-faint"
            >
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  feedState === 'live' ? 'bg-up' : feedState === 'stale' ? 'bg-down' : 'bg-faint'
                }`}
              />
              {feedState}
            </span>
          </div>
        </div>

        {watchlist.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1 max-w-[320px]">
            {watchlist.slice(0, 8).map((asset) => (
              <button
                key={asset}
                onClick={() => setSelectedAsset(asset)}
                className={`px-2 py-0.5 rounded-full font-jet text-[10px] ring-1 transition-colors ${selectedAsset === asset ? 'bg-up-soft ring-up/30 text-up' : 'bg-white ring-line text-subtle hover:text-ink'}`}
              >
                {asset}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Indicator Selection UI */}
      <div className="absolute top-16 right-4 z-50 pointer-events-none">
        <AnimatePresence>
          {isIndicatorsOpen && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className={`${OVERLAY} w-56 p-1.5 overflow-hidden pointer-events-auto`}
            >
              <div className="flex justify-between items-center px-2.5 py-2">
                <p className="text-[12px] text-subtle">Indicators</p>
                <button
                  onClick={() => setIsIndicatorsOpen(false)}
                  aria-label="Close indicators"
                  className="text-faint hover:text-ink transition-colors"
                >
                  <X size={14} weight="bold" />
                </button>
              </div>
              {[
                { id: 'ma', name: 'Moving Average', icon: <TrendUp size={16} /> },
                { id: 'alligator', name: 'Alligator', icon: <Waveform size={16} /> },
                { id: 'bollinger', name: 'Bollinger Bands', icon: <ArrowsDownUp size={16} /> },
                { id: 'rsi', name: 'RSI', icon: <Pulse size={16} /> },
              ].map(indicator => (
                <button
                  key={indicator.id}
                  onClick={() => toggleIndicator(indicator.id)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-[13px] transition-colors ${activeIndicators[indicator.id] ? 'bg-up-soft text-up' : 'text-muted hover:bg-surface hover:text-ink'}`}
                >
                  {indicator.icon}
                  <span className="flex-1 text-left">{indicator.name}</span>
                  <span className={`w-3.5 h-3.5 rounded-full ring-1 ${activeIndicators[indicator.id] ? 'bg-up ring-up' : 'ring-line'}`} />
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>


      {/* Insufficient Funds Notice */}
      {showInsufficientFunds && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50">
          <div className={`${OVERLAY} px-4 py-2.5`}>
            <p className="text-down text-sm text-center max-w-[260px]">
              Not enough house credits — deposit in the Wallet tab first
            </p>
          </div>
        </div>
      )}

      {/* Bet Result Notifications */}
      <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden">
        {betResults.map((result) => {
          const age = Date.now() - result.timestamp;
          const opacity = Math.max(0, 1 - age / 3000);
          const translateY = -age / 20; // Float upward faster

          return (
            <div
              key={result.id}
              className="absolute"
              style={{
                left: Math.min(Math.max(result.x, 80), dimensions.width - 140),
                top: Math.min(Math.max(result.y + translateY, 40), dimensions.height - 120),
                opacity,
                transform: `translateY(${translateY}px)`,
              }}
            >
              <div className={`${OVERLAY} px-4 py-3`}>
                <div className="flex items-baseline justify-between gap-4">
                  <p className="text-[12px] text-subtle">{result.won ? 'Won' : 'Lost'}</p>
                  {result.won && (
                    <span className="font-jet text-[11px] text-faint">{result.multiplier}x</span>
                  )}
                </div>
                <p className={`font-jet text-lg leading-tight ${result.won ? 'text-up' : 'text-down'}`}>
                  {result.won
                    ? `+${result.payout.toFixed(4)}`
                    : `-${result.amount.toFixed(4)}`
                  }
                  <span className="text-xs ml-1 text-faint">{currencySymbol}</span>
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Asset Dropdown - rendered via Portal to escape all stacking contexts */}
      {isAssetDropdownOpen && typeof document !== 'undefined' && createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setIsAssetDropdownOpen(false)}
          />

          {/* Dropdown Panel */}
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left }}
            className={`${OVERLAY} w-80 overflow-hidden z-[9999] p-2 text-ink`}
          >
            {/* Search Input */}
            <div className="relative mb-2">
              <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
              <input
                type="text"
                placeholder="Search assets"
                value={assetSearchQuery}
                onChange={(e) => setAssetSearchQuery(e.target.value)}
                className="w-full bg-surface ring-1 ring-line rounded-xl py-2 pl-9 pr-3 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-up/40 transition-shadow"
              />
            </div>

            {/* Category Tabs */}
            <div className="flex gap-0.5 mb-2 bg-surface p-0.5 rounded-full ring-1 ring-line">
              {(['All', 'Crypto', 'Metals', 'Forex', 'Stocks', 'Commodities'] as const).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveAssetCategory(cat)}
                  className={`flex-1 py-1 px-1 rounded-full text-[10px] transition-colors ${activeAssetCategory === cat ? 'bg-white text-ink ring-1 ring-line' : 'text-subtle hover:text-ink'}`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Asset List */}
            <div className="max-h-[320px] overflow-y-auto scrollbar-none no-scrollbar grid grid-cols-1 gap-0.5">
              {filteredAssets.length > 0 ? (
                filteredAssets.map((asset) => (
                  <button
                    key={asset}
                    onClick={() => {
                      setSelectedAsset(asset);
                      setIsAssetDropdownOpen(false);
                      setAssetSearchQuery('');
                    }}
                    className={`flex items-center gap-3 px-2.5 py-2 rounded-xl transition-colors ${selectedAsset === asset ? 'bg-up-soft' : 'hover:bg-surface'}`}
                  >
                    <div className="w-7 h-7 rounded-full flex items-center justify-center overflow-hidden">
                      <AssetIcon
                        src={ASSET_CONFIG[asset].logo}
                        asset={asset}
                        className="w-7 h-7 object-contain"
                      />
                    </div>
                    <div className="flex-1 text-left">
                      <p className={`text-sm font-medium ${selectedAsset === asset ? 'text-up' : 'text-ink'}`}>{ASSET_CONFIG[asset].name}</p>
                      <p className="font-jet text-[10px] text-faint">{ASSET_CONFIG[asset].pair}</p>
                    </div>

                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleWatchlist(asset);
                      }}
                      className={`p-1 rounded-full cursor-pointer transition-colors ${watchlist.includes(asset) ? 'text-up' : 'text-faint hover:text-ink'}`}
                      title={watchlist.includes(asset) ? 'Remove from watchlist' : 'Add to watchlist'}
                    >
                      <Star size={14} weight={watchlist.includes(asset) ? 'fill' : 'regular'} />
                    </span>
                  </button>
                ))
              ) : (
                <div className="py-8 text-center">
                  <p className="text-subtle text-xs">No assets found</p>
                </div>
              )}
            </div>
          </motion.div>
        </>,
        document.body
      )}
    </div>
  );
});
