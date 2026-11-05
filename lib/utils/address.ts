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
