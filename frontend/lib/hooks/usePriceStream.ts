'use client';


import { useEffect, useRef, useState } from 'react';
import { rememberPrices, startPricePolling } from '@/lib/utils/priceFeed';

export type PriceFeedMode = 'stream' | 'poll';

export interface UsePriceStreamOptions {
  streamPath?: string;
  firstTickTimeoutMs?: number;
  maxReconnectBackoffMs?: number;
  onBands?: (bands: Record<string, number>) => void;
  onClosed?: (closed: string[]) => void;
  onHistory?: (asset: string, points: [number, number][]) => void;
  onMarket?: (state: unknown) => void;
}

const DEFAULT_STREAM_PATH = '/api/prices/stream';
const DEFAULT_FIRST_TICK_TIMEOUT_MS = 4000;
// The very first connect only: a page that has never had a price shouldn't wait out the full timeout.
const COLD_START_TICK_TIMEOUT_MS = 1500;
const DEFAULT_MAX_RECONNECT_BACKOFF_MS = 15_000;
// Once streaming, no event for this long means the connection is dead even though onerror never fired.
const LIVENESS_TIMEOUT_MS = 10_000;
const MARKET_POLL_MS = 5_000;

export function usePriceStream(
  onTick: (prices: Record<string, number>) => void,
  options: UsePriceStreamOptions = {}
): { mode: PriceFeedMode; connected: boolean } {
  const streamPath = options.streamPath ?? DEFAULT_STREAM_PATH;
  const firstTickTimeoutMs = options.firstTickTimeoutMs ?? DEFAULT_FIRST_TICK_TIMEOUT_MS;
  const maxReconnectBackoffMs = options.maxReconnectBackoffMs ?? DEFAULT_MAX_RECONNECT_BACKOFF_MS;

  const onTickRef = useRef(onTick);
  const onBandsRef = useRef(options.onBands);
  const onClosedRef = useRef(options.onClosed);
  const onHistoryRef = useRef(options.onHistory);
  const onMarketRef = useRef(options.onMarket);
  useEffect(() => {
    onTickRef.current = onTick;
    onBandsRef.current = options.onBands;
    onClosedRef.current = options.onClosed;
    onHistoryRef.current = options.onHistory;
    onMarketRef.current = options.onMarket;
  }, [onTick, options.onBands, options.onClosed, options.onHistory, options.onMarket]);

  const [mode, setMode] = useState<PriceFeedMode>('poll');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let disposed = false;
    let es: EventSource | null = null;
    let stopPoll: (() => void) | null = null;
    let marketTimer: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer !== null) clearTimeout(timer);
      return null;
    };

    const startPollFallback = () => {
      if (disposed || stopPoll) return;
      stopPoll = startPricePolling((prices) => {
        if (!disposed) onTickRef.current(prices);
      });
      // The stream also carries market state (clock offset, quiet flags, Blitz window); poll it while degraded.
      const pollMarket = () =>
        fetch('/api/market/state')
          .then((r) => (r.ok ? r.json() : null))
          .then((m) => m && !disposed && onMarketRef.current?.(m))
          .catch(() => {});
      void pollMarket();
      marketTimer = setInterval(pollMarket, MARKET_POLL_MS);
      setMode('poll');
      setConnected(false);
    };

    const stopPollFallback = () => {
      if (stopPoll) stopPoll();
      stopPoll = null;
      if (marketTimer !== null) clearInterval(marketTimer);
      marketTimer = null;
    };

    if (typeof window.EventSource !== 'function') {
      startPollFallback();
      return () => {
        disposed = true;
        stopPollFallback();
      };
    }

    const closeEventSource = () => {
      watchdog = clearTimer(watchdog);
      if (es) {
        es.onmessage = null;
        es.onerror = null;
        es.close();
        es = null;
      }
    };

    const scheduleReconnect = () => {
      if (reconnectTimer !== null) return;
      const delay = Math.min(1000 * 2 ** attempt, maxReconnectBackoffMs);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const degrade = () => {
      if (!stopPoll) console.warn('[prices] stream unavailable, polling until it reconnects');
      startPollFallback();
      closeEventSource();
      scheduleReconnect();
    };

    const connect = () => {
      if (disposed) return;
      es = new EventSource(streamPath);
      const coldStart = attempt === 0;
      watchdog = setTimeout(
        degrade,
        coldStart ? Math.min(COLD_START_TICK_TIMEOUT_MS, firstTickTimeoutMs) : firstTickTimeoutMs
      );

      // Every event proves the stream is alive; silence after the first frame restarts the connection.
      const alive = () => {
        watchdog = clearTimer(watchdog);
        watchdog = setTimeout(degrade, LIVENESS_TIMEOUT_MS);
      };

      es.onmessage = (event: MessageEvent) => {
        alive();
        attempt = 0;

        let frame: { prices?: unknown; bands?: unknown; closed?: unknown };
        try {
          frame = JSON.parse(String(event.data));
        } catch (err) {
          console.error('[prices] malformed stream frame', event.data, err);
          return;
        }
        if (typeof frame?.prices !== 'object' || frame.prices === null) {
          console.error('[prices] stream frame without prices', event.data);
          return;
        }

        stopPollFallback();
        reconnectTimer = clearTimer(reconnectTimer);
        setMode('stream');
        setConnected(true);
        const prices = frame.prices as Record<string, number>;
        if (Object.keys(prices).length > 0) {
          onTickRef.current(prices);
          rememberPrices(prices);
        }
        if (frame.bands) onBandsRef.current?.(frame.bands as Record<string, number>);
        if (Array.isArray(frame.closed)) onClosedRef.current?.(frame.closed as string[]);
      };

      es.addEventListener('history', (event) => {
        alive();
        try {
          const { asset, points } = JSON.parse(String((event as MessageEvent).data));
          if (typeof asset === 'string' && Array.isArray(points)) onHistoryRef.current?.(asset, points);
        } catch (err) {
          console.error('[prices] malformed history frame', err);
        }
      });
      es.addEventListener('market', (event) => {
        alive();
        try {
          onMarketRef.current?.(JSON.parse(String((event as MessageEvent).data)));
        } catch (err) {
          console.error('[prices] malformed market frame', err);
        }
      });

      es.onerror = () => degrade();
    };

    connect();

    return () => {
      disposed = true;
      reconnectTimer = clearTimer(reconnectTimer);
      closeEventSource();
      stopPollFallback();
      setMode('poll');
      setConnected(false);
    };
  }, [streamPath, firstTickTimeoutMs, maxReconnectBackoffMs]);

  return { mode, connected };
}
