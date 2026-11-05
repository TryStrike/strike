/** Shared by concurrency.mjs: env, token minting, HTTP and DB helpers. */
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(HERE, '../../package.json'));
export const { ethers } = require('ethers');

export const ENV = Object.fromEntries(
  readFileSync(resolve(HERE, '.env.bench'), 'utf8').split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
export const WORK = process.env.BENCH_WORK || resolve(process.env.TMPDIR || tmpdir(), 'strike-bench');
export const SERVER = { url: 'http://127.0.0.1:4400', sqlite: resolve(WORK, 'bench.sqlite') };
export const STUB = `http://127.0.0.1:${ENV.STUB_PORT}`;

// --- token algorithms, same as backend/parity/emit.mjs ---------------------
const b64url = (v) => Buffer.from(v, 'utf8').toString('base64url');
const sign = (input, secret) => createHmac('sha256', secret).update(input).digest('base64url');

export function mintSession(ttl = 43200, secret = ENV.BALANCE_INTERNAL_SECRET) {
  const payload = b64url(JSON.stringify({ v: 1, exp: Math.floor(Date.now() / 1000) + ttl, n: randomBytes(16).toString('hex') }));
  return `${payload}.${sign(payload, secret)}`;
}
export function mintSettlement(payload, ttl = 300, secret = ENV.BALANCE_SETTLEMENT_SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttl }));
  return `${body}.${sign(body, secret)}`;
}
export function mintAdmin(iat = Math.floor(Date.now() / 1000), password = ENV.DASHBOARD_PASSWORD) {
  const sig = createHmac('sha256', password).update(`admin:${iat}`).digest('hex');
  return b64url(JSON.stringify({ iat, sig }));
}

// --- deterministic wallets --------------------------------------------------
export const key = (n) => ethers.id(`strike-bench-wallet-${n}`);
export const wallet = (n) => new ethers.Wallet(key(n));
export const addr = (n) => wallet(n).address.toLowerCase();

export async function signWithdrawal(w, amount, signedAt, address = w.address, currency = 'USDC') {
  const message = `STRIKE withdrawal authorization\naddress:${address}\namount:${amount.toFixed(8)}\ncurrency:${currency}\nsignedAt:${signedAt}`;
  return w.signMessage(message);
}

// --- transport --------------------------------------------------------------
const COOKIE = { session: 'strike_balance_gate', admin: 'strike_admin_session' };

export function authHeaders(auth) {
  switch (auth) {
    case 'bearer': return { authorization: `Bearer ${ENV.BALANCE_INTERNAL_SECRET}` };
    case 'session': return { cookie: `${COOKIE.session}=${mintSession()}` };
    case 'session-expired': return { cookie: `${COOKIE.session}=${mintSession(-60)}` };
    case 'session-forged': return { cookie: `${COOKIE.session}=${mintSession(3600, 'wrong')}` };
    case 'browser-key': return { 'x-strike-balance-key': ENV.BALANCE_INTERNAL_SECRET };
    case 'admin': return { cookie: `${COOKIE.admin}=${mintAdmin()}` };
    case 'admin-expired': return { cookie: `${COOKIE.admin}=${mintAdmin(Math.floor(Date.now() / 1000) - 9 * 3600)}` };
    case 'admin-forged': return { cookie: `${COOKIE.admin}=${mintAdmin(undefined, 'wrong')}` };
    default: return {};
  }
}

/** spec: { m, p, auth, h, body (json), raw (string) } */
export async function call(server, spec, timeoutMs = 20000) {
  const headers = { ...authHeaders(spec.auth), ...(spec.h ?? {}) };
  let payload;
  if (spec.raw !== undefined) { payload = spec.raw; headers['content-type'] ??= 'application/json'; }
  else if (spec.body !== undefined) { payload = JSON.stringify(spec.body); headers['content-type'] = 'application/json'; }
  const started = performance.now();
  try {
    const res = await fetch(server.url + spec.p, {
      method: spec.m ?? 'GET', headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* non-JSON stays in text */ }
    return { status: res.status, headers: res.headers, text, json, ms: performance.now() - started };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: String(e.cause?.code ?? e.name ?? e), ms: performance.now() - started };
  }
}

export async function stub(path, body) {
  const res = await fetch(STUB + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

// The ledger keeps NUMERIC as value * 10^scale and timestamps as microseconds. Decode
// to decimal strings and Dates, which is what the checks compare.
const SCALE = { balance: 10, amount: 10, balance_before: 10, balance_after: 10, fee_amount: 10, net_amount: 10, payout: 10, max_payout: 10, stake: 10, multiplier: 4, strike_price: 8, end_price: 8 };
const TIMES = new Set(['created_at', 'updated_at', 'resolved_at', 'requested_at', 'decided_at', 'used_at', 'started_at', 'last_ping_at', 'ended_at', 'end_time', 'consumed_at', 'locked_at']);
const BOOLS = new Set(['won', 'is_used']);
export function fromFixed(v, scale) {
  const neg = v < 0n; const a = neg ? -v : v;
  const s = a.toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -scale)}.${s.slice(-scale)}`;
}
function decodeSqlite(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== 'bigint') { out[k] = v; continue; }
    if (SCALE[k]) out[k] = fromFixed(v, SCALE[k]);
    else if (TIMES.has(k)) out[k] = new Date(Number(v / 1000n));
    else if (BOOLS.has(k)) out[k] = v === 1n;
    else out[k] = Number(v);
  }
  return out;
}
const toFixed10 = (v) => BigInt(Math.round(Number(v) * 1e6)) * 10000n;

export function db(server) {
  const { DatabaseSync } = require('node:sqlite');
  const conn = new DatabaseSync(server.sqlite);
  conn.exec('PRAGMA busy_timeout = 5000');
  return {
    q: async (sql, args = []) => {
      const stmt = conn.prepare(sql.replace(/\$(\d+)/g, '?$1').replace(/::int/g, ''));
      stmt.setReadBigInts(true);
      return /^\s*select/i.test(sql) ? stmt.all(...args).map(decodeSqlite) : (stmt.run(...args), []);
    },
    money: toFixed10,
    end: async () => conn.close(),
  };
}

/** A funded wallet row plus the audit row that explains its opening balance. */
export async function fund(d, address, amount, { deposited = amount } = {}) {
  await d.q(
    `INSERT INTO user_balances (user_address, currency, balance) VALUES ($1,'USDC',$2)
     ON CONFLICT (user_address, currency) DO UPDATE SET balance = EXCLUDED.balance`, [address, d.money(amount)]);
  await d.q(
    `INSERT INTO balance_audit_log (user_address, currency, operation_type, amount, balance_before, balance_after, transaction_hash)
     VALUES ($1,'USDC','deposit',$2,0,$3,$4)`, [address, d.money(deposited), d.money(amount), `fund:${address}:${randomBytes(4).toString('hex')}`]);
}

/**
 * balances must equal signed audit movements, and the before/after chain must be
 * unbroken. Lock rows carry no money. Returns problems as strings.
 */
export const SIGN = { deposit: 1, payout: 1, bet_won: 1, refund: 1, withdrawal: -1, bet_placed: -1 };
const units = (v) => BigInt(String(v ?? 0).replace('.', '').padEnd(String(v ?? 0).split('.')[0].length + 10, '0').slice(0, String(v ?? 0).split('.')[0].length + 10));

export async function reconcile(d, address, opening) {
  const rows = await d.q(
    `SELECT id, operation_type, amount, balance_before, balance_after FROM balance_audit_log
     WHERE user_address = $1 AND currency = 'USDC' ORDER BY id`, [address]);
  const [bal] = await d.q(`SELECT balance FROM user_balances WHERE user_address = $1 AND currency = 'USDC'`, [address]);
  const problems = [];
  if (!bal) return ['no balance row'];
  const actual = units(bal.balance);
  if (actual < 0n) problems.push(`negative balance ${bal.balance}`);
  let sum = 0n;
  let chain = null;
  for (const r of rows) {
    const s = SIGN[r.operation_type];
    if (!s) continue;
    const isOpening = r.balance_before !== null && units(r.balance_before) === 0n && chain === null;
    sum += isOpening ? units(r.balance_after) : BigInt(s) * units(r.amount);
    if (chain !== null && r.balance_before !== null && units(r.balance_before) !== chain) {
      problems.push(`audit chain break at id ${r.id}: before=${r.balance_before}`);
    }
    if (r.balance_after !== null) chain = units(r.balance_after);
  }
  if (sum !== actual) problems.push(`ledger ${bal.balance} != audit sum ${Number(sum) / 1e10}`);
  if (opening !== undefined && units(opening) > actual && rows.length === 0) problems.push('balance moved with no audit rows');
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // self-check: fixed-point conversion underpins reconcile().
  const assert = (await import('node:assert')).strict;
  assert.equal(units('1.5'), 15000000000n);
  assert.equal(units('0.0000000001'), 1n);
  assert.equal(units('100'), 1000000000000n);
  assert.equal(units('12.3456789012'), 123456789012n);
  assert.equal(fromFixed(15000000000n, 10), '1.5000000000');
  assert.equal(fromFixed(1n, 10), '0.0000000001');
  assert.equal(fromFixed(83394n, 4), '8.3394');
  assert.equal(toFixed10(40), 400000000000n);
  console.log('lib ok');
}
