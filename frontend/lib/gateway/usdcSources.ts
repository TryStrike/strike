import { useCallback, useEffect, useState } from "react";
import { erc20Abi, parseUnits, type Address } from "viem";
import { useConfig } from "wagmi";
import { readContract } from "wagmi/actions";
import type { OutChain } from "@/lib/bridge/cctp";
import {
  GATEWAY_CHAINS,
  gatewayBalances,
  gatewayFees,
  type GatewayChain,
} from "./gateway";

/** Covers the approve and buy on Arc, where gas is paid in USDC. */
const ARC_GAS = parseUnits("0.05", 6);
/** A mint from Gateway is paid by the wallet, so it needs this much on Arc first. */
const MINT_GAS = parseUnits("0.02", 6);
/** Covers CCTP's fee and Circle's Forwarder, which are taken from the bridged amount. */
const BRIDGE_FLAT_BUFFER = parseUnits("0.25", 6);
const BRIDGE_BPS_BUFFER = BigInt(100);

const CCTP_CHAIN: Record<string, OutChain> = {
  base: "Base_Sepolia",
  arbitrum: "Arbitrum_Sepolia",
  sepolia: "Ethereum_Sepolia",
};

export interface UsdcSources {
  /** Wallet USDC per chain key. Null means the read failed, which is not zero. */
  wallet: Record<string, bigint | null>;
  gateway: Record<string, bigint>;
  fees: Record<string, bigint>;
}

export type Funding =
  | { kind: "arc" }
  | { kind: "gateway"; chain: GatewayChain; amount: bigint; maxFee: bigint }
  | { kind: "bridge"; chain: GatewayChain; cctp: OutChain; amount: bigint };

/** The one cheapest way to have `need` on Arc: already there, Gateway, then a bridge. */
export function planFunding(
  need: bigint,
  { wallet, gateway, fees }: UsdcSources,
): Funding | null {
  const arc = wallet.arc;
  if (arc == null) return { kind: "arc" };
  const short = need + ARC_GAS - arc;
  if (short <= BigInt(0)) return { kind: "arc" };

  if (arc >= MINT_GAS) {
    const chain = GATEWAY_CHAINS.find(
      (c) =>
        (gateway[c.key] ?? BigInt(0)) >= short + (fees[c.key] ?? BigInt(0)),
    );
    if (chain && fees[chain.key] != null)
      return {
        kind: "gateway",
        chain,
        amount: short,
        maxFee: fees[chain.key],
      };
  }

  const amount =
    short + BRIDGE_FLAT_BUFFER + (short * BRIDGE_BPS_BUFFER) / BigInt(10_000);
  const chain = GATEWAY_CHAINS.find(
    (c) => CCTP_CHAIN[c.key] && (wallet[c.key] ?? BigInt(0)) >= amount,
  );
  return chain
    ? { kind: "bridge", chain, cctp: CCTP_CHAIN[chain.key], amount }
    : null;
}

/** Everywhere this wallet holds USDC. Reads only while `active`, so a closed form costs nothing. */
export function useUsdcSources(address: Address | undefined, active: boolean) {
  const config = useConfig();
  const [sources, setSources] = useState<UsdcSources | null>(null);
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((n) => n + 1), []);

  useEffect(() => {
    if (!address || !active) return;
    let cancelled = false;
    const failed = (what: string) => (err: Error) => {
      console.error(`[usdc] ${what} read failed`, err);
      return null;
    };
    Promise.all([
      Promise.all(
        GATEWAY_CHAINS.map((c) =>
          readContract(config, {
            chainId: c.chainId as (typeof config.chains)[number]["id"],
            address: c.usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }).catch(failed(`${c.name} wallet`)),
        ),
      ),
      gatewayBalances(address).catch(failed("Gateway balance")),
      gatewayFees(address, address).catch(failed("Gateway fee")),
    ]).then(([wallet, gateway, fees]) => {
      if (cancelled) return;
      setSources({
        wallet: Object.fromEntries(
          GATEWAY_CHAINS.map((c, i) => [c.key, wallet[i]]),
        ),
        gateway: Object.fromEntries(
          (gateway ?? []).map((b) => [b.chain.key, b.balance]),
        ),
        fees: fees ?? {},
      });
    });
    return () => {
      cancelled = true;
    };
  }, [address, active, config, reads]);

  return { sources, refresh };
}
