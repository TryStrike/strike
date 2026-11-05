/**
 * Canonical X/Twitter share copy for referral links (used from /referrals and /profile).
 */

function getReferralShareTweetText(): string {
  return [
    'THIS PLATFORM IS INSANE.⚡️',
    '',
    'Strike - The first binary options trading dapp where you can trade over 1,010+ crypto, forex, metals, stocks and commodities in 5s-1m time charts.',
    '',
    'Tap my link → We earn 10% on their trading volume. We both run it up. 💸',
    '',
    'Stop watching. Start trading. Try it now: 🔥👇',
  ].join('\n');
}

/**
 * Public origin used to build shareable referral links.
 *
 * Prefers the configured app URL (NEXT_PUBLIC_APP_URL — inlined into the client
 * bundle at build time), then the current browser origin, and never a hardcoded
 * domain. Returns '' when neither is available so callers can guard rather than
 * ship a bogus link.
 */
function getPublicAppOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return '';
}

/** Absolute base URL for the app, for building referral landing links. */
export function getReferralBaseUrl(): string {
  return getPublicAppOrigin();
}

/** A 0x… address or a bearer-ish token must never ride along in a share link. */
const EVM_ADDRESS_IN_TEXT = /0x[a-fA-F0-9]{40}/;
const PARAMS_WITHDRAWN_FROM_SHARES = ['address', 'wallet', 'access_code', 'accesscode', 'code', 'secret', 'token'];

/**
 * Landing link for a referral. Only the (public, shareable) ref code travels; the
 * code is percent-encoded, so a code containing `&`, `=`, `#` or a space cannot
 * smuggle extra query params into the link or break out of the share target.
 */
export function referralLandingUrl(referralCode: string): string {
  const code = (referralCode || '').trim();
  if (!code) return '';
  // Control characters and separators are structural, never part of a real code.
  // Dropping them keeps a malformed code from forging a second query param.
  const safe = code.replace(/[\u0000-\u001f\s]+/g, '');
  // A real ref code is a short token, never a wallet address: refuse to build a
  // link that would hand someone's address to the share target.
  if (!safe || EVM_ADDRESS_IN_TEXT.test(safe)) return '';
  const params = new URLSearchParams({ ref: safe });
  return `${getPublicAppOrigin()}/?${params.toString()}`;
}

/**
 * Final safety pass before anything is handed to a third-party target: strip any
 * wallet-address / credential-looking query param, and refuse a link that still
 * carries a full address. The referee's address is theirs, not part of the pitch.
 */
export function sanitizeShareLink(link: string): string {
  if (!link) return '';
  try {
    const url = new URL(link);
    for (const key of [...url.searchParams.keys()]) {
      if (PARAMS_WITHDRAWN_FROM_SHARES.includes(key.toLowerCase()) && key.toLowerCase() !== 'ref') {
        url.searchParams.delete(key);
      }
    }
    const rebuilt = url.toString();
    return EVM_ADDRESS_IN_TEXT.test(rebuilt) ? '' : rebuilt;
  } catch {
    // Not a parseable URL: only a bare, address-free fragment is shareable.
    return EVM_ADDRESS_IN_TEXT.test(link) ? '' : link;
  }
}

/**
 * Open the X/Twitter composer with the invite copy and the referral link.
 * A link that fails the leak check is not opened at all — no half-redacted tweet.
 */
export function openReferralShareOnX(referralLink: string): void {
  if (typeof window === 'undefined') return;
  const link = sanitizeShareLink(referralLink);
  if (!link) return;

  const params = new URLSearchParams({
    text: getReferralShareTweetText(),
    url: link,
  });
  window.open(
    `https://twitter.com/intent/tweet?${params.toString()}`,
    '_blank',
    // No opener handle: the share page cannot reach back into this app.
    'noopener,noreferrer',
  );
}
