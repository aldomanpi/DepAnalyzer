# Chrome Web Store listing copy

Paste-ready text for the Web Store developer dashboard. Screenshots live in
`store-assets/store/` (1280×800).

---

## Short description (max 132 chars)

Capture a website's third-party domains and sort them into first-party, dependencies, common providers, and noise.

---

## Detailed description

Dependency Analyzer captures the third-party domains a website talks to and sorts them into clear, actionable categories — so you can build internet-filter allowlists, audit a site's dependencies, or just understand what a page is really loading.

Click Start Capture, browse the site normally, then Analyze with AI. Every domain is sorted into one of four categories with a plain-English note on what it does:

• First Party — the site's own domain.
• Specific Dependencies — services this site needs that you'd add to its allowlist (its CDN, APIs, integrated vendors).
• Generic Dependencies — ubiquitous providers (Google Fonts, jsDelivr, Stripe, …) already allowed almost everywhere, so they don't need per-site whitelisting.
• Noise — ads, trackers, analytics, and other optional services.

FEATURES
• Live capture of every domain a tab contacts, with request counts and the exact request paths.
• AI classification that reads what each domain actually serves on the page — a content CDN is treated differently from an ad pixel, even on the same domain.
• One-click "Copy whitelist" of the domains you actually need to allow.
• Subdomain mode to classify each subdomain individually, shown as a tidy tree.
• Manual mode — paste a list of hostnames or URLs to categorize without capturing.
• Results cached locally so you're not re-billed for sites you've already analyzed.
• Light / dark / system theme and adjustable font size.

REQUIREMENTS — BRING YOUR OWN API KEY
Classification uses Anthropic's Claude (the low-cost Haiku model) with YOUR OWN API key, which you add in Options. A free Anthropic account plus a small amount of credit is all you need — analyzing a site typically costs a fraction of a cent, and re-analyzing a cached site is free. The extension is fully usable for capturing domains without a key; the key is only needed for AI categorization.

PRIVACY
There is no developer-operated server and no analytics or tracking of any kind. When you run an analysis, domain names plus a sample of request paths (query strings removed) are sent to the Anthropic API using your key, and domain names are sent to DuckDuckGo for short descriptions. The extension also fetches each analyzed domain's public homepage to read its title/description. Your API key, cache, and settings stay in your browser. Full details: https://github.com/aldomanpi/DepAnalyzer-ext/blob/main/PRIVACY.md

WHO IT'S FOR
Network and content-filter administrators building allowlists, security and privacy researchers, and web developers auditing third-party dependencies.

---

## Screenshots

The Chrome Web Store has **no caption field** — text can only be baked into the
image. Recommended display order (lead with the payoff). The caption lines below
are optional overlay text if you want them rendered onto the images.

1. **Results** (`Screenshot 2026-06-25 230528-1280x800.png`)
   Optional overlay: "Sorted into first-party, dependencies, common providers, and noise"
2. **Live capture** (`Screenshot 2026-06-25 230332-1280x800.png`)
   Optional overlay: "Capture every domain a site contacts, in real time"
3. **Analyze** (`Screenshot 2026-06-25 230443-1280x800.png`)
   Optional overlay: "One click to AI-categorize the captured domains"
4. **Setup** (`Screenshot 2026-06-25 230638-1280x800.png`)
   Optional overlay: "Bring your own Anthropic key; pick theme and font size"

---

## Privacy practices tab

**Single purpose:**
Capture and categorize the third-party domains a website depends on, to help build internet-filter allowlists.

**Permission justifications:**
- `webRequest` — Observes the URLs (not contents) of network requests on the tab the user explicitly starts capturing, to extract the third-party domains the site contacts.
- Host permission `<all_urls>` — Users may analyze any website, so capture must work on any host; the extension also fetches each captured domain's public homepage metadata, which can be any domain. It only acts when the user starts a capture or runs an analysis.
- `storage` — Stores the user's API key, the classification cache, and capture state locally.
- `tabs` — Reads the active tab's URL to know which site is being analyzed.
- Remote code: **No** — all code is bundled; the extension fetches data, not executable code.

**Data handling disclosure:**
- Sends domain names and request paths (query strings removed) to the Anthropic API (the user's own key) and domain names to DuckDuckGo, for the core categorization feature.
- Does NOT sell or transfer data to third parties beyond these service providers.
- Does NOT use data for purposes unrelated to the single purpose, or for creditworthiness/lending.
- No data is sent to any developer-operated server.

**Privacy policy URL:**
https://github.com/aldomanpi/DepAnalyzer-ext/blob/main/PRIVACY.md
