import { ethers } from 'ethers';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

/**
 * The admin accept route re-verifies the signed withdrawal intent.
 *
 * The wallet signs the address in whatever casing it reports — wagmi hands back
 * the checksummed form — while the row stores it lowercased. Rebuilding the
 * message from the stored value alone recovers a different signer, which is why
 * accepting a perfectly valid request failed with "Invalid withdrawal
 * signature". This pins the behaviour the route relies on.
 */

function buildMessage(address: string, amount: number, currency: string, signedAt: number) {
  return (
    `STRIKE withdrawal authorization\n` +
    `address:${address}\n` +
    `amount:${amount.toFixed(8)}\n` +
    `currency:${currency}\n` +
    `signedAt:${signedAt}`
  );
}

/** Mirrors the verification the accept route performs. */
function verifyAgainstStored(
  storedAddress: string,
  amount: number,
  currency: string,
  signedAt: number,
  signature: string
): boolean {
  const spellings = new Set([storedAddress]);
  try {
    spellings.add(ethers.getAddress(storedAddress));
  } catch {
    /* not checksummable */
  }

  return Array.from(spellings).some((spelling) => {
    try {
      const recovered = ethers.verifyMessage(
        buildMessage(spelling, amount, currency, signedAt),
        signature
      );
      return canonicalHouseUserAddress(recovered) === canonicalHouseUserAddress(storedAddress);
    } catch {
      return false;
    }
  });
}

describe('admin withdrawal signature check', () => {
  // Fixed keys: ethers' createRandom cannot get randomness under jsdom, and a
  // deterministic signer makes the expectations easier to read anyway.
  const wallet = new ethers.Wallet(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  );
  const amount = 1.5;
  const currency = 'USDT';
  const signedAt = 1_788_000_000_000;

  it('accepts a signature made over the checksummed address when the row stores it lowercased', async () => {
    // What the browser signs.
    const signature = await wallet.signMessage(
      buildMessage(ethers.getAddress(wallet.address), amount, currency, signedAt)
    );
    // What the database holds.
    const stored = canonicalHouseUserAddress(wallet.address);
    expect(stored).toBe(wallet.address.toLowerCase());

    expect(verifyAgainstStored(stored, amount, currency, signedAt, signature)).toBe(true);
  });

  it('accepts a signature made over the lowercased address too', async () => {
    const stored = canonicalHouseUserAddress(wallet.address);
    const signature = await wallet.signMessage(buildMessage(stored, amount, currency, signedAt));

    expect(verifyAgainstStored(stored, amount, currency, signedAt, signature)).toBe(true);
  });

  it('rejects a signature from a different wallet', async () => {
    const stranger = new ethers.Wallet(
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
    );
    const signature = await stranger.signMessage(
      buildMessage(ethers.getAddress(wallet.address), amount, currency, signedAt)
    );
    const stored = canonicalHouseUserAddress(wallet.address);

    expect(verifyAgainstStored(stored, amount, currency, signedAt, signature)).toBe(false);
  });

  it('rejects a signature made for a different amount', async () => {
    const signature = await wallet.signMessage(
      buildMessage(ethers.getAddress(wallet.address), amount, currency, signedAt)
    );
    const stored = canonicalHouseUserAddress(wallet.address);

    expect(verifyAgainstStored(stored, amount + 1, currency, signedAt, signature)).toBe(false);
  });

  it('rejects a signature made for a different currency', async () => {
    const signature = await wallet.signMessage(
      buildMessage(ethers.getAddress(wallet.address), amount, 'BOT', signedAt)
    );
    const stored = canonicalHouseUserAddress(wallet.address);

    expect(verifyAgainstStored(stored, amount, 'USDT', signedAt, signature)).toBe(false);
  });
});
