'use client';

/**
 * Toast management hook + zustand store.
 *
 * Public API contract (keep stable — many call sites depend on it):
 *   const toast = useToast();
 *   toast.success(msg); toast.error(msg); toast.warning(msg); toast.info(msg);
 *   useToastStore.getState().addToast(message, type, links?)
 *
 * New (all optional, backwards compatible):
 *   toast.error(msg, { onRetry })            -> error toast with Retry action
 *   toast.info(msg, { action, duration })    -> any variant with an action button
 *   addToast(msg, type, links, options)      -> 4th positional arg
 *
 * Behaviour: bounded stack (MAX_TOASTS kept, MAX_VISIBLE shown with a
 * "+N earlier" collapse), dedupe of identical type+message inside a short
 * window, auto-dismiss that pauses on hover/keyboard focus (in Toast.tsx).
 *
 * Task: 9.2 Implement deposit transaction flow
 * Requirements: 8.5, 10.1
 */

import { create } from 'zustand';
import { ToastType } from '@/components/ui/Toast';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** ms before auto-dismiss; 0 pins the toast until dismissed. */
  duration?: number;
  /** Optional single action button rendered under the message. */
  action?: ToastAction;
  /** Shorthand for `action: { label: 'Retry', onClick: onRetry }`. */
  onRetry?: () => void;
  /** Explicit dedupe key; defaults to `${type}:${message}`. */
  dedupeKey?: string;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  links?: Array<{ label: string; href: string }>;
  action?: ToastAction;
  /** Per-toast auto-dismiss override; undefined = component default. */
  duration?: number;
  /** Epoch ms when queued — lets the container stagger/collapse old items. */
  createdAt: number;
  /** Internal dedupe key (`type:message` unless overridden). */
  dedupeKey?: string;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (
    message: string,
    type: ToastType,
    links?: Array<{ label: string; href: string }>,
    options?: ToastOptions
  ) => void;
  removeToast: (id: string) => void;
  clearAll: () => void;
}

/** Hard ceiling on toasts kept in the store at all. */
export const MAX_TOASTS = 5;
/** Toasts shown before the older ones collapse into a "+N earlier" chip. */
export const MAX_VISIBLE_TOASTS = 3;
/** Identical message+type within this window is treated as a duplicate. */
export const DEDUPE_WINDOW_MS = 2000;

/** Pure: dedupe key for a toast. */
export function toastDedupeKey(type: ToastType, message: string, dedupeKey?: string): string {
  return dedupeKey ?? `${type}:${message}`;
}

/**
 * Pure: true when `key` was emitted within `windowMs` of `now`.
 * Does not mutate `recent` — the caller records the timestamp.
 */
export function isDuplicateToast(
  recent: Map<string, number>,
  key: string,
  now: number,
  windowMs: number = DEDUPE_WINDOW_MS
): boolean {
  const lastSeen = recent.get(key);
  return lastSeen !== undefined && now - lastSeen < windowMs;
}

/** Pure: drop entries older than the dedupe window. Returns count pruned. */
export function pruneDedupeEntries(
  recent: Map<string, number>,
  now: number,
  windowMs: number = DEDUPE_WINDOW_MS
): number {
  let pruned = 0;
  for (const [key, ts] of recent) {
    if (now - ts >= windowMs) {
      recent.delete(key);
      pruned += 1;
    }
  }
  return pruned;
}

/** Pure: keep only the newest `max` items (input assumed append-ordered). */
export function clampToasts<T>(toasts: T[], max: number = MAX_TOASTS): T[] {
  if (max <= 0) return [];
  return toasts.length <= max ? toasts : toasts.slice(toasts.length - max);
}

/**
 * Pure: split the stack into collapsed (older) + visible (newest) segments.
 * Oldest-first input; visible segment stays oldest-first for rendering.
 */
export function splitToastStack<T>(
  toasts: T[],
  maxVisible: number = MAX_VISIBLE_TOASTS
): { collapsed: T[]; visible: T[] } {
  if (toasts.length <= maxVisible) return { collapsed: [], visible: toasts };
  return {
    collapsed: toasts.slice(0, toasts.length - maxVisible),
    visible: toasts.slice(toasts.length - maxVisible),
  };
}

/** Pure: true when a toast with this dedupe key is still in the stack. */
export function hasToastWithKey<T extends { dedupeKey?: string }>(toasts: T[], key: string): boolean {
  return toasts.some((toast) => toast.dedupeKey === key);
}

// Last-emitted timestamp per dedupe key.
const recentByToastKey = new Map<string, number>();

/** Zustand store for toast management */
export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  addToast: (
    message: string,
    type: ToastType,
    links?: Array<{ label: string; href: string }>,
    options?: ToastOptions
  ) => {
    const now = Date.now();

    // Drop identical message+type spam fired inside the dedupe window
    // (e.g. a retry loop erroring every second).
    const dedupeKey = toastDedupeKey(type, message, options?.dedupeKey);
    if (isDuplicateToast(recentByToastKey, dedupeKey, now)) {
      return;
    }
    recentByToastKey.set(dedupeKey, now);
    // Prune stale entries so the map doesn't grow unbounded.
    pruneDedupeEntries(recentByToastKey, now);

    const action: ToastAction | undefined =
      options?.action ?? (options?.onRetry ? { label: 'Retry', onClick: options.onRetry } : undefined);

    const toast: Toast = {
      id: `toast-${now}-${Math.random()}`,
      message,
      type,
      links,
      action,
      duration: options?.duration,
      createdAt: now,
      dedupeKey,
    };

    set((state) => {
      // Same message+type still on screen → never stack a second copy,
      // even after the timed dedupe window has passed. Returning the
      // current state object means zustand notifies no subscribers.
      if (hasToastWithKey(state.toasts, dedupeKey)) return state;
      // Cap the list: keep only the newest MAX_TOASTS toasts.
      return { toasts: clampToasts([...state.toasts, toast]) };
    });
  },

  removeToast: (id: string) => {
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id)
    }));
  },

  clearAll: () => {
    set({ toasts: [] });
    recentByToastKey.clear();
  }
}));

/**
 * Hook for showing toast notifications
 * Returns functions for showing different types of toasts
 */
export const useToast = () => {
  // Subscribe only to the (stable) addToast action so consumers don't
  // re-render whenever any toast is added or removed.
  const addToast = useToastStore((s) => s.addToast);

  return {
    success: (message: string, options?: ToastOptions) => addToast(message, 'success', undefined, options),
    error: (message: string, options?: ToastOptions) => addToast(message, 'error', undefined, options),
    warning: (message: string, options?: ToastOptions) => addToast(message, 'warning', undefined, options),
    info: (message: string, options?: ToastOptions) => addToast(message, 'info', undefined, options)
  };
};
