
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
export const LIST_MAX_OFFSET = 100_000;
export const LIST_MAX_QUERY_LENGTH = 100;
export const LIST_MAX_CURRENCY_LENGTH = 16;

export interface ParsedListParams {
    limit: number;
    offset: number;
    q: string | null;
    status: string | null;
    currency: string | null;
    from: string | null;
    to: string | null;
    extras: Record<string, string>;
}

export type ParseListParamsResult =
    | { ok: true; params: ParsedListParams }
    | { ok: false; error: string };

export interface ListParamsOptions {
    statusValues?: readonly string[];
    extraEnums?: Record<string, readonly string[]>;
    defaultLimit?: number;
}

function parseWholeNumber(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return null;
    return n;
}

function normalizeIso(raw: string, name: string): { value?: string; error?: string } {
    const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
    const ms = Date.parse(candidate);
    if (!Number.isFinite(ms)) return { error: `Invalid ${name} (expected an ISO date)` };
    return { value: new Date(ms).toISOString() };
}

export function sanitizeQueryTerm(q: string): string {
    let out = '';
    for (const ch of q) {
        const code = ch.charCodeAt(0);
        if (ch === ',' || code < 32 || code === 127) continue;
        out += ch;
    }
    return out.trim().slice(0, LIST_MAX_QUERY_LENGTH);
}

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

export function listRange(params: ParsedListParams): { from: number; to: number } {
    return { from: params.offset, to: params.offset + params.limit - 1 };
}
