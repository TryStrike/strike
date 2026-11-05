
export const DASHBOARD_TABS = [
    'wallet_intel',
    'users',
    'player_pnl',
    'gameplay',
    'financial',
    'markets',
    'referrals',
    'danger',
] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number];

export const DEFAULT_DASHBOARD_TAB: DashboardTab = 'wallet_intel';

export function isDashboardTab(value: unknown): value is DashboardTab {
    return typeof value === 'string' && (DASHBOARD_TABS as readonly string[]).includes(value);
}

export function normalizeTabParam(value: string | null | undefined): DashboardTab {
    const v = (value ?? '').trim().toLowerCase();
    return isDashboardTab(v) ? v : DEFAULT_DASHBOARD_TAB;
}

export const TAB_SHORTCUT_ORDER: readonly DashboardTab[] = DASHBOARD_TABS;
