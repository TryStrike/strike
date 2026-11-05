'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AI_ROUTE, isAiPath } from './theme';

let finishTransition: (() => void) | null = null;

function applyTheme(pathname: string | null) {
  if (isAiPath(pathname)) document.documentElement.dataset.theme = 'ai';
  else delete document.documentElement.dataset.theme;
}

/** Keeps the theme in step with the route (back button, links) and ends a pending burst. */
export function useThemeSync() {
  const pathname = usePathname();
  useEffect(() => {
    applyTheme(pathname);
    finishTransition?.();
    finishTransition = null;
  }, [pathname]);
}

/** Toggles AI mode with the theme bursting out of the clicked point. */
export function useAiModeToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const inAi = isAiPath(pathname);

  const toggle = (e: { clientX: number; clientY: number }) => {
    const href = inAi ? '/trade' : AI_ROUTE;
    const root = document.documentElement;
    root.style.setProperty('--burst-x', `${e.clientX}px`);
    root.style.setProperty('--burst-y', `${e.clientY}px`);
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      router.push(href);
      return;
    }
    document.startViewTransition(
      () =>
        new Promise<void>((resolve) => {
          finishTransition = resolve;
          router.push(href);
        })
    );
  };

  return { inAi, toggle };
}
