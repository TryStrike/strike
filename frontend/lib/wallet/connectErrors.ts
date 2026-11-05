
import type { ConnectErrorKind } from './connectMachine';

interface ErrorShape {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  shortMessage?: unknown;
  details?: unknown;
}

function haystack(err: unknown): { text: string; code: number | string | null } {
  if (err instanceof Error) {
    const e = err as Error & ErrorShape;
    const parts = [e.name, e.message, e.shortMessage, e.details].filter((p): p is string => typeof p === 'string');
    const code = typeof e.code === 'number' || typeof e.code === 'string' ? e.code : null;
    return { text: parts.join(' ').toLowerCase(), code };
  }
  if (err && typeof err === 'object') {
    const e = err as ErrorShape & { error?: unknown };
    const parts = [e.name, e.message, e.shortMessage, e.details].filter((p): p is string => typeof p === 'string');
    const code = typeof e.code === 'number' || typeof e.code === 'string' ? e.code : null;
    if (e.error && typeof e.error === 'object') {
      const inner = e.error as ErrorShape;
      if (typeof inner.message === 'string') parts.push(inner.message);
      if (typeof inner.code === 'number' || typeof inner.code === 'string') parts.push(String(inner.code));
    }
    return { text: parts.join(' ').toLowerCase(), code };
  }
  return { text: String(err ?? '').toLowerCase(), code: null };
}

export function classifyConnectError(err: unknown): ConnectErrorKind {
  const { text, code } = haystack(err);

  if (code === 4001 || code === '4001') return 'rejected';
  if (code === -32002 || code === '-32002') return 'locked';
  if (code === 4902 || code === '4902') return 'wrong_network';
  if (code === 'ACTION_REJECTED') return 'rejected';

  const name = err && typeof err === 'object' && typeof (err as Error).name === 'string' ? (err as Error).name : '';
  if (/userejected|rejectedrequest|actionrejected|providerrejected/i.test(name)) return 'rejected';
  if (/resourceunavailable|nodiscovery|noethereumprovider|noprov|providermissing/i.test(name)) return 'no_provider';
  if (/timeout|expired/i.test(name)) return 'timeout';

  if (/user rejected|user denied|declined|action rejected|rejected the request|request was dismissed|permission denied|not allowed|cancel?l?ed by user|denied access|user closed/i.test(text)) {
    return 'rejected';
  }
  if (/lock(?:ed|box)|unlock your|wallet is locked|accounts locked/i.test(text)) return 'locked';
  if (/no (?:injected |usable |detected )?(?:ethereum )?provider|provider (?:not (?:found|available|injected)|missing|is undefined)|ethereum (?:object )?(?:not found|is not)|install (?:a |your )?(?:wallet|metamask)|extension (?:required|not (?:found|installed))|no wallet (?:found|detected)/i.test(text)) {
    return 'no_provider';
  }
  if (/(?:wrong|unexpected|unsupported|invalid|unknown|not (?:added|supported)) (?:network|chain)|network (?:mismatch|error)|chain (?:mismatch|not (?:added|supported))|switch chain|unrecognized chain|insecure wallet-connect uri/i.test(text)) {
    return 'wrong_network';
  }
  if (/tim(?:ed )?out|timeout|expired/i.test(text)) return 'timeout';

  return 'unknown';
}

export function safeConnectErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim().slice(0, 300);
  }
  if (err && typeof err === 'object') {
    const e = err as ErrorShape;
    if (typeof e.message === 'string' && e.message.trim()) return e.message.trim().slice(0, 300);
  }
  return 'Unknown connection error';
}
