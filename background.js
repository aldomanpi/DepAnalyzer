import { getRegisteredDomain, isPrivateHost, extractHostname } from './lib/domainUtils.js';

const SYSTEM_PROMPT = `You are helping an internet filtering organization categorize the third-party domains a website depends on, for allowlist management.

Classify each domain into exactly one of these three categories:

- generic: A widely-used third-party service or provider that many different websites rely on — a common building block of the web — and is therefore typically already permitted globally, so it does NOT need to be added to a per-site allowlist. These ARE real, functional dependencies (blocking them can break the site); they belong here because the SERVICE is widely used, NOT because it is safe to block. This applies regardless of which site is being analyzed:
  - Public open-source CDNs (cdnjs.cloudflare.com, jsdelivr.net, unpkg.com, bootstrapcdn.com)
  - Shared static/CDN infrastructure (gstatic.com, fonts.googleapis.com, fonts.gstatic.com, ajax.googleapis.com; cloudflare/akamai/fastly/cloudfront edges serving shared assets)
  - Widely-used payment processors and gateways (stripe.com, js.stripe.com, paypal.com, braintree-api.com, braintreegateway.com, adyen.com, checkout.com, and Apple Pay endpoints such as apple.com / cdn-apple.com / applepay.cdn-apple.com)
  - Common auth, identity, and bot-protection providers (accounts.google.com, auth0.com, okta.com, recaptcha, hcaptcha.com)
  - Common maps, fonts, embeds, and media providers (maps.googleapis.com, youtube.com / ytimg.com, vimeo.com, gravatar.com, typekit.net)

- specific: A functional dependency that belongs to THIS site itself — not a service that many other sites also use. This is mainly the site's own infrastructure under a different domain name: its own CDN, media/asset servers, API backends, search/recommendation services, URL shorteners, or redirect domains. Choose specific ONLY when the domain is the site's own infrastructure or a niche provider used by very few sites — NOT for well-known third-party providers, which are generic.

- noise: An optional service that does not affect what the user sees or can do — blocking it would not break or visibly degrade the site. This includes advertising, tracking, web analytics, telemetry, performance/RUM monitoring, A/B testing, error monitoring, session recording, chat widgets, social embeds/pixels, and consent management — even when the vendor's data is described as "specific to this site." Examples: google-analytics.com, googletagmanager.com, doubleclick.net, hotjar.com, segment.io, facebook.net, sentry.io, datadoghq.com, btttag.com / Blue Triangle and similar RUM vendors, intercom.io, onetrust.com.

Critical rules:
1. Classify by what the service IS and how widely it is used across the web, not by who integrated it or which site is being analyzed. A payment gateway like Braintree or Apple Pay is generic on every site that uses it.
2. generic vs specific: if the SERVICE is a recognizable third-party provider used across many websites (payments, auth, CDNs, fonts, maps, captcha, embeds), choose generic. Choose specific only for the site's own infrastructure or a niche dependency particular to this site.
3. Performance monitoring, RUM, and analytics are noise even when the data is described as "specific to this site."
4. When genuinely uncertain between specific and noise, choose specific — treat it as a needed dependency rather than risk breaking the site.
5. Some domains include an "observed paths" line listing what they actually served on the analyzed page (query strings removed). Use it: paths like /static/app.js, /assets/img.png, /fonts/…, or an API/data endpoint indicate a functional role; paths like /ads/pixel.js, /collect, /track, /beacon, /b/ss indicate tracking.
6. A domain often serves more than one purpose. Classify it by its MOST functional role: if ANY of its requests deliver content the SITE'S OWN experience needs — its scripts, styles, images, media, fonts, or API/data — classify the whole domain as functional (generic or specific), even if it also serves some tracking. BUT a script whose PURPOSE is advertising, analytics, or tracking does NOT count as functional content: an ad network or measurement vendor is noise even though it delivers JavaScript (e.g. doubleclick.net serving an ad library, a tag manager, or a measurement pixel). Decide by the domain's purpose, not the file type — if its role is advertising/tracking/measurement, it is noise even when the request is a .js or .css file.
7. Use the observed paths to judge ROLE (functional vs ads/tracking), NOT ownership. A site or brand name appearing in a request path (e.g. /lowes/, /deployments/Lowes/, /widgets/lowes/) does NOT make a domain specific — multi-tenant third-party providers (reviews, ratings, rebates, search, chat, widgets, CDNs like cloudfront.net) serve per-customer content under customer-named paths but remain third-party services used by many sites; classify them generic (or noise) based on the provider, not specific. A domain is 'specific' ONLY when the domain/provider itself is the site's own infrastructure or a genuinely niche, single-customer service — never merely because a path mentions the site.`;

const CLASSIFY_TOOL = {
  name: 'classify_domains',
  description: 'Submit the final classification for all domains.',
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
            category: { type: 'string', enum: ['generic', 'specific', 'noise'],
                        description: 'generic = widely-used third-party provider (already allowed everywhere); specific = the site\'s own infrastructure; noise = optional (ads/tracking/analytics/monitoring).' },
            impact:   { type: 'string', description: 'One neutral sentence describing what this service does and what depends on it. Do not claim blocking is safe for generic or specific domains.' },
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

// In-flight classify operations, so the popup can cancel a long AI run.
// Map<tabId, AbortController>
const inflight = new Map();

// --- Toolbar badge: live captured-domain count, per tab ---
chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' }).catch(() => {});
function updateBadge(tabId, count) {
  if (tabId == null || tabId < 0) return;
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }).catch(() => {});
}

// Recover persisted capture data after a service worker restart. The
// `capturing` flag is restored too, so a capture keeps recording across the
// MV3 service-worker lifecycle instead of silently stopping on eviction.
(async () => {
  try {
    const { captureState } = await chrome.storage.session.get('captureState');
    if (captureState) {
      for (const [tabId, data] of Object.entries(captureState)) {
        const domains = new Map(Object.entries(data.domains || {}));
        captures.set(Number(tabId), {
          capturing: !!data.capturing,
          targetUrl: data.targetUrl || '',
          targetRegistered: data.targetRegistered || '',
          domains,
        });
        updateBadge(Number(tabId), domains.size); // restore badge after SW restart
      }
    }
  } catch {}
})();

async function persistCaptures() {
  const serializable = {};
  for (const [tabId, data] of captures.entries()) {
    serializable[String(tabId)] = {
      capturing: data.capturing,
      targetUrl: data.targetUrl,
      targetRegistered: data.targetRegistered,
      domains: Object.fromEntries(data.domains.entries()),
    };
  }
  await chrome.storage.session.set({ captureState: serializable }).catch(() => {});
}

// Coalesce frequent updates (request-count/subdomain growth) into at most one
// write per second so progress survives a service-worker restart without
// hammering session storage on every request.
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistCaptures(); }, 1000);
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
      updateBadge(tabId, state.domains.size);
      chrome.runtime.sendMessage({ type: 'newDomain', tabId, domain: registered }).catch(() => {});
    } else {
      // Persist incremental growth (counts/subdomains/urls) on a throttle.
      schedulePersist();
    }
  },
  { urls: ['<all_urls>'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  captures.delete(tabId);
  persistCaptures();
});

// Re-assert the badge after a captured tab navigates. Chrome can drop the
// per-tab badge on navigation, and we otherwise only repaint it when a brand-
// new domain is seen — so a new page that re-contacts already-seen domains
// would leave the badge blank. Capture itself continues across navigations
// (state is keyed by tabId and survives in memory + session storage).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.status) return; // only react to load-lifecycle changes
  const s = captures.get(tabId);
  if (s) updateBadge(tabId, s.domains.size);
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
    updateBadge(tabId, 0);
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
    updateBadge(tabId, 0);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'classify') {
    const controller = new AbortController();
    inflight.set(tabId, controller);
    classify(msg.domainMap, msg.targetUrl, tabId, msg.targetRegistered || '', controller.signal)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(e => {
        if (e.name === 'AbortError') sendResponse({ cancelled: true });
        else sendResponse({ error: friendlyError(e) });
      })
      .finally(() => inflight.delete(tabId));
    return true; // keep channel open for async response
  }

  if (msg.type === 'cancelClassify') {
    inflight.get(tabId)?.abort();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'clearCache') {
    chrome.storage.local.remove(CACHE_KEY)
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

// Classifications are cached for this long, then re-checked so a domain that
// changes purpose doesn't stay misclassified forever.
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Versioned cache key. Bumped when category semantics or the key shape change
// so stale entries aren't reused. Superseded keys are dropped on startup.
const CACHE_KEY = 'domainCache_v6';
chrome.storage.local.remove(
  ['domainCache', 'domainCache_v2', 'domainCache_v3', 'domainCache_v4', 'domainCache_v5'])
  .catch(() => {});

// AI verdicts are cached per analyzed site, because a domain's category can
// depend on what it does on a given page (e.g. redditstatic.com serves media
// on one page and an ads pixel on another). A verdict from one site is never
// reused on another. (Always-generic infra is handled separately by
// KNOWN_GENERIC below and never reaches the cache.)
function cacheKey(site, domain) {
  return `${site || ''}\n${domain}`;
}

async function getCache() {
  const { [CACHE_KEY]: cache } = await chrome.storage.local.get(CACHE_KEY);
  return cache || {};
}

// A cache entry is stale once it's older than the TTL. Entries written before
// timestamps existed (no `ts`) are treated as fresh and re-stamped on next save.
function isStale(entry) {
  return !!entry?.ts && (Date.now() - entry.ts) > CACHE_TTL_MS;
}

async function saveToCache(target, entries) {
  const cache = await getCache();
  const ts = Date.now();
  for (const { domain, category, impact } of entries) {
    cache[cacheKey(target, domain)] = { category, impact, ts };
  }
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

// Map an error to a user-friendly message for the popup.
function friendlyError(e) {
  if (e?.message && /failed to fetch|networkerror/i.test(e.message)) {
    return 'Network error reaching the API — check your connection and try again.';
  }
  return e?.message || 'Something went wrong.';
}

function mapHttpError(status, apiMsg) {
  if (status === 401 || status === 403) return 'Invalid or expired API key — check it in Options.';
  if (status === 429) return 'Anthropic rate limit reached — wait a moment and try again.';
  if (status >= 500) return 'Anthropic is temporarily unavailable — try again shortly.';
  return apiMsg || `Anthropic API error ${status}`;
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

// Cap the number of domains per AI request. A single 4096-token tool response
// can't hold classifications for an unbounded list, so large captures are split
// into batches to avoid silently dropping domains.
const CLASSIFY_BATCH_SIZE = 40;

// Distinct request pathnames a domain served (query strings stripped for
// privacy), capped so the prompt stays bounded. Gives the model the signal it
// needs to judge a domain's role on this page (e.g. /ads/pixel.js vs /app.js).
function samplePaths(urls, max = 8) {
  const seen = new Set();
  for (const u of urls || []) {
    try {
      seen.add(new URL(u).pathname || '/');
      if (seen.size >= max) break;
    } catch {}
  }
  return [...seen];
}

// --- AI classification (batched API calls with pre-fetched summaries) ---
async function classifyWithAI(domains, pathsByDomain, targetUrl, targetRegistered, apiKey, tabId, signal) {
  if (!domains.length) return {};

  const out = {};
  const total = domains.length;
  for (let i = 0; i < total; i += CLASSIFY_BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = domains.slice(i, i + CLASSIFY_BATCH_SIZE);
    const range = total > CLASSIFY_BATCH_SIZE
      ? ` (${i + 1}–${Math.min(i + batch.length, total)} of ${total})`
      : '';
    Object.assign(out, await classifyBatch(batch, pathsByDomain, targetUrl, targetRegistered, apiKey, tabId, range, signal));
  }
  return out;
}

async function classifyBatch(domains, pathsByDomain, targetUrl, targetRegistered, apiKey, tabId, range = '', signal) {
  // Fetch all summaries in parallel — free, no AI tokens consumed
  sendProgress(tabId, `Looking up ${domains.length} domain(s)${range}…`);
  const settled = await Promise.allSettled(
    domains.map(d => fetchDomainSummary(d).then(s => ({ domain: d, summary: s }))),
  );

  const domainLines = settled.map(r => {
    if (r.status === 'rejected') return null;
    const { domain, summary } = r.value;
    const brief = (summary || '').replace(/\s+/g, ' ').slice(0, 250);
    const paths = (pathsByDomain && pathsByDomain[domain]) || [];
    let line = brief ? `- ${domain}: ${brief}` : `- ${domain}`;
    if (paths.length) line += `\n    observed paths: ${paths.join(', ')}`;
    return line;
  }).filter(Boolean).join('\n') || domains.map(d => `- ${d}`).join('\n');

  const targetHint = targetRegistered
    ? `\nNote: the target site's registered domain is "${targetRegistered}". Domains sharing its brand name or clearly serving as its own infrastructure should be classified as specific.`
    : '';

  sendProgress(tabId, `Classifying ${domains.length} domain(s)${range}…`);

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
    signal,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(mapHttpError(resp.status, err.error?.message));
  }

  const data = await resp.json();
  const block = data.content?.find(b => b.type === 'tool_use' && b.name === 'classify_domains');
  if (!block) return Object.fromEntries(domains.map(d => [d, { category: 'specific', impact: '' }]));

  const VALID = new Set(['generic', 'specific', 'noise']);
  const out = {};
  for (const e of block.input.classifications || []) {
    // Default to 'specific' when uncertain so a needed dependency isn't dropped.
    if (e.domain) out[e.domain] = { category: VALID.has(e.category) ? e.category : 'specific', impact: e.impact || '' };
  }
  return out;
}

const CATEGORY_LABELS = {
  first_party: 'First Party',
  specific: 'Specific Dependencies',
  generic: 'Generic Dependencies',
  noise: 'Noise',
};
const CATEGORY_RANK = { first_party: 0, specific: 1, generic: 2, noise: 3 };

// Domains that are ALWAYS generic regardless of page — ubiquitous public
// infrastructure already permitted by virtually every filter. These are forced
// to 'generic' without asking the AI. Keep this to truly site-independent infra
// (a domain that could ever serve site-specific content or tracking does NOT
// belong here — let the AI judge those per page). Matched by registered domain.
const KNOWN_GENERIC = new Set([
  'gstatic.com', 'googleapis.com', 'jsdelivr.net', 'unpkg.com',
  'bootstrapcdn.com', 'jquery.com', 'fontawesome.com', 'typekit.net',
]);
const KNOWN_GENERIC_IMPACT = 'Ubiquitous public infrastructure, already allowed by virtually every filter.';
function isKnownGeneric(domain) {
  return KNOWN_GENERIC.has(domain) || KNOWN_GENERIC.has(getRegisteredDomain(domain));
}

// Domains that are ALWAYS noise — pure advertising / tracking / measurement
// networks with no site-functional role, even though they deliver JavaScript.
// Forced to 'noise' without asking the AI. Keep this to unambiguous ad/tracking
// (a domain that can ever serve genuine site content does NOT belong here).
const KNOWN_NOISE = new Set([
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'googletagservices.com', 'googletagmanager.com', 'google-analytics.com',
  'adnxs.com', 'adsrvr.org', 'amazon-adsystem.com', 'criteo.com', 'criteo.net',
  'taboola.com', 'outbrain.com', 'scorecardresearch.com', 'quantserve.com',
  'adroll.com', 'hotjar.com', 'mixpanel.com',
]);
const KNOWN_NOISE_IMPACT = 'Advertising / tracking / measurement network — optional, excluded as noise.';
function isKnownNoise(domain) {
  return KNOWN_NOISE.has(domain) || KNOWN_NOISE.has(getRegisteredDomain(domain));
}

async function classify(domainMap, targetUrl, tabId, providedTargetRegistered = '', signal) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No Anthropic API key set — open Options to add one.');

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

  // Per-site cached verdict (ignoring stale entries past their TTL).
  const lookup = d => {
    const e = cache[cacheKey(targetRegistered, d)];
    return e && !isStale(e) ? e : null;
  };

  const allDomains = Object.keys(domainMap);
  // Always-generic infra (gstatic, …) and always-noise ad/tracking networks
  // (doubleclick, …) are resolved by their lists and skip the AI and the cache.
  const thirdParty = allDomains.filter(
    d => !isTargetParty(d) && !isKnownGeneric(d) && !isKnownNoise(d));
  const cached   = thirdParty.filter(d =>  lookup(d));
  const uncached = thirdParty.filter(d => !lookup(d));

  if (!uncached.length) {
    sendProgress(tabId, `All ${cached.length} domain(s) found in cache…`);
  } else if (cached.length) {
    sendProgress(tabId, `${cached.length} from cache, asking AI about ${uncached.length} new…`);
  } else {
    sendProgress(tabId, `Asking AI to classify ${uncached.length} domain(s)…`);
  }

  let aiResults = {};
  if (uncached.length) {
    // Give the model what each domain actually served on this page so it can
    // judge role (and bump a mixed-purpose domain up to its functional category).
    const pathsByDomain = {};
    for (const d of uncached) pathsByDomain[d] = samplePaths(domainMap[d]?.urls);
    aiResults = await classifyWithAI(uncached, pathsByDomain, targetUrl, targetRegistered, apiKey, tabId, signal);
    await saveToCache(
      targetRegistered,
      Object.entries(aiResults).map(([domain, { category, impact }]) => ({ domain, category, impact })),
    );
  }

  const allCats = {
    ...Object.fromEntries(cached.map(d => [d, lookup(d)])),
    ...aiResults,
  };

  const results = [];
  for (const [domain, info] of Object.entries(domainMap)) {
    const isFirstParty = isTargetParty(domain);
    let cat, impact;
    if (isFirstParty) {
      cat = 'first_party'; impact = '';
    } else if (isKnownGeneric(domain)) {
      cat = 'generic'; impact = KNOWN_GENERIC_IMPACT;
    } else if (isKnownNoise(domain)) {
      cat = 'noise'; impact = KNOWN_NOISE_IMPACT;
    } else {
      cat = allCats[domain]?.category || 'specific';
      impact = allCats[domain]?.impact || '';
    }
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
    const ra = CATEGORY_RANK[a.category] ?? 9, rb = CATEGORY_RANK[b.category] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.domain.localeCompare(b.domain);
  });

  return { results, target: targetRegistered || targetUrl || 'unknown' };
}
