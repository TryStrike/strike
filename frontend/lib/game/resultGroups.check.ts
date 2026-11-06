import assert from 'node:assert/strict';
import { groupKey, summarizeGroup, type SettledResult } from './resultGroups';

const r = (betId: string, amount: number, payout: number, refunded = false, endTime = 1000): SettledResult => ({
  betId, asset: 'BTC', mode: 'box', endTime, won: payout > 0, refunded, amount, payout, currency: 'USDC', timestamp: 1,
});

const one = summarizeGroup([r('a', 0.1, 0), r('b', 0.1, 0.21), r('c', 0.1, 0)])!;
assert.equal(one.count, 3);
assert.equal(one.wins, 1);
assert.equal(Math.round(one.amount * 100), 30);
assert.equal(Math.round(one.payout * 100), 21);
assert.equal(one.won, false);
assert.equal(one.betId, 'b');
assert.equal(one.sound, 'lose');

const loss = summarizeGroup([r('a', 0.1, 0.12), r('b', 0.5, 0), r('c', 0.5, 0)])!;
assert.equal(loss.wins, 1);
assert.equal(loss.won, false);
assert.equal(loss.sound, 'lose');

const two = summarizeGroup([r('a', 0.1, 0.3), r('b', 0.1, 0.3), r('c', 0.1, 0)])!;
assert.equal(two.won, true);
assert.equal(two.wins, 2);
assert.equal(two.betId, 'a');

const refund = summarizeGroup([r('a', 0.1, 0.1, true), r('b', 0.1, 0.1, true)])!;
assert.equal(refund.refunded, true);
assert.equal(refund.sound, null);

const single = summarizeGroup([r('a', 0.1, 0)])!;
assert.deepEqual([single.count, single.won, single.refunded, single.betId, single.sound], [1, false, false, 'a', 'lose']);
assert.equal(summarizeGroup([r('a', 0.1, 0.2)])!.sound, 'win');
assert.equal(summarizeGroup([]), null);

assert.equal(groupKey(r('a', 1, 0)), groupKey(r('b', 1, 0)));
assert.notEqual(groupKey(r('a', 1, 0, false, 1000)), groupKey(r('b', 1, 0, false, 2000)));
console.log('resultGroups ok');
