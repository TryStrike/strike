import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  erc20Abi,
  fallback,
  formatUnits,
  http,
  type Chain,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import {
  arcRpcUrls,
  getArcConfig,
  getAssetConfig,
  type ArcAsset,
} from "./config";

let chain: Chain | null = null;
let client: PublicClient | null = null;

function arcChain(): Chain {
  if (!chain) {
    const config = getArcConfig();
    chain = defineChain({
      id: config.chainId,
      name: config.name,
      nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcEndpoint] } },
    });
  }
  return chain;
}

export function arcPublicClient(): PublicClient {
  client ??= createPublicClient({
    chain: arcChain(),
    pollingInterval: 2_000,
    transport: fallback(
      arcRpcUrls().map((url) => http(url, { retryCount: 0 })),
    ),
  });
  return client;
}

export function arcWalletClient(
  provider: EIP1193Provider,
  account: `0x${string}`,
) {
  return createWalletClient({
    account,
    chain: arcChain(),
    transport: custom(provider),
  });
}

export async function readAssetBalance(
  address: string,
  asset: ArcAsset,
): Promise<number> {
  const cfg = getAssetConfig(asset);
  const raw = await arcPublicClient().readContract({
    address: cfg.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });
  return Number(formatUnits(raw, cfg.decimals));
}
