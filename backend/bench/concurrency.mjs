#!/usr/bin/env node
/**
 * Money invariants under real parallelism.
 *
 *   backend/bench/servers.sh setup && backend/bench/servers.sh reset && backend/bench/servers.sh start
 *   node backend/bench/concurrency.mjs [--rounds=5] [--n=32]
 *   backend/bench/servers.sh stop-all
 *
 * Every round uses brand-new wallets, so rounds are independent and repeated
 * races show up as a violation count rather than a single lucky pass. After each
 * test every touched wallet is reconciled against balance_audit_log.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HERE, SERVER, ENV, call, stub, db, fund, reconcile, ethers, signWithdrawal, mintSettlement } from './lib.mjs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROUNDS = Number(arg('rounds', 5));
const N = Number(arg('n', 32));
const tag = arg('tag', 'concurrency');

const fresh = () => ethers.Wallet.createRandom();
const reqId = () => randomBytes(12).toString('hex');
const STRIKE = 100;
const MULTIPLIER = 1.75; // the classic 5 s tier
const ROUND_MS = 5000;
const SAMPLE_MS = 1300; // long enough for one sample to land
const bet = (address, amount, id, direction = 'UP') => ({
  userAddress: address, betAmount: amount, currency: 'USDC', roundId: 7, asset: 'BTC', mode: 'binomo',
  targetPrice: STRIKE, strikePrice: STRIKE, isOver: direction === 'UP', multiplier: MULTIPLIER,
  targetCell: { id: 1, priceChange: 0.5, direction, timeframe: 5 }, betRequestId: id,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The market, as far as the server's sampler can tell. */
const setPrice = async (price) => { await stub('/__price', { BTCUSDT: price }); await sleep(SAMPLE_MS); };
const claim = (s, a, b, over = {}) => call(s, { m: 'POST', p: '/api/balance/win', auth: 'bearer', body: { userAddress: a, winAmount: 17.5, currency: 'USDC', betId: b.betId, settlementToken: b.settlementToken, ...over } });
const openRound = async (s, a, amount, direction) => (await call(s, { m: 'POST', p: '/api/balance/bet', auth: 'bearer', body: bet(a, amount, reqId(), direction) })).json;
const roundOver = () => sleep(ROUND_MS - SAMPLE_MS + 300);
/** Exact, in 1e-10 units: stake floored to 8 decimals after the multiplier. */
const payoutUnits = (stake) => {
  const [whole, fraction = ''] = String(stake).split('.');
  const product = BigInt(whole + fraction.padEnd(10, '0')) * 17500n; // units of 1e-14
  return (product / 10n ** 6n) * 100n; // floored to 1e-8, back in units of 1e-10
};
const tally = (rs) => rs.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
const parallel = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const balanceOf = async (d, a) => Number((await d.q(`SELECT balance FROM user_balances WHERE user_address=$1 AND currency='USDC'`, [a]))[0]?.balance ?? 0);
const count = async (d, a, op) => Number((await d.q(`SELECT count(*)::int c FROM balance_audit_log WHERE user_address=$1 AND operation_type=$2`, [a, op]))[0].c);
const paidTo = async (address) => (await stub('/__stats')).sent.filter((t) => t.to === address.toLowerCase());
const sumUnits = (txs) => txs.reduce((s, t) => s + Number(t.amount), 0) / 1e6;

const TESTS = {
  /** N identical bets, one key: exactly one debit. */
  async idempotent_bet(s, d, v) {
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100);
    const id = reqId();
    const rs = await parallel(N, () => call(s, { m: 'POST', p: '/api/balance/bet', auth: 'bearer', body: bet(a, 1, id) }));
    const bal = await balanceOf(d, a);
    const placed = await count(d, a, 'bet_placed');
    if (bal !== 99) v.push(`balance ${bal}, want 99`);
    if (placed !== 1) v.push(`${placed} bet_placed rows`);
    const ids = new Set(rs.filter((r) => r.status === 200).map((r) => r.json?.betId));
    if (ids.size > 1) v.push(`${ids.size} distinct betIds for one key`);
    return { wallets: [a], statuses: tally(rs), balance: bal, placed };
  },

  /** Distinct bets totalling far more than the balance: stop exactly at zero. */
  async overspend_bets(s, d, v) {
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 10);
    const rs = await parallel(N, () => call(s, { m: 'POST', p: '/api/balance/bet', auth: 'bearer', body: bet(a, 1, reqId()) }));
    const bal = await balanceOf(d, a);
    const ok = rs.filter((r) => r.status === 200).length;
    if (bal < 0) v.push(`negative balance ${bal}`);
    if (ok > 10) v.push(`${ok} bets accepted on a balance of 10`);
    if (bal !== 10 - ok) v.push(`balance ${bal} after ${ok} accepted bets`);
    if (ok !== 10) v.push(`only ${ok}/10 affordable bets accepted (failure, not a safety violation)`);
    return { wallets: [a], statuses: tally(rs), accepted: ok, balance: bal };
  },

  /** One winning round claimed N times at once, racing the sweep: pays once. */
  async parallel_settlement(s, d, v) {
    await setPrice(STRIKE);
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100);
    const b = await openRound(s, a, 10, 'UP');
    await setPrice(STRIKE + 10);
    await roundOver();
    const rs = await parallel(N, () => claim(s, a, b));
    const bal = await balanceOf(d, a);
    const won = await count(d, a, 'bet_won') + await count(d, a, 'payout');
    const fresh200 = rs.filter((r) => r.status === 200 && !r.json?.duplicate).length;
    await stub('/__price', { BTCUSDT: STRIKE });
    if (bal !== 107.5) v.push(`balance ${bal}, want 107.5`);
    if (won !== 1) v.push(`${won} payout rows`);
    if (fresh200 > 1) v.push(`${fresh200} non-duplicate 200s`);
    if (rs.some((r) => r.status !== 200 || r.json?.payout !== 17.5)) v.push('a claim did not get the server result');
    return { wallets: [a], statuses: tally(rs), balance: bal, won };
  },

  /**
   * Every way a client can ask to be paid for a round it lost, or has not finished,
   * in parallel: early, inflated, no token, a forged token, another bet's token, and a
   * token signed with the real secret for a bet that does not exist.
   */
  async forged_wins_never_paid(s, d, v) {
    await setPrice(STRIKE);
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100);
    const lost = await openRound(s, a, 10, 'UP');
    const other = await openRound(s, a, 10, 'DOWN');
    const forgeries = () => [
      {},
      { winAmount: 1e9 },
      { settlementToken: undefined },
      { settlementToken: 'abc.def' },
      { settlementToken: mintSettlement({ betId: lost.betId, userAddress: a, currency: 'USDC', maxPayout: 1e9 }, 300, 'wrong-secret') },
      { settlementToken: other.settlementToken },
      { betId: 'bet_invented', settlementToken: mintSettlement({ betId: 'bet_invented', userAddress: a, currency: 'USDC', maxPayout: 1e9 }) },
      { strikePrice: 1, endPrice: 1e9, won: true, payout: 1e9 },
    ];
    const early = await parallel(N, (i) => claim(s, a, lost, forgeries()[i % 8]));
    const beforeEnd = await balanceOf(d, a);
    if (beforeEnd !== 80) v.push(`paid before the round ended: balance ${beforeEnd}, want 80`);

    await setPrice(STRIKE - 10); // UP loses, DOWN wins
    await roundOver();
    const late = await parallel(N, (i) => claim(s, a, lost, forgeries()[i % 8]));
    await sleep(1200);
    const bal = await balanceOf(d, a);
    const paid = await count(d, a, 'payout');
    await stub('/__price', { BTCUSDT: STRIKE });
    // Only the DOWN round won, and it pays its own 17.5.
    if (bal !== 97.5) v.push(`balance ${bal}, want 97.5`);
    if (paid !== 1) v.push(`${paid} payout rows, want 1`);
    return { wallets: [a], early: tally(early), late: tally(late), balance: bal, paid };
  },

  /**
   * Mixed stakes, sides and claimants: what left the house equals, to the last unit,
   * what the terms and the prices say it should, computed here independently.
   */
  async total_paid_equals_server_computed(s, d, v) {
    await setPrice(STRIKE);
    const stakes = [1, 0.1, 0.123456, 1.234567, 7.7, 0.000003, 3.333333, 12.5];
    const placed = await parallel(stakes.length, async (i) => {
      const a = fresh().address.toLowerCase();
      await fund(d, a, 100);
      const direction = i % 2 === 0 ? 'UP' : 'DOWN';
      return { a, stake: stakes[i], direction, ticket: await openRound(s, a, stakes[i], direction) };
    });
    await setPrice(STRIKE + 1);
    await roundOver();
    // Half claim, half are left to the sweep. Everyone claims with a lie about the amount.
    await parallel(placed.length, (i) => (i % 4 < 2 ? claim(s, placed[i].a, placed[i].ticket, { winAmount: 1e6 }) : null));
    await sleep(1500);
    await stub('/__price', { BTCUSDT: STRIKE });

    const wallets = placed.map((p) => p.a);
    const want = placed.filter((p) => p.direction === 'UP').reduce((sum, p) => sum + payoutUnits(p.stake), 0n);
    const list = wallets.map((_, i) => `$${i + 1}`).join(',');
    const sumOf = async (sql) => BigInt((await d.q(sql, wallets))[0].total ?? 0);
    const paidAudit = await sumOf(`SELECT CAST(sum(amount) AS TEXT) total FROM balance_audit_log WHERE operation_type = 'payout' AND user_address IN (${list})`);
    const paidRounds = await sumOf(`SELECT CAST(sum(payout) AS TEXT) total FROM bet_rounds WHERE user_address IN (${list})`);
    const open = (await d.q(`SELECT count(*) c FROM bet_rounds WHERE outcome IS NULL AND user_address IN (${list})`, wallets))[0].c;
    if (open) v.push(`${open} rounds left open`);
    if (paidAudit !== want) v.push(`ledger paid ${paidAudit}, terms say ${want}`);
    if (paidRounds !== want) v.push(`rounds record ${paidRounds}, terms say ${want}`);
    return { wallets, paidUnits: String(paidAudit), wantUnits: String(want) };
  },

  /** Same deposit hash N times at once, then again serially: credits once. */
  async repeat_deposit(s, d, v) {
    const w = fresh(); const a = w.address.toLowerCase();
    const txHash = `0x${randomBytes(32).toString('hex')}`;
    await stub('/__tx', { hash: txHash, from: a, amount: 100_000000, payTo: ENV.NEXT_PUBLIC_TREASURY_ADDRESS });
    const feeBefore = (await paidTo(ENV.NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC)).length;
    const body = { userAddress: a, amount: 100, txHash, currency: 'USDC' };
    const rs = await parallel(N, () => call(s, { m: 'POST', p: '/api/balance/deposit', auth: 'bearer', body }));
    const again = await call(s, { m: 'POST', p: '/api/balance/deposit', auth: 'bearer', body });
    const bal = await balanceOf(d, a);
    const deposits = await count(d, a, 'deposit');
    const feeTxs = (await paidTo(ENV.NEXT_PUBLIC_PLATFORM_FEE_WALLET_ARC)).length - feeBefore;
    if (bal !== 90) v.push(`balance ${bal}, want 90 (100 less 10% fee)`);
    if (deposits !== 1) v.push(`${deposits} deposit rows`);
    if (again.status !== 409) v.push(`serial repeat answered ${again.status}`);
    if (feeTxs !== 1) v.push(`${feeTxs} fee transfers`);
    return { wallets: [a], statuses: tally(rs), repeat: again.status, balance: bal, deposits, feeTxs };
  },

  /**
   * Parallel intents summing past the balance, with deposit history large enough
   * that the 1.08x cap cannot be what stops them. Then every queued request is
   * accepted at once. Treasury payouts must never exceed what the ledger debited.
   */
  async parallel_withdrawals_accept(s, d, v) {
    await stub('/__ctl', { nonce: 'strict' });
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100, { deposited: 100000 });
    const now = Date.now();
    const rs = await parallel(8, async (i) => {
      const signedAt = now + i;
      return call(s, { m: 'POST', p: '/api/balance/withdraw', auth: 'bearer', body: { userAddress: a, amount: 40, currency: 'USDC', signedAt, signature: await signWithdrawal(w, 40, signedAt, a) } });
    });
    const ids = rs.filter((r) => r.status === 200).map((r) => r.json.requestId);
    const accepts = await parallel(ids.length, (i) => call(s, { m: 'POST', p: `/api/admin/withdrawal-requests/${ids[i]}/accept`, auth: 'admin' }, 30000));
    await stub('/__ctl', { nonce: 'strict' });
    const bal = await balanceOf(d, a);
    const payouts = await paidTo(a);
    const paidNet = sumUnits(payouts);
    const debited = await count(d, a, 'withdrawal');
    const rows = await d.q(`SELECT status, count(*)::int c FROM withdrawal_requests WHERE user_address=$1 GROUP BY 1 ORDER BY 1`, [a]);
    if (bal < 0) v.push(`negative balance ${bal}`);
    if (payouts.length > debited) v.push(`treasury paid ${payouts.length} payouts (${paidNet} USDC net) against ${debited} ledger debits on a balance of 100`);
    if (paidNet > 100) v.push(`treasury paid ${paidNet} net against a balance of 100`);
    if (payouts.length === 0) v.push('no payout happened: test did not exercise anything');
    return { wallets: [a], requestStatuses: tally(rs), queuedGross: ids.length * 40, acceptStatuses: tally(accepts), balance: bal, payouts: payouts.length, paidNet, debited, rows };
  },

  /** Same, but only the request stage, with the cap binding: pending total vs the 1.08x cap. */
  async parallel_withdrawals_cap(s, d, v) {
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100);
    const now = Date.now();
    const rs = await parallel(8, async (i) => {
      const signedAt = now + i;
      return call(s, { m: 'POST', p: '/api/balance/withdraw', auth: 'bearer', body: { userAddress: a, amount: 40, currency: 'USDC', signedAt, signature: await signWithdrawal(w, 40, signedAt, a) } });
    });
    const ok = rs.filter((r) => r.status === 200).length;
    if (ok * 40 > 108) v.push(`${ok} requests queued = ${ok * 40} USDC against a 108 cap (serially at most 2 pass)`);
    return { wallets: [a], statuses: tally(rs), queuedGross: ok * 40 };
  },

  /** One signed intent POSTed N times at once: one queued row. */
  async same_intent_replay(s, d, v) {
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100, { deposited: 100000 });
    const signedAt = Date.now();
    const body = { userAddress: a, amount: 10, currency: 'USDC', signedAt, signature: await signWithdrawal(w, 10, signedAt, a) };
    const rs = await parallel(N, () => call(s, { m: 'POST', p: '/api/balance/withdraw', auth: 'bearer', body }));
    const [{ c }] = await d.q(`SELECT count(*)::int c FROM withdrawal_requests WHERE user_address=$1`, [a]);
    if (c !== 1) v.push(`${c} rows queued from one signed intent`);
    return { wallets: [a], statuses: tally(rs), rows: c };
  },

  /**
   * Parallel accepts of requests the balance can cover: every transfer must really
   * succeed, get its tx hash, and debit exactly once. The money path with no failure.
   */
  async accept_success_parallel(s, d, v) {
    await stub('/__ctl', { nonce: 'strict' });
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100, { deposited: 100000 });
    const now = Date.now();
    const made = [];
    for (let i = 0; i < 4; i += 1) {
      const signedAt = now + i;
      made.push(await call(s, { m: 'POST', p: '/api/balance/withdraw', auth: 'bearer', body: { userAddress: a, amount: 20, currency: 'USDC', signedAt, signature: await signWithdrawal(w, 20, signedAt, a) } }));
    }
    const accepts = await parallel(4, (i) => call(s, { m: 'POST', p: `/api/admin/withdrawal-requests/${made[i].json.requestId}/accept`, auth: 'admin' }, 30000));
    await stub('/__ctl', { nonce: 'strict' });
    const bal = await balanceOf(d, a);
    const payouts = await paidTo(a);
    const debited = await count(d, a, 'withdrawal');
    const hashes = await d.q(`SELECT count(*)::int c FROM withdrawal_requests WHERE user_address=$1 AND status='accepted' AND tx_hash IS NOT NULL`, [a]);
    const ok = accepts.filter((r) => r.status === 200).length;
    if (ok !== 4) v.push(`${ok}/4 accepts succeeded`);
    if (payouts.length !== 4) v.push(`${payouts.length} payouts, want 4`);
    if (sumUnits(payouts) !== 72) v.push(`net paid ${sumUnits(payouts)}, want 72`);
    if (debited !== 4) v.push(`${debited} debits, want 4`);
    if (bal !== 20) v.push(`balance ${bal}, want 20`);
    if (hashes[0].c !== 4) v.push(`${hashes[0].c} rows finalised with a tx hash`);
    return { wallets: [a], acceptStatuses: tally(accepts), balance: bal, payouts: payouts.length, paidNet: sumUnits(payouts), debited, finalised: hashes[0].c };
  },

  /**
   * Same parallel accepts, node-accurate nonces: accepts share the treasury nonce, so
   * only some transfers land. Money paid and money debited must still agree.
   */
  async accept_strict_nonce(s, d, v) {
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100, { deposited: 100000 });
    const now = Date.now();
    const made = [];
    for (let i = 0; i < 4; i += 1) {
      const signedAt = now + i;
      made.push(await call(s, { m: 'POST', p: '/api/balance/withdraw', auth: 'bearer', body: { userAddress: a, amount: 20, currency: 'USDC', signedAt, signature: await signWithdrawal(w, 20, signedAt, a) } }));
    }
    const accepts = await parallel(4, (i) => call(s, { m: 'POST', p: `/api/admin/withdrawal-requests/${made[i].json.requestId}/accept`, auth: 'admin' }, 30000));
    const bal = await balanceOf(d, a);
    const payouts = await paidTo(a);
    const debited = await count(d, a, 'withdrawal');
    const rows = await d.q(`SELECT status, count(*)::int c FROM withdrawal_requests WHERE user_address=$1 GROUP BY 1 ORDER BY 1`, [a]);
    if (payouts.length > debited) v.push(`${payouts.length} payouts landed against ${debited} debits: treasury lost money`);
    if (payouts.length < debited) v.push(`${debited} debits against ${payouts.length} payouts: player debited for ${debited - payouts.length} unpaid (parked)`);
    return { wallets: [a], acceptStatuses: tally(accepts), balance: bal, payouts: payouts.length, debited, rows };
  },

  /** One request accepted N times at once: pays and debits once. */
  async double_accept(s, d, v) {
    const w = fresh(); const a = w.address.toLowerCase();
    await fund(d, a, 100, { deposited: 100000 });
    const signedAt = Date.now();
    const r = await call(s, { m: 'POST', p: '/api/balance/withdraw', auth: 'bearer', body: { userAddress: a, amount: 10, currency: 'USDC', signedAt, signature: await signWithdrawal(w, 10, signedAt, a) } });
    const rs = await parallel(N, () => call(s, { m: 'POST', p: `/api/admin/withdrawal-requests/${r.json.requestId}/accept`, auth: 'admin' }, 30000));
    const bal = await balanceOf(d, a);
    const payouts = await paidTo(a);
    const debited = await count(d, a, 'withdrawal');
    if (payouts.length !== 1) v.push(`${payouts.length} payouts`);
    if (debited !== 1) v.push(`${debited} ledger debits`);
    if (bal !== 90) v.push(`balance ${bal}, want 90`);
    return { wallets: [a], statuses: tally(rs), balance: bal, payouts: payouts.length, debited };
  },
};

await stub('/__price', { BTCUSDT: STRIKE });
await sleep(SAMPLE_MS);
const report = {};
const d = db(SERVER);
for (const [name, test] of Object.entries(TESTS)) {
  const rounds = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const violations = [];
    const detail = await test(SERVER, d, violations);
    await new Promise((r) => setTimeout(r, 150)); // fire-and-forget fee audit row
    for (const a of detail.wallets) for (const p of await reconcile(d, a)) violations.push(`reconcile ${a.slice(0, 10)}: ${p}`);
    rounds.push({ violations, ...detail });
  }
  const failed = rounds.filter((r) => r.violations.length).length;
  report[name] = { rounds: ROUNDS, failed, sample: rounds.find((r) => r.violations.length) ?? rounds[0], all: rounds };
  console.error(`${name}: ${failed}/${ROUNDS} rounds violated`);
}

const stats = await stub('/__stats');
// One accept on its own: does the plain path work with the stub's real 32-byte words?
const w = fresh(); const a = w.address.toLowerCase();
await fund(d, a, 100, { deposited: 100000 });
const signedAt = Date.now();
const r = await call(SERVER, { m: 'POST', p: '/api/balance/withdraw', auth: 'bearer', body: { userAddress: a, amount: 10, currency: 'USDC', signedAt, signature: await signWithdrawal(w, 10, signedAt, a) } });
const acc = await call(SERVER, { m: 'POST', p: `/api/admin/withdrawal-requests/${r.json.requestId}/accept`, auth: 'admin' }, 30000);
const [row] = await d.q(`SELECT status, notes FROM withdrawal_requests WHERE user_address=$1`, [a]);
const realAbi = { accept: acc.status, status: row.status, notes: (row.notes ?? '').slice(0, 90), balance: await balanceOf(d, a), payouts: (await paidTo(a)).length };
await d.end();

const rows = Object.keys(TESTS).map((name) => `| ${name} | ${report[name].failed ? `FAIL ${report[name].failed}/${ROUNDS}` : `pass ${ROUNDS}/${ROUNDS}`} |`);
let md = `N=${N} parallel clients unless stated, ${ROUNDS} rounds, fresh wallets each round. External CONNECT attempts: ${stats.connects.length}.\n\n| Invariant | Result |\n|---|---|\n${rows.join('\n')}\n\nSingle accept, real 32-byte ABI words: \`${JSON.stringify(realAbi)}\`\n`;
for (const [name, res] of Object.entries(report)) {
  if (res.failed) md += `\n**${name}** sample: ${res.sample.violations.join('; ')}\n\`${JSON.stringify({ ...res.sample, violations: undefined, wallets: undefined })}\`\n`;
}
mkdirSync(resolve(HERE, 'results'), { recursive: true });
writeFileSync(resolve(HERE, `results/${tag}.json`), JSON.stringify({ report, realAbi }, null, 1));
writeFileSync(resolve(HERE, `results/${tag}.md`), md);
console.log(md);
