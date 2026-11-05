/**
 * Browser-safe database client: the Rust backend's /api/db gateway.
 *
 * The module path, the exported `supabase` name and the query-builder surface
 * are unchanged from the Supabase version, so existing call sites keep working:
 *
 *     const { data, error } = await supabase
 *       .from('user_profiles')
 *       .select('username')
 *       .eq('user_address', address)
 *       .single();
 *
 * What changed: there is no anon key and no direct database connection in the
 * browser. Requests go to /api/db, which validates them against a narrow
 * allow-list (backend/crates/core/src/gateway.rs) — that is what replaces RLS.
 */
import { QueryBuilder } from '../db/query';
import { browserExecutor } from '../db/browser';

export const supabase = {
  from<T = any>(table: string) {
    return new QueryBuilder<T, T[]>(table, browserExecutor);
  },
};
