'use client';

/**
 * Bets the player owns on Arkiv. The wallet signs once to delegate a browser key;
 * that key then writes one `strike.bets` entity per bet, with no wallet popup.
 * The entity is created by the player's key, not by Strike, and carries the
 * wallet's delegation signature, so anyone can check wallet -> key -> bet.
 */
import { useSyncExternalStore } from 'react';
import {
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ARKIV_RPC } from '@/lib/arkiv';

export const BET_SCHEMA = 'strike.bets';
const ARKIV_CONTRACT = '0x4400000000000000000000000000000000000044';
const EXECUTE: Hex = '0x49650044';
const ENTITY_CREATED = keccak256(stringToHex('EntityCreated(bytes32,address,uint64,uint8)'));
const OP_CREATE = BigInt(1);
const FLAG_READONLY = BigInt(1);
/** About one day of 2 s blocks: the bet is settled long before it expires. */
const LIFETIME_BLOCKS = BigInt(43_200);
const KEY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const STR = 8;
const DEC = 5;
const U64 = 3;
const ADDR = 9;
const INDEXED = 0x80;

const arkivChain = defineChain({
  id: 7_794_095,
  name: 'Arkiv Rabdi',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ARKIV_RPC] } },
});

interface Delegation {
  pk: Hex;
  key: string;
  wallet: string;
  expires: number;
  signature: Hex;
}

/** Must match `arkiv::delegation_message` in the Rust backend byte for byte. */
export const delegationMessage = (wallet: string, key: string, expires: number) =>
  `Strike: let this browser key record my bets on Arkiv\nWallet: ${wallet.toLowerCase()}\nKey: ${key.toLowerCase()}\nExpires: ${expires}`;

const storageKey = (wallet: string) => `strike.arkivKey.${wallet.toLowerCase()}`;

function load(wallet: string): Delegation | null {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    const d = raw ? (JSON.parse(raw) as Delegation) : null;
    return d && d.expires > Date.now() + 60 * 60 * 1000 ? d : null;
  } catch {
    return null;
  }
}

// --- tiny external store: delegation per wallet and entity key per bet ---
const listeners = new Set<() => void>();
const entities = new Map<string, string>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useArkivDelegation(wallet: string | null | undefined): Delegation | null {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return wallet && typeof window !== 'undefined' ? load(wallet) : null;
}

export function useBetEntity(betId: string): string | undefined {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return entities.get(betId);
}

/** One wallet signature, then the server sends the new key a little Arkiv gas. */
export async function enableArkivBets(wallet: string, sign: (message: string) => Promise<Hex>): Promise<Delegation> {
  const pk = generatePrivateKey();
  const key = privateKeyToAccount(pk).address;
  const expires = Date.now() + KEY_LIFETIME_MS;
  const signature = await sign(delegationMessage(wallet, key, expires));
  const res = await fetch('/api/arkiv/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, key, expiresAt: expires, signature }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Arkiv key setup failed (${res.status})`);
  const { fundTx } = (await res.json()) as { fundTx: Hex };
  await createPublicClient({ chain: arkivChain, transport: http() }).waitForTransactionReceipt({ hash: fundTx, timeout: 30_000 });
  const d: Delegation = { pk, key: key.toLowerCase(), wallet: wallet.toLowerCase(), expires, signature };
  localStorage.setItem(storageKey(wallet), JSON.stringify(d));
  emit();
  return d;
}

export interface BetForArkiv {
  id: string;
  asset: string;
  mode: string;
  direction: 'UP' | 'DOWN';
  amount: number;
  multiplier: number;
  strikePrice?: number;
  endTime?: number;
  priceTop?: number;
  priceBottom?: number;
}

const name32 = (n: string): Hex => toHex(n, { size: 32 }) as Hex;
const dec = (v: number): Hex => toHex(parseUnits(v.toFixed(8), 18), { size: 32 });
const u64 = (v: number): Hex => toHex(BigInt(Math.round(v)), { size: 32 });

function attributes(wallet: string, bet: BetForArkiv, d: Delegation): [Hex, bigint, Hex][] {
  const list: [string, number, Hex][] = [
    ['arkiv.schema', STR | INDEXED, stringToHex(BET_SCHEMA)],
    ['betId', STR | INDEXED, stringToHex(bet.id)],
    ['wallet', ADDR | INDEXED, concat([toHex(0, { size: 12 }), wallet.toLowerCase() as Hex])],
    ['asset', STR | INDEXED, stringToHex(bet.asset)],
    ['mode', STR | INDEXED, stringToHex(bet.mode)],
    ['direction', STR | INDEXED, stringToHex(bet.direction)],
    ['stake', DEC, dec(bet.amount)],
    ['multiplier', DEC, dec(bet.multiplier)],
    ['placedAt', U64 | INDEXED, u64(Date.now())],
    // Arkiv strings stop at 128 bytes; the 65-byte signature goes in as r and s||v.
    ['delegationR', STR, stringToHex(d.signature.slice(0, 66))],
    ['delegationSV', STR, stringToHex(`0x${d.signature.slice(66)}`)],
    ['delegationExpires', U64, u64(d.expires)],
  ];
  if (bet.strikePrice) list.push(['strikePrice', DEC, dec(bet.strikePrice)]);
  if (bet.endTime) list.push(['endTime', U64 | INDEXED, u64(bet.endTime)]);
  if (bet.priceTop !== undefined) list.push(['priceTop', DEC, dec(bet.priceTop)]);
  if (bet.priceBottom !== undefined) list.push(['priceBottom', DEC, dec(bet.priceBottom)]);
  return list
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, t, v]) => [name32(n), BigInt(t), v]);
}

/** `execute([create])` calldata, the same layout the backend's sealer sends. */
function createCalldata(wallet: string, bet: BetForArkiv, d: Delegation): Hex {
  const salt = BigInt(`0x${crypto.randomUUID().replaceAll('-', '')}`);
  const data = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'tuple[]', components: [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }] },
        ],
      },
    ],
    [[salt, BigInt(0), LIFETIME_BLOCKS, FLAG_READONLY, attributes(wallet, bet, d)]],
  );
  const ops = encodeAbiParameters(
    [{ type: 'tuple[]', components: [{ type: 'uint256' }, { type: 'bytes' }] }],
    [[[OP_CREATE, data]]],
  );
  return concat([EXECUTE, ops]);
}

// One write at a time so the key's nonces never collide.
let queue: Promise<unknown> = Promise.resolve();

/** Writes the bet from the player's own key. Resolves to the entity key, or null when not enabled. */
export function recordBetOnArkiv(wallet: string, bet: BetForArkiv): Promise<string | null> {
  const d = load(wallet);
  if (!d) return Promise.resolve(null);
  const run = async () => {
    const account = privateKeyToAccount(d.pk);
    const walletClient = createWalletClient({ account, chain: arkivChain, transport: http() });
    const hash = await walletClient.sendTransaction({ to: ARKIV_CONTRACT, data: createCalldata(wallet, bet, d) });
    const receipt = await createPublicClient({ chain: arkivChain, transport: http() }).waitForTransactionReceipt({
      hash,
      timeout: 30_000,
    });
    const created = receipt.logs.find(
      (l) => l.address.toLowerCase() === ARKIV_CONTRACT && l.topics[0] === ENTITY_CREATED,
    );
    const key = created?.topics[1] ?? null;
    if (key) {
      entities.set(bet.id, key);
      emit();
    }
    return key;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
