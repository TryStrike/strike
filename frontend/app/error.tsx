'use client';

import React from 'react';
import { RouteError } from '@/components/states/RouteFallbacks';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} />;
}
