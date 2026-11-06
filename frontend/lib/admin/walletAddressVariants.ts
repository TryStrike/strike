

export function isDemoWalletAddress(addr: string | null | undefined): boolean {
  return !!addr && addr.toLowerCase().startsWith('0xdemo');
}

export function isDemoBetHistoryRow(row: {
  wallet_address?: string | null;
  id?: string | null;
}): boolean {
  if (isDemoWalletAddress(row.wallet_address)) return true;
  const id = row.id != null ? String(row.id) : '';
  return id.toLowerCase().startsWith('demo-');
}
