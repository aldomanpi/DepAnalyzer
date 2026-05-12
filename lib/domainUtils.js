// Compact registered-domain extractor — offline, no PSL network fetch.
// Handles the most common multi-part TLDs; falls back to last-two-parts.

const MULTI_PART_TLDS = new Set([
  // UK
  'co.uk','me.uk','net.uk','org.uk','ltd.uk','plc.uk','sch.uk',
  // Australia
  'com.au','net.au','org.au','edu.au','gov.au','asn.au','id.au',
  // Brazil
  'com.br','net.br','org.br','gov.br','edu.br','ind.br',
  // Japan
  'co.jp','ne.jp','or.jp','ac.jp','go.jp','ad.jp',
  // New Zealand
  'co.nz','net.nz','org.nz','govt.nz','geek.nz',
  // South Africa
  'co.za','net.za','org.za','gov.za','edu.za',
  // China
  'com.cn','net.cn','org.cn','gov.cn','edu.cn',
  // India
  'co.in','net.in','org.in','gov.in','edu.in','firm.in','gen.in',
  // Argentina
  'com.ar','net.ar','org.ar','gov.ar','edu.ar',
  // Mexico
  'com.mx','net.mx','org.mx','gob.mx','edu.mx',
  // Singapore
  'com.sg','net.sg','org.sg','gov.sg','edu.sg',
  // Hong Kong
  'com.hk','net.hk','org.hk','gov.hk','edu.hk',
  // Turkey
  'com.tr','net.tr','org.tr','gov.tr','edu.tr',
  // Ukraine
  'com.ua','net.ua','org.ua','gov.ua',
  // Colombia
  'com.co','net.co','org.co','gov.co',
  // Venezuela
  'com.ve','net.ve','org.ve','gov.ve',
  // Egypt
  'com.eg','net.eg','org.eg','gov.eg',
  // Pakistan
  'com.pk','net.pk','org.pk','gov.pk',
  // Philippines
  'com.ph','net.ph','org.ph','gov.ph',
  // Vietnam
  'com.vn','net.vn','org.vn','gov.vn',
  // Nigeria
  'com.ng','net.ng','org.ng','gov.ng',
  // Malaysia
  'com.my','net.my','org.my','gov.my','edu.my',
]);

const SKIP_SCHEMES = new Set([
  'data', 'blob', 'javascript', 'about',
  'chrome', 'chrome-extension', 'moz-extension', 'edge-extension',
]);

const PRIVATE_RE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|::1)$/;

export function getRegisteredDomain(hostname) {
  if (!hostname) return '';
  hostname = hostname.toLowerCase().replace(/\.$/, '');
  if (PRIVATE_RE.test(hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) return '';
  const parts = hostname.split('.');
  if (parts.length < 2) return '';
  if (parts.length >= 3) {
    const twoPartTld = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(twoPartTld)) return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

export function isPrivateHost(hostname) {
  return !hostname || PRIVATE_RE.test(hostname.toLowerCase());
}

export function extractHostname(urlStr) {
  try {
    const url = new URL(urlStr);
    const scheme = url.protocol.replace(':', '');
    if (SKIP_SCHEMES.has(scheme)) return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}
