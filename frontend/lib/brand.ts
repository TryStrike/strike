export const BRAND = {
  name: 'Strike',
  wordmark: 'Strike',
  tagline: '5-second binary rounds, settled in USDC on Arc',
  description:
    'Call higher or lower on crypto, forex, stocks and metals in 5-second to 1-minute rounds. Deposit and withdraw USDC on Arc.',
  /** The deployed site: the VM deploy sets NEXT_PUBLIC_APP_URL to its domain. */
  url: process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000',
} as const;
