'use client';

/**
 * Server-pushed price ticks via /api/prices/stream (SSE), with the existing
 * 1s poll of /api/prices/latest as an automatic fallback.
 *
 * The hook never removes the poller's role: until the stream has actually
 * delivered a parseable tick, ticks keep flowing through
 * startMultiPythPriceFeed — the exact poller the app has always used. A
 * missing EventSource, a proxy that strips/buffers text/event-stream, a 404
 * or a stream that opens but stays silent all degrade to polling, while a
 * backoff reconnect keeps probing the stream in the background. Feed state is
 * surfaced for the stall indicator: "live" (SSE), "polling" (fallback), or
 * "stale" (nothing fresh — decided by the consumer from lastTickAt).
 */

import { useEffect, useRef, useState } from 'react';
import { startMultiPythPriceFeed, type AssetType } from '@/lib/utils/priceFeed';

export type PriceFeedMode = 'stream' | 'poll';

export interface UsePriceStreamOptions {
  /** SSE endpoint path. */
  streamPath?: string;
  /**
   * How long to wait for the first tick on a fresh connection before
   * concluding SSE cannot deliver through this network path. The route primes
   * every connection with a snapshot frame, so silence here means "broken",
   * never "quiet market".
   */
  firstTickTimeoutMs?: number;
  /** Cap for the exponential reconnect backoff. */
  maxReconnectBackoffMs?: number;
}

const DEFAULT_STREAM_PATH = '/api/prices/stream';
const DEFAULT_FIRST_TICK_TIMEOUT_MS = 4000;
const DEFAULT_MAX_RECONNECT_BACKOFF_MS = 15_000;

export function usePriceStream(
  asset: AssetType,
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
    // Each (re)connect starts pessimistically: polling owns the feed until the
    // stream proves it can deliver.
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

    // Environment without EventSource at all: polling is the feed.
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
      // Stream died or never delivered: hand the chart to the poller and keep
      // probing SSE in the background with backoff.
      startPollFallback();
      closeEventSource();
      scheduleReconnect();
    };

    const connect = () => {
      if (disposed) return;
      es = new EventSource(`${streamPath}?assets=${encodeURIComponent(asset)}`);
      watchdog = setTimeout(degrade, firstTickTimeoutMs);

      es.onmessage = (event: MessageEvent) => {
        watchdog = clearTimer(watchdog);
        attempt = 0;

        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const tick = payload as { asset?: unknown; price?: unknown };
        const price = typeof tick?.price === 'number' ? tick.price : NaN;
        if (!Number.isFinite(price) || price <= 0) return;
        const key = typeof tick.asset === 'string' && tick.asset ? tick.asset : asset;

        // The stream demonstrably delivers — retire the poll fallback and
        // feed the tick through the same ingest path the poll result uses.
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
  }, [asset, streamPath, firstTickTimeoutMs, maxReconnectBackoffMs]);

  return { mode, connected };
}
