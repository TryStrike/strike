'use client';

import React from 'react';
import { RouteError } from '@/components/states/RouteFallbacks';

export default function LeaderboardError({
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
      hint="Ranks are still being counted — your bets are unaffected. Try again in a moment."
    />
  );
}
