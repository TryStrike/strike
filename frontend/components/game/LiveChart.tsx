'use client';

import React, { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Cell, CellLabel, Scales, TapGrid } from 'tapgrid';
import { TapGridChart } from 'tapgrid/react';
import { useStore } from '@/lib/store';
import { resolveHouseLedgerCurrency } from '@/lib/balance/houseLedgerCurrency';
import { AssetType } from '@/lib/utils/priceFeed';
import { motion, AnimatePresence } from 'framer-motion';
import { computeIndicators, drawBets, drawIndicators, drawRsiPanel, RSI_PANEL_INSET } from './chartOverlays';
import type { OverlayPalette } from './chartOverlays';
import { useToast } from '@/lib/hooks/useToast';
import { CaretDown, X, MagnifyingGlass, Star, TrendUp, Waveform, ArrowsDownUp, Pulse } from '@phosphor-icons/react';


const BET_LOCK_MS = 2_500;
const RESULT_VISIBLE_MS = 3_000;
const ROWS = 10;
const LINE_VIEW_SPAN = 3;
const LINE_MIN_RANGE = 0.001;
/** Box bands scale with the view, and multipliers are priced for this span, so it moves the house edge. */
const BOX_VIEW_SPAN = 1.7;
const BOX_MIN_RANGE = 0.0003;
const OVERLAY = 'bg-white rounded-2xl ring-1 ring-line shadow-xl font-tight';

interface LiveChartProps {
  betAmount: string;
}

interface BoxQuote {
  asset: AssetType;
  multiplier: string;
  isUp: boolean;
}

function readPalette(el: HTMLElement): { palette: OverlayPalette; fontFamily: string } {
  const css = getComputedStyle(el);
  const color = (name: string) => css.getPropertyValue(name).trim();
  return {
    fontFamily: color('--font-jet'),
    palette: {
      background: color('--paper'),
      grid: color('--line'),
      text: color('--faint'),
      cellText: color('--faint'),
      accentText: color('--down'),
      crossing: color('--surface'),
      line: color('--up'),
      tipText: color('--paper'),
      up: color('--up'),
      upSoft: color('--up-soft'),
      down: color('--down'),
      ink: color('--ink'),
      subtle: color('--subtle'),
      faint: color('--faint'),
      muted: color('--muted'),
      border: color('--line'),
    },
  };
}

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
  
  GOLD: { name: 'Gold', symbol: 'GOLD', pair: 'XAU/USD', logo: '/logos/gold.jpg', category: 'Metals', decimals: 2 },
  SILVER: { name: 'Silver', symbol: 'SILVER', pair: 'XAG/USD', logo: '/logos/silver.avif', category: 'Metals', decimals: 3 },
  
  EUR: { name: 'Euro', symbol: 'EUR', pair: 'EUR/USD', logo: '/logos/euro.png', category: 'Forex', decimals: 4 },
  GBP: { name: 'British Pound', symbol: 'GBP', pair: 'GBP/USD', logo: '/logos/uk.png', category: 'Forex', decimals: 4 },
  JPY: { name: 'Japanese Yen', symbol: 'JPY', pair: 'USD/JPY', logo: '/logos/japan.jpg', category: 'Forex', decimals: 2 },
  AUD: { name: 'Australian Dollar', symbol: 'AUD', pair: 'AUD/USD', logo: '/logos/australia.png', category: 'Forex', decimals: 4 },
  CAD: { name: 'Canadian Dollar', symbol: 'CAD', pair: 'USD/CAD', logo: '/logos/canada.png', category: 'Forex', decimals: 4 },
  
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
  
  WTI: { name: 'Crude Oil WTI', symbol: 'WTI', pair: 'WTI/USD', logo: 'OIL', category: 'Commodities', decimals: 2 },
  BRENT: { name: 'Crude Oil Brent', symbol: 'BRENT', pair: 'BRENT/USD', logo: 'OIL', category: 'Commodities', decimals: 2 },
};


const LOGO_SOURCES = {
  CLEARBIT: (domain: string) => `https://logo.clearbit.com/${domain}`,
  
  GOOGLE: (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
  
  COINCAP: (symbol: string) => `https://assets.coincap.io/assets/icons/${symbol.toLowerCase()}@2x.png`,

  BINANCE: (symbol: string) => `https://bin.bnbstatic.com/static/images/coins/icon/${symbol.toLowerCase()}.png`,

  LOCAL: (symbol: string) => `/logos/${symbol.toLowerCase()}.png`,
};

const STOCK_DOMAIN_MAP: Record<string, string> = {
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
  
  SPX: 'spglobal.com',
  NDX: 'nasdaq.com',
  DJI: 'spglobal.com',
  VIX: 'spglobal.com',
  DAX: 'deutsche-boerse.com',
  N225: 'nikkei.com',
  HSI: 'hkex.com.hk',
  FTSE: 'ftserussell.com',
  CAC: 'euronext.com',
};


const AssetIcon = ({ src, asset, className }: { src: string; asset: string; className: string }) => {

  const [currentSrc, setCurrentSrc] = useState(src);
  const [attemptIndex, setAttemptIndex] = useState(0);
  const [showFallback, setShowFallback] = useState(false);

  useEffect(() => {
    setCurrentSrc(src);
    setAttemptIndex(0);
    setShowFallback(false);
  }, [src, asset]);

  const getAllSources = (): string[] => {
    const sources: string[] = [];

    if (src && !src.includes('clearbit') && !src.includes('google.com')) {
      sources.push(src);
    }

    const cryptoMapping: Record<string, string> = {
      RENDER: 'rndr',
      EGLD: 'egld',
      KAS: 'kas',
    };
    const cryptoSymbol = cryptoMapping[asset] || asset;
    sources.push(LOGO_SOURCES.COINCAP(cryptoSymbol));
    sources.push(LOGO_SOURCES.BINANCE(cryptoSymbol));

    const domain = STOCK_DOMAIN_MAP[asset];
    if (domain) {
      sources.push(LOGO_SOURCES.CLEARBIT(domain));
      sources.push(LOGO_SOURCES.GOOGLE(domain));
    }

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

    sources.push(LOGO_SOURCES.LOCAL(asset));

    return sources;
  };

  const allSources = getAllSources();

  const handleImageError = () => {
    const nextIndex = attemptIndex + 1;
    
    if (nextIndex < allSources.length) {
      setCurrentSrc(allSources[nextIndex]);
      setAttemptIndex(nextIndex);
    } else {
      setShowFallback(true);
    }
  };

  if (showFallback || allSources.length === 0) {
    return (
      <div className={`relative flex items-center justify-center w-full h-full ${className}`}>
        <span className="font-semibold text-sm text-ink">{asset[0]}</span>
      </div>
    );
  }

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

export const LiveChart = React.memo(function LiveChart({ betAmount }: LiveChartProps) {
  const priceHistory = useStore((state) => state.priceHistory);
  const currentPrice = useStore((state) => state.currentPrice);
  const selectedAsset = useStore((state) => state.selectedAsset);
  const toast = useToast();
  const setSelectedAsset = useStore((state) => state.setSelectedAsset);
  const placeBetFromHouseBalance = useStore((state) => state.placeBetFromHouseBalance);
  const settlingCount = useStore((state) => state.settlingBets.length);
  const maxBand = useStore((state) => state.maxBands[state.selectedAsset] ?? 0);
  const userAddress = useStore((state) => state.address);
  const houseBalance = useStore((state) => state.houseBalance);
  const isPlacingBet = useStore((state) => state.isPlacingBet);

  const gameMode = useStore((state) => state.gameMode);
  const timeframeSeconds = useStore((state) => state.timeframeSeconds);
  const lastResult = useStore((state) => state.lastResult);
  const selectedCurrency = useStore((state) => state.selectedCurrency);

  const { mode: feedMode, connected: streamLive } = useStore((state) => state.priceFeed);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [chart, setChart] = useState<TapGrid | null>(null);
  const [theme, setTheme] = useState<ReturnType<typeof readPalette> | null>(null);
  const [isAssetDropdownOpen, setIsAssetDropdownOpen] = useState(false);
  const assetSelectorRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  const [isLoadingPrice, setIsLoadingPrice] = useState(true);

  const [showInsufficientFunds, setShowInsufficientFunds] = useState(false);

  const [assetSearchQuery, setAssetSearchQuery] = useState('');
  const [watchlist, setWatchlist] = useState<AssetType[]>([]);
  const [activeAssetCategory, setActiveAssetCategory] = useState<'All' | 'Crypto' | 'Metals' | 'Forex' | 'Stocks' | 'Commodities'>('All');

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

  const currencySymbol = useMemo(
    () => resolveHouseLedgerCurrency({ selectedCurrency }),
    [selectedCurrency]
  );

  const currentAssetConfig = ASSET_CONFIG[selectedAsset] || ASSET_CONFIG.BTC;

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


  useEffect(() => {
    setBetResults([]);
    setIsLoadingPrice(priceHistory.length === 0 || currentPrice <= 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAsset]);

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

  useEffect(() => {
    if (betResults.length === 0) return;
    const interval = setInterval(() => {
      const nowTime = Date.now();
      setBetResults(prev => {
        const filtered = prev.filter((r: BetResult) => nowTime - r.timestamp < RESULT_VISIBLE_MS);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [betResults.length]);

  useEffect(() => {
    if (currentPrice > 0 && priceHistory.length >= 2) {
      setIsLoadingPrice(false);
    }
  }, [currentPrice, priceHistory]);

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
    const observer = new ResizeObserver(updateDimensions);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setPrefersReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

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

  const feedState = feedStalled ? 'stale' : feedMode === 'stream' && streamLive ? 'live' : 'polling';

  const isMobile = dimensions.width < 640;
  const historyWidthRatio = isMobile ? 0.35 : 0.50;
  const targetColWidthPx = isMobile ? 100 : 250;
  const isBox = gameMode === 'box';
  const gridInterval = (isBox ? timeframeSeconds : 30) * 1000;
  const pixelsPerSecond = isBox
    ? Math.max(2, targetColWidthPx / (gridInterval / 1000))
    : (isMobile ? 20 : 30);
  const tickRange = 20 * 10 ** -currentAssetConfig.decimals;

  useEffect(() => {
    chart?.setData(priceHistory, currentPrice);
  }, [chart, priceHistory, currentPrice]);

  useEffect(() => {
    const read = () => {
      if (containerRef.current) setTheme(readPalette(containerRef.current));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const lastProcessedResultRef = useRef<number>(0);
  useEffect(() => {
    if (!lastResult || lastResult.timestamp <= lastProcessedResultRef.current) return;
    lastProcessedResultRef.current = lastResult.timestamp;
    const scales = chart?.scales();
    if (!scales) return;

    setBetResults((prev) => [
      ...prev,
      {
        id: `result-${lastResult.betId ?? lastResult.timestamp}`,
        won: lastResult.won,
        amount: lastResult.amount,
        payout: lastResult.payout,
        multiplier: Number((lastResult.amount > 0 ? lastResult.payout / lastResult.amount : 0).toFixed(2)),
        timestamp: Date.now(),
        x: scales.tipX,
        y: scales.y(currentPrice),
      },
    ]);
  }, [chart, lastResult, currentPrice]);

  const indicators = useMemo(
    () => computeIndicators(priceHistory, activeIndicators),
    [priceHistory, activeIndicators],
  );

  const quoteCell = useCallback((cell: Cell, scales: Scales): CellLabel<BoxQuote> => {
    const { currentPrice: price, selectedAsset: asset, isBlitzActive, hasBlitzAccess, blitzMultiplier } = useStore.getState();
    const center = (cell.top + cell.bottom) / 2;
    const priceRange = scales.maxPrice - scales.minPrice;
    const inRow = price <= cell.top && price >= cell.bottom;
    const distance = Math.min(Math.abs(center - price) / (priceRange * 0.8), 1);
    const base = inRow ? 1.01 : 1.05 + Math.pow(distance, 1.3) * 3.95;
    const timeBonus = Math.max(0, (scales.x(cell.time) - scales.tipX) / 800) * 0.25;

    const isLuckyDiagonal = (Math.round(cell.top / scales.step) + Math.floor(cell.time / (timeframeSeconds * 1000))) % 5 === 0;
    const boosted = isBlitzActive && hasBlitzAccess && (base > 2.2 || isLuckyDiagonal);
    const multiplier = Math.min(Math.min(base + timeBonus, 10) * (boosted ? blitzMultiplier : 1), 20).toFixed(2);

    return { text: `${multiplier}x`, accent: boosted, value: { asset, multiplier, isUp: center > price } };
  }, [timeframeSeconds]);

  const handleCellTap = async (cell: Cell, label: CellLabel | null) => {
    const quote = label?.value as BoxQuote | undefined;
    if (!quote || quote.asset !== useStore.getState().selectedAsset || !betAmount || !userAddress) return;

    if ((houseBalance || 0) < parseFloat(betAmount)) {
      setShowInsufficientFunds(true);
      setTimeout(() => setShowInsufficientFunds(false), 2000);
      return;
    }

    try {
      await placeBetFromHouseBalance(
        betAmount,
        `${quote.isUp ? 'UP' : 'DOWN'}-${quote.multiplier}-${timeframeSeconds}`,
        userAddress,
        cell.key,
        { priceTop: cell.top, priceBottom: cell.bottom, startTime: cell.time, endTime: cell.time },
      );
    } catch (error) {
      console.error('Failed to place box bet:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to place bet');
    }
  };

  const underlay = (ctx: CanvasRenderingContext2D, scales: Scales) => {
    if (theme) drawIndicators(ctx, scales, indicators, theme.palette);
  };

  const overlay = (ctx: CanvasRenderingContext2D, scales: Scales) => {
    if (!theme) return;
    const { activeBets, settlingBets } = useStore.getState();
    drawBets(ctx, scales, [...activeBets, ...settlingBets], {
      mode: gameMode,
      asset: selectedAsset,
      price: useStore.getState().currentPrice,
      intervalMs: gridInterval,
      symbol: currencySymbol,
      fontFamily: theme.fontFamily,
    }, theme.palette);
    if (indicators.rsi) drawRsiPanel(ctx, scales, indicators.rsi, theme.palette, theme.fontFamily);
  };

  return (
    <div ref={containerRef} className="absolute inset-0 z-0 bg-white font-tight text-ink overflow-hidden select-none">
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

      {theme && (
        <div className="absolute inset-0 z-5">
          <TapGridChart
            mode={isBox ? 'grid' : 'line'}
            seriesKey={selectedAsset}
            intervalMs={gridInterval}
            pxPerSecond={pixelsPerSecond}
            tipRatio={historyWidthRatio}
            rows={ROWS}
            decimals={currentAssetConfig.decimals}
            lockMs={BET_LOCK_MS}
            viewSpan={isBox ? BOX_VIEW_SPAN : LINE_VIEW_SPAN}
            minRange={Math.max(currentPrice * (isBox ? BOX_MIN_RANGE : LINE_MIN_RANGE), tickRange)}
            maxStep={isBox ? maxBand : 0}
            colors={theme.palette}
            fontFamily={theme.fontFamily}
            reducedMotion={prefersReducedMotion}
            stale={feedStalled}
            tapInsetBottom={indicators.rsi ? RSI_PANEL_INSET : 0}
            cellLabel={quoteCell}
            onCellTap={handleCellTap}
            underlay={underlay}
            overlay={overlay}
            onReady={setChart}
            style={{ cursor: isBox ? 'pointer' : 'default' }}
          />
        </div>
      )}

      {settlingCount > 0 && (
        <div className="absolute bottom-8 left-4 z-40 pointer-events-none">
          <div className={`${OVERLAY} px-3 py-1.5 text-[11px] text-subtle`}>Settling on the server</div>
        </div>
      )}

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
              const pct = Number((((currentPrice - first) / first) * 100).toFixed(2)) || 0;
              return (
                <span className={`font-jet text-[13px] ${pct > 0 ? 'text-up' : pct < 0 ? 'text-down' : 'text-faint'}`}>
                  {pct > 0 ? '+' : ''}{pct.toFixed(2)}%
                </span>
              );
            })()}
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


      {showInsufficientFunds && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50">
          <div className={`${OVERLAY} px-4 py-2.5`}>
            <p className="text-down text-sm text-center max-w-[260px]">
              Not enough house credits — deposit in the Wallet tab first
            </p>
          </div>
        </div>
      )}

      <div className="absolute inset-0 z-50 pointer-events-none overflow-hidden">
        {betResults.map((result) => {
          return (
            <div
              key={result.id}
              className="absolute"
              style={{
                left: Math.min(Math.max(result.x, 80), dimensions.width - 140),
                top: Math.min(Math.max(result.y, 40), dimensions.height - 120),
                animation: `result-float ${RESULT_VISIBLE_MS}ms linear forwards`,
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

      {isAssetDropdownOpen && typeof document !== 'undefined' && createPortal(
        <>
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setIsAssetDropdownOpen(false)}
          />

          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left }}
            className={`${OVERLAY} w-80 overflow-hidden z-[9999] p-2 text-ink`}
          >
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
