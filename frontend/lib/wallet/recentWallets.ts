
export interface RecentWallet {
  connectorId: string;
  name: string;
  address: string;
  lastUsedAt: number;
}

export const RECENT_WALLETS_STORAGE_KEY = 'strike_recent_wallets';
export const RECENT_WALLETS_CAP = 3;

function dedupeKey(entry: Pick<RecentWallet, 'connectorId' | 'address'>): string {
  return `${entry.connectorId.trim().toLowerCase()}:${entry.address.trim().toLowerCase()}`;
}

function isValidRaw(value: unknown): value is RecentWallet {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.connectorId === 'string' && v.connectorId.trim() !== '' &&
    typeof v.address === 'string' && v.address.trim() !== '' &&
    typeof v.name === 'string' &&
    typeof v.lastUsedAt === 'number' && Number.isFinite(v.lastUsedAt)
  );
}

export function upsertRecentWallet(
  list: readonly RecentWallet[],
  entry: { connectorId: string; name?: string; address: string; lastUsedAt?: number },
  cap: number = RECENT_WALLETS_CAP,
): RecentWallet[] {
  if (!entry || typeof entry.connectorId !== 'string' || !entry.connectorId.trim()) return [...list];
  if (typeof entry.address !== 'string' || !entry.address.trim()) return [...list];

  const normalized: RecentWallet = {
    connectorId: entry.connectorId.trim(),
    name: (entry.name ?? '').trim(),
    address: entry.address.trim(),
    lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : Date.now(),
  };
  const key = dedupeKey(normalized);
  const rest = list.filter((item) => isValidRaw(item) && dedupeKey(item) !== key);
  return [...rest, normalized].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, Math.max(0, cap));
}

export function normalizeRecentWallets(raw: unknown, cap: number = RECENT_WALLETS_CAP): RecentWallet[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter(isValidRaw).map((v) => ({
    connectorId: v.connectorId.trim(),
    name: v.name.trim(),
    address: v.address.trim(),
    lastUsedAt: v.lastUsedAt,
  }));
  const seen = new Set<string>();
  const unique = valid.filter((v) => {
    const k = dedupeKey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, Math.max(0, cap));
}

export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function getSessionStore(): KVStore | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    const store = window.sessionStorage;
    const probe = '__strike_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

export function loadRecentWallets(store: KVStore | null = getSessionStore()): RecentWallet[] {
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_WALLETS_STORAGE_KEY);
    if (!raw) return [];
    return normalizeRecentWallets(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveRecentWallets(list: readonly RecentWallet[], store: KVStore | null = getSessionStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(RECENT_WALLETS_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function clearRecentWallets(store: KVStore | null = getSessionStore()): void {
  if (!store) return;
  try {
    store.removeItem?.(RECENT_WALLETS_STORAGE_KEY);
  } catch {}
}
