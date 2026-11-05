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
