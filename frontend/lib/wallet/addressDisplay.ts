/**
 * Address presentation helpers — truncation and human labels. Pure, so the
 * short/long/ENS edge cases are unit-testable.
 */

export const DEFAULT_HEAD = 6;
export const DEFAULT_TAIL = 4;

/**
 * `0x1234…abcd`. Anything already short enough to read stays verbatim —
 * chopping a 10-char vanity label into ellipsis mush is worse than useless.
 */
export function truncateAddress(address?: string | null, head: number = DEFAULT_HEAD, tail: number = DEFAULT_TAIL): string {
  if (typeof address !== 'string') return '';
  const t = address.trim();
  if (!t) return '';
  if (t.length <= head + tail) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

export interface WalletLabelInput {
  address?: string | null;
  /** ENS name (or other resolution) when the app has one. */
  ens?: string | null;
  /** Arbitrary human label (e.g. a ConnectKit connector name). */
  label?: string | null;
  head?: number;
  tail?: number;
}

/** ENS wins, then a provided label, then the truncated address. */
export function displayNameForWallet({ address, ens, label, head, tail }: WalletLabelInput): string {
  const e = (ens ?? '').trim();
  if (e) return e;
  const l = (label ?? '').trim();
  if (l) return l;
  return truncateAddress(address, head, tail);
}

/**
 * Copy to clipboard with a `document.execCommand` fallback for non-secure
 * contexts (http on a LAN, older WebKit). Resolves true when the copy was
 * performed.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    if (typeof document === 'undefined') return false;
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
