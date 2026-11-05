'use client';

import { RouteError } from '@/components/states/RouteFallbacks';

export default function TradeError({
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
      hint="Your open rounds and balance are safe — the board just failed to render. Try again."
    />
  );
}
