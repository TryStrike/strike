#!/usr/bin/env node
/**
 * Token parity harness.
 *
 * The functions below are transcriptions of the production TypeScript in
 * lib/balance/balanceSession.ts, lib/balance/settlementToken.ts and
 * lib/admin/adminToken.ts. They are kept here instead of imported because the
 * service is TypeScript and this harness must run without a build step.
 *
 *   node backend/parity/emit.mjs                -> writes vectors.json  (TS-minted)
 *   node backend/parity/emit.mjs --verify FILE  -> verifies Rust-minted tokens
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SESSION_VERSION = 1;
const TTL_SECONDS = 60 * 60 * 12;
const DEFAULT_TTL_SECONDS = 5 * 60;
const ADMIN_TTL_SECONDS = 8 * 3600;

// vectors.json is committed and read by `cargo test`, so the fixtures it holds
// outlive the production windows: expiry is carried inside each payload, and
// both verifiers only compare it against the clock. Minting long-lived ones
// keeps the cross-check reproducible instead of green-for-eight-hours.
const FIXTURE_TTL_SECONDS = 30 * 24 * 3600;

// Fixed secrets so both sides sign with the same key regardless of .env.
const SECRETS = {
  internal: 'parity-internal-secret',
  settlement: 'parity-settlement-secret',
  dashboard: 'parity-dashboard-password',
};

function b64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}
function sign(input, secret) {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

// --- minters (verbatim from the TS) -----------------------------------------

function mintBalanceSession(secret, ttlSeconds = TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const n = randomBytes(16).toString('hex');
  const payload = b64url(JSON.stringify({ v: SESSION_VERSION, exp, n }));
  const sig = sign(payload, secret);
  return `${payload}.${sig}`;
}

function createSettlementToken(payload, secret, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const full = {
    ...payload,
    iat: now,
    exp: now + Math.max(60, Math.floor(ttlSeconds)),
  };
  const encodedPayload = b64url(JSON.stringify(full));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function issueAdminToken(password) {
  const iat = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', password).update(`admin:${iat}`).digest('hex');
  return b64url(JSON.stringify({ iat, sig }));
}

// --- verifiers (verbatim from the TS) ---------------------------------------

function verifyBalanceSession(raw, secret) {
  if (!raw) return false;
  const parts = raw.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!payload || !sig) return false;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.v !== SESSION_VERSION || typeof decoded.exp !== 'number') return false;
    return decoded.exp >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function verifySettlementToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, providedSig] = parts;
  if (!encodedPayload || !providedSig) return null;
  const expected = sign(encodedPayload, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
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

function verifyAdminToken(token, password, ttlSeconds = ADMIN_TTL_SECONDS) {
  if (!token) return false;
  try {
    const { iat, sig } = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof iat !== 'number' || typeof sig !== 'string') return false;
    const age = Math.floor(Date.now() / 1000) - iat;
    if (age < 0 || age > ttlSeconds) return false;
    const expected = createHmac('sha256', password).update(`admin:${iat}`).digest('hex');
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

// --- cli -------------------------------------------------------------------

const SETTLEMENT_INPUT = {
  betId: 'bet-parity-1',
  userAddress: '0x1111111111111111111111111111111111111111',
  currency: 'USDC',
  maxPayout: 7.25,
};

if (process.argv[2] === '--verify') {
  const file = process.argv[3];
  if (!file) {
    console.error('usage: emit.mjs --verify <rust-tokens.json>');
    process.exit(2);
  }
  const rust = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const checks = [
    ['session', verifyBalanceSession(rust.session, SECRETS.internal), true],
    ['settlement', verifySettlementToken(rust.settlement, SECRETS.settlement) !== null, true],
    [
      'settlement-fields',
      verifySettlementToken(rust.settlement, SECRETS.settlement)?.betId,
      rust.expectedBetId,
    ],
    ['admin', verifyAdminToken(rust.admin, SECRETS.dashboard), true],
    // Negative controls: a Rust token must NOT validate under a wrong secret,
    // otherwise the signature is doing nothing.
    ['session-rejects-wrong-secret', verifyBalanceSession(rust.session, 'nope'), false],
    ['admin-rejects-wrong-secret', verifyAdminToken(rust.admin, 'nope'), false],
  ];
  let failed = 0;
  for (const [name, actual, expected] of checks) {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  }
  if (failed) {
    console.error(`${failed} Rust->TS parity check(s) failed`);
    process.exit(1);
  }
  console.log('Rust-minted tokens verify under the TypeScript implementation.');
  process.exit(0);
}

const vectors = {
  secrets: SECRETS,
  // How long the TS-minted fixtures stay valid, read by the Rust test so it can
  // apply the same window instead of the production one.
  adminTtlSeconds: FIXTURE_TTL_SECONDS,
  typescript: {
    session: mintBalanceSession(SECRETS.internal, FIXTURE_TTL_SECONDS),
    settlement: createSettlementToken(SETTLEMENT_INPUT, SECRETS.settlement, FIXTURE_TTL_SECONDS),
    admin: issueAdminToken(SECRETS.dashboard),
  },
  expected: SETTLEMENT_INPUT,
};

writeFileSync(resolve(HERE, 'vectors.json'), JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${resolve(HERE, 'vectors.json')}`);
