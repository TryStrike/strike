import { BridgeKit } from '@circle-fin/bridge-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import type { EIP1193Provider } from 'viem';

export type BridgeDirection = 'in' | 'out';

export interface BridgeOutcome {
  burnTx: string | null;
  mintTx: string | null;
}

export async function bridgeUsdc(
  provider: EIP1193Provider,
  recipient: string,
  amount: string,
  direction: BridgeDirection,
  onStep: (name: string) => void,
): Promise<BridgeOutcome> {
  const [from, to] = direction === 'in' ? (['Base_Sepolia', 'Arc_Testnet'] as const) : (['Arc_Testnet', 'Base_Sepolia'] as const);
  const kit = new BridgeKit();
  kit.on('*', (event: { method?: string }) => {
    if (event?.method) onStep(event.method);
  });
  const adapter = await createViemAdapterFromProvider({ provider });
  const result = await kit.bridge({
    from: { adapter, chain: from },
    to: { recipientAddress: recipient, chain: to, useForwarder: true },
    amount,
  });
  if (result.state !== 'success') {
    const failed = result.steps.find((s) => s.state === 'error');
    throw new Error(`Bridge ${result.state}${failed ? ` at the ${failed.name} step` : ''}`);
  }
  const tx = (name: string) => result.steps.find((s) => s.name.toLowerCase() === name)?.txHash ?? null;
  return { burnTx: tx('burn'), mintTx: tx('mint') };
}
