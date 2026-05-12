import { getRegisteredDomain, isPrivateHost, extractHostname } from './lib/domainUtils.js';

const SYSTEM_PROMPT = `You are helping an internet filtering organization categorize website dependencies.

Classify each domain into exactly one of these two categories:

- noise: Any service whose removal would not break or visibly degrade the site's user experience — if a user would not notice the domain being blocked, it is noise. Exception: domains so ubiquitous that every organization's standard filter already has a policy for them are also noise even if blocking them does affect UX — this covers public open-source CDNs and widely-deployed infrastructure from major tech companies (Google, Microsoft, Amazon, etc.). Classify as noise regardless of who owns the domain or who the target site is. This includes:
  - Analytics and telemetry (google-analytics.com, googletagmanager.com, hotjar.com, mixpanel.com, segment.io, amplitude.com, clarity.ms, heap.io, etc.)
  - A/B testing, experimentation, and feature flagging (growthbook.io, optimizely.com, vwo.com, launchdarkly.com, split.io, statsig.com, etc.)
  - Advertising and tracking (doubleclick.net, googlesyndication.com, facebook.net, criteo.com, taboola.com, outbrain.com, etc.)
  - Social media embeds/pixels (facebook.com, twitter.com, x.com, linkedin.com, instagram.com, tiktok.com, pinterest.com, etc.)
  - Public CDN frameworks hosting open-source JS/CSS (cdnjs.cloudflare.com, jsdelivr.net, unpkg.com, bootstrapcdn.com, etc.)
  - Ubiquitous infrastructure from major tech companies — any domain that is clearly a property of Google, Microsoft, Amazon, Apple, Cloudflare, Akamai, Fastly, or a similar hyperscaler, serving generic infrastructure such as CDN delivery, APIs, content hosting, or authentication. This applies to the entire family of domains owned by these companies, not just known examples. Known examples include: googleapis.com, gstatic.com, googleusercontent.com, google.com (subdomains), microsoft.com, live.com, windows.net, amazonaws.com, cloudfront.net, azureedge.net, azurefd.net, fastly.net, akamaized.net, akamai.net — but if you encounter an unfamiliar domain that is clearly part of one of these companies' infrastructure, classify it as noise too.
  - Error/performance monitoring (sentry.io, datadoghq.com, newrelic.com, bugsnag.com, rollbar.com, etc.)
  - Live chat and customer support widgets (intercom.io, drift.com, crisp.chat, tawk.to, zendesk.com, etc.)
  - Consent management platforms (onetrust.com, cookiebot.com, trustarc.com, usercentrics.com, etc.)

- cdn: A domain whose absence would break or visibly degrade the site's user experience — something a user would notice if blocked. This includes the site's own CDN/hosting, payment processors, authentication providers, maps APIs, video hosting, fonts, or any third-party service that delivers visible content or enables core functionality.

Critical rule: classify by what the domain IS (e.g. an analytics service), not by who owns it or who the target site is. google-analytics.com is always noise even if the target site is google.com.`;

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
    if (isNew) state.domains.set(registered, { subdomains: [], requestCount: 0, urls: [] });

    const info = state.domains.get(registered);
    info.requestCount++;
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
      targetRegistered = getRegisteredDomain(new URL(u).hostname);
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
    if (!s) { sendResponse({ domains: [], capturing: false, targetUrl: '' }); return; }
    sendResponse({
      domains: [...s.domains.entries()].map(([d, info]) => ({ domain: d, ...info })),
      capturing: s.capturing,
      targetUrl: s.targetUrl,
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
    classify(msg.domainMap, msg.targetUrl, msg.tabId)
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
  // Fallback: DuckDuckGo Instant Answer
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
  return '';
}

// --- AI classification (single API call with pre-fetched summaries) ---
async function classifyWithAI(domains, targetUrl, apiKey, tabId) {
  if (!domains.length) return {};

  // Fetch all summaries in parallel — free, no AI tokens consumed
  sendProgress(tabId, `Looking up ${domains.length} domain(s)…`);
  const settled = await Promise.allSettled(
    domains.map(d => fetchDomainSummary(d).then(s => ({ domain: d, summary: s }))),
  );

  const domainLines = settled.map(r => {
    if (r.status === 'rejected' || !r.value) return null;
    const { domain, summary } = r.value;
    const brief = summary.replace(/\s+/g, ' ').slice(0, 250);
    return brief ? `- ${domain}: ${brief}` : `- ${domain}`;
  }).filter(Boolean).join('\n') ||
    domains.map(d => `- ${d}`).join('\n');

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
        content: `Target site: ${targetUrl || '(unknown)'}\n\nClassify these third-party domains:\n${domainLines}`,
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

async function classify(domainMap, targetUrl, tabId) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured — open extension Options to set it.');

  const cache = await getCache();
  let targetRegistered = '';
  try {
    if (targetUrl) {
      const u = targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`;
      targetRegistered = getRegisteredDomain(new URL(u).hostname);
    }
  } catch {}

  const allDomains = Object.keys(domainMap);
  const thirdParty = allDomains.filter(d => d !== targetRegistered);
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
    aiResults = await classifyWithAI(uncached, targetUrl, apiKey, tabId);
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
    const isFirstParty = domain === targetRegistered;
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
