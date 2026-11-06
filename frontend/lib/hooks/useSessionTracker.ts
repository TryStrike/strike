'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { backoffDelayMs, computeExpiryMs, nextRefreshMs } from '@/lib/wallet/sessionTiming';


const CHANNEL_NAME = 'strike-session-tracker';
const ELECTION_MS = 350;
const FOLLOWER_CHECK_MS = 5_000;
const TAKEOVER_JITTER_MS = 750;
const LEADER_GRACE_MS = 4_000;
const MAX_CONSECUTIVE_FAILURES = 6;

export type SessionStatus = 'idle' | 'active' | 'refreshing' | 'expiring' | 'expired' | 'error';

export interface SessionTrackerSnapshot {
  status: SessionStatus;
  expiresAt: number | null;
  sessionId: string | null;
  isLeader: boolean;
}

export interface SessionTrackerState extends SessionTrackerSnapshot {
  refreshNow: () => void;
}

export interface UseSessionTrackerOptions {
  random?: () => number;
}

type Role = 'none' | 'electing' | 'leader' | 'follower';

interface CoordMessage {
  type: 'claim' | 'session' | 'release';
  tabId: string;
  address: string;
  ts: number;
  session_id?: string;
  expires_at_ms?: number;
  refresh_after_ms?: number;
}

function makeTabId(random: () => number): string {
  return `tab-${Date.now().toString(36)}-${Math.floor(random() * 1e9).toString(36)}`;
}

function createChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

export function useSessionTracker(
  walletAddress: string | null,
  network: string | null,
  options: UseSessionTrackerOptions = {},
): SessionTrackerState {
  const random = options.random ?? Math.random;

  const [tabId] = useState(() => makeTabId(Math.random));
  const tabIdRef = useRef<string>(tabId);

  const networkRef = useRef<string | null>(network);
  const addressRef = useRef<string | null>(walletAddress);
  useLayoutEffect(() => {
    networkRef.current = network;
    addressRef.current = walletAddress;
  });

  const roleRef = useRef<Role>('none');
  const sessionIdRef = useRef<string | null>(null);
  const expiresAtRef = useRef<number | null>(null);
  const refreshAfterMsRef = useRef<number>(nextRefreshMs(null));
  const failsRef = useRef(0);
  const lastSuccessAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const takeoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingInFlightRef = useRef(false);
  const gaveUpRef = useRef(false);
  const lastHeardFromLeaderRef = useRef(0);
  const peersRef = useRef<Set<string>>(new Set());
  const activeKeyRef = useRef<string | null>(null);
  const trackedAddressRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  const [snapshot, setSnapshot] = useState<SessionTrackerSnapshot>({
    status: 'idle',
    expiresAt: null,
    sessionId: null,
    isLeader: false,
  });

  const publish = useCallback((patch: Partial<SessionTrackerSnapshot>) => {
    if (!aliveRef.current) return;
    setSnapshot((prev) => {
      const next = { ...prev, ...patch };
      if (
        next.status === prev.status &&
        next.expiresAt === prev.expiresAt &&
        next.sessionId === prev.sessionId &&
        next.isLeader === prev.isLeader
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const clearTimers = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (followerTimerRef.current) { clearTimeout(followerTimerRef.current); followerTimerRef.current = null; }
    if (takeoverTimerRef.current) { clearTimeout(takeoverTimerRef.current); takeoverTimerRef.current = null; }
  }, []);

  const channelRef = useRef<BroadcastChannel | null>(null);

  const runPingRef = useRef<() => void>(() => {});

  const post = useCallback((msg: CoordMessage) => {
    try {
      const ch = channelRef.current;
      if (ch) ch.postMessage(msg);
    } catch {}
  }, []);

  const closeSession = useCallback(async (address: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      await fetch('/api/session/ping', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id, wallet_address: address }),
        keepalive: true,
      });
    } catch {}
    if (sessionIdRef.current === id) sessionIdRef.current = null;
  }, []);

  const sendSessionSnapshot = useCallback(() => {
    const address = addressRef.current;
    if (!address || roleRef.current !== 'leader' || lastSuccessAtRef.current === 0) return;
    const exp = expiresAtRef.current;
    if (exp !== null && Date.now() >= exp) {
      void runPingRef.current();
      return;
    }
    post({
      type: 'session',
      tabId: tabIdRef.current,
      address,
      ts: Date.now(),
      session_id: sessionIdRef.current ?? undefined,
      expires_at_ms: exp ?? undefined,
      refresh_after_ms: refreshAfterMsRef.current,
    });
  }, [post]);

  const runPing = useCallback(async () => {
    const address = addressRef.current;
    if (!address || pingInFlightRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    pingInFlightRef.current = true;
    publish({ status: 'refreshing' });

    let data: Record<string, unknown> | null = null;
    try {
      const res = await fetch('/api/session/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: address,
          network: networkRef.current ?? 'ARC',
          session_id: sessionIdRef.current ?? undefined,
        }),
      });
      if (res.ok) {
        const parsed: unknown = await res.json().catch(() => null);
        if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
      } else {
        console.warn(`[session] ping answered ${res.status}`);
      }
    } catch (err) {
      console.warn('[session] ping failed', err);
      data = null;
    }
    pingInFlightRef.current = false;
    if (!aliveRef.current || addressRef.current !== address) return;

    const now = Date.now();
    if (data) {
      failsRef.current = 0;
      gaveUpRef.current = false;
      lastSuccessAtRef.current = now;
      if (typeof data.session_id === 'string') sessionIdRef.current = data.session_id;
      const serverMs = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
      expiresAtRef.current = computeExpiryMs(
        now,
        typeof data.ttl_seconds === 'number' ? data.ttl_seconds : undefined,
        Number.isFinite(serverMs) ? serverMs : null,
      );
      refreshAfterMsRef.current = nextRefreshMs(data as { ttl_seconds?: unknown; refresh_after_seconds?: unknown });
      publish({ status: 'active', expiresAt: expiresAtRef.current, sessionId: sessionIdRef.current });

      if (roleRef.current === 'leader') {
        sendSessionSnapshot();
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => { void runPingRef.current(); }, refreshAfterMsRef.current);
      }
      return;
    }

    failsRef.current += 1;
    clearTimers();
    const nextDelay = backoffDelayMs(failsRef.current, { random });
    if (failsRef.current >= MAX_CONSECUTIVE_FAILURES) {
      gaveUpRef.current = true;
      const exp0 = expiresAtRef.current;
      publish({ status: exp0 !== null && now >= exp0 ? 'expired' : 'error' });
      return;
    }
    const exp = expiresAtRef.current;
    const status = exp !== null && now >= exp
      ? 'expired'
      : exp !== null && now + nextDelay >= exp
        ? 'expiring'
        : 'error';
    publish({ status });
    timerRef.current = setTimeout(() => { void runPingRef.current(); }, nextDelay);
  }, [publish, clearTimers, random, sendSessionSnapshot]);

  useLayoutEffect(() => {
    runPingRef.current = () => { void runPing(); };
  });

  const becomeLeader = useCallback(() => {
    if (roleRef.current === 'leader') return;
    roleRef.current = 'leader';
    clearTimers();
    const address = addressRef.current;
    if (address) post({ type: 'claim', tabId: tabIdRef.current, address, ts: Date.now() });
    publish({ isLeader: true });
    void runPing();
  }, [clearTimers, post, publish, runPing]);

  const attemptTakeover = useCallback((reason: 'stale' | 'release') => {
    if (roleRef.current === 'leader' || roleRef.current === 'none' || takeoverTimerRef.current) return;
    const delay = reason === 'release' ? 0 : 100 + Math.floor(random() * TAKEOVER_JITTER_MS);
    takeoverTimerRef.current = setTimeout(() => {
      takeoverTimerRef.current = null;
      if (!aliveRef.current || roleRef.current === 'leader' || roleRef.current === 'none') return;
      const since = Date.now() - lastHeardFromLeaderRef.current;
      if (reason === 'release' || since > refreshAfterMsRef.current + LEADER_GRACE_MS) {
        becomeLeader();
      }
    }, delay);
  }, [random, becomeLeader]);

  const followerTickRef = useRef<() => void>(() => {});
  const followerTick = useCallback(() => {
    if (roleRef.current !== 'follower' || !aliveRef.current) return;
    const since = Date.now() - lastHeardFromLeaderRef.current;
    if (since > refreshAfterMsRef.current + LEADER_GRACE_MS) {
      attemptTakeover('stale');
      followerTimerRef.current = setTimeout(() => followerTickRef.current(), FOLLOWER_CHECK_MS);
      return;
    }
    const now = Date.now();
    const exp = expiresAtRef.current;
    if (exp !== null) {
      if (now >= exp) publish({ status: 'expired' });
      else if (now >= exp - refreshAfterMsRef.current) publish({ status: 'expiring' });
      else publish({ status: 'active' });
    } else {
      const address = addressRef.current;
      if (address) post({ type: 'claim', tabId: tabIdRef.current, address, ts: Date.now() });
      attemptTakeover('stale');
    }
    followerTimerRef.current = setTimeout(() => followerTickRef.current(), FOLLOWER_CHECK_MS);
  }, [attemptTakeover, publish, post]);
  useLayoutEffect(() => {
    followerTickRef.current = followerTick;
  });

  const becomeFollower = useCallback((msg: CoordMessage) => {
    roleRef.current = 'follower';
    clearTimers();
    lastHeardFromLeaderRef.current = msg.ts || Date.now();
    if (typeof msg.session_id === 'string') sessionIdRef.current = msg.session_id;
    if (typeof msg.expires_at_ms === 'number') expiresAtRef.current = msg.expires_at_ms;
    if (typeof msg.refresh_after_ms === 'number' && msg.refresh_after_ms > 0) refreshAfterMsRef.current = msg.refresh_after_ms;
    publish({
      isLeader: false,
      sessionId: sessionIdRef.current,
      expiresAt: expiresAtRef.current,
      status: expiresAtRef.current === null ? 'refreshing' : 'active',
    });
    followerTimerRef.current = setTimeout(followerTick, FOLLOWER_CHECK_MS);
  }, [clearTimers, publish, followerTick]);

  useEffect(() => {
    if (!walletAddress) {
      activeKeyRef.current = null;
      roleRef.current = 'none';
      clearTimers();
      publish({ status: 'idle', expiresAt: null, sessionId: null, isLeader: false });
      return;
    }

    const net = networkRef.current ?? 'ARC';
    const key = `${walletAddress}:${net}`;
    if (activeKeyRef.current === key) return;

    if (activeKeyRef.current !== null) {
      void closeSession(trackedAddressRef.current ?? walletAddress);
    }
    activeKeyRef.current = key;
    trackedAddressRef.current = walletAddress;
    sessionIdRef.current = null;
    expiresAtRef.current = null;
    failsRef.current = 0;
    gaveUpRef.current = false;
    lastSuccessAtRef.current = 0;
    lastHeardFromLeaderRef.current = 0;
    peersRef.current = new Set();
    clearTimers();

    aliveRef.current = true;
    const channel = createChannel();
    channelRef.current = channel;
    const tabId = tabIdRef.current;

    if (!channel) {
      becomeLeader();
    } else {
      roleRef.current = 'electing';
      publish({ status: 'refreshing', isLeader: false, expiresAt: null, sessionId: null });
      post({ type: 'claim', tabId, address: walletAddress, ts: Date.now() });
      const onMessage = (ev: MessageEvent) => {
        const msg = ev.data as CoordMessage | undefined;
        if (!msg || typeof msg !== 'object' || msg.tabId === tabId || msg.address !== walletAddress) return;
        if (msg.type === 'release') {
          peersRef.current.delete(msg.tabId);
          if (roleRef.current !== 'leader') attemptTakeover('release');
          return;
        }
        peersRef.current.add(msg.tabId);
        if (roleRef.current === 'leader') {
          sendSessionSnapshot();
          return;
        }
        becomeFollower(msg);
      };
      channel.onmessage = onMessage;
      followerTimerRef.current = setTimeout(() => {
        if (roleRef.current === 'electing') becomeLeader();
      }, ELECTION_MS + Math.floor(random() * 200));
    }

    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (roleRef.current === 'leader') {
          post({ type: 'release', tabId, address: walletAddress, ts: Date.now() });
          roleRef.current = 'electing';
          publish({ isLeader: false });
        }
        const exp = expiresAtRef.current;
        if (exp !== null && Date.now() >= exp) publish({ status: 'expiring' });
        return;
      }
      failsRef.current = 0;
      gaveUpRef.current = false;
      if (roleRef.current === 'leader') {
        void runPing();
      } else if (roleRef.current === 'electing') {
        becomeLeader();
      } else if (roleRef.current === 'follower') {
        attemptTakeover('stale');
      }
    };
    const onFocus = () => {
      if (typeof document === 'undefined' || document.hidden) return;
      if (roleRef.current !== 'leader') return;
      const staleFor = Date.now() - lastSuccessAtRef.current;
      if ((gaveUpRef.current || staleFor > refreshAfterMsRef.current / 2) && !pingInFlightRef.current) {
        failsRef.current = 0;
        void runPing();
      }
    };
    const onUnload = () => {
      if (roleRef.current !== 'leader') return;
      post({ type: 'release', tabId, address: walletAddress, ts: Date.now() });
      if (peersRef.current.size === 0) {
        void closeSession(walletAddress);
      }
    };

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('beforeunload', onUnload);

    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('beforeunload', onUnload);
      if (roleRef.current === 'leader') {
        post({ type: 'release', tabId, address: walletAddress, ts: Date.now() });
      }
      roleRef.current = 'none';
      clearTimers();
      if (channelRef.current === channel) channelRef.current = null;
      try { channel?.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  useEffect(() => {
    return () => {
      aliveRef.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  const refreshNow = useCallback(() => {
    failsRef.current = 0;
    gaveUpRef.current = false;
    if (roleRef.current === 'leader') void runPing();
    else if (roleRef.current === 'electing') becomeLeader();
    else if (roleRef.current === 'follower') attemptTakeover('stale');
  }, [runPing, becomeLeader, attemptTakeover]);

  return { ...snapshot, refreshNow };
}
