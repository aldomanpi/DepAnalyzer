// DepAnalyzer — Cloudflare Worker (OPTIONAL / EXPERIMENTAL backend)
//
// NOT part of the published browser extension and NOT called by it. The
// shipped extension talks to api.anthropic.com directly with the user's own
// key (see background.js). This worker is a separate, self-hosted backend for
// a future hosted/paid tier and uses a DIFFERENT classification taxonomy
// (functional/observational/ubiquitous) than the extension (first_party/cdn/
// noise) — the popup cannot consume these responses as-is. Exclude the
// worker/ directory when packaging the extension for the Web Store.
//
// Setup:
//   1. wrangler kv:namespace create KV
//      Copy the id into wrangler.toml below.
//   2. wrangler secret put ANTHROPIC_API_KEY
//   3. wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET  (only needed for paid tier)
//   4. wrangler deploy
//
// Free-tier note: Cloudflare KV allows 1 000 writes/day on the free plan.
// Each classify request writes once (rate counter) plus once per newly-seen domain.
// Upgrade to the Workers paid plan ($5/mo) when you have ~30+ daily active users.

const SYSTEM_PROMPT = `You are analyzing the third-party domains a website contacts, classifying each by its role in the user's experience.

Classify each domain into one of two categories:

- functional: Delivers visible content or enables features users directly experience. Includes the site’s own CDN, media servers, asset delivery, payment processors, authentication providers, maps, video hosting, fonts, or any third-party service whose absence would break or noticeably degrade the site.

- observational: Monitors, measures, or advertises without affecting what users see or can do. Includes analytics, A/B testing, tracking pixels, advertising networks, error monitoring, session recording, chat widgets, and consent management platforms.

Additionally, for each domain set ubiquitous to true if the service has an industry-wide presence across a large fraction of all websites on the internet (e.g. Google Analytics, Facebook Pixel, Cloudflare CDN, AWS CloudFront, Akamai), or false if it is specific to this site or a narrower set of sites.

For the impact field: one neutral sentence describing what this service does and what user data or interactions it handles.

Rules:
1. Classify by what the domain IS, regardless of who owns it or what site it appears on.
2. When uncertain, prefer functional.
3. Domains sharing obvious branding with the target site are almost certainly its own infrastructure — classify as functional.
4. A domain serving the site’s own content, images, video, or user data is always functional, even under a generic-sounding name.`;

const CLASSIFY_TOOL = {
  name: 'classify_domains',
  description: 'Submit the final classification for all domains.',
  input_schema: {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            domain:     { type: 'string' },
            category:   { type: 'string', enum: ['functional', 'observational'],
                          description: 'functional = users would notice if absent; observational = invisible to users' },
            ubiquitous: { type: 'boolean',
                          description: 'true if industry-wide presence across a large fraction of all websites' },
            impact:     { type: 'string',
                          description: 'One neutral sentence: what this service does and what user data or interactions it handles.' },
          },
          required: ['domain', 'category', 'ubiquitous', 'impact'],
        },
      },
    },
    required: ['classifications'],
  },
};

const FREE_DAILY_LIMIT = 20;
const PAID_DAILY_LIMIT = 500;

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
    try {
      if (url.pathname === '/classify' && request.method === 'POST') return await handleClassify(request, env);
      if (url.pathname === '/webhook'  && request.method === 'POST') return await handleWebhook(request, env);
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
    return new Response('DepAnalyzer', { headers: corsHeaders() });
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function checkRateLimit(uuid, licenseKey, env) {
  let limit = FREE_DAILY_LIMIT;
  if (licenseKey) {
    const lic = await env.KV.get(`license:${licenseKey}`, 'json').catch(() => null);
    if (lic?.active) limit = PAID_DAILY_LIMIT;
  }
  const today = new Date().toISOString().slice(0, 10);
  const rateKey = `rate:${uuid}:${today}`;
  const current = parseInt(await env.KV.get(rateKey).catch(() => null) || '0');
  if (current >= limit) return { allowed: false, limit, current };
  await env.KV.put(rateKey, String(current + 1), { expirationTtl: 172800 }).catch(() => {});
  return { allowed: true, limit, remaining: limit - current - 1 };
}

// ── /classify ────────────────────────────────────────────────────────────────

async function handleClassify(request, env) {
  const body = await request.json();
  const { domains, targetUrl, targetRegistered, uuid, licenseKey } = body;

  if (!uuid || !Array.isArray(domains) || !domains.length) {
    return jsonResp({ error: 'Invalid request' }, 400);
  }

  const rateCheck = await checkRateLimit(uuid, licenseKey || '', env);
  if (!rateCheck.allowed) {
    return jsonResp({
      error: `Daily limit of ${rateCheck.limit} analyses reached. Resets at midnight UTC.`,
      limitReached: true,
      limit: rateCheck.limit,
    }, 429);
  }

  // Check central cache first
  const results = {};
  const uncached = [];
  await Promise.all(domains.map(async (domain) => {
    const hit = await env.KV.get(`domain:${domain}`, 'json').catch(() => null);
    if (hit) results[domain] = hit;
    else uncached.push(domain);
  }));

  // AI-classify anything not in central cache
  if (uncached.length) {
    const aiResults = await classifyWithAI(uncached, targetUrl || '', targetRegistered || '', env);
    await Promise.all(Object.entries(aiResults).map(([domain, data]) => {
      results[domain] = data;
      return env.KV.put(`domain:${domain}`, JSON.stringify(data), { expirationTtl: 15552000 }).catch(() => {});
    }));
  }

  return jsonResp({ results, remaining: rateCheck.remaining });
}

// ── /webhook (LemonSqueezy) ───────────────────────────────────────────────────

async function handleWebhook(request, env) {
  const body = await request.text();

  if (env.LEMONSQUEEZY_WEBHOOK_SECRET) {
    const sig = request.headers.get('X-Signature') || '';
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(env.LEMONSQUEEZY_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const sigBytes = new Uint8Array((sig.match(/.{2}/g) || []).map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body));
    if (!valid) return new Response('Unauthorized', { status: 401 });
  }

  const event = JSON.parse(body);
  const eventName = event.meta?.event_name;
  const licenseKey = event.data?.attributes?.license_key?.key;

  if (licenseKey) {
    const active =
      eventName === 'license_key.created' ||
      eventName === 'subscription_payment.success' ||
      (eventName === 'subscription.updated' && event.data?.attributes?.status === 'active');
    const inactive =
      eventName === 'subscription.cancelled' ||
      eventName === 'subscription_payment.failed' ||
      eventName === 'subscription.expired';

    if (active || inactive) {
      await env.KV.put(`license:${licenseKey}`, JSON.stringify({ active: !!active, updated: Date.now() }));
    }
  }

  return new Response('OK');
}

// ── Domain summary lookup ─────────────────────────────────────────────────────

async function fetchDomainSummary(domain) {
  try {
    const r = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(domain)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(4000) },
    );
    const d = await r.json();
    const h = (d.Heading || '').trim();
    const a = (d.AbstractText || '').trim();
    if (h || a) return `${h}${a ? ` — ${a}` : ''}`;
  } catch {}
  try {
    const r = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DepAnalyzer/1.0)' },
    });
    const text = await r.text();
    const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
      .replace(/<[^>]+>/g, '').trim();
    const desc = (
      text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
      text.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)
    )?.[1]?.trim() || '';
    if (title || desc) return `${title}${desc ? ` — ${desc}` : ''}`;
  } catch {}
  return '';
}

// ── AI classification ─────────────────────────────────────────────────────────

async function classifyWithAI(domains, targetUrl, targetRegistered, env) {
  const settled = await Promise.allSettled(
    domains.map(d => fetchDomainSummary(d).then(s => ({ domain: d, summary: s }))),
  );

  const lines = settled.map(r => {
    if (r.status === 'rejected') return null;
    const { domain, summary } = r.value;
    const brief = (summary || '').replace(/\s+/g, ' ').slice(0, 250);
    return brief ? `- ${domain}: ${brief}` : `- ${domain}`;
  }).filter(Boolean).join('\n') || domains.map(d => `- ${d}`).join('\n');

  const hint = targetRegistered
    ? `\nNote: target site registered domain is "${targetRegistered}". Domains sharing its brand are its own infrastructure — classify as functional.`
    : '';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [{ ...CLASSIFY_TOOL, cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'tool', name: 'classify_domains' },
      messages: [{ role: 'user', content: `Target: ${targetUrl || '(unknown)'}${hint}\n\nClassify:\n${lines}` }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic error ${resp.status}`);
  }

  const data = await resp.json();
  const block = data.content?.find(b => b.type === 'tool_use' && b.name === 'classify_domains');
  if (!block) return Object.fromEntries(domains.map(d => [d, { category: 'functional', ubiquitous: false, impact: '' }]));

  const out = {};
  for (const e of block.input.classifications || []) {
    if (e.domain) {
      out[e.domain] = {
        category: e.category === 'observational' ? 'observational' : 'functional',
        ubiquitous: e.ubiquitous === true,
        impact: e.impact || '',
      };
    }
  }
  return out;
}
