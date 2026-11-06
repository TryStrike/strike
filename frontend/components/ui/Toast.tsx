'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, ArrowCounterClockwise } from '@phosphor-icons/react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastActionView {
  label: string;
  onClick: () => void;
}

interface ToastProps {
  message: string;
  type: ToastType;
  onClose: () => void;
  duration?: number;
  links?: Array<{ label: string; href: string }>;
  action?: ToastActionView;
  onRetry?: () => void;
}

const DOT: Record<ToastType, string> = {
  success: 'bg-up',
  error: 'bg-down',
  warning: 'bg-down',
  info: 'bg-faint',
};

export const DEFAULT_TOAST_DURATION_MS = 5000;

interface DismissTimer {
  remaining: number;
  startedAt: number;
  handle: ReturnType<typeof setTimeout> | null;
}

const Toast: React.FC<ToastProps> = ({
  message,
  type,
  onClose,
  duration = DEFAULT_TOAST_DURATION_MS,
  links,
  action,
  onRetry
}) => {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const timerRef = useRef<DismissTimer>({ remaining: duration, startedAt: 0, handle: null });

  const clearTimer = useCallback(() => {
    if (timerRef.current.handle !== null) {
      clearTimeout(timerRef.current.handle);
      timerRef.current.handle = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    if (duration <= 0 || timerRef.current.handle !== null || timerRef.current.remaining <= 0) return;
    timerRef.current.startedAt = Date.now();
    timerRef.current.handle = setTimeout(() => {
      timerRef.current.handle = null;
      onCloseRef.current();
    }, timerRef.current.remaining);
  }, [duration]);

  const pauseTimer = useCallback(() => {
    if (timerRef.current.handle === null) return;
    clearTimeout(timerRef.current.handle);
    timerRef.current.handle = null;
    timerRef.current.remaining = Math.max(0, timerRef.current.remaining - (Date.now() - timerRef.current.startedAt));
  }, []);

  useEffect(() => {
    timerRef.current.remaining = duration;
    startTimer();
    return clearTimer;
  }, [duration, startTimer, clearTimer]);

  const interactiveProps = duration > 0
    ? {
        onMouseEnter: pauseTimer,
        onMouseLeave: startTimer,
        onFocus: pauseTimer,
        onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) startTimer();
        }
      }
    : {};

  const retryLabel = action ? action.label : onRetry ? 'Retry' : null;
  const retryClick = action ? action.onClick : onRetry;

  return (
    <div
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
      className="flex items-start gap-3 rounded-2xl bg-white px-4 py-3 font-tight text-ink ring-1 ring-line shadow-[0_20px_40px_-24px_rgba(10,12,16,0.3)] animate-slide-in"
      {...interactiveProps}
    >
      <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${DOT[type]}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{message}</p>
        {links && links.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-3">
            {links.map((link) => (
              <a
                key={`${link.href}-${link.label}`}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-up hover:underline underline-offset-2"
              >
                {link.label}
              </a>
            ))}
          </div>
        )}
        {retryLabel && retryClick && (
          <button
            type="button"
            onClick={retryClick}
            className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${
              type === 'error'
                ? 'bg-down-soft text-down hover:brightness-95'
                : 'bg-up-soft text-up hover:brightness-95'
            }`}
          >
            {type === 'error' && <ArrowCounterClockwise size={12} weight="bold" aria-hidden="true" />}
            {retryLabel}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 rounded-full p-0.5 text-faint transition-colors hover:text-ink"
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  );
};

interface ToastContainerProps {
  toasts: Array<{
    id: string;
    message: string;
    type: ToastType;
    links?: Array<{ label: string; href: string }>;
    action?: ToastActionView;
    duration?: number;
  }>;
  onRemove: (id: string) => void;
  maxVisible?: number;
}

export const DEFAULT_MAX_VISIBLE = 3;

export const ToastContainer: React.FC<ToastContainerProps> = ({
  toasts,
  onRemove,
  maxVisible = DEFAULT_MAX_VISIBLE
}) => {
  const [expanded, setExpanded] = useState(false);
  if (expanded && toasts.length <= maxVisible) setExpanded(false);

  const collapsedCount = Math.max(0, toasts.length - maxVisible);
  const visible = expanded || collapsedCount === 0
    ? toasts
    : toasts.slice(toasts.length - maxVisible);

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 top-4 z-[200] w-[min(360px,calc(100vw-2rem))] space-y-2"
    >
      {collapsedCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="pointer-events-auto ml-auto block rounded-full bg-ink/70 px-3 py-1 font-jet text-[11px] font-medium text-white backdrop-blur-xl transition-colors hover:bg-ink"
        >
          {expanded ? 'Collapse' : `+${collapsedCount} earlier`}
        </button>
      )}
      {visible.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast
            message={toast.message}
            type={toast.type}
            links={toast.links}
            action={toast.action}
            duration={toast.duration}
            onClose={() => onRemove(toast.id)}
          />
        </div>
      ))}
    </div>
  );
};

export default Toast;
