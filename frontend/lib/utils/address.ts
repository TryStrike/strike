import { ethers } from 'ethers';

export const isValidAddress = async (address: string): Promise<boolean> => {
  if (!address) return false;
  return ethers.isAddress(address);
};

export const shortenAddress = (address?: string | null, chars = 4): string => {
  const value = (address || '').trim();
  if (!value) return '';
  if (value.length <= chars * 2 + 2) return value;
  return `${value.slice(0, chars + 2)}…${value.slice(-chars)}`;
};
