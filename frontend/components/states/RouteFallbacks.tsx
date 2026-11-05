'use client';

/**
 * Shared fallback bodies for Next.js route files (loading.tsx / error.tsx /
 * not-found.tsx). Keeping the markup here means every app/<segment> file is a
 * three-line wrapper and all route states stay visually consistent.
 */

import React from 'react';
import { House } from '@phosphor-icons/react';
import { StateScreen } from './StateScreen';
import { SkeletonCard, SkeletonChartBlock, SkeletonStatTile, SkeletonTable } from './Skeleton';

/** Full-viewport light panel so fallbacks read correctly on the dark body. */
export const FallbackShell: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <div className={`flex min-h-[70vh] w-full items-center justify-center bg-white font-tight text-ink ${className}`}>
    {children}
  </div>
);

export type RouteShape = 'page' | 'dashboard' | 'list' | 'chart' | 'stats';

/** Which skeletons approximate the segment while its page streams/loads. */
export function routeSkeleton(shape: RouteShape) {
  switch (shape) {
    case 'dashboard':
    case 'stats':
      return (
        <div className="w-full max-w-[880px] space-y-4 px-4 py-8">
          <div className="grid gap-4 sm:grid-cols-3">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <SkeletonCard />
        </div>
      );
    case 'chart':
      return (
        <div className="w-full max-w-[880px] space-y-4 px-4 py-8">
          <SkeletonChartBlock />
          <div className="grid gap-4 sm:grid-cols-3">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
        </div>
      );
    case 'list':
      return (
        <div className="w-full max-w-[720px] px-4 py-8">
          <SkeletonTable rows={7} />
        </div>
      );
    case 'page':
    default:
      return <StateScreen variant="loading" hint="Loading this page…" />;
  }
}

export interface RouteLoadingProps {
  shape?: RouteShape;
  label?: string;
}

/** Body used by every app/**&#47;loading.tsx. */
export const RouteLoading: React.FC<RouteLoadingProps> = ({ shape = 'page', label }) => (
  <FallbackShell>
    <div aria-live="polite" aria-busy="true" className="sr-only">
      {label ?? 'Loading'}
    </div>
    {routeSkeleton(shape)}
  </FallbackShell>
);

export interface RouteErrorProps {
  error: unknown;
  reset: () => void;
  /** Contextual hint, e.g. "Prices may have moved mid-round." */
  hint?: string;
}

/** Body used by every app/**&#47;error.tsx. Raw error is sanitized by StateScreen. */
export const RouteError: React.FC<RouteErrorProps> = ({ error, reset, hint }) => (
  <FallbackShell>
    <StateScreen
      variant="error"
      title="This view couldn’t load"
      hint={hint ?? 'Your funds and open rounds are unaffected. Try again — if it keeps failing, check the activity page.'}
      error={error}
      onRetry={reset}
      secondaryAction={{ label: 'Back to home', onClick: () => { window.location.href = '/'; } }}
    />
  </FallbackShell>
);

/** Body for app/not-found.tsx. */
export const RouteNotFound: React.FC = () => (
  <FallbackShell>
    <StateScreen
      variant="empty"
      icon={<House size={30} weight="duotone" className="text-faint" />}
      title="Page not found"
      hint="That route doesn’t exist on Strike. The trade board and your wallet are still one click away."
      secondaryAction={{ label: 'Go home', onClick: () => { window.location.href = '/'; } }}
    />
  </FallbackShell>
);

export default RouteLoading;
