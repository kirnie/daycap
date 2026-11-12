// Registrable-domain extraction.
//
// A full Public Suffix List is overkill here, so this handles the common
// multi-part suffixes explicitly and treats everything else as eTLD+1.
// Consequence worth knowing: news.ycombinator.com buckets as ycombinator.com,
// and m.youtube.com buckets as youtube.com. That is the intent -- one bucket
// per site, so one limit per site.

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz',
  'com.br', 'net.br', 'org.br',
  'co.in', 'net.in', 'org.in',
  'co.za', 'org.za',
  'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.sg', 'com.hk', 'com.tw',
  'co.kr', 'or.kr',
  'com.pl', 'com.ua', 'co.il', 'com.my', 'co.th', 'com.ph', 'com.vn',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Returns the bucket key for a URL, or null when the URL is not trackable
// (browser internals, extension pages, files, blank tabs).
export function registrableDomain(url) {
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;

  // IP literals and single-label hosts (localhost, intranet names) stand alone.
  if (IPV4.test(host) || host.includes(':') || !host.includes('.')) return host;

  const parts = host.split('.');
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}
