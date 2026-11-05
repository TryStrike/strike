/**
 * Pure scheduling math for the client session tracker.
 *
 * The tracker must derive its refresh cadence from the TTL the server
 * reports (see backend/crates/server/src/routes/session.rs) rather than a hardcoded
 * poll, retry with exponential backoff + jitter on failure, and clamp
 * both the delay and the consecutive-failure count.
 */

/** Matches SESSION_TIMEOUT_SECONDS on the ping route; used only when the server omits a TTL. */
export const FALLBACK_TTL_SECONDS = 90;

/** Never refresh more than this often (protects the route from client-side churn). */
export const MIN_REFRESH_SECONDS = 5;

/** Never go longer than this between refreshes (stays well under a 90 s TTL). */
export const MAX_REFRESH_SECONDS = 60;

/** Refresh this fraction of the server-reported TTL. */
export const DEFAULT_REFRESH_RATIO = 0.5;

/** A TTL outside this range is treated as garbage from the wire. */
export const TTL_SANITY_MIN_SECONDS = 1;
export const TTL_SANITY_MAX_SECONDS = 86_400;

function finiteOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface RefreshTimingOptions {
  /** Fraction of the TTL used as the refresh lead time. Default 0.5. */
  ratio?: number;
  minSeconds?: number;
  maxSeconds?: number;
}

/**
 * Convert a server-reported TTL (seconds) into a refresh delay (ms).
 * Invalid/absent TTLs fall back to FALLBACK_TTL_SECONDS; the result is
 * always inside [minSeconds, maxSeconds] so a hostile or buggy payload
 * cannot schedule a stampede or a stale poll.
 */
export function refreshDelayMsFromTtl(ttlSeconds: number | null | undefined, opts: RefreshTimingOptions = {}): number {
  const ratio = opts.ratio ?? DEFAULT_REFRESH_RATIO;
  const minSeconds = opts.minSeconds ?? MIN_REFRESH_SECONDS;
  const maxSeconds = opts.maxSeconds ?? MAX_REFRESH_SECONDS;

  const raw = finiteOrNull(ttlSeconds);
  const ttl = raw === null ? FALLBACK_TTL_SECONDS : clamp(raw, TTL_SANITY_MIN_SECONDS, TTL_SANITY_MAX_SECONDS);
  const seconds = clamp(ttl * ratio, minSeconds, maxSeconds);
  return Math.round(seconds * 1000);
}

export interface ServerSessionTiming {
  ttl_seconds?: unknown;
  refresh_after_seconds?: unknown;
}

/**
 * Decide the next refresh delay from a /api/session/ping response. A server
 * that sends `refresh_after_seconds` wins (still clamped); otherwise the
 * delay is computed from `ttl_seconds`.
 */
export function nextRefreshMs(data: ServerSessionTiming | null | undefined, opts: RefreshTimingOptions = {}): number {
  const serverRefresh = finiteOrNull(data?.refresh_after_seconds);
  if (serverRefresh !== null && serverRefresh > 0) {
    return Math.round(clamp(serverRefresh, opts.minSeconds ?? MIN_REFRESH_SECONDS, opts.maxSeconds ?? MAX_REFRESH_SECONDS) * 1000);
  }
  return refreshDelayMsFromTtl(finiteOrNull(data?.ttl_seconds), opts);
}

export interface BackoffOptions {
  baseMs?: number;
  ceilingMs?: number;
  /** Fraction of the raw delay added as uniform jitter, [0, 1). */
  jitterRatio?: number;
  /** Injectable for deterministic tests. Default Math.random. */
  random?: () => number;
}

export const DEFAULT_BACKOFF = {
  baseMs: 2_000,
  ceilingMs: 60_000,
  jitterRatio: 0.25,
} as const;

/**
 * Exponential backoff for consecutive ping failures:
 *   raw(attempt) = min(ceiling, base * 2^(attempt-1))
 *   delay        = raw + raw * jitterRatio * random()
 * so delay ∈ [raw, raw * (1 + jitterRatio)] and, at the ceiling,
 * delay ∈ [ceiling, ceiling * (1 + jitterRatio)]. attempt is 1-based;
 * values below 1 or fractional are floored/clamped.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const ceilingMs = opts.ceilingMs ?? DEFAULT_BACKOFF.ceilingMs;
  const jitterRatio = opts.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio;
  const random = opts.random ?? Math.random;

  const a = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(a - 1, 40); // guard against 2**1024 -> Infinity
  const raw = Math.min(ceilingMs, baseMs * 2 ** exponent);
  const jitter = raw * jitterRatio * random();
  return Math.round(raw + jitter);
}

/**
 * Expiry timestamp for a freshly confirmed session. `serverExpiresAt` (epoch
 * ms) is trusted only when the server sends one; otherwise computed locally
 * from the TTL so clock skew cannot silently shorten/lengthen the window by
 * more than the machine's offset.
 */
export function computeExpiryMs(nowMs: number, ttlSeconds: number | null | undefined, serverExpiresAtMs?: number | null): number {
  const server = finiteOrNull(serverExpiresAtMs);
  if (server !== null && server > nowMs) return server;
  const raw = finiteOrNull(ttlSeconds);
  const ttl = raw === null ? FALLBACK_TTL_SECONDS : clamp(raw, TTL_SANITY_MIN_SECONDS, TTL_SANITY_MAX_SECONDS);
  return nowMs + ttl * 1000;
}
