
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const TOUR_KEY_PREFIX = 'strike_tour';
export const ANON_TOUR_SCOPE = 'anon';

export function canonicalAddressForScope(address: string): string {
  const t = address.trim();
  if (!t) return '';
  return t.startsWith('0x') ? t.toLowerCase() : t;
}

export function hashForScope(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

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

export function clampTourStep(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), total - 1);
}

export function readTourStep(storage: StorageLike | null, scope: string, total: number): number {
  if (!storage || total <= 0) return 0;
  try {
    const raw = storage.getItem(tourStepKey(scope));
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return 0;
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
  } catch {}
}

export function clearTourProgress(storage: StorageLike | null, scope: string): void {
  if (!storage) return;
  try {
    storage.removeItem(tourStepKey(scope));
  } catch {}
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
  } catch {}
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
  } catch {}
}

export function shouldAutoStartTour(flags: { dismissed: boolean; seen: boolean }): boolean {
  return !flags.dismissed && !flags.seen;
}
