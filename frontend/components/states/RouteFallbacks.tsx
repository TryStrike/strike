'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { House } from '@phosphor-icons/react';
import { StateScreen } from './StateScreen';
import { SkeletonCard, SkeletonStatTile, SkeletonTable } from './Skeleton';

export const FallbackShell: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <div className={`flex min-h-[70vh] w-full items-center justify-center bg-white font-tight text-ink ${className}`}>
    {children}
  </div>
);

export type RouteShape = 'page' | 'dashboard' | 'list' | 'stats';

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
  hint?: string;
}

export const RouteError: React.FC<RouteErrorProps> = ({ error, reset, hint }) => {
  const router = useRouter();
  return (
    <FallbackShell>
      <StateScreen
        variant="error"
        title="This view couldn’t load"
        hint={
          hint ?? 'Your funds and open rounds are unaffected. Try again — if it keeps failing, check the activity page.'
        }
        error={error}
        onRetry={reset}
        secondaryAction={{ label: 'Back to home', onClick: () => router.push('/') }}
      />
    </FallbackShell>
  );
};

export const RouteNotFound: React.FC = () => {
  const router = useRouter();
  return (
    <FallbackShell>
      <StateScreen
        variant="empty"
        icon={<House size={30} weight="duotone" className="text-faint" />}
        title="Page not found"
        hint="That route doesn’t exist on Strike. The trade board and your wallet are still one click away."
        secondaryAction={{ label: 'Go home', onClick: () => router.push('/') }}
      />
    </FallbackShell>
  );
};

export default RouteLoading;
