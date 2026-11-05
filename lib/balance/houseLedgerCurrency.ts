/**
 * Single source for which `user_balances.currency` row the house ledger uses
 * (fetch, bet, deposit, withdraw).
 *
 * Arc settles in native USDC, so the row is chosen by the selected asset
 * alone. Anything unrecognised falls back to USDC rather than to a currency the
 * treasury cannot pay out.
 */

const PLAYABLE = ['USDC'] as const;
type Playable = (typeof PLAYABLE)[number];

export function resolveHouseLedgerCurrency(params: {
  network?: string;
  selectedCurrency: string | null | undefined;
  userAddress?: string | null;
}): Playable {
  const selected = (params.selectedCurrency || '').toUpperCase();
  return (PLAYABLE as readonly string[]).includes(selected) ? (selected as Playable) : 'USDC';
}
