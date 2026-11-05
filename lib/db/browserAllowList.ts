/**
 * What the browser is allowed to ask /api/db for.
 *
 * Supabase enforced this with row-level security. Neon has no equivalent that
 * a browser can talk to directly, so the gateway is deliberately narrow: it
 * accepts only the handful of (table, operation) pairs the client bundle
 * actually performs, and rejects everything else. Anything more sensitive —
 * balances, bets, admin — goes through a purpose-built API route that
 * does its own auth, exactly as before.
 *
 * Keep this list minimal. Adding a table here exposes it to the public.
 */
import type { QueryDescriptor } from './query';

interface Rule {
  table: string;
  op: QueryDescriptor['op'];
  /** Columns the browser may read or write. */
  columns: string[];
  /** Columns the browser must filter on (prevents whole-table reads). */
  requireFilterOn?: string[];
  maxLimit?: number;
}

const RULES: Rule[] = [
  // Profile store: read own profile, check username availability, set username.
  {
    table: 'user_profiles',
    op: 'select',
    columns: ['user_address', 'username', 'access_code'],
    requireFilterOn: ['user_address', 'username'],
    maxLimit: 1,
  },
  {
    table: 'user_profiles',
    op: 'upsert',
    columns: ['user_address', 'username', 'updated_at'],
  },
];

interface AllowResult {
  allowed: boolean;
  reason?: string;
}

export function checkAllowed(desc: QueryDescriptor): AllowResult {
  const rule = RULES.find((r) => r.table === desc.table && r.op === desc.op);
  if (!rule) {
    return { allowed: false, reason: `${desc.op} on "${desc.table}" is not available to the browser` };
  }

  // Columns being read.
  if (desc.columns && desc.columns.trim() !== '*') {
    const requested = desc.columns.split(',').map((c) => c.trim()).filter(Boolean);
    const extra = requested.filter((c) => !rule.columns.includes(c));
    if (extra.length) {
      return { allowed: false, reason: `columns not readable: ${extra.join(', ')}` };
    }
  } else if (desc.op === 'select') {
    return { allowed: false, reason: 'select * is not allowed; list the columns' };
  }

  // Columns being written.
  const written = [
    ...(desc.values ?? []).flatMap((row) => Object.keys(row)),
    ...Object.keys(desc.patch ?? {}),
  ];
  const badWrite = written.filter((c) => !rule.columns.includes(c));
  if (badWrite.length) {
    return { allowed: false, reason: `columns not writable: ${badWrite.join(', ')}` };
  }

  // Reads must be scoped.
  if (rule.requireFilterOn) {
    const filtered = desc.filters.map((f) => f.column);
    if (!filtered.some((c) => rule.requireFilterOn!.includes(c))) {
      return {
        allowed: false,
        reason: `a filter on one of ${rule.requireFilterOn.join(' / ')} is required`,
      };
    }
  }

  if (rule.maxLimit !== undefined) {
    const limit = desc.single ? 1 : desc.limit;
    if (limit === undefined || limit > rule.maxLimit) {
      return { allowed: false, reason: `limit must be <= ${rule.maxLimit}` };
    }
  }

  if (desc.orFilter) {
    return { allowed: false, reason: '.or() is not available to the browser' };
  }

  return { allowed: true };
}
