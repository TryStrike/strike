import { ethers } from 'ethers';

/**
 * Validates a wallet address.
 *
 * The platform settles on Arc only, so the sole valid form is an EVM
 * address. Kept async because every caller awaits it.
 *
 * @param address Address to validate
 */
export const isValidAddress = async (address: string): Promise<boolean> => {
  if (!address) return false;
  return ethers.isAddress(address);
};

/**
 * Display form of an address: `0x1aE1…4De7A`.
 *
 * Money paths must show the destination, and a full 42-character hex string is
 * the kind of thing nobody actually reads. Verification always happens against
 * the full address (or a copy of it), never against this shortened form.
 */
export const shortenAddress = (address?: string | null, chars = 4): string => {
  const value = (address || '').trim();
  if (!value) return '';
  if (value.length <= chars * 2 + 2) return value;
  return `${value.slice(0, chars + 2)}…${value.slice(-chars)}`;
};
