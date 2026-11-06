export type StepUpStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "mismatch"
  | "failed"
  | "used"
  | "cancelled";

export interface StepUp {
  id: string;
  kind: "yolo_start" | "agent_checkpoint" | "agent_chase" | "proposal" | "withdraw";
  status: StepUpStatus;
  reason: string | null;
  userCode: string;
  verifyUri: string;
  verifyUriComplete: string;
  expiresAt: number;
  intervalMs: number;
  summary: string;
}

export interface ApiError {
  status: number;
  code?: string;
  error: string;
  retryAfter?: number;
  stepup?: StepUp;
  until?: number;
  retryable: boolean;
  field?: string;
}

export const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);

function retryAfterMs(header: string | null, body: unknown): number | undefined {
  const raw = header ?? (typeof body === "number" ? String(body) : null);
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Date.now() + secs * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}

export async function readApiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {}
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : undefined);
  const until = typeof body?.until === "number" ? toMs(body.until) : undefined;
  return {
    status: res.status,
    code: str("code"),
    error: str("error") ?? (text.trim().slice(0, 200) || `Request failed with ${res.status}`),
    retryAfter: retryAfterMs(res.headers.get("retry-after"), body?.retryAfter),
    stepup: body?.stepup && typeof body.stepup === "object" ? (body.stepup as StepUp) : undefined,
    until,
    retryable: body?.retryable === true || res.status === 502 || res.status === 503,
    field: str("field"),
  };
}

export const needsSession = (e: { status: number; code?: string }) =>
  e.status === 401 && (!e.code || e.code === "session_required");

export function wait(until: number, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const MESSAGES: Record<string, (e: ApiError) => string> = {
  session_required: () => "Your wallet session expired. Sign in again and retry.",
  step_up_required: () => "This needs a fresh approval in World App.",
  human_required: () => "Verify you're human with World ID to do this. Nothing was charged.",
  human_tier_too_low: () => "This needs an Orb-verified World ID. Upgrade to Orb to continue.",
  human_mismatch: () => "This wallet or World ID is already linked to a different human.",
  banned: () => "This account is blocked from trading.",
  stepup_denied: () => "The approval was denied. Nothing happened, no money moved.",
  human_exposure_cap: (e) =>
    `Your open stakes across all your wallets would pass your limit. ${e.error}`,
  human_daily_loss: (e) =>
    `Daily loss limit reached across your wallets.${e.until ? ` Trading resumes in ${wait(e.until)}.` : ""}`,
  human_cooloff: (e) =>
    `Cool-off after hitting your loss limit.${e.until ? ` Trading resumes in ${wait(e.until)}.` : ""}`,
  stepup_pending: () => "An approval is already waiting. Finish it in World App first.",
  stepup_used: () => "That approval was already used. Request a new one.",
  stepup_expired: () => "The approval expired. Nothing happened, no money moved.",
  stepup_cancelled: () => "Approval cancelled. Nothing happened, no money moved.",
  stepup_mismatch: () =>
    "A different World ID approved this than the one linked to you. Nothing happened, no money moved.",
  stepup_failed: () => "World could not finish the approval. Nothing happened, no money moved.",
  attempt_expired: () => "The World ID check expired. Start it again.",
  not_paused: () => "The agent is not paused anymore.",
  agent_running: () => "You already have an agent running. Stop it before starting another.",
  not_found: () => "That approval is gone. Start the action again.",
  withdraw_cap: (e) => e.error,
  insufficient_balance: () => "Not enough balance for this.",
  frozen: () => "This account is frozen.",
  dev_bypass: () => "Dev mode: World ID is bypassed on this server, every wallet already counts as verified.",
  duplicate: (e) => e.error,
  price_moved: () => "The price moved before your bet landed. Nothing was charged, try again.",
  betting_closed: () => "Betting on this round has closed. Pick a later one.",
  market_quiet: () => "This market is too quiet to bet on right now.",
  blitz_inactive: () => "Blitz is not running right now. Wait for the next window.",
  market_closed: () => "This market is closed.",
  price_unavailable: () => "The live price is unavailable. Nothing was charged, try again shortly.",
  proposal_expired: () => "This proposal expired. Nothing was placed.",
  invalid_body: (e) => (e.field ? `Invalid ${e.field}: ${e.error}` : e.error),
  rate_limited: (e) =>
    `Too many requests.${e.retryAfter ? ` Try again in ${wait(e.retryAfter)}.` : " Try again shortly."}`,
  daily_cap: (e) =>
    `Daily limit reached.${e.retryAfter ? ` Try again in ${wait(e.retryAfter)}.` : ""}`,
  world_unavailable: () => "World is unavailable right now. Nothing happened, try again.",
  world_unconfigured: () =>
    "World ID is not configured on this server, so this action is turned off.",
};

export function errorMessage(e: ApiError): string {
  const known = e.code && MESSAGES[e.code];
  if (known) return known(e);
  if (e.status === 429) return MESSAGES.rate_limited(e);
  if (e.retryable || e.status >= 500)
    return `${e.error}. Nothing happened, try again.`.replace(/\.\. /, ". ");
  return e.error;
}

export class ApiFailure extends Error {
  constructor(public api: ApiError) {
    super(errorMessage(api));
    this.name = "ApiFailure";
  }
}

export async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ApiFailure(await readApiError(res));
  return res.json() as Promise<T>;
}
