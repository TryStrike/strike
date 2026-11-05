/**
 * Recent-wallet bookkeeping.
 *
 * Policy: recently-used wallets live in **sessionStorage only** — never
 * localStorage. A wallet address plus connector id is linkable identity
 * data, so it must die with the tab. Every storage touch is defensive:
 * private browsing modes and disabled-storage policies can throw from the
 * property getter itself, and reads of corrupt JSON must not break the
 * connect flow.
 */

export interface RecentWallet {
  /** wagmi/ConnectKit connector id, e.g. 'injected' or 'walletConnect'. */
  connectorId: string;
  /** Display name, e.g. 'MetaMask'. */
  name: string;
  /** Address last used with this connector (checksummed or not; canonical key is lowercase). */
  address: string;
  /** Epoch ms of last successful connect. */
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

/**
 * Insert-or-refresh an entry: dedupe by connector+address (case-insensitive),
 * newest first, capped. Pure — returns a fresh array, never mutates.
 */
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

/** Validate + normalize a parsed storage blob; garbage yields []. */
export function normalizeRecentWallets(raw: unknown, cap: number = RECENT_WALLETS_CAP): RecentWallet[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter(isValidRaw).map((v) => ({
    connectorId: v.connectorId.trim(),
    name: v.name.trim(),
    address: v.address.trim(),
    lastUsedAt: v.lastUsedAt,
  }));
  // Dedupe on the way in too: a hand-edited blob must not render two rows.
  const seen = new Set<string>();
  const unique = valid.filter((v) => {
    const k = dedupeKey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, Math.max(0, cap));
}

/** Minimal storage surface; `Storage` satisfies it. */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * sessionStorage access that fails closed: absent (SSR), disabled by policy,
 * or throwing from the getter (some privacy modes) all yield null. The probe
 * write confirms setItem actually works before we rely on it.
 */
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

/**
 * Persist the list. Returns false (and never throws) when storage is
 * unavailable or the write is rejected (quota / disabled storage) — so the
 * connect flow proceeds with memory-only bookkeeping.
 */
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
  } catch {
    // nothing to do
  }
}
