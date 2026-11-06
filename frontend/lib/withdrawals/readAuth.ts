

export const WITHDRAWAL_READ_AUTH_HEADER = 'x-strike-withdrawal-read-auth';

export const READ_AUTH_MAX_AGE_MS = 10 * 60 * 1000;
export const READ_AUTH_REFRESH_AFTER_MS = READ_AUTH_MAX_AGE_MS - 60 * 1000;

export function buildWithdrawalReadAuthMessage(
  address: string,
  issuedAt: number,
  nonce: string,
): string {
  return (
    `STRIKE withdrawal read authorization\n` +
    `address:${address}\n` +
    `issuedAt:${issuedAt}\n` +
    `nonce:${nonce}`
  );
}

