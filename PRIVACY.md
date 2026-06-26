# DepAnalyzer — Privacy Policy

_Last updated: 2026-06-26_

DepAnalyzer is a browser extension that helps you discover and categorize the
third-party domains a website depends on, for use in internet-filter / allowlist
management. This policy explains exactly what data the extension accesses, what
leaves your browser, and where it goes.

**Summary:** DepAnalyzer has no backend that we operate, collects no analytics,
and never sells or shares your data. Everything is stored locally in your
browser. The only data that leaves your machine is sent — at your initiation —
to the third-party services described below so the extension can do its job.

## What the extension accesses

- **Network request URLs, only while you are capturing.** When you click
  **Start Capture** on a tab, the extension observes the URLs of network
  requests made by that tab (via the `webRequest` API) in order to extract the
  domains and subdomains the site contacts. It records hostnames, per-domain
  request counts, and a small sample of request paths for your review. It does
  **not** read request bodies, response contents, cookies, headers, or form
  data. Capturing is off by default and runs only on the tab you explicitly
  start it on.
- **The active tab's URL**, to show which site you are analyzing.
- **Your Anthropic API key**, which you enter in Options. It is stored locally
  (`chrome.storage.local`) and is only ever sent to `api.anthropic.com`.

## Data that leaves your browser

When you run an analysis, the extension contacts these third parties. It sends
**domain names**, the target site's domain, and a small sample of the **request
paths** those domains served (see below) — never request bodies, response
contents, cookies, headers, or your broader browsing history.

1. **Anthropic API (`api.anthropic.com`).** The domains you are analyzing are
   sent to Anthropic's Claude API, using your own API key, to classify each one.
   To judge what a domain does on the page (e.g. serving a script/image vs an
   ads/tracking pixel), a short sample of the **request paths** observed for each
   domain is included — for example `/static/app.js` or `/ads/pixel.js`. **Query
   strings are stripped** (everything after `?`); only the path portion is sent.
   Your key is required and is sent only to Anthropic.
   See Anthropic's privacy policy: https://www.anthropic.com/legal/privacy
2. **DuckDuckGo Instant Answer API (`api.duckduckgo.com`).** Each domain name is
   sent to DuckDuckGo to fetch a short description used to improve
   classification. See: https://duckduckgo.com/privacy
3. **Direct connections to each captured domain.** To build a better
   description, the extension fetches the **homepage** of each newly-analyzed
   domain directly (an HTTPS `GET` to `https://<domain>/`) and reads only its
   `<title>` and `<meta name="description">`. This means **your browser connects
   directly to those domains from your IP address**, similar to visiting them.
   No cookies or credentials are attached, and only public homepage metadata is
   read. Results are cached locally so a given domain is contacted at most once.

The extension does **not** send data to any server operated by the developer.

## Data stored locally

- **API key** — `chrome.storage.local`, until you change or clear it.
- **Classification cache** — per-site domain → category results, stored locally
  so a domain isn't re-sent to the AI each time. You can clear it any time in Options
  ("Clear cache").
- **Capture data** — kept in session storage for the current browser session
  and cleared when the browser closes or when you click Clear.
- **Theme and font-size preferences** — stored in `localStorage`.

None of this is transmitted anywhere except as described above.

## Permissions and why they are needed

- `webRequest` + `<all_urls>` host access — to observe request URLs on whatever
  site you choose to capture. Broad host access is required because you may
  analyze any website, and because the homepage-metadata lookup above may
  contact any domain. The extension only acts when you start a capture or run an
  analysis.
- `storage` — to save your API key, cache, and capture state locally.
- `tabs` — to read the active tab's URL so it can be analyzed.

## Data sharing and retention

We do not collect, store on our servers, sell, or share your data — there is no
developer-operated server. Third-party processing by Anthropic and DuckDuckGo is
governed by their own policies (linked above). Locally stored data persists
until you clear it or remove the extension.

## Contact

Questions or requests: https://github.com/aldomanpi/DepAnalyzer-ext (open an
issue), or the developer at aldomanpi@gmail.com.
