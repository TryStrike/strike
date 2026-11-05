/**
 * Server-side Neon transport.
 *
 * Holds the only connection pool in the app. Never import this from a client
 * component — lib/supabase/client.ts picks the right transport automatically.
 */
import 'server-only';
import pg, { Pool } from 'pg';
import { compile, type Executor, type QueryDescriptor } from './query';

// Match the wire format the app was written against. PostgREST served JSON, so
// numeric and bigint columns arrived as numbers and timestamps as ISO strings.
// node-postgres returns strings and Date objects instead, which would change
// what every existing call site sees. Align it here rather than touching
// 50-odd call sites.
//
// Numerics become JS numbers, so balances are bounded by double precision
// (~9e15 exact). House balances are far below that; if that ever stops being
// true, this is the line to revisit.
const NUMERIC = 1700;
const INT8 = 20;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;

pg.types.setTypeParser(NUMERIC, (value) => (value === null ? null : parseFloat(value)));
pg.types.setTypeParser(INT8, (value) => (value === null ? null : parseInt(value, 10)));
const toIso = (value: string | null) => (value === null ? null : new Date(value).toISOString());
pg.types.setTypeParser(TIMESTAMP, toIso);
pg.types.setTypeParser(TIMESTAMPTZ, toIso);

declare global {
  // eslint-disable-next-line no-var
  var __strikePool: Pool | undefined;
}

function pool(): Pool {
  if (!global.__strikePool) {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error('Missing environment variable: DATABASE_URL');
    }
    global.__strikePool = new Pool({
      connectionString,
      // Serverless functions are short-lived; a small pool avoids exhausting
      // Neon's connection limit across many concurrent invocations.
      max: Number(process.env.PGPOOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return global.__strikePool;
}

export const serverExecutor: Executor = async (desc: QueryDescriptor) => {
  const compiled = compile(desc);
  const result = await pool().query(compiled.text, compiled.values as any[]);

  let count: number | null = null;
  if (compiled.countText) {
    const countResult = await pool().query(compiled.countText, compiled.countValues as any[]);
    count = Number(countResult.rows[0]?.count ?? 0);
  }

  return { rows: result.rows, count };
};

/** Calls a Postgres function — the replacement for supabase.rpc(). */
export async function callRpc(fn: string, params: Record<string, unknown> = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fn)) {
    throw new Error(`Unsafe function name: ${fn}`);
  }
  const keys = Object.keys(params);
  const args = keys.map((k, i) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Unsafe parameter name: ${k}`);
    return `"${k}" => $${i + 1}`;
  });
  const values = keys.map((k) => params[k]);
  const text = `SELECT * FROM "${fn}"(${args.join(', ')})`;
  const result = await pool().query(text, values);

  // A function returning a scalar comes back as a single column; unwrap it so
  // callers see the same shape Supabase gave them.
  const rows = result.rows;
  if (rows.length === 1 && result.fields.length === 1) {
    return rows[0][result.fields[0].name];
  }
  return rows;
}
