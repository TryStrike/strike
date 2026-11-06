
const PLAYABLE = ['USDC', 'EURC'] as const;
type Playable = (typeof PLAYABLE)[number];

export function resolveHouseLedgerCurrency(params: {
  network?: string;
  selectedCurrency: string | null | undefined;
  userAddress?: string | null;
}): Playable {
  const selected = (params.selectedCurrency || '').toUpperCase();
  return (PLAYABLE as readonly string[]).includes(selected) ? (selected as Playable) : 'USDC';
}
