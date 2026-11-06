import { injected } from 'wagmi/connectors';

export const PASSKEY_CONNECTOR_ID = 'circle-passkey';
const STORE = 'strike.passkey';

type Provider = { request: (args: { method: string; params?: unknown }) => Promise<unknown> };
interface StoredCredential {
  id: string;
  publicKey: `0x${string}`;
}

let provider: Promise<Provider> | null = null;

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

/** Circle smart account on Arc testnet, gas sponsored by Circle's paymaster. */
async function build(credential: StoredCredential): Promise<Provider> {
  const [{ toCircleSmartAccount, toModularTransport, EIP1193Provider }, { createPublicClient }, aa, { arcTestnet }] =
    await Promise.all([
      import('@circle-fin/modular-wallets-core'),
      import('viem'),
      import('viem/account-abstraction'),
      import('viem/chains'),
    ]);
  const { key, url } = circleEnv();
  const transport = toModularTransport(`${url}/arcTestnet`, key);
  const client = createPublicClient({ chain: arcTestnet, transport });
  const account = await toCircleSmartAccount({ client, owner: aa.toWebAuthnAccount({ credential }) });
  const bundler = aa.createBundlerClient({ account, chain: arcTestnet, transport, paymaster: true });
  return new EIP1193Provider(bundler, client) as unknown as Provider;
}

/** Runs the Touch ID or Face ID prompt, then keeps the public credential so reloads reconnect silently. */
export async function passkeySignIn(mode: 'register' | 'login'): Promise<void> {
  const { toPasskeyTransport, toWebAuthnCredential, WebAuthnMode } = await import('@circle-fin/modular-wallets-core');
  const { key, url } = circleEnv();
  const credential = await toWebAuthnCredential({
    transport: toPasskeyTransport(url, key),
    mode: mode === 'register' ? WebAuthnMode.Register : WebAuthnMode.Login,
    username: mode === 'register' ? `strike-${Date.now()}` : undefined,
  });
  const keep: StoredCredential = { id: credential.id, publicKey: credential.publicKey };
  localStorage.setItem(STORE, JSON.stringify(keep));
  provider = build(keep);
  await provider;
}

const lazyProvider = {
  async request(args: { method: string; params?: unknown }) {
    if (!provider) {
      const credential = stored();
      if (!credential) throw new Error('No passkey on this device yet');
      provider = build(credential);
    }
    const res = (await (await provider).request(args)) as { result?: unknown; error?: { message?: string } };
    if (res?.error) throw new Error(res.error.message ?? `passkey wallet refused ${args.method}`);
    return res?.result;
  },
  on() {},
  removeListener() {},
};

export const passkeyConnector = injected({
  target: () => ({ id: PASSKEY_CONNECTOR_ID, name: 'Passkey', provider: lazyProvider as never }),
});

export function forgetPasskey() {
  localStorage.removeItem(STORE);
  provider = null;
}
