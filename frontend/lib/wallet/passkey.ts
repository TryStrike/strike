import { injected } from 'wagmi/connectors';
import type { Chain } from 'viem';

export const PASSKEY_CONNECTOR_ID = 'circle-passkey';
const STORE = 'strike.passkey';

type Provider = { request: (args: { method: string; params?: unknown }) => Promise<unknown> };
type Listener = (value: unknown) => void;
interface StoredCredential {
  id: string;
  publicKey: `0x${string}`;
}

const CHAINS = { 5042002: 'arcTestnet', 84532: 'baseSepolia' } as const;
type ChainId = keyof typeof CHAINS;

let credential: StoredCredential | null = null;
let chainId: ChainId = 5042002;
const providers = new Map<ChainId, Promise<Provider>>();
const listeners = new Map<string, Set<Listener>>();

function circleEnv() {
  const key = process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY;
  const url = process.env.NEXT_PUBLIC_CIRCLE_CLIENT_URL;
  if (!key || !url) throw new Error('NEXT_PUBLIC_CIRCLE_CLIENT_KEY and NEXT_PUBLIC_CIRCLE_CLIENT_URL must be set');
  return { key, url };
}

function stored(): StoredCredential | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as StoredCredential) : null;
  } catch {
    return null;
  }
}

async function build(owner: StoredCredential, id: ChainId): Promise<Provider> {
  const [{ toCircleSmartAccount, toModularTransport, EIP1193Provider, getUserOperationGasPrice }, { createPublicClient }, aa, chains] =
    await Promise.all([
      import('@circle-fin/modular-wallets-core'),
      import('viem'),
      import('viem/account-abstraction'),
      import('viem/chains'),
    ]);
  const chain: Chain = id === 84532 ? chains.baseSepolia : chains.arcTestnet;
  const { key, url } = circleEnv();
  const transport = toModularTransport(`${url}/${CHAINS[id]}`, key);
  const client = createPublicClient({ chain, transport });
  const account = await toCircleSmartAccount({ client, owner: aa.toWebAuthnAccount({ credential: owner }) });
  const bundler = aa.createBundlerClient({
    account,
    chain,
    transport,
    paymaster: true,
    userOperation: {
      estimateFeesPerGas: async () => {
        const { medium } = await getUserOperationGasPrice(client);
        return { maxFeePerGas: BigInt(medium.maxFeePerGas), maxPriorityFeePerGas: BigInt(medium.maxPriorityFeePerGas) };
      },
    },
  });
  return new EIP1193Provider(bundler, client) as unknown as Provider;
}

function current(): Promise<Provider> {
  credential ??= stored();
  if (!credential) throw new Error('No passkey on this device yet');
  if (!providers.has(chainId)) {
    const id = chainId;
    const made = build(credential, id);
    providers.set(id, made);
    // A rejected build must not stay cached until reload.
    made.catch(() => providers.get(id) === made && providers.delete(id));
  }
  return providers.get(chainId)!;
}

export async function passkeySignIn(mode: 'register' | 'login'): Promise<void> {
  const { toPasskeyTransport, toWebAuthnCredential, WebAuthnMode } = await import('@circle-fin/modular-wallets-core');
  const { key, url } = circleEnv();
  const made = await toWebAuthnCredential({
    transport: toPasskeyTransport(url, key),
    mode: mode === 'register' ? WebAuthnMode.Register : WebAuthnMode.Login,
    username: mode === 'register' ? `strike-${Date.now()}` : undefined,
  });
  credential = { id: made.id, publicKey: made.publicKey };
  localStorage.setItem(STORE, JSON.stringify(credential));
  providers.clear();
  await current();
}

const lazyProvider = {
  async request(args: { method: string; params?: unknown }) {
    if (args.method === 'wallet_switchEthereumChain') {
      const next = Number((args.params as [{ chainId: string }])?.[0]?.chainId) as ChainId;
      if (!(next in CHAINS)) throw new Error(`Passkey wallets run on Arc and Base Sepolia, not chain ${next}`);
      if (next !== chainId) {
        chainId = next;
        await current();
        listeners.get('chainChanged')?.forEach((fn) => fn(`0x${next.toString(16)}`));
      }
      return null;
    }
    const res = (await (await current()).request(args)) as { result?: unknown; error?: { message?: string } };
    if (res?.error) throw new Error(res.error.message ?? `passkey wallet refused ${args.method}`);
    return res?.result;
  },
  on(event: string, fn: Listener) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(fn);
  },
  removeListener(event: string, fn: Listener) {
    listeners.get(event)?.delete(fn);
  },
};

export const passkeyConnector = injected({
  target: () => ({ id: PASSKEY_CONNECTOR_ID, name: 'Passkey', provider: lazyProvider as never }),
});
