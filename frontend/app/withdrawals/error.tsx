'use client';

import React from 'react';
import { RouteError } from '@/components/states/RouteFallbacks';

export default function WithdrawalsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      error={error}
      reset={reset}
      hint="No withdrawal was lost or duplicated — this view just failed to load. Try again, and never re-send from the wallet side."
    />
  );
}
