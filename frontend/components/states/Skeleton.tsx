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

/** Fills a positioned parent, and stays invisible for a moment so fast loads never flash it. */
export const ChartSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div className="by-chart-skeleton pointer-events-none absolute inset-0 overflow-hidden bg-white" role="status">
    {[20, 40, 60, 80].map((top) => (
      <span key={top} className="absolute inset-x-0 h-px bg-line" style={{ top: `${top}%` }} />
    ))}
    <svg
      className="absolute inset-x-0 top-1/4 h-1/2 w-full animate-pulse text-line motion-reduce:animate-none"
      viewBox="0 0 400 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M0 80 C40 60 60 90 100 70 S160 40 200 55"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
    <p className="absolute inset-x-0 top-1/2 mt-16 text-center text-xs text-subtle">{label}</p>
  </div>
);

export const SkeletonStatTile: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`rounded-3xl bg-white p-5 ring-1 ring-line ${className}`} role="presentation">
    <Skeleton className="mb-3 h-3 w-16" rounded="sm" />
    <Skeleton className="mb-2 h-7 w-28" />
    <Skeleton className="h-4 w-12" rounded="full" />
  </div>
);

export default Skeleton;
