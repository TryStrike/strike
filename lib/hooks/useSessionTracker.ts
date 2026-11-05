'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { backoffDelayMs, computeExpiryMs, nextRefreshMs } from '@/lib/wallet/sessionTiming';

/**
 * Client-side lifecycle for the /api/session/ping uplink.
 *
 * - Refresh timing comes from the server-reported TTL (ttl_seconds /
 *   refresh_after_seconds), never a hardcoded interval.
 * - Failures retry with capped exponential backoff + jitter; after
 *   MAX_CONSECUTIVE_FAILURES the ladder stops until the tab regains
 *   visibility/focus (which resets it).
 * - Polling pauses while document.hidden and refetches immediately on
 *   visibilitychange.
 * - Cross-tab coordination via BroadcastChannel: one leader pings per wallet,
 *   followers mirror its expiry and take over when the leader goes silent.
 *   No BroadcastChannel → every tab pings (pre-existing single-tab behavior).
 *
 * Exported API stays source-compatible with existing call sites
 * (`useSessionTracker(address, network)`); the return value is additive.
 */

const CHANNEL_NAME = 'strike-session-tracker';
/** How long a new tab waits for an existing leader before claiming one. */
const ELECTION_MS = 350;
/** Followers re-check leader freshness locally (no network) this often. */
const FOLLOWER_CHECK_MS = 5_000;
/** Random spread for takeover so N followers don't claim simultaneously. */
const TAKEOVER_JITTER_MS = 750;
/** Past the advertised expiry + this grace, the leader counts as stale. */
const LEADER_GRACE_MS = 4_000;
/** Stop the backoff ladder here; retry only on visibility/focus. */
const MAX_CONSECUTIVE_FAILURES = 6;

export type SessionStatus = 'idle' | 'active' | 'refreshing' | 'expiring' | 'expired' | 'error';

export interface SessionTrackerSnapshot {
  status: SessionStatus;
  /** Epoch ms the tracked session lapses (server TTL from last success). */
  expiresAt: number | null;
  sessionId: string | null;
  /** Whether this tab owns the ping schedule for the tracked wallet. */
  isLeader: boolean;
}

export interface SessionTrackerState extends SessionTrackerSnapshot {
  /** Force an immediate refresh (e.g. after the user unlocks their wallet). */
  refreshNow: () => void;
}

export interface UseSessionTrackerOptions {
  /** Injectable RNG so backoff jitter is deterministic in tests. */
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

  const tabIdRef = useRef<string | null>(null);
  if (!tabIdRef.current) tabIdRef.current = makeTabId(Math.random);

  const networkRef = useRef<string | null>(network);
  networkRef.current = network;

  const addressRef = useRef<string | null>(walletAddress);
  addressRef.current = walletAddress;

  // Engine state lives in refs (mutated from timers/handlers); only the
  // snapshot below is React state, deduped so stable periods don't re-render.
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

  // Indirection so scheduled callbacks always run the latest closure.
  const runPingRef = useRef<() => void>(() => {});

  const post = useCallback((msg: CoordMessage) => {
    try {
      const ch = channelRef.current;
      if (ch) ch.postMessage(msg);
    } catch {/* channel closed mid-unload: fine */}
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
    } catch {/* ignore */}
    // Only consume the id if nothing newer took its place.
    if (sessionIdRef.current === id) sessionIdRef.current = null;
  }, []);

  const sendSessionSnapshot = useCallback(() => {
    const address = addressRef.current;
    if (!address || roleRef.current !== 'leader' || lastSuccessAtRef.current === 0) return;
    const exp = expiresAtRef.current;
    if (exp !== null && Date.now() >= exp) {
      // Lapsed while a peer asked: refresh rather than hand out stale data.
      void runPingRef.current();
      return;
    }
    post({
      type: 'session',
      tabId: tabIdRef.current!,
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
    if (typeof document !== 'undefined' && document.hidden) return; // resumed by the visibility handler
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
      }
    } catch {
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

    // Failure ladder: capped exponential backoff with jitter.
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

  runPingRef.current = () => { void runPing(); };

  const becomeLeader = useCallback(() => {
    if (roleRef.current === 'leader') return;
    roleRef.current = 'leader';
    clearTimers();
    const address = addressRef.current;
    if (address) post({ type: 'claim', tabId: tabIdRef.current!, address, ts: Date.now() });
    publish({ isLeader: true });
    void runPing();
  }, [clearTimers, post, publish, runPing]);

  const attemptTakeover = useCallback((reason: 'stale' | 'release') => {
    if (roleRef.current === 'leader' || roleRef.current === 'none' || takeoverTimerRef.current) return;
    // Spread concurrent followers; the first claimant wins, the rest demote
    // again when they see the fresh 'claim'.
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

  const followerTick = useCallback(() => {
    if (roleRef.current !== 'follower' || !aliveRef.current) return;
    const since = Date.now() - lastHeardFromLeaderRef.current;
    if (since > refreshAfterMsRef.current + LEADER_GRACE_MS) {
      attemptTakeover('stale');
      // Keep ticking until the takeover lands; a competing claim (or our own
      // promotion to leader) clears this via becomeFollower/becomeLeader.
      followerTimerRef.current = setTimeout(followerTick, FOLLOWER_CHECK_MS);
      return;
    }
    const now = Date.now();
    const exp = expiresAtRef.current;
    if (exp !== null) {
      if (now >= exp) publish({ status: 'expired' });
      else if (now >= exp - refreshAfterMsRef.current) publish({ status: 'expiring' });
      else publish({ status: 'active' });
    } else {
      // Follower with no snapshot yet (joined mid-session, leader silent on
      // data): a fresh 'claim' prompts the leader to broadcast its current
      // session state; the takeover check is the backstop if it stays quiet.
      const address = addressRef.current;
      if (address) post({ type: 'claim', tabId: tabIdRef.current!, address, ts: Date.now() });
      attemptTakeover('stale');
    }
    followerTimerRef.current = setTimeout(followerTick, FOLLOWER_CHECK_MS);
  }, [attemptTakeover, publish, post]);

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

  // Wire one tracked session per wallet. `network` is intentionally NOT a
  // dependency: the store flips it null -> 'ARC' right after connect and a
  // teardown/restart there would drop the live channel. It is read from a
  // ref when a ping fires.
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
    if (activeKeyRef.current === key) return; // double-start guard

    if (activeKeyRef.current !== null) {
      // Wallet switched: close the previous wallet's session before resetting.
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
    const tabId = tabIdRef.current!;

    if (!channel) {
      // No coordination primitive: this tab is its own leader. Safe fallback
      // (every tab pings, like before cross-tab support existed).
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
          // A peer deferred to us (or mirrored us): hand over the current
          // session state so it can render status without pinging.
          sendSessionSnapshot();
          return;
        }
        becomeFollower(msg);
      };
      channel.onmessage = onMessage;
      // Electing tabs that hear nothing from an existing leader promote
      // themselves when this fires.
      followerTimerRef.current = setTimeout(() => {
        if (roleRef.current === 'electing') becomeLeader();
      }, ELECTION_MS + Math.floor(random() * 200));
    }

    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        // Pause all scheduled pings while hidden; expiry is recomputed on resume.
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (roleRef.current === 'leader') {
          // Hand leadership to a visible tab if one exists; otherwise this
          // tab re-claims it on resume.
          post({ type: 'release', tabId, address: walletAddress, ts: Date.now() });
          roleRef.current = 'electing';
          publish({ isLeader: false });
        }
        const exp = expiresAtRef.current;
        if (exp !== null && Date.now() >= exp) publish({ status: 'expiring' });
        return;
      }
      // Back in view: reset the ladder and refetch immediately.
      failsRef.current = 0;
      gaveUpRef.current = false;
      if (roleRef.current === 'leader') {
        void runPing();
      } else if (roleRef.current === 'electing') {
        // Resume of a tab that handed off (or started hidden) with no peer
        // in sight: claim again right away.
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
      // Only close the session outright when no peer tab is mirroring it;
      // otherwise the takeover path keeps it alive. Without BroadcastChannel
      // every tab is a leader with no peers — pre-existing close-on-unload.
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
      try { channel?.close(); } catch {/* already closed */}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // Unmount: stop everything.
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
