/**
 * Pure, dependency-free parser for the uniform list-endpoint query params:
 *   limit, offset, q, status, currency, from, to
 *
 * Every admin list route funnels searchParams through this so that:
 *  - numeric params can never be NaN / Infinity / fractions reaching SQL,
 *  - enum params (status, currency, extra enums) fail with a 400 message
 *    instead of crashing the route with a 500,
 *  - pagination is capped (default 50, max 200).
 *
 * Returns { ok: false, error } with a client-safe message; the error strings
 * here contain no SQL, secrets or internals — they are safe to echo to the UI.
 */

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
export const LIST_MAX_OFFSET = 100_000;
export const LIST_MAX_QUERY_LENGTH = 100;
export const LIST_MAX_CURRENCY_LENGTH = 16;

export interface ParsedListParams {
    limit: number;
    offset: number;
    /** Lowercased, trimmed search term (addresses / usernames / ids). */
    q: string | null;
    /** Validated enum value for the route's status filter. */
    status: string | null;
    /** Uppercased currency/asset ticker. */
    currency: string | null;
    /** ISO-8601 lower bound (inclusive) for the route's timestamp column. */
    from: string | null;
    /** ISO-8601 upper bound (inclusive) for the route's timestamp column. */
    to: string | null;
    /** Extra validated enum params, keyed by param name (e.g. { account: 'real' }). */
    extras: Record<string, string>;
}

export type ParseListParamsResult =
    | { ok: true; params: ParsedListParams }
    | { ok: false; error: string };

export interface ListParamsOptions {
    /** Allowed values for `status`. Unknown / missing → any status value is rejected with 400. */
    statusValues?: readonly string[];
    /** Extra enum params, e.g. { account: ['all', 'real', 'demo'] }. */
    extraEnums?: Record<string, readonly string[]>;
    defaultLimit?: number;
}

/** Whole numbers only; rejects '', 'abc', '1.5', 'NaN', 'Infinity', '1e999', '+-3'. */
function parseWholeNumber(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return null;
    return n;
}

function normalizeIso(raw: string, name: string): { value?: string; error?: string } {
    // Accept full ISO timestamps and plain dates; interpret date-only as UTC.
    const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
    const ms = Date.parse(candidate);
    if (!Number.isFinite(ms)) return { error: `Invalid ${name} (expected an ISO date)` };
    return { value: new Date(ms).toISOString() };
}

/**
 * Strips characters that would break a PostgREST `.or()` expression
 * (commas split clauses) and non-printables; keeps ILIKE wildcards (% _)
 * since the value is always bound as a SQL parameter anyway.
 */
export function sanitizeQueryTerm(q: string): string {
    let out = '';
    for (const ch of q) {
        const code = ch.charCodeAt(0);
        if (ch === ',' || code < 32 || code === 127) continue;
        out += ch;
    }
    return out.trim().slice(0, LIST_MAX_QUERY_LENGTH);
}

/** Wraps a sanitized query term as an ILIKE contains-pattern. */
export function likePattern(sanitizedQ: string): string {
    return `%${sanitizedQ}%`;
}

export function parseListParams(
    searchParams: URLSearchParams,
    opts: ListParamsOptions = {},
): ParseListParamsResult {
    const params: ParsedListParams = {
        limit: Math.min(Math.max(opts.defaultLimit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT),
        offset: 0,
        q: null,
        status: null,
        currency: null,
        from: null,
        to: null,
        extras: {},
    };

    const limitRaw = (searchParams.get('limit') ?? '').trim();
    if (limitRaw !== '') {
        const n = parseWholeNumber(limitRaw);
        if (n === null) return { ok: false, error: 'Invalid limit (must be a whole number).' };
        if (n < 1) return { ok: false, error: 'limit must be >= 1.' };
        params.limit = Math.min(n, LIST_MAX_LIMIT);
    }

    const offsetRaw = (searchParams.get('offset') ?? '').trim();
    if (offsetRaw !== '') {
        const n = parseWholeNumber(offsetRaw);
        if (n === null) return { ok: false, error: 'Invalid offset (must be a whole number).' };
        params.offset = Math.min(n, LIST_MAX_OFFSET);
    }

    const qRaw = (searchParams.get('q') ?? '').trim();
    if (qRaw !== '') {
        const q = sanitizeQueryTerm(qRaw);
        if (qRaw.length > LIST_MAX_QUERY_LENGTH * 2) {
            return { ok: false, error: `q is too long (max ${LIST_MAX_QUERY_LENGTH} characters).` };
        }
        params.q = q.length > 0 ? q : null;
    }

    const statusRaw = (searchParams.get('status') ?? '').trim().toLowerCase();
    if (statusRaw !== '') {
        const allowed = opts.statusValues;
        if (!allowed || allowed.length === 0 || !allowed.includes(statusRaw)) {
            const allowedText = allowed && allowed.length > 0 ? ` Allowed: ${allowed.join(', ')}.` : '';
            return { ok: false, error: `Invalid status: ${statusRaw}.${allowedText}` };
        }
        params.status = statusRaw;
    }

    const currencyRaw = (searchParams.get('currency') ?? '').trim();
    if (currencyRaw !== '') {
        if (!/^[A-Za-z0-9_]{1,16}$/.test(currencyRaw)) {
            return { ok: false, error: 'Invalid currency (expected a short ticker symbol).' };
        }
        params.currency = currencyRaw.toUpperCase();
    }

    const fromRaw = (searchParams.get('from') ?? '').trim();
    if (fromRaw !== '') {
        const iso = normalizeIso(fromRaw, 'from');
        if (iso.error) return { ok: false, error: iso.error };
        params.from = iso.value!;
    }

    const toRaw = (searchParams.get('to') ?? '').trim();
    if (toRaw !== '') {
        const iso = normalizeIso(toRaw, 'to');
        if (iso.error) return { ok: false, error: iso.error };
        params.to = iso.value!;
    }

    if (fromRaw !== '' && toRaw !== '' && params.from && params.to && params.to < params.from) {
        return { ok: false, error: 'to must not be earlier than from.' };
    }

    for (const [name, allowed] of Object.entries(opts.extraEnums ?? {})) {
        const raw = (searchParams.get(name) ?? '').trim().toLowerCase();
        if (raw === '') continue;
        if (!allowed.includes(raw)) {
            return { ok: false, error: `Invalid ${name}: ${raw}. Allowed: ${allowed.join(', ')}.` };
        }
        params.extras[name] = raw;
    }

    return { ok: true, params };
}

/** Serialises parsed params back into a URLSearchParams for the dashboard. */
export function listParamsToQuery(params: ParsedListParams): string {
    const sp = new URLSearchParams();
    sp.set('limit', String(params.limit));
    if (params.offset > 0) sp.set('offset', String(params.offset));
    if (params.q) sp.set('q', params.q);
    if (params.status) sp.set('status', params.status);
    if (params.currency) sp.set('currency', params.currency);
    if (params.from) sp.set('from', params.from);
    if (params.to) sp.set('to', params.to);
    for (const [k, v] of Object.entries(params.extras)) sp.set(k, v);
    return sp.toString();
}

/** range() end index for the QueryBuilder: [offset, offset+limit-1]. */
export function listRange(params: ParsedListParams): { from: number; to: number } {
    return { from: params.offset, to: params.offset + params.limit - 1 };
}
