'use client';


import { create } from 'zustand';
import { ToastType } from '@/components/ui/Toast';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  duration?: number;
  action?: ToastAction;
  onRetry?: () => void;
  dedupeKey?: string;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  links?: Array<{ label: string; href: string }>;
  action?: ToastAction;
  duration?: number;
  createdAt: number;
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

export const MAX_TOASTS = 5;
export const MAX_VISIBLE_TOASTS = 3;
export const DEDUPE_WINDOW_MS = 2000;

export function toastDedupeKey(type: ToastType, message: string, dedupeKey?: string): string {
  return dedupeKey ?? `${type}:${message}`;
}

export function isDuplicateToast(
  recent: Map<string, number>,
  key: string,
  now: number,
  windowMs: number = DEDUPE_WINDOW_MS
): boolean {
  const lastSeen = recent.get(key);
  return lastSeen !== undefined && now - lastSeen < windowMs;
}

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

export function clampToasts<T>(toasts: T[], max: number = MAX_TOASTS): T[] {
  if (max <= 0) return [];
  return toasts.length <= max ? toasts : toasts.slice(toasts.length - max);
}

export function hasToastWithKey<T extends { dedupeKey?: string }>(toasts: T[], key: string): boolean {
  return toasts.some((toast) => toast.dedupeKey === key);
}

const recentByToastKey = new Map<string, number>();

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  addToast: (
    message: string,
    type: ToastType,
    links?: Array<{ label: string; href: string }>,
    options?: ToastOptions
  ) => {
    const now = Date.now();

    const dedupeKey = toastDedupeKey(type, message, options?.dedupeKey);
    if (isDuplicateToast(recentByToastKey, dedupeKey, now)) {
      return;
    }
    recentByToastKey.set(dedupeKey, now);
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
      if (hasToastWithKey(state.toasts, dedupeKey)) return state;
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

export const useToast = () => {
  const addToast = useToastStore((s) => s.addToast);

  return {
    success: (message: string, options?: ToastOptions) => addToast(message, 'success', undefined, options),
    error: (message: string, options?: ToastOptions) => addToast(message, 'error', undefined, options),
    warning: (message: string, options?: ToastOptions) => addToast(message, 'warning', undefined, options),
    info: (message: string, options?: ToastOptions) => addToast(message, 'info', undefined, options)
  };
};
