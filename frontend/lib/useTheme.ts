'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AI_ROUTE, isAiPath } from './theme';

let finishTransition: (() => void) | null = null;

function applyTheme(pathname: string | null) {
  if (isAiPath(pathname)) document.documentElement.dataset.theme = 'ai';
  else delete document.documentElement.dataset.theme;
}

export function useThemeSync() {
  const pathname = usePathname();
  useEffect(() => {
    applyTheme(pathname);
    finishTransition?.();
    finishTransition = null;
  }, [pathname]);
}

export function useAiModeToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const inAi = isAiPath(pathname);
  const target = inAi ? '/trade' : AI_ROUTE;

  useEffect(() => {
    router.prefetch(target);
  }, [router, target]);

  const toggle = (e: { clientX: number; clientY: number }) => {
    const root = document.documentElement;
    root.style.setProperty('--burst-x', `${e.clientX}px`);
    root.style.setProperty('--burst-y', `${e.clientY}px`);
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      router.push(target);
      return;
    }
    document.startViewTransition(
      () =>
        new Promise<void>((resolve) => {
          finishTransition = resolve;
          router.push(target);
        })
    );
  };

  return { inAi, toggle };
}
