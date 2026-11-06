

export const ASSETS = [
  'BTC', 'ETH', 'SOL', 'SUI', 'TRX', 'XRP', 'DOGE', 'ADA', 'BCH', 'BNB',
  'XLM', 'XTZ', 'NEAR', 'APT', 'GOLD', 'SILVER', 'EUR', 'GBP', 'JPY', 'AUD',
  'CAD', 'AAPL', 'GOOGL', 'AMZN', 'MSFT', 'NVDA', 'TSLA', 'META', 'NFLX', 'WTI',
  'BRENT', 'SPX', 'NDX', 'DJI', 'LINK', 'AVAX', 'DOT', 'LTC', 'UNI', 'PEPE',
  'SHIB', 'ATOM', 'RENDER', 'TAO', 'INJ', 'KAS', 'FET', 'FIL', 'AR', 'STX',
  'HBAR', 'ICP', 'VET', 'OP', 'BONK', 'ARB', 'SNX', 'AAVE', 'GRT', 'THETA',
  'ALGO', 'EGLD', 'FLOW', 'AMD', 'BABA', 'DIS', 'JPM', 'V', 'MA', 'PYPL',
  'COIN', 'MSTR', 'UBER', 'PLTR', 'CRM', 'INTC', 'TSM',
] as const;

export type AssetType = (typeof ASSETS)[number];

export const isAsset = (value: string): value is AssetType =>
  (ASSETS as readonly string[]).includes(value);

const PRICES_ENDPOINT = '/api/prices/latest';

const PRICE_CACHE_STORAGE_KEY = 'strike_last_price_cache_v1';
const PRICE_CACHE_WRITE_MS = 5_000;

const rememberedPrices: Record<string, number> = {};
let rememberedAt = 0;

/** Stream frames carry only what moved, so these merge. The landing page seeds from this. */
export function rememberPrices(prices: Record<string, number>) {
  Object.assign(rememberedPrices, prices);
  const now = Date.now();
  if (now - rememberedAt < PRICE_CACHE_WRITE_MS) return;
  rememberedAt = now;
  try {
    window.localStorage.setItem(PRICE_CACHE_STORAGE_KEY, JSON.stringify(rememberedPrices));
  } catch {}
}

async function fetchAllPrices(): Promise<Record<string, number>> {
  const res = await fetch(PRICES_ENDPOINT, { signal: AbortSignal.timeout(6_000) });
  if (!res.ok) throw new Error(`${PRICES_ENDPOINT} answered ${res.status}`);
  const prices = ((await res.json()) as { prices?: Record<string, unknown> }).prices ?? {};
  const results: Record<string, number> = {};
  for (const sym of ASSETS) {
    const px = Number(prices[sym]);
    if (Number.isFinite(px) && px > 0) results[sym] = px;
  }
  if (Object.keys(results).length > 0) rememberPrices(results);
  return results;
}

export const startPricePolling = (
  callback: (prices: Record<string, number>) => void
): (() => void) => {
  let isActive = true;
  let inFlight = false;
  let failing = false;

  const run = async () => {
    if (!isActive || inFlight) return;
    inFlight = true;
    try {
      const prices = await fetchAllPrices();
      if (failing) console.info('[prices] poll recovered');
      failing = false;
      if (isActive) callback(prices);
    } catch (err) {
      if (!failing) console.error('[prices] poll failed:', err);
      failing = true;
    } finally {
      inFlight = false;
    }
  };

  void run();
  const intervalId = setInterval(() => {
    void run();
  }, 1000);

  return () => {
    isActive = false;
    clearInterval(intervalId);
  };
};
