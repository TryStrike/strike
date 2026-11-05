/**
 * Latest USD prices for every asset the game trades.
 *
 * Two unauthenticated sources:
 *
 *   Crypto  -> Binance. The client polls once a second and rounds last five
 *              seconds, so the feed has to actually move; Yahoo only refreshes
 *              a crypto quote every ten to fifteen seconds, which left the
 *              chart looking frozen.
 *   The rest -> Yahoo. Equities, indices, metals, energy and FX are delayed at
 *              source anyway, so a slower refresh costs nothing there.
 *
 * Binance quotes against USDT rather than USD. The basis is a fraction of a
 * percent and every round compares a price to itself moments later, so the
 * direction a bet settles on is unaffected.
 *
 * The symbols below were each checked against a second source before being
 * committed. Two crypto tickers collide with unrelated coins on Yahoo (a plain
 * SUI-USD or APT-USD quotes something else entirely, off by three orders of
 * magnitude), so those use Yahoo's id-suffixed form.
 *
 * FX pairs: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD.
 */

const SPARK_ENDPOINT = 'https://query2.finance.yahoo.com/v7/finance/spark';

/** App asset -> Binance symbol. Checked against Coinbase and CoinGecko. */
const BINANCE_SYMBOLS: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  SUI: 'SUIUSDT',
  TRX: 'TRXUSDT',
  XRP: 'XRPUSDT',
  DOGE: 'DOGEUSDT',
  ADA: 'ADAUSDT',
  BCH: 'BCHUSDT',
  BNB: 'BNBUSDT',
  XLM: 'XLMUSDT',
  XTZ: 'XTZUSDT',
  NEAR: 'NEARUSDT',
  APT: 'APTUSDT',
};

/** App asset -> Yahoo symbol. Also the fallback for crypto if Binance fails. */
const YAHOO_SYMBOLS: Record<string, string> = {
  // Crypto
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  SUI: 'SUI20947-USD',
  TRX: 'TRX-USD',
  XRP: 'XRP-USD',
  DOGE: 'DOGE-USD',
  ADA: 'ADA-USD',
  BCH: 'BCH-USD',
  BNB: 'BNB-USD',
  XLM: 'XLM-USD',
  XTZ: 'XTZ-USD',
  NEAR: 'NEAR-USD',
  APT: 'APT21794-USD',
  // Metals
  GOLD: 'GC=F',
  SILVER: 'SI=F',
  // FX
  EUR: 'EURUSD=X',
  GBP: 'GBPUSD=X',
  JPY: 'JPY=X',
  AUD: 'AUDUSD=X',
  CAD: 'CAD=X',
  // Equities
  AAPL: 'AAPL',
  GOOGL: 'GOOGL',
  AMZN: 'AMZN',
  MSFT: 'MSFT',
  NVDA: 'NVDA',
  TSLA: 'TSLA',
  META: 'META',
  NFLX: 'NFLX',
  // Energy
  WTI: 'CL=F',
  BRENT: 'BZ=F',
  // Indices
  SPX: '^GSPC',
  NDX: '^NDX',
  DJI: '^DJI',
};

type CacheEntry = { price: number; at: number };
const cache = new Map<string, CacheEntry>();

// Clients poll once a second. Crypto is cached briefly enough to stay live;
// everything else moves slowly at source, so it is held longer.
const CRYPTO_CACHE_MS = 1_000;
const SLOW_CACHE_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8_000;

const BINANCE_ENDPOINT = 'https://api.binance.com/api/v3/ticker/price';

function cacheWindow(asset: string): number {
  return BINANCE_SYMBOLS[asset] ? CRYPTO_CACHE_MS : SLOW_CACHE_MS;
}

function fresh(asset: string): number | undefined {
  const hit = cache.get(asset);
  if (hit && Date.now() - hit.at < cacheWindow(asset)) return hit.price;
  return undefined;
}

/** Binance takes the whole list in one call. */
async function fetchBinance(assets: string[]): Promise<Array<[string, number]>> {
  const symbolByAsset = new Map(assets.map((a) => [a, BINANCE_SYMBOLS[a]]));
  const assetBySymbol = new Map(Array.from(symbolByAsset, ([a, s]) => [s, a]));
  const symbols = JSON.stringify(Array.from(symbolByAsset.values()));

  try {
    const response = await fetch(
      `${BINANCE_ENDPOINT}?symbols=${encodeURIComponent(symbols)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) {
      console.warn(`[prices] binance returned ${response.status}`);
      return [];
    }
    const rows: Array<{ symbol?: string; price?: string }> = await response.json();
    const out: Array<[string, number]> = [];
    for (const row of rows ?? []) {
      const asset = row?.symbol ? assetBySymbol.get(row.symbol) : undefined;
      const price = Number(row?.price);
      if (asset && Number.isFinite(price) && price > 0) out.push([asset, price]);
    }
    return out;
  } catch (error) {
    console.warn('[prices] binance failed:', (error as Error).message);
    return [];
  }
}

function priceFromResponse(response: any): number | null {
  const direct = Number(response?.meta?.regularMarketPrice);
  if (Number.isFinite(direct) && direct > 0) return direct;

  // Fall back to the last non-null close in the spark series.
  const closes: unknown[] = response?.close ?? [];
  for (let i = closes.length - 1; i >= 0; i -= 1) {
    const value = Number(closes[i]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** Yahoo rejects oversized symbol lists; stay comfortably under the limit. */
const BATCH_SIZE = 15;

async function fetchBatch(symbols: string[]): Promise<Array<[string, number]>> {
  // Encode each symbol but keep the separators literal: Yahoo does not split
  // on an encoded comma and silently answers with only the first symbol.
  const query = symbols.map((s) => encodeURIComponent(s)).join(',');
  try {
    const response = await fetch(
      `${SPARK_ENDPOINT}?symbols=${query}&interval=1d&range=1d`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // Yahoo answers 401 to requests without a browser user agent.
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }
    );
    if (!response.ok) {
      console.warn(`[prices] upstream returned ${response.status}`);
      return [];
    }
    const data = await response.json();
    const out: Array<[string, number]> = [];
    for (const result of data?.spark?.result ?? []) {
      const price = priceFromResponse(result?.response?.[0]);
      if (price !== null && typeof result?.symbol === 'string') out.push([result.symbol, price]);
    }
    return out;
  } catch (error) {
    console.warn('[prices] fetch failed:', (error as Error).message);
    return [];
  }
}

export async function fetchLatestPrices(
  assets: string[]
): Promise<Partial<Record<string, number>>> {
  const wanted = Array.from(new Set(assets.filter(Boolean).map((a) => a.toUpperCase())));

  const out: Partial<Record<string, number>> = {};
  const crypto: string[] = [];
  const slow: string[] = [];
  for (const asset of wanted) {
    const cached = fresh(asset);
    if (cached !== undefined) out[asset] = cached;
    else if (BINANCE_SYMBOLS[asset]) crypto.push(asset);
    else if (YAHOO_SYMBOLS[asset]) slow.push(asset);
  }
  if (crypto.length === 0 && slow.length === 0) return out;

  const record = (pairs: Array<[string, number]>) => {
    for (const [asset, price] of pairs) {
      out[asset] = price;
      cache.set(asset, { price, at: Date.now() });
    }
  };

  const [binance, yahoo] = await Promise.all([
    crypto.length ? fetchBinance(crypto) : Promise.resolve([]),
    slow.length ? fetchYahoo(slow) : Promise.resolve([]),
  ]);
  record(binance);
  record(yahoo);

  // Binance is the only live crypto source; if it failed, Yahoo still quotes
  // these assets, just more slowly.
  const cryptoMissing = crypto.filter((a) => out[a] === undefined);
  if (cryptoMissing.length) record(await fetchYahoo(cryptoMissing));

  // Anything still missing falls back to the last price we saw for it.
  const missing: string[] = [];
  for (const asset of [...crypto, ...slow]) {
    if (out[asset] !== undefined) continue;
    const stale = cache.get(asset);
    if (stale) out[asset] = stale.price;
    else missing.push(asset);
  }
  if (missing.length) console.warn(`[prices] no quote for ${missing.join(', ')}`);

  return out;
}

/** Yahoo, in batches it will accept, returning [asset, price] pairs. */
async function fetchYahoo(assets: string[]): Promise<Array<[string, number]>> {
  const symbolByAsset = new Map(assets.map((a) => [a, YAHOO_SYMBOLS[a]]));
  const assetBySymbol = new Map(Array.from(symbolByAsset, ([a, s]) => [s, a]));

  const symbols = Array.from(symbolByAsset.values()).filter(Boolean);
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    batches.push(symbols.slice(i, i + BATCH_SIZE));
  }

  const results = await Promise.all(batches.map((batch) => fetchBatch(batch)));
  const out: Array<[string, number]> = [];
  for (const batch of results) {
    for (const [symbol, price] of batch) {
      const asset = assetBySymbol.get(symbol);
      if (asset) out.push([asset, price]);
    }
  }
  return out;
}
