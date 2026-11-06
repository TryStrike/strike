
function getReferralShareTweetText(): string {
  return [
    'Strike: 5-second binary rounds on crypto, forex, metals and stocks, settled in USDC on Arc.',
    '',
    'Join with my link:',
  ].join('\n');
}

function getPublicAppOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return '';
}

const EVM_ADDRESS_IN_TEXT = /0x[a-fA-F0-9]{40}/;
const PARAMS_WITHDRAWN_FROM_SHARES = ['address', 'wallet', 'access_code', 'accesscode', 'code', 'secret', 'token'];

export function referralLandingUrl(referralCode: string): string {
  const code = (referralCode || '').trim();
  if (!code) return '';
  const safe = code.replace(/[\u0000-\u001f\s]+/g, '');
  if (!safe || EVM_ADDRESS_IN_TEXT.test(safe)) return '';
  const params = new URLSearchParams({ ref: safe });
  return `${getPublicAppOrigin()}/?${params.toString()}`;
}

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
    return EVM_ADDRESS_IN_TEXT.test(link) ? '' : link;
  }
}

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
    'noopener,noreferrer',
  );
}
