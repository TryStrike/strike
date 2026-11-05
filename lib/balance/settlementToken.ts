import { createHmac, timingSafeEqual } from 'crypto';

// Settlement tokens should have short TTL to minimize window of attack if intercepted
// 5 minutes is enough for a bet to resolve while limiting exposure
const DEFAULT_TTL_SECONDS = 5 * 60;

interface SettlementTokenPayload {
  betId: string;
  userAddress: string;
  currency: string;
  maxPayout: number;
  iat: number;
  exp: number;
}

function getSettlementSecret(): string {
  // IMPORTANT: Must use a separate dedicated secret for settlement tokens
  // Never fall back to BALANCE_INTERNAL_SECRET as that increases attack surface
  const secret = process.env.BALANCE_SETTLEMENT_SECRET?.trim();
  if (!secret) {
    throw new Error('BALANCE_SETTLEMENT_SECRET is not configured. This is required for secure bet settlement.');
  }
  return secret;
}

/** True when the server can sign settlement tokens for bets (env is set). */
export function isBalanceSettlementSigningConfigured(): boolean {
  return Boolean(process.env.BALANCE_SETTLEMENT_SECRET?.trim());
}

function base64urlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64urlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

export function createSettlementToken(
  payload: Omit<SettlementTokenPayload, 'iat' | 'exp'>,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const secret = getSettlementSecret();
  const now = Math.floor(Date.now() / 1000);
  const full: SettlementTokenPayload = {
    ...payload,
    iat: now,
    exp: now + Math.max(60, Math.floor(ttlSeconds)),
  };

  const encodedPayload = base64urlEncode(JSON.stringify(full));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifySettlementToken(token?: string | null): SettlementTokenPayload | null {
  if (!token) return null;

  const secret = getSettlementSecret();
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, providedSig] = parts;
  if (!encodedPayload || !providedSig) return null;

  const expectedSig = sign(encodedPayload, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(base64urlDecode(encodedPayload)) as SettlementTokenPayload;
    const now = Math.floor(Date.now() / 1000);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.betId || !parsed.userAddress || !parsed.currency) return null;
    if (!Number.isFinite(parsed.maxPayout) || parsed.maxPayout <= 0) return null;
    if (!Number.isFinite(parsed.exp) || parsed.exp < now) return null;
    return parsed;
  } catch {
    return null;
  }
}
