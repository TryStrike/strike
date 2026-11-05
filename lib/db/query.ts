/**
 * A PostgREST-shaped query builder that compiles to plain SQL.
 *
 * This is what lets the Supabase migration touch almost nothing: every call
 * site keeps writing `supabase.from('t').select('*').eq('a', 1)`, but the chain
 * now produces a serialisable descriptor which is executed either directly
 * against Neon (server) or forwarded to /api/db (browser).
 *
 * Only the surface the app actually uses is implemented — see README notes in
 * ARC_MIGRATION.md. Anything unsupported throws loudly rather than
 * silently returning wrong rows.
 */

type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'is'
  | 'contains';

export interface QueryFilter {
  op: FilterOp;
  column: string;
  value: unknown;
}

export interface QueryDescriptor {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  columns?: string;
  values?: Record<string, unknown>[];
  patch?: Record<string, unknown>;
  onConflict?: string;
  filters: QueryFilter[];
  orFilter?: string;
  order: { column: string; ascending: boolean; nullsFirst?: boolean }[];
  limit?: number;
  offset?: number;
  returning: boolean;
  single?: 'one' | 'maybe';
  count?: 'exact' | 'planned' | 'estimated';
  head?: boolean;
}

interface QueryResult<T = any> {
  data: T | null;
  error: { message: string; code?: string; details?: string } | null;
  count: number | null;
  status: number;
}

/** Reject anything that is not a plain identifier before it reaches SQL. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

function columnList(columns: string | undefined): string {
  if (!columns || columns.trim() === '*') return '*';
  const parts = columns
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (parts.length === 0) return '*';
  return parts.map(ident).join(', ');
}

interface CompiledQuery {
  text: string;
  values: unknown[];
  /** A separate COUNT query when the caller asked for one. */
  countText?: string;
  countValues?: unknown[];
}

function buildWhere(
  desc: QueryDescriptor,
  values: unknown[]
): string {
  const clauses: string[] = [];

  for (const f of desc.filters) {
    const col = ident(f.column);
    switch (f.op) {
      case 'eq':
        values.push(f.value);
        clauses.push(`${col} = $${values.length}`);
        break;
      case 'neq':
        values.push(f.value);
        clauses.push(`${col} <> $${values.length}`);
        break;
      case 'gt':
        values.push(f.value);
        clauses.push(`${col} > $${values.length}`);
        break;
      case 'gte':
        values.push(f.value);
        clauses.push(`${col} >= $${values.length}`);
        break;
      case 'lt':
        values.push(f.value);
        clauses.push(`${col} < $${values.length}`);
        break;
      case 'lte':
        values.push(f.value);
        clauses.push(`${col} <= $${values.length}`);
        break;
      case 'like':
        values.push(f.value);
        clauses.push(`${col} LIKE $${values.length}`);
        break;
      case 'ilike':
        values.push(f.value);
        clauses.push(`${col} ILIKE $${values.length}`);
        break;
      case 'in':
        values.push(f.value);
        clauses.push(`${col} = ANY($${values.length})`);
        break;
      case 'is':
        // PostgREST `.is()` is only ever used for null / boolean checks.
        if (f.value === null) clauses.push(`${col} IS NULL`);
        else if (f.value === true) clauses.push(`${col} IS TRUE`);
        else if (f.value === false) clauses.push(`${col} IS FALSE`);
        else throw new Error(`Unsupported .is() value: ${String(f.value)}`);
        break;
      case 'contains':
        values.push(JSON.stringify(f.value));
        clauses.push(`${col} @> $${values.length}::jsonb`);
        break;
      default:
        throw new Error(`Unsupported filter: ${(f as QueryFilter).op}`);
    }
  }

  if (desc.orFilter) {
    clauses.push(compileOr(desc.orFilter, values));
  }

  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * PostgREST `.or("a.eq.1,b.ilike.%x%")`. Only the comma-separated flat form is
 * supported; nested and(...) groups are not used by this app.
 */
function compileOr(expr: string, values: unknown[]): string {
  const parts = expr.split(',').map((p) => p.trim()).filter(Boolean);
  const compiled = parts.map((part) => {
    const [column, op, ...rest] = part.split('.');
    const raw = rest.join('.');
    const col = ident(column);
    switch (op) {
      case 'eq':
        values.push(raw);
        return `${col} = $${values.length}`;
      case 'neq':
        values.push(raw);
        return `${col} <> $${values.length}`;
      case 'gt':
        values.push(raw);
        return `${col} > $${values.length}`;
      case 'gte':
        values.push(raw);
        return `${col} >= $${values.length}`;
      case 'lt':
        values.push(raw);
        return `${col} < $${values.length}`;
      case 'lte':
        values.push(raw);
        return `${col} <= $${values.length}`;
      case 'like':
        values.push(raw);
        return `${col} LIKE $${values.length}`;
      case 'ilike':
        values.push(raw);
        return `${col} ILIKE $${values.length}`;
      case 'is':
        if (raw === 'null') return `${col} IS NULL`;
        if (raw === 'true') return `${col} IS TRUE`;
        if (raw === 'false') return `${col} IS FALSE`;
        throw new Error(`Unsupported .or() is-value: ${raw}`);
      default:
        throw new Error(`Unsupported .or() operator: ${op}`);
    }
  });
  return `(${compiled.join(' OR ')})`;
}

function orderLimit(desc: QueryDescriptor): string {
  let sql = '';
  if (desc.order.length) {
    const parts = desc.order.map((o) => {
      const dir = o.ascending ? 'ASC' : 'DESC';
      const nulls = o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
      return `${ident(o.column)} ${dir}${nulls}`;
    });
    sql += ` ORDER BY ${parts.join(', ')}`;
  }
  if (desc.limit !== undefined) sql += ` LIMIT ${Number(desc.limit)}`;
  if (desc.offset !== undefined) sql += ` OFFSET ${Number(desc.offset)}`;
  return sql;
}

export function compile(desc: QueryDescriptor): CompiledQuery {
  const table = ident(desc.table);
  const values: unknown[] = [];

  if (desc.op === 'select') {
    const cols = desc.head ? '1' : columnList(desc.columns);
    const where = buildWhere(desc, values);
    const text = `SELECT ${cols} FROM ${table}${where}${orderLimit(desc)}`;
    const out: CompiledQuery = { text, values };
    if (desc.count) {
      const countValues: unknown[] = [];
      const countWhere = buildWhere(desc, countValues);
      out.countText = `SELECT COUNT(*)::bigint AS count FROM ${table}${countWhere}`;
      out.countValues = countValues;
    }
    return out;
  }

  if (desc.op === 'insert' || desc.op === 'upsert') {
    const rows = desc.values ?? [];
    if (rows.length === 0) throw new Error('insert/upsert requires at least one row');
    // Union of keys so rows with differing shapes still line up.
    const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    if (keys.length === 0) throw new Error('insert/upsert requires at least one column');

    const tuples = rows.map((row) => {
      const placeholders = keys.map((k) => {
        values.push(row[k] === undefined ? null : row[k]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    let text = `INSERT INTO ${table} (${keys.map(ident).join(', ')}) VALUES ${tuples.join(', ')}`;

    if (desc.op === 'upsert') {
      const conflict = (desc.onConflict ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const target = conflict.length ? `(${conflict.map(ident).join(', ')})` : '';
      const updatable = keys.filter((k) => !conflict.includes(k));
      text += target
        ? ` ON CONFLICT ${target} DO UPDATE SET ${updatable
            .map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`)
            .join(', ')}`
        : ' ON CONFLICT DO NOTHING';
    }

    if (desc.returning) text += ` RETURNING ${columnList(desc.columns)}`;
    return { text, values };
  }

  if (desc.op === 'update') {
    const patch = desc.patch ?? {};
    const keys = Object.keys(patch);
    if (keys.length === 0) throw new Error('update requires at least one column');
    const sets = keys.map((k) => {
      values.push(patch[k] === undefined ? null : patch[k]);
      return `${ident(k)} = $${values.length}`;
    });
    const where = buildWhere(desc, values);
    // A filterless UPDATE would rewrite the whole table; PostgREST refuses too.
    if (!where) throw new Error(`Refusing to UPDATE ${desc.table} without a filter`);
    let text = `UPDATE ${table} SET ${sets.join(', ')}${where}`;
    if (desc.returning) text += ` RETURNING ${columnList(desc.columns)}`;
    return { text, values };
  }

  if (desc.op === 'delete') {
    const where = buildWhere(desc, values);
    if (!where) throw new Error(`Refusing to DELETE FROM ${desc.table} without a filter`);
    let text = `DELETE FROM ${table}${where}`;
    if (desc.returning) text += ` RETURNING ${columnList(desc.columns)}`;
    return { text, values };
  }

  throw new Error(`Unsupported operation: ${desc.op}`);
}

/** Executes a compiled query; supplied by the server or browser transport. */
export type Executor = (
  desc: QueryDescriptor
) => Promise<{ rows: any[]; count: number | null; error?: { message: string; code?: string } }>;

/**
 * The chainable builder. It is thenable, so `await` on any point in the chain
 * runs the query — matching how the Supabase client behaves.
 */
/**
 * `Row` is the shape of one record; `Result` is what `await` yields. A plain
 * chain resolves to `Row[]` (matching the Supabase client, so `.map(r => …)`
 * still infers `r`), while `.single()` / `.maybeSingle()` narrow it to `Row`.
 */
export class QueryBuilder<Row = any, Result = Row[]>
  implements PromiseLike<QueryResult<Result>>
{
  private desc: QueryDescriptor;
  private exec: Executor;

  constructor(table: string, exec: Executor) {
    this.exec = exec;
    this.desc = { table, op: 'select', filters: [], order: [], returning: false };
  }

  select(columns = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    this.desc.columns = columns;
    if (opts?.count) this.desc.count = opts.count;
    if (opts?.head) this.desc.head = true;
    // After insert/update/upsert/delete, .select() means RETURNING.
    if (this.desc.op === 'select') this.desc.op = 'select';
    else this.desc.returning = true;
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.desc.op = 'insert';
    this.desc.values = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string }
  ) {
    this.desc.op = 'upsert';
    this.desc.values = Array.isArray(values) ? values : [values];
    this.desc.onConflict = opts?.onConflict;
    return this;
  }

  update(patch: Record<string, unknown>) {
    this.desc.op = 'update';
    this.desc.patch = patch;
    return this;
  }

  delete() {
    this.desc.op = 'delete';
    return this;
  }

  private filter_(op: FilterOp, column: string, value: unknown) {
    this.desc.filters.push({ op, column, value });
    return this;
  }

  eq(column: string, value: unknown) { return this.filter_('eq', column, value); }
  neq(column: string, value: unknown) { return this.filter_('neq', column, value); }
  gt(column: string, value: unknown) { return this.filter_('gt', column, value); }
  gte(column: string, value: unknown) { return this.filter_('gte', column, value); }
  lt(column: string, value: unknown) { return this.filter_('lt', column, value); }
  lte(column: string, value: unknown) { return this.filter_('lte', column, value); }
  like(column: string, value: string) { return this.filter_('like', column, value); }
  ilike(column: string, value: string) { return this.filter_('ilike', column, value); }
  in(column: string, values: unknown[]) { return this.filter_('in', column, values); }
  is(column: string, value: null | boolean) { return this.filter_('is', column, value); }
  contains(column: string, value: unknown) { return this.filter_('contains', column, value); }

  /** PostgREST generic filter: .filter('col', 'eq', value) */
  filter(column: string, op: string, value: unknown) {
    return this.filter_(op as FilterOp, column, value);
  }

  /** .match({a: 1, b: 2}) is sugar for chained .eq() */
  match(criteria: Record<string, unknown>) {
    for (const [column, value] of Object.entries(criteria)) this.filter_('eq', column, value);
    return this;
  }

  or(expression: string) {
    this.desc.orFilter = expression;
    return this;
  }

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.desc.order.push({
      column,
      ascending: opts?.ascending !== false,
      nullsFirst: opts?.nullsFirst,
    });
    return this;
  }

  limit(n: number) {
    this.desc.limit = n;
    return this;
  }

  range(from: number, to: number) {
    this.desc.offset = from;
    this.desc.limit = to - from + 1;
    return this;
  }

  single(): QueryBuilder<Row, Row> {
    this.desc.single = 'one';
    return this as unknown as QueryBuilder<Row, Row>;
  }

  maybeSingle(): QueryBuilder<Row, Row | null> {
    this.desc.single = 'maybe';
    return this as unknown as QueryBuilder<Row, Row | null>;
  }

  /** Present for API compatibility; the executor already returns rows. */
  returns<U>() {
    return this as unknown as QueryBuilder<U, U[]>;
  }

  private async run(): Promise<QueryResult<Result>> {
    // A bare insert/update/delete with no .select() still returns rows in the
    // Supabase client, so always ask for RETURNING when it is safe to.
    const desc: QueryDescriptor = { ...this.desc };
    if (desc.op !== 'select' && (desc.single || desc.returning)) desc.returning = true;

    try {
      const { rows, count, error } = await this.exec(desc);
      if (error) {
        return { data: null, error, count: null, status: 400 };
      }

      if (desc.head) {
        return { data: null, error: null, count, status: 200 };
      }

      if (desc.single === 'one') {
        if (rows.length === 0) {
          // Matches PostgREST: "no rows" is an error for .single()
          return {
            data: null,
            error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
            count,
            status: 406,
          };
        }
        return { data: rows[0] as Result, error: null, count, status: 200 };
      }

      if (desc.single === 'maybe') {
        return { data: (rows[0] ?? null) as Result, error: null, count, status: 200 };
      }

      if (desc.op !== 'select' && !desc.returning) {
        return { data: null, error: null, count, status: 200 };
      }

      return { data: rows as unknown as Result, error: null, count, status: 200 };
    } catch (err: any) {
      return {
        data: null,
        error: { message: err?.message ?? String(err), code: err?.code, details: err?.detail },
        count: null,
        status: 500,
      };
    }
  }

  then<R1 = QueryResult<Result>, R2 = never>(
    onfulfilled?: ((value: QueryResult<Result>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}
