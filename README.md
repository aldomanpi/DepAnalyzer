# DepAnalyzer

A Manifest V3 Chrome extension that discovers and categorizes the third-party
domains a website depends on — built for internet-filter / allowlist management.
Capture a site's network activity, then classify each domain into one of four
categories:

- **First Party** — the site's own registered domain.
- **Specific Dependencies** — functional services particular to this site
  (its CDN, asset servers, API backends, specific integrations) — these go in
  the per-site allowlist.
- **Generic Dependencies** — widely-used third-party providers (e.g. `gstatic.com`,
  `jsdelivr.net`, `stripe.com`, Braintree, Apple Pay) that are real dependencies
  but already allowed almost everywhere, so they don't need per-site whitelisting.
- **Noise** — ads, trackers, analytics, and other optional services.

## Features

- **Live capture** of the domains a tab contacts, with per-domain request counts
  and the exact request paths, updating in real time.
- **AI classification** (Anthropic Claude Haiku, using your own API key) into the
  four categories above, with a one-line impact note per domain.
- **Subdomain mode** — classify each subdomain individually *and* its registered
  domain, shown as a nested tree.
- **Copy whitelist** of the domains to allow (first-party + specific dependencies).
- **Manual mode** — paste a list of hostnames/URLs to classify without capturing.
- Local, permanent **classification cache** so each domain is only analyzed once.
- Light / dark / system **theme**.

## Install (development)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this directory.
3. Click the extension's **Options** and follow the steps to create an Anthropic
   API key and paste it in. (Requires Chrome 111+.)

## Permissions

| Permission | Why |
|---|---|
| `webRequest` + `<all_urls>` host access | Observe request **URLs** (not contents) on whatever site you capture, and contact any domain for the homepage-metadata lookup below. Only acts when you start a capture or run an analysis. |
| `storage` | Store your API key, the classification cache, and capture state locally. |
| `tabs` | Read the active tab's URL so it can be analyzed. |

## Privacy

The extension has **no developer-operated backend** and collects no analytics.
When you run an analysis it sends **domain names only** to the Anthropic API
(with your key) and to DuckDuckGo (for short descriptions). It also fetches the
**public homepage of each newly-analyzed domain directly** to read its title and
meta description — meaning your browser connects to those domains from your IP.
No cookies/credentials are sent and results are cached so each domain is
contacted at most once.

Full details: [PRIVACY.md](./PRIVACY.md). You must host this policy at a public
URL and link it in your Web Store listing.

## Packaging for the Chrome Web Store

Build a clean zip that contains **only** the extension files (docs and tooling
are excluded):

```sh
./package.sh           # produces dist/depanalyzer-<version>.zip
```

Upload the resulting zip to the Web Store. Remember to: bump `version` in
`manifest.json`, provide screenshots, and supply the privacy-policy URL plus a
justification for the broad host permission (see the table above).

## Credit

Created by [@aldomanpi](https://github.com/aldomanpi).
