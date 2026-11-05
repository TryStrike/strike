'use client';

/**
 * StateScreen — one component that renders the four first-class route/data
 * states: empty, loading, error, offline. Theme is off the existing light
 * design tokens (ink/muted/faint/line/surface/up) defined in app/globals.css.
 *
 * The error variant intentionally shows a sanitized `ErrorNote` instead of
 * anything derived from the raw error object, so stack traces, SQL, env vars
 * and absolute paths structurally cannot reach the DOM via this component.
 */

import React, { useEffect, useState, type ReactNode } from 'react';
import {
  Archive,
  WarningOctagon,
  WifiSlash,
  ArrowCounterClockwise,
} from '@phosphor-icons/react';
import { ErrorNote, defaultErrorHeadline } from './ErrorNote';

export type StateVariant = 'empty' | 'loading' | 'error' | 'offline';

export interface SecondaryAction {
  label: string;
  onClick: () => void;
}

interface VariantDefaults {
  icon: ReactNode;
  title: string;
  actionLabel: string;
  tone: 'neutral' | 'error' | 'muted';
}

/** Pure so tests can pin the copy/variant contract. */
export function describeStateVariant(variant: StateVariant): VariantDefaults {
  switch (variant) {
    case 'loading':
      return {
        icon: <SpinnerGlyph />,
        title: 'Loading…',
        actionLabel: 'Retry',
        tone: 'neutral',
      };
    case 'error':
      return {
        icon: <WarningOctagon size={30} weight="duotone" className="text-down" />,
        title: defaultErrorHeadline,
        actionLabel: 'Try again',
        tone: 'error',
      };
    case 'offline':
      return {
        icon: <WifiSlash size={30} weight="duotone" className="text-faint" />,
        title: 'You appear to be offline',
        actionLabel: 'Reconnect',
        tone: 'muted',
      };
    case 'empty':
    default:
      return {
        icon: <Archive size={30} weight="duotone" className="text-faint" />,
        title: 'Nothing here yet',
        actionLabel: 'Refresh',
        tone: 'neutral',
      };
  }
}

function SpinnerGlyph() {
  return (
    <span
      className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-up-soft"
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 by-spin text-up" fill="none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export interface StateScreenProps {
  variant: StateVariant;
  /** Override the default headline for the variant. */
  title?: string;
  /** Supporting line under the headline. */
  hint?: ReactNode;
  /** Replace the default icon entirely. */
  icon?: ReactNode;
  /** Retry CTA. The CTA only renders when onRetry is provided (error/offline
   *  variants default to their own labels). */
  onRetry?: () => void;
  retryLabel?: string;
  /** Optional secondary, lower-emphasis action. */
  secondaryAction?: SecondaryAction;
  /** For the error variant: the raw error (or message) to sanitize + show. */
  error?: unknown;
  className?: string;
  /** Tighter paddings for embedding inside cards/panels. */
  compact?: boolean;
}

export const StateScreen: React.FC<StateScreenProps> = ({
  variant,
  title,
  hint,
  icon,
  onRetry,
  retryLabel,
  secondaryAction,
  error,
  className = '',
  compact = false,
}) => {
  const defaults = describeStateVariant(variant);

  // "Empty" means the request succeeded and there is genuinely no data
  // (title "Nothing here yet", neutral icon, no error line, no CTA unless
  // the caller passes onRetry). A FAILED request must use variant="error",
  // which shows the sanitized ErrorNote and always offers an actionable
  // retry — falling back to reloading the page when no handler is given.
  const showCta = variant === 'error' || variant === 'offline' || !!onRetry;
  const handleRetry =
    onRetry ??
    (() => {
      if (typeof window !== 'undefined') window.location.reload();
    });

  return (
    <div
      role={
        variant === 'error' || variant === 'offline'
          ? 'alert'
          : variant === 'loading'
            ? 'status'
            : undefined
      }
      aria-busy={variant === 'loading' ? true : undefined}
      className={`flex flex-col items-center justify-center text-center font-tight text-ink ${
        compact ? 'gap-2.5 px-4 py-8' : 'gap-4 px-6 py-12'
      } ${className}`}
    >
      <div className={compact ? 'scale-90' : undefined} aria-hidden={variant === 'loading' ? undefined : 'true'}>
        {icon ?? defaults.icon}
      </div>

      <p className="text-[17px] font-semibold leading-snug tracking-tight">
        {title ?? defaults.title}
      </p>

      {hint && <p className="max-w-[38ch] text-sm leading-relaxed text-muted">{hint}</p>}

      {variant === 'error' && error !== undefined && error !== null && (
        <ErrorNote error={error} className="mt-1 max-w-[46ch]" />
      )}

      {showCta && (
        <button
          type="button"
          onClick={handleRetry}
          className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-all active:scale-[0.98] ${
            defaults.tone === 'error'
              ? 'bg-[#2151F5] text-white shadow-[0_8px_20px_-8px_rgba(33,81,245,0.6)] hover:brightness-110'
              : 'bg-white text-ink ring-1 ring-ink/[0.08] shadow-[0_1px_2px_rgba(10,12,16,0.04)] hover:ring-ink/30'
          }`}
        >
          <ArrowCounterClockwise size={15} weight="bold" aria-hidden="true" />
          {retryLabel ?? defaults.actionLabel}
        </button>
      )}

      {secondaryAction && (
        <button
          type="button"
          onClick={secondaryAction.onClick}
          className="rounded-full px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-ink"
        >
          {secondaryAction.label}
        </button>
      )}
    </div>
  );
};

/**
 * Live-status helper for the offline variant: returns whether the browser is
 * currently online and re-renders on online/offline events. SSR-safe.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export default StateScreen;
