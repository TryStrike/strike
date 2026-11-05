/**
 * Every user-facing brand string lives here, so a rebrand is a one-file change.
 *
 * Not covered on purpose (changing them breaks existing data or signatures):
 * the "STRIKE withdrawal authorization" signing message, cookie / localStorage
 * keys, the x-strike-balance-key header, and the StrikeTreasury contract name.
 */
export const BRAND = {
  name: 'Strike',
  /** Lower-case wordmark shown in navs. */
  wordmark: 'strike',
  tagline: '5-second binary rounds, settled in USDC on Arc',
  description:
    'Call higher or lower on crypto, forex, stocks and metals in 5-second to 1-minute rounds. Deposit and withdraw USDC on Arc.',
  url: 'https://ethglobalmumbai.vercel.app',
  /** Optional social links; empty strings are hidden. */
  social: { x: '', telegram: '' },
} as const;
