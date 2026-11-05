/**
 * Apply the SQL schema to Neon Postgres.
 *
 * The Supabase migrations are reused as-is except for the parts that only make
 * sense inside Supabase: row-level security policies and grants to the
 * anon/authenticated/service_role roles. Those roles do not exist on Neon, and
 * access control now lives server-side (only the API routes hold a connection
 * string), so RLS is dropped rather than emulated.
 *
 * Usage: node db/migrate.mjs [--reset]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Order matters: later files alter tables the earlier ones create.
const MIGRATIONS = [
  'supabase/migrations/001_complete_schema.sql',
  'supabase/migrations/002_banned_wallets.sql',
  'supabase/migrations/003_user_sessions.sql',
  'supabase/migrations/007_withdrawal_columns.sql',
  'supabase/migrations/008_staking.sql',
  'supabase/migrations/009_staking_manual_withdrawals.sql',
  'supabase/migrations/010_staking_365d_100pct_apy.sql',
  'supabase/access_system.sql',
  'supabase/user_profiles.sql',
  'db/arc.sql',
];

function readEnv(name) {
  if (process.env[name]) return process.env[name].trim();
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) return null;
  const match = readFileSync(envPath, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

const NEWLINE = String.fromCharCode(10);

/**
 * Split on statement boundaries while respecting dollar-quoted bodies, so the
 * semicolons inside a plpgsql function are not treated as separators.
 */
function splitStatements(sql) {
  const statements = [];
  let buf = '';
  let i = 0;
  let tag = null; // active dollar-quote tag, e.g. "$$" or "$fn$"

  while (i < sql.length) {
    if (tag) {
      if (sql.startsWith(tag, i)) {
        buf += tag;
        i += tag.length;
        tag = null;
        continue;
      }
      buf += sql[i++];
      continue;
    }

    // Line comment
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf(NEWLINE, i);
      const end = nl === -1 ? sql.length : nl + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    // Single-quoted literal
    if (sql[i] === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollar) {
      tag = dollar[0];
      buf += tag;
      i += tag.length;
      continue;
    }

    if (sql[i] === ';') {
      statements.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }

    buf += sql[i++];
  }

  if (buf.trim()) statements.push(buf.trim());
  return statements.filter(Boolean);
}

/**
 * Returns the statements to run, minus the Supabase-only ones.
 * Everything else (tables, indexes, functions, triggers) is plain Postgres.
 */
function stripSupabaseOnly(sql) {
  return splitStatements(sql)
    .filter((stmt) => {
      // Leading comments travel with the statement, so strip them before
      // anchoring on the first keyword.
      const s = stmt
        .split(NEWLINE)
        .filter((line) => !line.trim().startsWith('--'))
        .join(' ')
        .trim()
        .toLowerCase();
      if (/create\s+policy/.test(s)) return false;
      if (/drop\s+policy/.test(s)) return false;
      if (/alter\s+policy/.test(s)) return false;
      if (/row\s+level\s+security/.test(s)) return false;
      if (/^(grant|revoke)\b/.test(s)) return false;
      if (/auth\.(uid|role|jwt)/.test(s)) return false;
      return true;
    })
    .map((x) => `${x};`);
}

const url = readEnv('DIRECT_URL') || readEnv('DATABASE_URL');
if (!url) {
  console.error('DATABASE_URL / DIRECT_URL not set (checked env and .env)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

if (process.argv.includes('--reset')) {
  console.log('Resetting public schema…');
  await client.query('drop schema public cascade; create schema public;');
}

let applied = 0;
for (const rel of MIGRATIONS) {
  const file = resolve(root, rel);
  if (!existsSync(file)) {
    console.log(`  skip    ${basename(rel)} (not present)`);
    continue;
  }
  const statements = stripSupabaseOnly(readFileSync(file, 'utf8'));

  if (statements.length === 0) {
    console.log(`  empty   ${basename(rel)}`);
    continue;
  }

  let skipped = 0;
  for (const statement of statements) {
    try {
      await client.query(statement);
    } catch (err) {
      // Re-running a migration is normal (deploys, local resets). Objects that
      // already exist are not an error; anything else is.
      const duplicate =
        err.code === '42710' || // duplicate object (trigger, policy, role)
        err.code === '42P07' || // duplicate table/index
        err.code === '42701' || // duplicate column
        err.code === '42P06'; // duplicate schema
      if (duplicate) {
        skipped += 1;
        continue;
      }
      console.error(`  FAILED  ${basename(rel)}: ${err.message}`);
      await client.end();
      process.exit(1);
    }
  }
  console.log(
    `  applied ${basename(rel)}${skipped ? ` (${skipped} already present)` : ''}`
  );
  applied += 1;
}

const tables = await client.query(
  `select table_name from information_schema.tables
    where table_schema = 'public' order by 1`
);
const funcs = await client.query(
  `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' order by 1`
);

console.log(`${NEWLINE}${applied} migration file(s) applied.`);
console.log(`Tables (${tables.rowCount}): ${tables.rows.map((r) => r.table_name).join(', ')}`);
console.log(`Functions (${funcs.rowCount}): ${funcs.rows.map((r) => r.proname).join(', ')}`);

await client.end();
