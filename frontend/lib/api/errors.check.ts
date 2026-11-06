import assert from 'node:assert/strict';
import { errorMessage, needsSession, readApiError, type StepUp } from './errors';
import { sendGuarded, useGate } from '../world/gate';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const stepup = { id: 'su1', status: 'pending' } as StepUp;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  const html = await readApiError(json(502, '<html>Bad Gateway</html>'));
  assert.equal(html.retryable, true);
  assert.equal(html.code, undefined);

  const limited = await readApiError(json(429, { error: 'slow', code: 'rate_limited' }, { 'retry-after': '30' }));
  assert.ok(limited.retryAfter! > Date.now() + 29_000);
  assert.match(errorMessage(limited), /Try again in 3\ds/);

  const cool = await readApiError(json(409, { error: 'x', code: 'human_cooloff', until: Math.floor(Date.now() / 1000) + 600 }));
  assert.match(errorMessage(cool), /10 min/);

  assert.equal(needsSession({ status: 401 }), true);
  assert.equal(needsSession({ status: 401, code: 'session_required' }), true);
  assert.equal(needsSession({ status: 401, code: 'step_up_required' }), false);

  let calls = 0;
  const human = sendGuarded(async () => (++calls === 1 ? json(403, { code: 'human_required', error: 'x' }) : json(200, {})));
  await tick();
  useGate.getState().human!.done(true);
  assert.equal((await human).status, 200);
  assert.equal(calls, 2);

  calls = 0;
  const dismissed = sendGuarded(async () => (++calls, json(403, { code: 'human_required', error: 'x' })));
  await tick();
  useGate.getState().human!.done(false);
  assert.equal((await dismissed).status, 403);
  assert.equal(calls, 1);

  const ids: (string | undefined)[] = [];
  const stepped = sendGuarded(async (id) => (ids.push(id), id ? json(200, {}) : json(401, { code: 'step_up_required', error: 'x', stepup })));
  await tick();
  useGate.getState().stepup!.done({ ...stepup, status: 'approved' });
  assert.equal((await stepped).status, 200);
  assert.deepEqual(ids, [undefined, 'su1']);

  calls = 0;
  const denied = sendGuarded(async () => (++calls, json(401, { code: 'step_up_required', error: 'x', stepup })));
  await tick();
  useGate.getState().stepup!.done({ ...stepup, status: 'denied' });
  const d = await readApiError(await denied);
  assert.equal(d.code, 'stepup_denied');
  assert.equal(calls, 1);

  calls = 0;
  const twice = sendGuarded(async () => (++calls, json(401, { code: 'step_up_required', error: 'x', stepup })));
  await tick();
  useGate.getState().stepup!.done({ ...stepup, status: 'approved' });
  assert.equal((await twice).status, 401);
  assert.equal(calls, 2);

  console.log('ok: errors + gate');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
