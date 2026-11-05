/**
 * Self-check for the Neon query layer.
 *
 * Compiles the PostgREST-shaped chains the app actually uses and runs them
 * against the real database, then cleans up after itself. This is what proves
 * the drop-in replacement for the Supabase client behaves the same way.
 *
 * Usage: node db/check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readEnv(name) {
  if (process.env[name]) return process.env[name].trim();
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) return null;
  const m = readFileSync(envPath, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

const url = readEnv('DATABASE_URL');
assert.ok(url, 'DATABASE_URL not set');

// lib/db/query.ts has no runtime dependencies, so transpile it in memory with
// the TypeScript already in devDependencies rather than keeping a second copy.
const ts = (await import('typescript')).default;
const source = readFileSync(resolve(root, 'lib/db/query.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { compile, QueryBuilder } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
);

const pool = new pg.Pool({ connectionString: url, max: 3 });
const exec = async (desc) => {
  const c = compile(desc);
  const res = await pool.query(c.text, c.values);
  let count = null;
  if (c.countText) {
    const cr = await pool.query(c.countText, c.countValues);
    count = Number(cr.rows[0]?.count ?? 0);
  }
  return { rows: res.rows, count };
};

const db = { from: (t) => new QueryBuilder(t, exec) };

const addr = `0xcheck${Date.now().toString(16)}`;
const addr2 = `${addr}b`;
const username = `check${Date.now()}`;

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
};

console.log('Neon query-layer self-check');

await check('insert + select .eq() round-trip', async () => {
  const ins = await db.from('user_profiles').insert({ user_address: addr, username }).select('user_address, username');
  assert.equal(ins.error, null, ins.error?.message);
  const got = await db.from('user_profiles').select('user_address, username').eq('user_address', addr).single();
  assert.equal(got.error, null, got.error?.message);
  assert.equal(got.data.username, username);
});

await check('.single() on no rows returns PGRST116, like PostgREST', async () => {
  const res = await db.from('user_profiles').select('username').eq('user_address', 'nope').single();
  assert.equal(res.data, null);
  assert.equal(res.error?.code, 'PGRST116');
});

await check('.maybeSingle() on no rows returns null without an error', async () => {
  const res = await db.from('user_profiles').select('username').eq('user_address', 'nope').maybeSingle();
  assert.equal(res.data, null);
  assert.equal(res.error, null);
});

await check('.update() writes and returns the row', async () => {
  const res = await db.from('user_profiles').update({ username: `${username}x` }).eq('user_address', addr).select('username');
  assert.equal(res.error, null, res.error?.message);
  assert.equal(res.data[0].username, `${username}x`);
});

await check('.upsert() inserts then updates on conflict', async () => {
  const a = await db.from('user_profiles').upsert({ user_address: addr2, username: `${username}2` }, { onConflict: 'user_address' }).select('username');
  assert.equal(a.error, null, a.error?.message);
  const b = await db.from('user_profiles').upsert({ user_address: addr2, username: `${username}3` }, { onConflict: 'user_address' }).select('username');
  assert.equal(b.error, null, b.error?.message);
  assert.equal(b.data[0].username, `${username}3`);
});

await check('.in() matches any of the values', async () => {
  const res = await db.from('user_profiles').select('user_address').in('user_address', [addr, addr2]);
  assert.equal(res.error, null, res.error?.message);
  assert.equal(res.data.length, 2);
});

await check('.order() + .limit() shape the result set', async () => {
  const res = await db.from('user_profiles').select('user_address').in('user_address', [addr, addr2]).order('user_address', { ascending: true }).limit(1);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].user_address, addr);
});

await check('.range() maps to LIMIT/OFFSET', async () => {
  const res = await db.from('user_profiles').select('user_address').in('user_address', [addr, addr2]).order('user_address', { ascending: true }).range(1, 1);
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].user_address, addr2);
});

await check('count: exact + head returns a count and no rows', async () => {
  const res = await db.from('user_profiles').select('user_address', { count: 'exact', head: true }).in('user_address', [addr, addr2]);
  assert.equal(res.data, null);
  assert.equal(res.count, 2);
});

await check('.or() compiles to an OR group', async () => {
  const res = await db.from('user_profiles').select('user_address').or(`user_address.eq.${addr},user_address.eq.${addr2}`);
  assert.equal(res.error, null, res.error?.message);
  assert.equal(res.data.length, 2);
});

await check('.is(null) finds null columns', async () => {
  const res = await db.from('user_profiles').select('user_address').eq('user_address', addr).is('access_code', null);
  assert.equal(res.error, null, res.error?.message);
  assert.equal(res.data.length, 1);
});

await check('a filterless UPDATE is refused', async () => {
  const res = await db.from('user_profiles').update({ username: 'nope' });
  assert.match(res.error?.message ?? '', /without a filter/);
});

await check('a filterless DELETE is refused', async () => {
  const res = await db.from('user_profiles').delete();
  assert.match(res.error?.message ?? '', /without a filter/);
});

await check('an unsafe identifier is rejected before it reaches SQL', async () => {
  const res = await db.from('user_profiles').select('username').eq('user_address"; drop table x; --', 'x');
  assert.match(res.error?.message ?? '', /Unsafe identifier/);
});

await check('.delete() removes the rows', async () => {
  const res = await db.from('user_profiles').delete().in('user_address', [addr, addr2]).select('user_address');
  assert.equal(res.error, null, res.error?.message);
  assert.equal(res.data.length, 2);
  const left = await db.from('user_profiles').select('user_address').in('user_address', [addr, addr2]);
  assert.equal(left.data.length, 0);
});

await pool.query('delete from user_profiles where user_address = any($1)', [[addr, addr2]]);
await pool.end();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
