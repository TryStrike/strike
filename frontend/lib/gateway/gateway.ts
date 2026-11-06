/**
 * Circle Gateway, testnet: one USDC balance across chains, spent on Arc straight into the
 * StrikeTreasury. The backend credits the mint by Circle's `AttestationUsed` event, which
 * names the player as the source depositor.
 */
import {
  erc20Abi,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";

export const GATEWAY_API = "https://gateway-api-testnet.circle.com/v1";
export const GATEWAY_WALLET: Address =
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
export const GATEWAY_MINTER: Address =
  "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";

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

const walletAbi = parseAbi(["function deposit(address token, uint256 value)"]);
/** Only what the flows need, so a client for any testnet chain fits. */
type ReceiptClient = {
  waitForTransactionReceipt: (args: {
    hash: Hex;
  }) => Promise<{ status: "success" | "reverted" }>;
};

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

/** Moves USDC from the wallet into Gateway on `chain`. Counts once that chain finalizes it. */
export async function depositToGateway(
  wallet: WalletClient,
  client: ReceiptClient,
  chain: GatewayChain,
  amount: bigint,
): Promise<Hex> {
  const account = wallet.account!;
  const approve = await wallet.writeContract({
    account,
    chain: wallet.chain,
    address: chain.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [GATEWAY_WALLET, amount],
  });
  await client.waitForTransactionReceipt({ hash: approve });
  const hash = await wallet.writeContract({
    account,
    chain: wallet.chain,
    address: GATEWAY_WALLET,
    abi: walletAbi,
    functionName: "deposit",
    args: [chain.usdc, amount],
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
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
 * Signs a burn intent on `source`, gets Circle's attestation and mints on Arc into `recipient`.
 * `arcWallet` must be on Arc; it pays the mint's gas in USDC. Returns the mint tx hash.
 */
export async function spendToArc(params: {
  signer: WalletClient;
  arcWallet: WalletClient;
  arcClient: ReceiptClient;
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
  const hash = await arcWallet.writeContract({
    account: arcWallet.account!,
    chain: arcWallet.chain,
    address: GATEWAY_MINTER,
    abi: minterAbi,
    functionName: "gatewayMint",
    args: [body.attestation, body.signature],
  });
  const receipt = await arcClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error("Gateway mint reverted on Arc");
  return hash;
}
