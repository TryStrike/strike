/**
 * Browser transport: forwards a query descriptor to /api/db, which re-checks it
 * against the allow-list before touching Neon. No credentials reach the client.
 */
import type { Executor, QueryDescriptor } from './query';

export const browserExecutor: Executor = async (desc: QueryDescriptor) => {
  const response = await fetch('/api/db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(desc),
  });

  let body: any;
  try {
    body = await response.json();
  } catch {
    return {
      rows: [],
      count: null,
      error: { message: `Database gateway returned a non-JSON response (${response.status})` },
    };
  }

  if (!response.ok || body?.error) {
    return {
      rows: [],
      count: null,
      error: { message: body?.error?.message ?? 'Database request failed', code: body?.error?.code },
    };
  }

  return { rows: body.rows ?? [], count: body.count ?? null };
};
