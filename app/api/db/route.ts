/**
 * POST /api/db — the browser's only path to the database.
 *
 * Replaces what the Supabase anon key + RLS used to provide. Every request is
 * validated against lib/db/browserAllowList before it is compiled to SQL, so
 * this endpoint cannot be used to read balances, bets or admin data.
 */
import { NextResponse } from 'next/server';
import { serverExecutor, type QueryDescriptor } from '@/lib/db';
import { checkAllowed } from '@/lib/db/browserAllowList';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let desc: QueryDescriptor;
  try {
    desc = (await request.json()) as QueryDescriptor;
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
  }

  if (!desc || typeof desc.table !== 'string' || typeof desc.op !== 'string') {
    return NextResponse.json({ error: { message: 'Malformed query' } }, { status: 400 });
  }

  // Normalise the shape so a hand-crafted body cannot smuggle in extra fields.
  const safe: QueryDescriptor = {
    table: desc.table,
    op: desc.op,
    columns: typeof desc.columns === 'string' ? desc.columns : undefined,
    values: Array.isArray(desc.values) ? desc.values : undefined,
    patch: desc.patch && typeof desc.patch === 'object' ? desc.patch : undefined,
    onConflict: typeof desc.onConflict === 'string' ? desc.onConflict : undefined,
    filters: Array.isArray(desc.filters) ? desc.filters : [],
    orFilter: typeof desc.orFilter === 'string' ? desc.orFilter : undefined,
    order: Array.isArray(desc.order) ? desc.order : [],
    limit: typeof desc.limit === 'number' ? desc.limit : undefined,
    offset: typeof desc.offset === 'number' ? desc.offset : undefined,
    returning: Boolean(desc.returning),
    single: desc.single === 'one' || desc.single === 'maybe' ? desc.single : undefined,
    count: desc.count === 'exact' ? 'exact' : undefined,
    head: Boolean(desc.head),
  };

  const verdict = checkAllowed(safe);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: { message: verdict.reason ?? 'Not permitted', code: 'NOT_ALLOWED' } },
      { status: 403 }
    );
  }

  try {
    const { rows, count } = await serverExecutor(safe);
    return NextResponse.json({ rows, count });
  } catch (err: any) {
    console.error('[api/db]', err);
    return NextResponse.json(
      { error: { message: err?.message ?? 'Database error', code: err?.code } },
      { status: 500 }
    );
  }
}
