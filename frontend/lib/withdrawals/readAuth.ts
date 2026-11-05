
import { ethers } from 'ethers';
import { MAX_CLOCK_SKEW_MS } from '@/lib/balance/withdrawalIntent';
import { canonicalHouseUserAddress } from '@/lib/wallet/canonicalAddress';

export const WITHDRAWAL_READ_AUTH_HEADER = 'x-strike-withdrawal-read-auth';

export const READ_AUTH_MAX_AGE_MS = 10 * 60 * 1000;
export const READ_AUTH_REFRESH_AFTER_MS = READ_AUTH_MAX_AGE_MS - 60 * 1000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const NONCE_RE = /^[0-9a-f]{8,64}$/;

export interface ReadAuthProof {
  address: string;
  issuedAt: number;
  nonce: string;
  signature: string;
}

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

export type ReadAuthFailureCode = 'malformed' | 'stale' | 'invalid_signature';

export type ReadAuthVerification =
  | { ok: true; proof: ReadAuthProof; recovered: string }
  | { ok: false; code: ReadAuthFailureCode; message: string };

export function parseReadAuthHeader(raw: string | null): ReadAuthProof | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.address !== 'string' || !ADDRESS_RE.test(v.address)) return null;
  if (typeof v.issuedAt !== 'number' || !Number.isFinite(v.issuedAt)) return null;
  if (typeof v.nonce !== 'string' || !NONCE_RE.test(v.nonce)) return null;
  if (typeof v.signature !== 'string' || !SIGNATURE_RE.test(v.signature)) return null;
  return {
    address: v.address,
    issuedAt: v.issuedAt,
    nonce: v.nonce,
    signature: v.signature,
  };
}

export function verifyWithdrawalReadAuth(
  rawHeader: string | null,
  now: number = Date.now(),
): ReadAuthVerification {
  const proof = parseReadAuthHeader(rawHeader);
  if (!proof) {
    return { ok: false, code: 'malformed', message: 'Missing or malformed withdrawal read authorization' };
  }

  const ageMs = now - proof.issuedAt;
  if (!Number.isFinite(ageMs) || ageMs > READ_AUTH_MAX_AGE_MS || ageMs < -MAX_CLOCK_SKEW_MS) {
    return { ok: false, code: 'stale', message: 'Withdrawal read authorization has expired. Please sign again.' };
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(
      buildWithdrawalReadAuthMessage(proof.address, proof.issuedAt, proof.nonce),
      proof.signature,
    );
  } catch {
    return { ok: false, code: 'invalid_signature', message: 'Invalid withdrawal read authorization' };
  }

  if (canonicalHouseUserAddress(recovered) !== canonicalHouseUserAddress(proof.address)) {
    return { ok: false, code: 'invalid_signature', message: 'Invalid withdrawal read authorization' };
  }

  return { ok: true, proof, recovered };
}
