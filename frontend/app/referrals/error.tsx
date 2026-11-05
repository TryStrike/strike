'use client';

import { RouteError } from '@/components/states/RouteFallbacks';

export default function ReferralsError({
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
      hint="Your referral code and any pending attribution are safe on the server. Try again in a moment."
    />
  );
}
