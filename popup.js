import { getRegisteredDomain } from './lib/domainUtils.js';

// ── Theme ──────────────────────────────────────────────────
const themeToggle = document.getElementById('theme-toggle');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === 'dark' ? '☀' : '🌙';
}

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  if (!localStorage.getItem('theme')) applyTheme(e.matches ? 'dark' : 'light');
});

applyTheme(document.documentElement.dataset.theme || 'light');

// ── Options button ───────────────────────────────────────────
document.getElementById('options-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Elements ────────────────────────────────────────────────
const tabUrlEl            = document.getElementById('tab-url');
const startBtn            = document.getElementById('start-btn');
const stopBtn             = document.getElementById('stop-btn');
const resumeBtn           = document.getElementById('resume-btn');
const analyzeBtn          = document.getElementById('analyze-captured-btn');
const clearBtn            = document.getElementById('clear-btn');
const captureStatus       = document.getElementById('capture-status');
const subdomainToggle     = document.getElementById('subdomain-toggle');
const captureDetailsEl    = document.getElementById('capture-details');
const captureDetailsCount = document.getElementById('capture-details-count');
const captureDetailsBody  = document.getElementById('capture-details-body');
const domainsInput        = document.getElementById('domains-input');
const categBtn            = document.getElementById('categorize-btn');
const loading             = document.getElementById('loading');
const loadingTxt          = document.getElementById('loading-text');
const results             = document.getElementById('results');
const errorMsg            = document.getElementById('error-msg');
const summary             = document.getElementById('summary');
const copyBtn             = document.getElementById('copy-btn');
const depSects            = document.getElementById('dependency-sections');
const noiseSects          = document.getElementById('noise-sections');
const noiseBadge          = document.getElementById('noise-badge');

const CATEGORY_ICONS = { first_party: '🏠', cdn: '🔗', noise: '🔇' };

let activeTabId  = null;
let activeTabUrl = '';
let whitelistDomains = [];

// Live capture view state
let pollTimer = null;                 // setInterval handle while capturing
const expandedDomains = new Set();    // domains the user expanded (preserved across live re-renders)
let lastCaptureSig = '';              // skip rebuilds when nothing changed

// ── Manual entry toggle ──────────────────────────────────────
document.getElementById('manual-toggle-btn').addEventListener('click', () => {
  const panel = document.getElementById('manual-entry-panel');
  const btn   = document.getElementById('manual-toggle-btn');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  btn.setAttribute('aria-expanded', String(opening));
  btn.classList.toggle('open', opening);
  if (opening) clearError();
});

// ── Subdomain categorization toggle (persisted) ─────────────────
chrome.storage.local.get('subdomainMode').then(({ subdomainMode }) => {
  subdomainToggle.checked = !!subdomainMode;
});
subdomainToggle.addEventListener('change', () => {
  chrome.storage.local.set({ subdomainMode: subdomainToggle.checked });
});

// ── Capture state UI ───────────────────────────────────────────
function setCaptureUI(state) {
  // state: 'idle' | 'capturing' | 'stopped'
  startBtn.classList.toggle('hidden',   state !== 'idle');
  stopBtn.classList.toggle('hidden',    state !== 'capturing');
  resumeBtn.classList.toggle('hidden',  state !== 'stopped');
  analyzeBtn.classList.toggle('hidden', state !== 'stopped');
  clearBtn.classList.toggle('hidden',   state === 'idle');
  captureStatus.classList.toggle('hidden', state !== 'capturing');
}

// ── Error ──────────────────────────────────────────────────
function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}
function clearError() {
  errorMsg.classList.add('hidden');
  errorMsg.textContent = '';
}

// ── Live capture polling ────────────────────────────────────────
// While capturing, pull the full capture state on an interval so the
// details table (subdomains, request counts, URIs) updates in real time.
async function refreshCaptureDetails() {
  const resp = await chrome.runtime
    .sendMessage({ type: 'getCapture', tabId: activeTabId })
    .catch(() => null);
  if (resp?.capturing) renderCaptureDetails(resp.domains || []);
}

function startCapturePolling() {
  stopCapturePolling();
  pollTimer = setInterval(refreshCaptureDetails, 1000);
}

function stopCapturePolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Raw capture details table ──────────────────────────────────
function renderCaptureDetails(domains) {
  if (!domains.length) {
    captureDetailsEl.classList.add('hidden');
    lastCaptureSig = '';
    return;
  }
  captureDetailsCount.textContent = domains.length;
  captureDetailsEl.classList.remove('hidden');

  // Skip the rebuild (and avoid flicker / collapsing expanded rows) when
  // nothing changed since the last render.
  const sig = domains
    .map(d => `${d.domain}:${d.requestCount || 0}:${(d.subdomains || []).length}:${(d.urls || []).length}`)
    .sort()
    .join('|');
  if (sig === lastCaptureSig) return;
  lastCaptureSig = sig;

  captureDetailsBody.innerHTML = '';
  captureDetailsBody.appendChild(buildCaptureTable(domains));
}

function buildCaptureTable(domains) {
  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>Domain</th>
        <th>Subdomains seen</th>
        <th class="right">Requests</th>
      </tr>
    </thead>`;
  const tbody = document.createElement('tbody');

  // Sort by request count descending for easy scanning
  const sorted = [...domains].sort((a, b) => (b.requestCount || 0) - (a.requestCount || 0));

  for (const { domain, subdomains, requestCount, urls } of sorted) {
    const isOpen = expandedDomains.has(domain);
    const tr = document.createElement('tr');
    tr.className = 'domain-row' + (isOpen ? ' expanded' : '');
    const subs = (subdomains || []).length
      ? subdomains.join(', ')
      : '<span class="muted">—</span>';
    tr.innerHTML = `
      <td class="domain-cell">
        <span class="expand-icon">▸</span><strong>${esc(domain)}</strong>
      </td>
      <td class="sub-cell">${subs}</td>
      <td class="right">${requestCount || 0}</td>`;

    const detailRow = document.createElement('tr');
    detailRow.className = 'url-detail' + (isOpen ? '' : ' hidden');
    const detailCell = document.createElement('td');
    detailCell.colSpan = 3;
    const paths = (urls || []).map(u => {
      try { const p = new URL(u); return p.host + p.pathname + p.search + p.hash; } catch { return u; }
    });
    const listHtml = paths.length
      ? paths.map(p => `<div class="url-entry">${esc(p)}</div>`).join('')
      : '<div class="url-entry muted">No paths recorded.</div>';
    detailCell.innerHTML = `<div class="url-list">${listHtml}</div>`;
    detailRow.appendChild(detailCell);

    tr.addEventListener('click', () => {
      const open = tr.classList.toggle('expanded');
      detailRow.classList.toggle('hidden', !open);
      if (open) expandedDomains.add(domain);
      else expandedDomains.delete(domain);
    });
    tbody.appendChild(tr);
    tbody.appendChild(detailRow);
  }
  table.appendChild(tbody);
  return table;
}

// ── Init: get active tab ───────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { setCaptureUI('idle'); return; }
  activeTabId  = tab.id;
  activeTabUrl = tab.url || '';

  try {
    tabUrlEl.textContent = new URL(activeTabUrl).hostname;
  } catch {
    tabUrlEl.textContent = activeTabUrl || 'Unknown page';
  }

  const resp = await chrome.runtime.sendMessage({ type: 'getCapture', tabId: activeTabId });
  if (!resp) { setCaptureUI('idle'); return; }

  if (resp.capturing) {
    setCaptureUI('capturing');
    renderCaptureDetails(resp.domains || []);
    startCapturePolling();
  } else if (resp.domains?.length) {
    setCaptureUI('stopped');
    renderCaptureDetails(resp.domains);
  } else {
    setCaptureUI('idle');
  }
}

init().catch(console.error);

// ── Background messages ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tabId !== activeTabId) return;
  if (msg.type === 'newDomain') {
    // A newly-seen domain — refresh the live table immediately
    // instead of waiting for the next poll tick.
    refreshCaptureDetails();
  }
  if (msg.type === 'progress') {
    loadingTxt.textContent = msg.status;
  }
});

// ── Capture buttons ───────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  clearError();
  if (!activeTabUrl || /^(chrome|edge|about):/.test(activeTabUrl)) {
    showError('Cannot capture on browser internal pages.'); return;
  }
  expandedDomains.clear();
  lastCaptureSig = '';
  captureDetailsEl.classList.add('hidden');
  results.classList.add('hidden');
  await chrome.runtime.sendMessage({ type: 'startCapture', tabId: activeTabId, url: activeTabUrl });
  setCaptureUI('capturing');
  startCapturePolling();
});

stopBtn.addEventListener('click', async () => {
  stopCapturePolling();
  await chrome.runtime.sendMessage({ type: 'stopCapture', tabId: activeTabId });
  // Fetch the full capture state (with subdomains + URLs) and render details table
  const resp = await chrome.runtime.sendMessage({ type: 'getCapture', tabId: activeTabId });
  setCaptureUI('stopped');
  renderCaptureDetails(resp?.domains || []);
});

resumeBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'resumeCapture', tabId: activeTabId });
  setCaptureUI('capturing');
  startCapturePolling();
  refreshCaptureDetails();
});

clearBtn.addEventListener('click', async () => {
  stopCapturePolling();
  await chrome.runtime.sendMessage({ type: 'clearCapture', tabId: activeTabId });
  expandedDomains.clear();
  lastCaptureSig = '';
  captureDetailsEl.classList.add('hidden');
  setCaptureUI('idle');
  results.classList.add('hidden');
});

analyzeBtn.addEventListener('click', () => runAnalyzeCapture());

// ── Analyze captured domains with AI ───────────────────────────
// Expand one captured registered-domain entry into per-hostname entries.
// Uses the background's per-host request counts; falls back to deriving
// hosts from captured URLs/subdomains for captures made before hostCounts.
function expandToHosts({ domain, subdomains, requestCount, urls, hostCounts }, out) {
  const counts = hostCounts && Object.keys(hostCounts).length ? hostCounts : null;
  const hosts = new Set(counts ? Object.keys(counts) : (subdomains || []));
  if (!counts) {
    for (const u of urls || []) {
      try { hosts.add(new URL(u).hostname); } catch {}
    }
  }
  if (!hosts.size) hosts.add(domain);
  for (const h of hosts) {
    const hostUrls = (urls || []).filter(u => {
      try { return new URL(u).hostname === h; } catch { return false; }
    });
    out[h] = {
      subdomains: [],
      requestCount: counts ? (counts[h] || 0) : Math.max(hostUrls.length, 1),
      urls: hostUrls,
    };
  }
}

async function runAnalyzeCapture() {
  clearError();
  const resp = await chrome.runtime.sendMessage({ type: 'getCapture', tabId: activeTabId });
  if (!resp?.domains?.length) { showError('No domains captured yet.'); return; }

  const perHost = subdomainToggle.checked;
  const domainMap = {};
  for (const entry of resp.domains) {
    if (perHost) {
      expandToHosts(entry, domainMap);
    } else {
      const { domain, subdomains, requestCount, urls } = entry;
      domainMap[domain] = { subdomains, requestCount, urls };
    }
  }
  // Pass the stored targetRegistered directly — avoids URL re-parsing errors
  await runClassify(domainMap, resp.targetUrl || activeTabUrl, resp.targetRegistered || '', perHost);
}

// ── Manual URL categorization ─────────────────────────────────
const URL_RE      = /^https?:\/\//i;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.\-]*[a-zA-Z0-9])?$/;

function parseDomainList(text) {
  const seen = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const mdM = /^\[.*?\]\((https?:\/\/[^)]+)\)/.exec(line);
    if (mdM) {
      try { const h = new URL(mdM[1]).hostname; if (h) seen.set(h, null); } catch {}
      continue;
    }
    if (URL_RE.test(line)) {
      try { const h = new URL(line).hostname; if (h) seen.set(h, null); } catch {}
      continue;
    }
    if (HOSTNAME_RE.test(line) && line.includes('.')) seen.set(line, null);
  }
  return [...seen.keys()];
}

categBtn.addEventListener('click', async () => {
  clearError();
  const text = domainsInput.value.trim();
  if (!text) { showError('Please enter at least one domain.'); return; }
  const hostnames = parseDomainList(text);
  if (!hostnames.length) { showError('No valid domains found in input.'); return; }

  const perHost = subdomainToggle.checked;
  const domainMap = {};
  for (const h of hostnames) {
    if (perHost) {
      // Each hostname becomes its own entry — no grouping by registered domain
      domainMap[h] = { subdomains: [], requestCount: 1, urls: [`https://${h}`] };
      continue;
    }
    const reg = getRegisteredDomain(h) || h;
    if (!domainMap[reg]) domainMap[reg] = { subdomains: [], requestCount: 0, urls: [] };
    domainMap[reg].requestCount++;
    domainMap[reg].urls.push(`https://${h}`);
    if (h !== reg && !domainMap[reg].subdomains.includes(h)) domainMap[reg].subdomains.push(h);
  }

  await runClassify(domainMap, '', '', perHost);
});

// ── Common classify runner ─────────────────────────────────────
async function runClassify(domainMap, targetUrl, targetRegistered = '', perHost = false) {
  results.classList.add('hidden');
  loading.classList.remove('hidden');
  loadingTxt.textContent = 'Starting…';

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'classify',
      domainMap,
      targetUrl,
      targetRegistered,
      tabId: activeTabId,
    });
    if (!resp) { showError('No response from background worker.'); return; }
    if (resp.error) { showError(resp.error); return; }
    renderResults(resp, perHost);
  } catch (e) {
    showError('Error: ' + e.message);
  } finally {
    loading.classList.add('hidden');
  }
}

// ── Results rendering ──────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildTable(items, perHost = false) {
  const table = document.createElement('table');
  // In per-host (subdomain) mode each row IS a hostname, so the
  // "Subdomains seen" column is redundant — drop it for a cleaner view.
  table.innerHTML = perHost
    ? `
    <thead>
      <tr>
        <th>Subdomain</th>
        <th class="right">Requests</th>
      </tr>
    </thead>`
    : `
    <thead>
      <tr>
        <th>Domain</th>
        <th>Subdomains seen</th>
        <th class="right">Requests</th>
      </tr>
    </thead>`;
  const tbody = document.createElement('tbody');
  for (const item of items) {
    const tr = document.createElement('tr');
    tr.className = 'domain-row';
    const subs = item.subdomains.length
      ? item.subdomains.join(', ')
      : '<span class="muted">—</span>';
    const impactHtml = item.impact
      ? `<div class="domain-reason">${esc(item.impact)}</div>` : '';
    tr.innerHTML = `
      <td class="domain-cell">
        <span class="expand-icon">▸</span><strong>${esc(item.domain)}</strong>${impactHtml}
      </td>
      ${perHost ? '' : `<td class="sub-cell">${subs}</td>`}
      <td class="right">${item.request_count}</td>`;

    const detailRow = document.createElement('tr');
    detailRow.className = 'url-detail hidden';
    const detailCell = document.createElement('td');
    detailCell.colSpan = perHost ? 2 : 3;
    const paths = (item.urls || []).map(u => {
      try { const p = new URL(u); return p.host + p.pathname + p.search + p.hash; } catch { return u; }
    });
    const listHtml = paths.length
      ? paths.map(p => `<div class="url-entry">${esc(p)}</div>`).join('')
      : '<div class="url-entry muted">No paths recorded.</div>';
    detailCell.innerHTML = `<div class="url-list">${listHtml}</div>`;
    detailRow.appendChild(detailCell);

    tr.addEventListener('click', () => {
      const open = tr.classList.toggle('expanded');
      detailRow.classList.toggle('hidden', !open);
    });
    tbody.appendChild(tr);
    tbody.appendChild(detailRow);
  }
  table.appendChild(tbody);
  return table;
}

function buildSection(label, icon, items, isNoise, perHost = false) {
  const section = document.createElement('div');
  section.className = 'category-section' + (isNoise ? ' noise' : '');
  const header = document.createElement('div');
  header.className = 'category-header';
  header.innerHTML = `
    <span class="cat-icon">${icon}</span>
    <span class="cat-label">${label}</span>
    <span class="badge">${items.length}</span>`;
  section.appendChild(header);
  section.appendChild(buildTable(items, perHost));
  return section;
}

function renderResults(data, perHost = false) {
  depSects.innerHTML = '';
  noiseSects.innerHTML = '';
  whitelistDomains = [];

  const grouped      = {};
  const noisyGrouped = {};
  for (const item of data.results) {
    if (item.is_noise) {
      (noisyGrouped[item.category] = noisyGrouped[item.category] || []).push(item);
    } else {
      (grouped[item.category] = grouped[item.category] || []).push(item);
      whitelistDomains.push(item.domain);
    }
  }

  const catOrder = ['first_party', 'cdn'];
  const orderedCats = [
    ...catOrder.filter(c => grouped[c]),
    ...Object.keys(grouped).filter(c => !catOrder.includes(c)),
  ];
  for (const cat of orderedCats) {
    const items = grouped[cat];
    if (!items) continue;
    depSects.appendChild(buildSection(items[0].label, CATEGORY_ICONS[cat] || '❓', items, false, perHost));
  }

  let noiseCount = 0;
  for (const cat of Object.keys(noisyGrouped)) {
    const items = noisyGrouped[cat];
    noiseCount += items.length;
    noiseSects.appendChild(buildSection(items[0].label, CATEGORY_ICONS[cat] || '❓', items, true, perHost));
  }
  noiseBadge.textContent = noiseCount;

  const cleanCount = data.results.filter(r => !r.is_noise).length;
  const unitLabel  = perHost ? 'subdomain' : 'domain';
  summary.innerHTML =
    `Analyzed <strong>${esc(data.target)}</strong> — ` +
    `<strong>${cleanCount}</strong> meaningful + <strong>${noiseCount}</strong> noise ${unitLabel}(s)`;

  results.classList.remove('hidden');
}

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(whitelistDomains.join('\n')).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy whitelist'; }, 2000);
  });
});
