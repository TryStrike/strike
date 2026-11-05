/**
 * Server-side database client — Neon Postgres, direct connection.
 *
 * The name and query-builder surface are unchanged from the Supabase service
 * client, so the API routes and server libraries that import `supabaseService`
 * keep working untouched. What changed: this now opens a pooled connection to
 * Neon using DATABASE_URL instead of speaking PostgREST with a service-role
 * JWT. Because it bypasses the browser allow-list, it must only ever be
 * imported from server code.
 */
import 'server-only';
import { QueryBuilder } from '../db/query';
import { serverExecutor, callRpc } from '../db/server';

/**
 * True when the database connection is configured. Kept from the Supabase
 * version so the existing "is the backend wired up?" checks still compile.
 */
export const isSupabaseServiceRoleConfigured = Boolean(process.env.DATABASE_URL?.trim());

export const supabaseService = {
  from<T = any>(table: string) {
    return new QueryBuilder<T, T[]>(table, serverExecutor);
  },

  /**
   * Calls a Postgres function. Returns the Supabase-shaped { data, error } so
   * existing `const { data, error } = await supabaseService.rpc(...)` keeps
   * working.
   */
  async rpc<T = any>(fn: string, params: Record<string, unknown> = {}) {
    try {
      const data = (await callRpc(fn, params)) as T;
      return { data, error: null as null };
    } catch (err: any) {
      return {
        data: null,
        error: { message: err?.message ?? String(err), code: err?.code, details: err?.detail },
      };
    }
  },
};

/**
 * Previously turned a PostgREST "Invalid API key" into operator instructions.
 * The failure mode is now a bad or missing connection string, so the hint
 * points at that instead. Signature kept so callers do not change.
 */
export function appendSupabaseServiceKeyHint(message: string): string {
  const m = message || '';
  if (!/connect|password|authentication|does not exist|ECONNREFUSED|timeout/i.test(m)) return m;
  return `${m} — Fix: set DATABASE_URL to the Neon pooled connection string (Neon → Project → Connection Details). In Vercel: Project → Settings → Environment Variables, then redeploy.`;
}
