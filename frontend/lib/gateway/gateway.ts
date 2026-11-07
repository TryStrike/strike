/**
 * Circle Gateway, testnet: one USDC balance across chains, spent on Arc straight into the
 * StrikeTreasury. The backend credits the mint by Circle's `AttestationUsed` event, which
 * names the player as the source depositor.
 */
import {
  erc20Abi,
  formatUnits,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";

export const GATEWAY_API = "https://gateway-api-testnet.circle.com/v1";
const GATEWAY_WALLET: Address = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_MINTER: Address = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";

export interface GatewayChain {
  key: string;
  name: string;
  domain: number;
  chainId: number;
  usdc: Address;
}

export const GATEWAY_CHAINS: GatewayChain[] = [
  {
    key: "arc",
    name: "Arc",
    domain: 26,
    chainId: 5_042_002,
    usdc: "0x3600000000000000000000000000000000000000",
  },
  {
    key: "base",
    name: "Base Sepolia",
    domain: 6,
    chainId: baseSepolia.id,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  {
    key: "sepolia",
    name: "Ethereum Sepolia",
    domain: 0,
    chainId: sepolia.id,
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  {
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    domain: 3,
    chainId: arbitrumSepolia.id,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  },
];
const ARC = GATEWAY_CHAINS[0];

const minterAbi = parseAbi([
  "function gatewayMint(bytes attestationPayload, bytes signature)",
]);

export interface GatewayBalance {
  chain: GatewayChain;
  /** USDC units (6 decimals). */
  balance: bigint;
}

const toUnits = (decimal: string) => {
  const [whole, frac = ""] = decimal.split(".");
  return (
    BigInt(whole || "0") * BigInt(1_000_000) +
    BigInt((frac + "000000").slice(0, 6) || "0")
  );
};

/** The player's Gateway balance on each chain, finalized deposits only. */
export async function gatewayBalances(
  depositor: Address,
): Promise<GatewayBalance[]> {
  const res = await fetch(`${GATEWAY_API}/balances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      sources: GATEWAY_CHAINS.map((c) => ({ depositor, domain: c.domain })),
    }),
  });
  if (!res.ok) throw new Error(`Gateway balances failed (${res.status})`);
  const { balances } = (await res.json()) as {
    balances: Array<{ domain: number; balance: string }>;
  };
  return GATEWAY_CHAINS.map((chain) => ({
    chain,
    balance: toUnits(
      balances.find((b) => b.domain === chain.domain)?.balance ?? "0",
    ),
  }));
}

const word = (address: Address): Hex =>
  pad(address.toLowerCase() as Hex, { size: 32 });

/** The EIP-712 burn intent that spends `amount` from `source` into `recipient` on Arc. */
export function burnIntent(
  source: GatewayChain,
  depositor: Address,
  recipient: Address,
  amount: bigint,
  maxFee: bigint,
) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return {
    types: {
      TransferSpec: [
        { name: "version", type: "uint32" },
        { name: "sourceDomain", type: "uint32" },
        { name: "destinationDomain", type: "uint32" },
        { name: "sourceContract", type: "bytes32" },
        { name: "destinationContract", type: "bytes32" },
        { name: "sourceToken", type: "bytes32" },
        { name: "destinationToken", type: "bytes32" },
        { name: "sourceDepositor", type: "bytes32" },
        { name: "destinationRecipient", type: "bytes32" },
        { name: "sourceSigner", type: "bytes32" },
        { name: "destinationCaller", type: "bytes32" },
        { name: "value", type: "uint256" },
        { name: "salt", type: "bytes32" },
        { name: "hookData", type: "bytes" },
      ],
      BurnIntent: [
        { name: "maxBlockHeight", type: "uint256" },
        { name: "maxFee", type: "uint256" },
        { name: "spec", type: "TransferSpec" },
      ],
    },
    domain: { name: "GatewayWallet", version: "1" },
    primaryType: "BurnIntent" as const,
    message: {
      maxBlockHeight: (BigInt(1) << BigInt(256)) - BigInt(1),
      maxFee,
      spec: {
        version: 1,
        sourceDomain: source.domain,
        destinationDomain: ARC.domain,
        sourceContract: word(GATEWAY_WALLET),
        destinationContract: word(GATEWAY_MINTER),
        sourceToken: word(source.usdc),
        destinationToken: word(ARC.usdc),
        sourceDepositor: word(depositor),
        destinationRecipient: word(recipient),
        sourceSigner: word(depositor),
        destinationCaller: pad("0x", { size: 32 }),
        value: amount,
        salt,
        hookData: "0x" as Hex,
      },
    },
  };
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * The fee to allow per source chain, from Circle's live estimate plus a 20% buffer for gas
 * moves. It differs a lot by chain: 0.004 USDC from Arc, 1.10 from Ethereum Sepolia.
 */
export async function gatewayFees(
  depositor: Address,
  recipient: Address,
): Promise<Record<string, bigint>> {
  const intents = GATEWAY_CHAINS.map(
    (chain) =>
      burnIntent(chain, depositor, recipient, BigInt(1_000_000), BigInt(1))
        .message,
  );
  const res = await fetch(`${GATEWAY_API}/estimate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: json(intents),
  });
  if (!res.ok) throw new Error(`Gateway fee estimate failed (${res.status})`);
  const estimated = (await res.json()) as Array<{
    burnIntent: { maxFee: string; spec: { sourceDomain: number } };
  }>;
  const fees: Record<string, bigint> = {};
  for (const chain of GATEWAY_CHAINS) {
    const entry = estimated.find(
      (e) => e.burnIntent.spec.sourceDomain === chain.domain,
    );
    if (!entry) throw new Error(`No Gateway fee for ${chain.name}`);
    fees[chain.key] =
      (BigInt(entry.burnIntent.maxFee) * BigInt(12)) / BigInt(10);
  }
  return fees;
}

/** Thrown with a message that is safe to show as is: it says where the money is. */
export class GatewayMintError extends Error {}

/**
 * Circle's signed attestation, kept until the mint lands. Once /transfer answers, the Gateway
 * balance is spent, so losing this would strand the funds until Circle returns them.
 */
const PENDING_KEY = "strike.gateway.pendingMint";
export interface PendingMint {
  attestation: Hex;
  signature: Hex;
  recipient: Address;
  /** USDC units (6 decimals) the mint pays out. */
  amount: string;
  createdAt: number;
}
export function pendingMint(recipient: Address): PendingMint | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const p = raw ? (JSON.parse(raw) as PendingMint) : null;
    return p?.attestation &&
      p.signature &&
      p.recipient?.toLowerCase() === recipient.toLowerCase()
      ? p
      : null;
  } catch {
    return null;
  }
}
const savePending = (p: PendingMint) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {}
};
const clearPending = () => {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {}
};

const MINT_TIMEOUT_MS = 120_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Mints on Arc and waits. Arc's public RPC often refuses receipt reads (rate limit), so the mint
 * counts as landed when the recipient's USDC rises by the amount (less the gas the mint costs),
 * or the receipt shows up. Only a reverted receipt or a real timeout is reported as a failure.
 */
export async function mintPending(params: {
  arcWallet: WalletClient;
  arcClient: PublicClient;
  pending: PendingMint;
}): Promise<Hex> {
  const { arcWallet, arcClient, pending } = params;
  const amount = BigInt(pending.amount);
  const readBalance = () =>
    arcClient.readContract({
      address: ARC.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [pending.recipient],
    });
  const before = await readBalance().catch(() => null);
  const worth = `${formatUnits(amount, 6)} USDC`;

  let hash: Hex;
  try {
    hash = await arcWallet.writeContract({
      account: arcWallet.account!,
      chain: arcWallet.chain,
      address: GATEWAY_MINTER,
      abi: minterAbi,
      functionName: "gatewayMint",
      args: [pending.attestation, pending.signature],
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : "";
    throw new GatewayMintError(
      `The mint was not sent (${reason}). Your funds are safe: the Gateway transfer already went through, and ${worth} is waiting to be minted on Arc. Press Finish transfer to try again.`,
    );
  }

  // The mint also pays its own gas in USDC, so allow for that when watching the balance.
  const gasSlack =
    amount / BigInt(2) < BigInt(50_000) ? amount / BigInt(2) : BigInt(50_000);
  const target = before == null ? null : before + amount - gasSlack;
  const deadline = Date.now() + MINT_TIMEOUT_MS;
  for (
    let wait = 1_500;
    Date.now() < deadline;
    wait = Math.min(wait * 1.5, 6_000)
  ) {
    const receipt = await arcClient
      .getTransactionReceipt({ hash })
      .catch(() => null);
    if (receipt?.status === "reverted") {
      clearPending();
      throw new GatewayMintError(
        "The mint reverted onchain, so it did not pay out. If the Gateway transfer was not minted another way, the balance returns in about 10 minutes.",
      );
    }
    if (receipt?.status === "success") break;
    const now = target == null ? null : await readBalance().catch(() => null);
    if (now != null && target != null && now >= target) break;
    await sleep(wait);
  }
  if (Date.now() >= deadline) {
    throw new GatewayMintError(
      `The mint was sent but Arc has not confirmed it after 2 minutes. It may still land, so check your balance before trying again. Finish transfer reuses the same signed transfer and cannot spend it twice.`,
    );
  }
  clearPending();
  return hash;
}

/**
 * Signs a burn intent on `source`, gets Circle's attestation and mints on Arc into `recipient`.
 * `arcWallet` must be on Arc; it pays the mint's gas in USDC. Returns the mint tx hash.
 * If the mint is cancelled or unconfirmed, the attestation stays saved (see `pendingMint`).
 */
export async function spendToArc(params: {
  signer: WalletClient;
  arcWallet: WalletClient;
  arcClient: PublicClient;
  source: GatewayChain;
  recipient: Address;
  amount: bigint;
  maxFee: bigint;
  onStep?: (step: "sign" | "attest" | "mint") => void;
}): Promise<Hex> {
  const {
    signer,
    arcWallet,
    arcClient,
    source,
    recipient,
    amount,
    maxFee,
    onStep,
  } = params;
  const depositor = signer.account!.address;
  const intent = burnIntent(source, depositor, recipient, amount, maxFee);
  onStep?.("sign");
  const signature = await signer.signTypedData({
    account: signer.account!,
    ...intent,
  });
  onStep?.("attest");
  const res = await fetch(`${GATEWAY_API}/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: json([{ burnIntent: intent.message, signature }]),
  });
  const body = (await res.json().catch(() => null)) as {
    attestation?: Hex;
    signature?: Hex;
    message?: string;
  } | null;
  if (!res.ok || !body?.attestation || !body.signature) {
    throw new Error(
      `Gateway refused the transfer: ${body?.message ?? res.status}`,
    );
  }
  onStep?.("mint");
  const pending: PendingMint = {
    attestation: body.attestation,
    signature: body.signature,
    recipient,
    amount: amount.toString(),
    createdAt: Date.now(),
  };
  savePending(pending);
  return mintPending({ arcWallet, arcClient, pending });
}
