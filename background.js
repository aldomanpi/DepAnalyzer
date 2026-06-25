import { getRegisteredDomain, isPrivateHost, extractHostname } from './lib/domainUtils.js';

const SYSTEM_PROMPT = `You are helping an internet filtering organization categorize website dependencies.

Classify each domain into exactly one of these two categories:

- noise: A service that is optional from the user's perspective — including advertising, tracking, and analytics — where blocking it would not break or visibly degrade the site. This applies regardless of who owns the domain or what site is being analyzed. Examples:
  - Analytics and telemetry (google-analytics.com, googletagmanager.com, hotjar.com, mixpanel.com, segment.io, amplitude.com, clarity.ms, heap.io, etc.)
  - A/B testing and feature flagging (optimizely.com, vwo.com, launchdarkly.com, growthbook.io, statsig.com, etc.)
  - Advertising and tracking pixels (doubleclick.net, googlesyndication.com, facebook.net, criteo.com, taboola.com, etc.)
  - Social media embeds and pixels (twitter.com, x.com, linkedin.com, instagram.com, tiktok.com, pinterest.com, etc.)
  - Public open-source CDN frameworks (cdnjs.cloudflare.com, jsdelivr.net, unpkg.com, bootstrapcdn.com, etc.)
  - Generic infrastructure from hyperscalers serving analytics/ads/tracking (googleapis.com, gstatic.com, cloudfront.net, amazonaws.com, fastly.net, akamaized.net, azureedge.net, etc.) — but only when the specific subdomain/usage is for analytics or optional services, not for delivering the site's own content
  - Error monitoring (sentry.io, datadoghq.com, newrelic.com, bugsnag.com, rollbar.com)
  - Chat widgets (intercom.io, drift.com, crisp.chat, tawk.to, zendesk.com)
  - Consent management (onetrust.com, cookiebot.com, trustarc.com)

- cdn: A domain that delivers visible content or enables core functionality — blocking it would break or noticeably degrade the user experience. This includes:
  - The target site's own CDN, media hosting, asset servers, URL shorteners, or redirect domains (even when hosted under a different domain name)
  - Payment processors, authentication providers, maps, video hosting, fonts
  - Any third-party service the site's core functionality visibly depends on

Critical rules:
1. Classify by what the domain IS, not by who owns it. google-analytics.com is always noise even on google.com.
2. WHEN UNCERTAIN, choose 'cdn'. Only choose 'noise' when you are confident the domain serves an optional, invisible purpose.
3. Domains whose names share obvious branding with the target site are almost certainly proprietary infrastructure — classify as 'cdn'.
4. A domain delivering the site's own content, images, videos, or user data is always 'cdn', even if it looks like a generic CDN name.`;

const CLASSIFY_TOOL = {
  name: 'classify_domains',
  description: 'Submit the final cdn/noise classification for all domains.',
  input_schema: {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        description: 'One entry per domain.',
        items: {
          type: 'object',
          properties: {
            domain:   { type: 'string' },
            category: { type: 'string', enum: ['cdn', 'noise'] },
            impact:   { type: 'string', description: 'One sentence describing what this domain does and how blocking it would generally affect any website that depends on it.' },
          },
          required: ['domain', 'category', 'impact'],
        },
      },
    },
    required: ['classifications'],
  },
  cache_control: { type: 'ephemeral' },
};

// In-memory capture state.
// Map<tabId, { capturing: bool, targetUrl: string, targetRegistered: string, domains: Map<domain, DomainInfo> }>
const captures = new Map();

// Recover persisted capture data after a service worker restart
(async () => {
  try {
    const { captureState } = await chrome.storage.session.get('captureState');
    if (captureState) {
      for (const [tabId, data] of Object.entries(captureState)) {
        captures.set(Number(tabId), {
          capturing: false,
          targetUrl: data.targetUrl || '',
          targetRegistered: data.targetRegistered || '',
          domains: new Map(Object.entries(data.domains || {})),
        });
      }
    }
  } catch {}
})();

async function persistCaptures() {
  const serializable = {};
  for (const [tabId, data] of captures.entries()) {
    serializable[String(tabId)] = {
      targetUrl: data.targetUrl,
      targetRegistered: data.targetRegistered,
      domains: Object.fromEntries(data.domains.entries()),
    };
  }
  await chrome.storage.session.set({ captureState: serializable }).catch(() => {});
}

// --- Network capture ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url } = details;
    if (tabId < 0) return;
    const state = captures.get(tabId);
    if (!state?.capturing) return;

    const hostname = extractHostname(url);
    if (!hostname || isPrivateHost(hostname)) return;
    const registered = getRegisteredDomain(hostname);
    if (!registered) return;

    const isNew = !state.domains.has(registered);
    if (isNew) state.domains.set(registered, { subdomains: [], requestCount: 0, urls: [], hostCounts: {} });

    const info = state.domains.get(registered);
    info.requestCount++;
    if (!info.hostCounts) info.hostCounts = {};
    info.hostCounts[hostname] = (info.hostCounts[hostname] || 0) + 1;
    if (hostname !== registered && !info.subdomains.includes(hostname)) {
      info.subdomains.push(hostname);
    }
    if (info.urls.length < 50 && !info.urls.includes(url)) {
      info.urls.push(url);
    }

    if (isNew) {
      persistCaptures();
      chrome.runtime.sendMessage({ type: 'newDomain', tabId, domain: registered }).catch(() => {});
    }
  },
  { urls: ['<all_urls>'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  captures.delete(tabId);
  persistCaptures();
});

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const tabId = msg.tabId;

  if (msg.type === 'startCapture') {
    let targetRegistered = '';
    try {
      const u = (msg.url || '').startsWith('http') ? msg.url : `https://${msg.url}`;
      targetRegistered = getRegisteredDomain(new URL(u).hostname) || '';
    } catch {}
    captures.set(tabId, {
      capturing: true,
      targetUrl: msg.url,
      targetRegistered,
      domains: new Map(),
    });
    persistCaptures();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'stopCapture') {
    const s = captures.get(tabId);
    if (s) { s.capturing = false; persistCaptures(); }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'resumeCapture') {
    const s = captures.get(tabId);
    if (s) s.capturing = true;
    sendResponse({ ok: !!s });
    return;
  }

  if (msg.type === 'getCapture') {
    const s = captures.get(tabId);
    if (!s) { sendResponse({ domains: [], capturing: false, targetUrl: '', targetRegistered: '' }); return; }
    sendResponse({
      domains: [...s.domains.entries()].map(([d, info]) => ({ domain: d, ...info })),
      capturing: s.capturing,
      targetUrl: s.targetUrl,
      targetRegistered: s.targetRegistered,
    });
    return;
  }

  if (msg.type === 'clearCapture') {
    captures.delete(tabId);
    persistCaptures();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'classify') {
    classify(msg.domainMap, msg.targetUrl, msg.tabId, msg.targetRegistered || '')
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(e => sendResponse({ error: e.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'clearCache') {
    chrome.storage.local.remove('domainCache')
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'getCacheStats') {
    getCache()
      .then(c => sendResponse({ size: Object.keys(c).length }))
      .catch(() => sendResponse({ size: 0 }));
    return true;
  }
});

// --- Storage helpers ---
async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey || '';
}

async function getCache() {
  const { domainCache } = await chrome.storage.local.get('domainCache');
  return domainCache || {};
}

async function saveToCache(entries) {
  const cache = await getCache();
  for (const { domain, category, impact } of entries) {
    cache[domain] = { category, impact };
  }
  await chrome.storage.local.set({ domainCache: cache });
}

function sendProgress(tabId, status) {
  if (tabId == null) return;
  chrome.runtime.sendMessage({ type: 'progress', tabId, status }).catch(() => {});
}

// --- Domain lookup (fetched before the AI call, no API cost) ---
async function fetchDomainSummary(domain) {
  // Try DuckDuckGo first — more reliable than raw HTML scraping for service identification
  try {
    const resp = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(domain)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(5000) },
    );
    const data = await resp.json();
    const h = (data.Heading      || '').trim();
    const a = (data.AbstractText || '').trim();
    if (h || a) return `${h}${a ? ` — ${a}` : ''}`;
  } catch {}
  // Fallback: parse title + meta description from homepage
  try {
    const resp = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DepAnalyzer/1.0)' },
    });
    const text = await resp.text();
    const titleM = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descM =
      text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
      text.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
    const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : '';
    const desc  = descM  ? descM[1].trim() : '';
    if (title || desc) return `${title}${desc ? ` — ${desc}` : ''}`;
  } catch {}
  return '';
}

// --- AI classification (single API call with pre-fetched summaries) ---
async function classifyWithAI(domains, targetUrl, targetRegistered, apiKey, tabId) {
  if (!domains.length) return {};

  // Fetch all summaries in parallel — free, no AI tokens consumed
  sendProgress(tabId, `Looking up ${domains.length} domain(s)…`);
  const settled = await Promise.allSettled(
    domains.map(d => fetchDomainSummary(d).then(s => ({ domain: d, summary: s }))),
  );

  const domainLines = settled.map(r => {
    if (r.status === 'rejected') return null;
    const { domain, summary } = r.value;
    const brief = (summary || '').replace(/\s+/g, ' ').slice(0, 250);
    return brief ? `- ${domain}: ${brief}` : `- ${domain}`;
  }).filter(Boolean).join('\n') || domains.map(d => `- ${d}`).join('\n');

  const targetHint = targetRegistered
    ? `\nNote: the target site's registered domain is "${targetRegistered}". Domains sharing its brand name or clearly serving as its infrastructure should be classified as cdn.`
    : '';

  sendProgress(tabId, `Classifying ${domains.length} domain(s)…`);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_domains' },
      messages: [{
        role: 'user',
        content: `Target site: ${targetUrl || '(unknown)'}${targetHint}\n\nClassify these third-party domains:\n${domainLines}`,
      }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
    throw new Error(err.error?.message || `Anthropic API error ${resp.status}`);
  }

  const data = await resp.json();
  const block = data.content?.find(b => b.type === 'tool_use' && b.name === 'classify_domains');
  if (!block) return Object.fromEntries(domains.map(d => [d, { category: 'cdn', impact: '' }]));

  const out = {};
  for (const e of block.input.classifications || []) {
    if (e.domain) out[e.domain] = { category: e.category === 'noise' ? 'noise' : 'cdn', impact: e.impact || '' };
  }
  return out;
}

const CATEGORY_LABELS = { first_party: 'First Party', cdn: 'CDN / Dependencies', noise: 'Noise' };

async function classify(domainMap, targetUrl, tabId, providedTargetRegistered = '') {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured — open extension Options to set it.');

  const cache = await getCache();

  // Prefer the stored targetRegistered (computed at capture time); fall back to derivation
  let targetRegistered = providedTargetRegistered;
  if (!targetRegistered) {
    try {
      if (targetUrl) {
        const u = targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`;
        targetRegistered = getRegisteredDomain(new URL(u).hostname) || '';
      }
    } catch {}
  }

  // A key may be a registered domain or (in subdomain mode) a full hostname —
  // either way it's first-party when its registered domain matches the target.
  const isTargetParty = d =>
    !!targetRegistered && (d === targetRegistered || getRegisteredDomain(d) === targetRegistered);

  const allDomains = Object.keys(domainMap);
  const thirdParty = allDomains.filter(d => !isTargetParty(d));
  const cached   = thirdParty.filter(d =>  (d in cache));
  const uncached = thirdParty.filter(d => !(d in cache));

  if (!uncached.length) {
    sendProgress(tabId, `All ${cached.length} domain(s) found in cache…`);
  } else if (cached.length) {
    sendProgress(tabId, `${cached.length} from cache, asking AI about ${uncached.length} new…`);
  } else {
    sendProgress(tabId, `Asking AI to classify ${uncached.length} domain(s)…`);
  }

  let aiResults = {};
  if (uncached.length) {
    aiResults = await classifyWithAI(uncached, targetUrl, targetRegistered, apiKey, tabId);
    await saveToCache(
      Object.entries(aiResults).map(([domain, { category, impact }]) => ({ domain, category, impact })),
    );
  }

  const allCats = {
    ...Object.fromEntries(cached.map(d => [d, cache[d]])),
    ...aiResults,
  };

  const results = [];
  for (const [domain, info] of Object.entries(domainMap)) {
    const isFirstParty = isTargetParty(domain);
    const cat    = isFirstParty ? 'first_party' : (allCats[domain]?.category || 'cdn');
    const impact = isFirstParty ? '' : (allCats[domain]?.impact || '');
    results.push({
      domain,
      category: cat,
      label: CATEGORY_LABELS[cat] || cat,
      is_noise: cat === 'noise',
      subdomains: info.subdomains || [],
      request_count: info.requestCount || info.request_count || 0,
      impact,
      urls: info.urls || [],
    });
  }
  results.sort((a, b) => {
    if (a.is_noise !== b.is_noise) return a.is_noise ? 1 : -1;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.domain.localeCompare(b.domain);
  });

  return { results, target: targetRegistered || targetUrl || 'unknown' };
}
