import React, { type CSSProperties } from 'react';


export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
}

const ROUNDED = { sm: 'rounded-md', md: 'rounded-xl', lg: 'rounded-3xl', full: 'rounded-full' } as const;

export const Skeleton: React.FC<SkeletonProps> = ({ className = '', style, rounded = 'md' }) => (
  <span
    aria-hidden="true"
    className={`by-skeleton block ${ROUNDED[rounded]} ${className}`}
    style={style}
  />
);

export const SkeletonCard: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`space-y-3 rounded-3xl bg-surface p-5 ring-1 ring-line ${className}`} role="presentation">
    <Skeleton className="h-3.5 w-24" rounded="sm" />
    <Skeleton className="h-8 w-40" />
    <Skeleton className="h-3.5 w-full" rounded="sm" />
    <Skeleton className="h-3.5 w-3/4" rounded="sm" />
  </div>
);

export const SkeletonTableRow: React.FC<{ columns?: number; className?: string }> = ({ columns = 3, className = '' }) => (
  <div className={`flex items-center gap-3 border-b border-line px-2 py-3 last:border-0 ${className}`} role="presentation">
    {Array.from({ length: columns }, (_, i) => (
      <div key={i} className={`flex min-w-0 flex-1 items-center gap-2.5 ${i === columns - 1 ? 'justify-end' : ''}`}>
        {i === 0 && <Skeleton className="h-6 w-6 shrink-0" rounded="full" />}
        <Skeleton className={i === columns - 1 ? 'h-3.5 w-16' : 'h-3.5 flex-1'} rounded="sm" />
      </div>
    ))}
  </div>
);

export const SkeletonTable: React.FC<{ rows?: number; columns?: number; className?: string }> = ({
  rows = 6,
  columns = 3,
  className = '',
}) => (
  <div className={className} role="presentation">
    {Array.from({ length: Math.max(0, rows) }, (_, i) => (
      <SkeletonTableRow key={i} columns={columns} />
    ))}
  </div>
);

export const SkeletonListItem: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`flex items-start gap-3 py-2 ${className}`} role="presentation">
    <Skeleton className="h-9 w-9 shrink-0" rounded="lg" />
    <div className="min-w-0 flex-1 space-y-2 pt-0.5">
      <Skeleton className="h-3.5 w-2/3" rounded="sm" />
      <Skeleton className="h-3 w-1/3" rounded="sm" />
    </div>
  </div>
);

export const SkeletonChartBlock: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div
    className={`relative min-h-[220px] w-full overflow-hidden rounded-3xl bg-surface ring-1 ring-line ${className}`}
    role="presentation"
  >
    <svg className="absolute inset-x-0 bottom-0 h-1/2 w-full text-line" viewBox="0 0 400 100" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 80 C40 60 60 90 100 70 S160 40 200 55 S280 30 320 45 S380 20 400 35 L400 100 L0 100 Z" fill="currentColor" opacity="0.7" />
    </svg>
    <Skeleton className="absolute left-4 top-4 h-4 w-24" rounded="sm" />
  </div>
);

export const SkeletonStatTile: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`rounded-3xl bg-white p-5 ring-1 ring-line ${className}`} role="presentation">
    <Skeleton className="mb-3 h-3 w-16" rounded="sm" />
    <Skeleton className="mb-2 h-7 w-28" />
    <Skeleton className="h-4 w-12" rounded="full" />
  </div>
);

export const SkeletonGrid: React.FC<{ tiles?: number; className?: string }> = ({ tiles = 3, className = '' }) => (
  <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-${Math.min(4, Math.max(1, tiles))} ${className}`}>
    {Array.from({ length: Math.max(0, tiles) }, (_, i) => (
      <SkeletonStatTile key={i} />
    ))}
  </div>
);

export default Skeleton;
