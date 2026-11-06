import { BridgeKit } from '@circle-fin/bridge-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import type { EIP1193Provider } from 'viem';

export interface BridgeOutcome {
  burnTx: string | null;
  mintTx: string | null;
}

/** Burns USDC on Base Sepolia and has Circle's Forwarder mint it to `recipient` on Arc, so no Arc gas is needed. */
export async function bridgeUsdcToArc(
  provider: EIP1193Provider,
  recipient: string,
  amount: string,
  onStep: (name: string) => void,
): Promise<BridgeOutcome> {
  const kit = new BridgeKit();
  kit.on('*', (event: { method?: string }) => {
    if (event?.method) onStep(event.method);
  });
  const adapter = await createViemAdapterFromProvider({ provider });
  const result = await kit.bridge({
    from: { adapter, chain: 'Base_Sepolia' },
    to: { recipientAddress: recipient, chain: 'Arc_Testnet', useForwarder: true },
    amount,
  });
  if (result.state !== 'success') {
    const failed = result.steps.find((s) => s.state === 'error');
    throw new Error(`Bridge ${result.state}${failed ? ` at the ${failed.name} step` : ''}`);
  }
  const tx = (name: string) => result.steps.find((s) => s.name.toLowerCase() === name)?.txHash ?? null;
  return { burnTx: tx('burn'), mintTx: tx('mint') };
}
