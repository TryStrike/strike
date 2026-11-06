'use client';


import { normalizeTabParam, type DashboardTab } from '@/lib/admin/dashboardTabs';
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from '@/lib/admin/listParams';

export interface DashFilters {
    tab: DashboardTab;
    q: string;
    status: string;
    currency: string;
    from: string;
    to: string;
    account: string;
    limit: number;
    offset: number;
    address: string;
}

function whole(raw: string | null, def: number, min: number, max: number): number {
    const v = (raw ?? '').trim();
    if (!/^\d+$/.test(v)) return def;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min) return def;
    return Math.min(n, max);
}

export function parseDashFilters(sp: URLSearchParams): DashFilters {
    return {
        tab: normalizeTabParam(sp.get('tab')),
        q: (sp.get('q') ?? '').trim().slice(0, 100),
        status: (sp.get('status') ?? '').trim().toLowerCase().replace(/[^a-z_]/g, '').slice(0, 24),
        currency: (sp.get('currency') ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16),
        from: (sp.get('from') ?? '').trim().slice(0, 40),
        to: (sp.get('to') ?? '').trim().slice(0, 40),
        account: ['all', 'real', 'demo'].includes((sp.get('account') ?? '').trim().toLowerCase())
            ? (sp.get('account') as string).trim().toLowerCase()
            : 'all',
        limit: whole(sp.get('limit'), LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT),
        offset: whole(sp.get('offset'), 0, 0, 100_000),
        address: (sp.get('address') ?? '').trim().slice(0, 128),
    };
}

export function dashQuery(f: DashFilters, overrides: Partial<DashFilters> = {}): string {
    const merged = { ...f, ...overrides };
    const sp = new URLSearchParams();
    sp.set('tab', merged.tab);
    if (merged.q) sp.set('q', merged.q);
    if (merged.status) sp.set('status', merged.status);
    if (merged.currency) sp.set('currency', merged.currency);
    if (merged.from) sp.set('from', merged.from);
    if (merged.to) sp.set('to', merged.to);
    if (merged.account !== 'all') sp.set('account', merged.account);
    if (merged.limit !== LIST_DEFAULT_LIMIT) sp.set('limit', String(merged.limit));
    if (merged.offset > 0) sp.set('offset', String(merged.offset));
    if (merged.address) sp.set('address', merged.address);
    const s = sp.toString();
    return s ? `?${s}` : '';
}

export function apiListQuery(f: DashFilters, overrides: Partial<DashFilters> = {}): string {
    const merged = { ...f, ...overrides };
    const sp = new URLSearchParams();
    sp.set('limit', String(merged.limit));
    if (merged.offset > 0) sp.set('offset', String(merged.offset));
    if (merged.q) sp.set('q', merged.q);
    if (merged.status) sp.set('status', merged.status);
    if (merged.currency) sp.set('currency', merged.currency);
    if (merged.from) sp.set('from', merged.from);
    if (merged.to) sp.set('to', merged.to);
    if (merged.account !== 'all') sp.set('account', merged.account);
    return sp.toString();
}

export function exportStatusFor(allowed: readonly string[], status: string): string {
    return allowed.includes(status) ? status : '';
}

export function apiExportQuery(f: DashFilters, allowedStatuses: readonly string[]): string {
    return apiListQuery(f, { status: exportStatusFor(allowedStatuses, f.status) });
}
