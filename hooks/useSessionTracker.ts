'use client';

import { useEffect, useRef } from 'react';

const PING_INTERVAL_MS = 30_000; // ping every 30 s

export function useSessionTracker(walletAddress: string | null, network: string | null) {
  const sessionIdRef = useRef<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const ping = async (address: string, net: string) => {
    try {
      const res = await fetch('/api/session/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: address,
          network: net,
          session_id: sessionIdRef.current ?? undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        sessionIdRef.current = data.session_id ?? sessionIdRef.current;
      }
    } catch {
      // Non-fatal — silently ignore
    }
  };

  const closeSession = async (address: string) => {
    if (!sessionIdRef.current) return;
    try {
      await fetch('/api/session/ping', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionIdRef.current, wallet_address: address }),
        keepalive: true,
      });
    } catch {/* ignore */}
    sessionIdRef.current = null;
  };

  useEffect(() => {
    if (!walletAddress) {
      // Wallet disconnected — clear interval, no close needed (server times out)
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }

    const addr = walletAddress;
    const net = network ?? 'ARC';

    // Immediate first ping
    void ping(addr, net);

    // Periodic pings
    intervalRef.current = setInterval(() => void ping(addr, net), PING_INTERVAL_MS);

    const handleUnload = () => void closeSession(addr);
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [walletAddress, network]);
}
