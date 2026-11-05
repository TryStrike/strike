'use client';

import React from 'react';
import { RouteError } from '@/components/states/RouteFallbacks';

export default function ProfileError({
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
      hint="Your account and balance are safe. Try reloading your profile."
    />
  );
}
