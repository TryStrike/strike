'use client';

import { createContext, useContext } from 'react';

/** True only when a Privy app id is set and PrivyProvider is mounted. */
export const PrivyEnabledContext = createContext(false);

export function usePrivyEnabled() {
  return useContext(PrivyEnabledContext);
}
