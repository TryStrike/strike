/**
 * Pure, dependency-free persistence helpers for the onboarding tour.
 * All storage access goes through a `StorageLike` so tests can pass a fake
 * and SSR never touches `window`.
 *
 * Privacy policy (mirrors lib/wallet/recentWallets.ts): tour progress is
 * tied to a wallet, so it lives in **sessionStorage only** — never
 * localStorage — and dies with the tab. A wallet address is linkable
 * identity data and must not appear in a storage key that could leak
 * across users of the same tab, so each key carries a small deterministic
 * hash of the canonical address instead. Progress is isolated per wallet:
 * switching wallets mid-tab cannot read, resume, complete, or dismiss
 * another wallet's tour.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const TOUR_KEY_PREFIX = 'strike_tour';
/** Scope used when no wallet is connected. */
export const ANON_TOUR_SCOPE = 'anon';

/** Canonical form for scoping (mirrors canonicalHouseUserAddress). */
export function canonicalAddressForScope(address: string): string {
  const t = address.trim();
  if (!t) return '';
  return t.startsWith('0x') ? t.toLowerCase() : t;
}

/** FNV-1a (32-bit) hex digest — keeps the raw address out of storage keys. */
export function hashForScope(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Storage scope for a wallet: hashed canonical address, else 'anon'. */
export function normalizeTourScope(address?: string | null): string {
  const canonical = canonicalAddressForScope(address ?? '');
  return canonical ? hashForScope(canonical) : ANON_TOUR_SCOPE;
}

export function tourStepKey(scope: string): string {
  return `${TOUR_KEY_PREFIX}:step:${scope}`;
}

export function tourDismissedKey(scope: string): string {
  return `${TOUR_KEY_PREFIX}:dismissed:${scope}`;
}

export function tourSeenKey(scope: string): string {
  return `${TOUR_KEY_PREFIX}:seen:${scope}`;
}

/**
 * sessionStorage wrapper that never throws (private mode, SSR, disabled
 * storage). Fails closed like recentWallets' getSessionStore(): the probe
 * write confirms setItem actually works before we rely on it.
 */
export function safeStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    const store = window.sessionStorage;
    if (!store) return null;
    const probe = '__strike_tour_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/**
 * Pure step math: clamp an index into [0, total-1].
 * Invalid/NaN input and empty step lists collapse to 0.
 */
export function clampTourStep(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), total - 1);
}

/** Read the persisted resume index for one wallet scope; 0 when absent/corrupt. */
export function readTourStep(storage: StorageLike | null, scope: string, total: number): number {
  if (!storage || total <= 0) return 0;
  try {
    const raw = storage.getItem(tourStepKey(scope));
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return 0;
    // A stored step at/after the end means the tour was finished elsewhere.
    if (n >= total) return 0;
    return clampTourStep(n, total);
  } catch {
    return 0;
  }
}

export function writeTourStep(storage: StorageLike | null, scope: string, index: number): void {
  if (!storage) return;
  try {
    storage.setItem(tourStepKey(scope), String(Math.max(0, Math.trunc(index) || 0)));
  } catch {
    /* ignore quota/private-mode errors */
  }
}

export function clearTourProgress(storage: StorageLike | null, scope: string): void {
  if (!storage) return;
  try {
    storage.removeItem(tourStepKey(scope));
  } catch {
    /* ignore */
  }
}

export function isTourDismissed(storage: StorageLike | null, scope: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(tourDismissedKey(scope)) === '1';
  } catch {
    return false;
  }
}

export function setTourDismissed(storage: StorageLike | null, scope: string, dismissed: boolean): void {
  if (!storage) return;
  try {
    if (dismissed) storage.setItem(tourDismissedKey(scope), '1');
    else storage.removeItem(tourDismissedKey(scope));
  } catch {
    /* ignore */
  }
}

export function hasSeenTour(storage: StorageLike | null, scope: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(tourSeenKey(scope)) === '1';
  } catch {
    return false;
  }
}

export function markTourSeen(storage: StorageLike | null, scope: string): void {
  if (!storage) return;
  try {
    storage.setItem(tourSeenKey(scope), '1');
  } catch {
    /* ignore */
  }
}

/**
 * Pure first-run rule: the tour may auto-start only when this wallet scope
 * has never finished/seen it and has not opted out via "Don't show again".
 */
export function shouldAutoStartTour(flags: { dismissed: boolean; seen: boolean }): boolean {
  return !flags.dismissed && !flags.seen;
}
