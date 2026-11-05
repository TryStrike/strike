
export const FALLBACK_TTL_SECONDS = 90;

export const MIN_REFRESH_SECONDS = 5;

export const MAX_REFRESH_SECONDS = 60;

export const DEFAULT_REFRESH_RATIO = 0.5;

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
  ratio?: number;
  minSeconds?: number;
  maxSeconds?: number;
}

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
  jitterRatio?: number;
  random?: () => number;
}

export const DEFAULT_BACKOFF = {
  baseMs: 2_000,
  ceilingMs: 60_000,
  jitterRatio: 0.25,
} as const;

export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const ceilingMs = opts.ceilingMs ?? DEFAULT_BACKOFF.ceilingMs;
  const jitterRatio = opts.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio;
  const random = opts.random ?? Math.random;

  const a = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(a - 1, 40);
  const raw = Math.min(ceilingMs, baseMs * 2 ** exponent);
  const jitter = raw * jitterRatio * random();
  return Math.round(raw + jitter);
}

export function computeExpiryMs(nowMs: number, ttlSeconds: number | null | undefined, serverExpiresAtMs?: number | null): number {
  const server = finiteOrNull(serverExpiresAtMs);
  if (server !== null && server > nowMs) return server;
  const raw = finiteOrNull(ttlSeconds);
  const ttl = raw === null ? FALLBACK_TTL_SECONDS : clamp(raw, TTL_SANITY_MIN_SECONDS, TTL_SANITY_MAX_SECONDS);
  return nowMs + ttl * 1000;
}
