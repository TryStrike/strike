
export function canonicalHouseUserAddress(address: string): string {
  const t = address.trim();
  if (t.startsWith('0x')) return t.toLowerCase();
  return t;
}
