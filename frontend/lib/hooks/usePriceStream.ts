'use client';


import { useEffect, useRef, useState } from 'react';
import { startMultiPythPriceFeed } from '@/lib/utils/priceFeed';

export type PriceFeedMode = 'stream' | 'poll';

export interface UsePriceStreamOptions {
  streamPath?: string;
  firstTickTimeoutMs?: number;
  maxReconnectBackoffMs?: number;
}

const DEFAULT_STREAM_PATH = '/api/prices/stream';
const DEFAULT_FIRST_TICK_TIMEOUT_MS = 4000;
const DEFAULT_MAX_RECONNECT_BACKOFF_MS = 15_000;

export function usePriceStream(
  onTick: (prices: Record<string, number>) => void,
  options: UsePriceStreamOptions = {}
): { mode: PriceFeedMode; connected: boolean } {
  const streamPath = options.streamPath ?? DEFAULT_STREAM_PATH;
  const firstTickTimeoutMs = options.firstTickTimeoutMs ?? DEFAULT_FIRST_TICK_TIMEOUT_MS;
  const maxReconnectBackoffMs = options.maxReconnectBackoffMs ?? DEFAULT_MAX_RECONNECT_BACKOFF_MS;

  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);

  const [mode, setMode] = useState<PriceFeedMode>('poll');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setMode('poll');
    setConnected(false);

    if (typeof window === 'undefined') return;

    let disposed = false;
    let es: EventSource | null = null;
    let stopPoll: (() => void) | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer !== null) clearTimeout(timer);
      return null;
    };

    const startPollFallback = () => {
      if (disposed || stopPoll) return;
      stopPoll = startMultiPythPriceFeed((prices) => {
        if (!disposed) onTickRef.current(prices);
      });
      setMode('poll');
      setConnected(false);
    };

    const stopPollFallback = () => {
      if (stopPoll) stopPoll();
      stopPoll = null;
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
      watchdog = setTimeout(degrade, firstTickTimeoutMs);

      es.onmessage = (event: MessageEvent) => {
        watchdog = clearTimer(watchdog);
        attempt = 0;

        let tick: { asset?: unknown; price?: unknown };
        try {
          tick = JSON.parse(String(event.data));
        } catch (err) {
          console.error('[prices] malformed stream frame', event.data, err);
          return;
        }
        const price = typeof tick?.price === 'number' ? tick.price : NaN;
        if (!Number.isFinite(price) || price <= 0) {
          console.error('[prices] stream frame without a usable price', event.data);
          return;
        }
        if (typeof tick.asset !== 'string' || !tick.asset) {
          console.error('[prices] stream frame without an asset', event.data);
          return;
        }
        const key = tick.asset;

        stopPollFallback();
        reconnectTimer = clearTimer(reconnectTimer);
        setMode('stream');
        setConnected(true);
        onTickRef.current({ [key]: price });
      };

      es.onerror = () => degrade();
    };

    connect();

    return () => {
      disposed = true;
      reconnectTimer = clearTimer(reconnectTimer);
      closeEventSource();
      stopPollFallback();
    };
  }, [streamPath, firstTickTimeoutMs, maxReconnectBackoffMs]);

  return { mode, connected };
}
