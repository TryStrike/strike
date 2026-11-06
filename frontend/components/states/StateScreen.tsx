'use client';


import React, { type ReactNode } from 'react';
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
  title?: string;
  hint?: ReactNode;
  icon?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: SecondaryAction;
  error?: unknown;
  className?: string;
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
              ? 'bg-up text-white hover:brightness-110'
              : 'bg-white text-ink ring-1 ring-ink/[0.08] hover:ring-ink/30'
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

export default StateScreen;
