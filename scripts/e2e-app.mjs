/**
 * End-to-end check of the full money path against a running app on Arc Testnet:
 * fund a fresh player -> on-chain USDC deposit into StrikeTreasury -> credit ->
 * bet -> signed withdrawal request -> admin accept -> on-chain payout.
 *
 * Usage (app running, .env.local pointing at Arc Testnet):
 *   APP_URL=http://localhost:3100 node scripts/e2e-app.mjs
 *
 * The treasury owner key (ARC_TREASURY_SECRET_KEY) funds the throwaway player.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['.env.local', '.env']) {
  const envPath = resolve(root, file);
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const APP = process.env.APP_URL || 'http://localhost:3000';
const chainId = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID);
assert.equal(chainId, 5042002, 'refusing to run outside Arc Testnet');

const provider = new ethers.JsonRpcProvider(process.env.NEXT_PUBLIC_ARC_RPC_ENDPOINT, chainId);
const owner = new ethers.Wallet(process.env.ARC_TREASURY_SECRET_KEY, provider);
const player = ethers.Wallet.createRandom().connect(provider);
const usdcAbi = [
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];
const usdc = new ethers.Contract(process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS, usdcAbi, owner);
const treasury = process.env.NEXT_PUBLIC_TREASURY_ADDRESS;
const u = (n) => ethers.parseUnits(String(n), 6);

let cookie = '';
async function api(path, body, extra = {}) {
  const res = await fetch(APP + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP, cookie, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) {
    const jar = new Map(cookie.split('; ').filter(Boolean).map((c) => c.split('=')));
    for (const c of set) { const [kv] = c.split(';'); const [k, ...v] = kv.split('='); jar.set(k, v.join('=')); }
    cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const step = (s) => console.log(`\n▶ ${s}`);

step(`player ${player.address}: fund 1 USDC (+ gas) from owner`);
await (await usdc.transfer(player.address, u(1.05))).wait();

step('deposit 1 USDC into StrikeTreasury (ERC-20 transfer)');
const dep = await (await usdc.connect(player).transfer(treasury, u(1))).wait();
console.log(`  tx ${dep.hash}`);

step('open balance session and credit the deposit');
assert.equal((await api('/api/balance/session', {})).status, 200);
let r = await api('/api/balance/deposit', { userAddress: player.address, amount: 1, txHash: dep.hash, currency: 'USDC' });
console.log(' ', r.status, JSON.stringify(r.json));
assert.equal(r.status, 200, 'deposit not credited');

step('replaying the same deposit tx is refused');
r = await api('/api/balance/deposit', { userAddress: player.address, amount: 1, txHash: dep.hash, currency: 'USDC' });
console.log(' ', r.status, JSON.stringify(r.json));
assert.notEqual(r.status, 200, 'replayed deposit was credited twice');

step('balance');
r = await api(`/api/balance/${player.address}`);
console.log(' ', JSON.stringify(r.json));

step('place a 0.1 USDC bet from the house balance (no wallet signature)');
r = await api('/api/balance/bet', {
  userAddress: player.address, betAmount: 0.1, currency: 'USDC', roundId: Date.now(),
  targetPrice: 0, isOver: true, multiplier: 1.9, targetCell: { id: 1, priceChange: 0 },
});
console.log(' ', r.status, JSON.stringify(r.json).slice(0, 200));
assert.equal(r.status, 200, 'bet rejected');

step('signed withdrawal request for 0.5 USDC');
const amount = 0.5;
const signedAt = Date.now();
const msg = `STRIKE withdrawal authorization\naddress:${player.address}\namount:${amount.toFixed(8)}\ncurrency:USDC\nsignedAt:${signedAt}`;
const signature = await player.signMessage(msg);
r = await api('/api/balance/withdraw', { userAddress: player.address, amount, currency: 'USDC', signature, signedAt });
console.log(' ', r.status, JSON.stringify(r.json));
assert.equal(r.status, 200, 'withdrawal request rejected');
const requestId = r.json.requestId;

step('a forged signature is refused');
const forged = await ethers.Wallet.createRandom().signMessage(msg);
r = await api('/api/balance/withdraw', { userAddress: player.address, amount, currency: 'USDC', signature: forged, signedAt });
console.log(' ', r.status, JSON.stringify(r.json));
assert.equal(r.status, 401);

step(`admin accepts request #${requestId} -> StrikeTreasury.withdrawTokenTo`);
assert.equal((await api('/api/admin/auth', { password: process.env.DASHBOARD_PASSWORD })).status, 200);
const before = await usdc.balanceOf(player.address);
r = await api(`/api/admin/withdrawal-requests/${requestId}/accept`, {});
console.log(' ', r.status, JSON.stringify(r.json));
assert.equal(r.status, 200, 'accept failed');
const after = await usdc.balanceOf(player.address);
console.log(`  player USDC ${ethers.formatUnits(before, 6)} -> ${ethers.formatUnits(after, 6)}`);
assert.ok(after > before, 'no on-chain payout reached the player');

console.log('\nAll app e2e steps passed.');
