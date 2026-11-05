/**
 * Display-only address shortening for referral surfaces.
 *
 * NOTE (integration hook): the canonical home for this helper is
 * `lib/utils/address.ts`, which currently only exports `isValidAddress`.
 * I did not edit that shared file because it is being modified concurrently;
 * this local copy lets /referrals render referred-friend addresses safely and
 * can be swapped for the shared util once it gains the function.
 */
export function shortenAddress(
  address: string | null | undefined,
  prefix = 6,
  suffix = 4,
): string {
  if (!address) return '---';
  const a = String(address).trim();
  if (a.length <= prefix + suffix) return a;
  return `${a.slice(0, prefix)}...${a.slice(-suffix)}`;
}

/** Format a joined timestamp as a short, human-readable date. */
export function formatJoinedDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
