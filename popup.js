import { getRegisteredDomain } from './lib/domainUtils.js';

// ── Theme ──────────────────────────────────────────────────────────
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

// ── Elements ────────────────────────────────────────────────────────
const tabUrlEl            = document.getElementById('tab-url');
const startBtn            = document.getElementById('start-btn');
const stopBtn             = document.getElementById('stop-btn');
const resumeBtn           = document.getElementById('resume-btn');
const analyzeBtn          = document.getElementById('analyze-captured-btn');
const clearBtn            = document.getElementById('clear-btn');
const captureStatus       = document.getElementById('capture-status');
const liveDiscovery       = document.getElementById('live-discovery');
const liveCount           = document.getElementById('live-count');
const liveList            = document.getElementById('live-list');
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

// ── Manual entry toggle ──────────────────────────────────────────
document.getElementById('manual-toggle-btn').addEventListener('click', () => {
  const panel = document.getElementById('manual-entry-panel');
  const btn   = document.getElementById('manual-toggle-btn');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  btn.setAttribute('aria-expanded', String(opening));
  btn.classList.toggle('open', opening);
  if (opening) clearError();
});

// ── Capture state UI ───────────────────────────────────────────────
function setCaptureUI(state) {
  // state: 'idle' | 'capturing' | 'stopped'
  startBtn.classList.toggle('hidden',   state !== 'idle');
  stopBtn.classList.toggle('hidden',    state !== 'capturing');
  resumeBtn.classList.toggle('hidden',  state !== 'stopped');
  analyzeBtn.classList.toggle('hidden', state !== 'stopped');
  clearBtn.classList.toggle('hidden',   state === 'idle');
  captureStatus.classList.toggle('hidden', state !== 'capturing');
  // Hide live chips when stopped (details table takes over)
  liveDiscovery.classList.toggle('hidden', state === 'stopped');
}

// ── Error ────────────────────────────────────────────────────────
function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}
function clearError() {
  errorMsg.classList.add('hidden');
  errorMsg.textContent = '';
}

// ── Live domain chip (during capture) ───────────────────────────────────
const knownDomains = new Set();

function addLiveChip(domain) {
  if (knownDomains.has(domain)) return;
  knownDomains.add(domain);
  const chip = document.createElement('span');
  chip.className = 'live-chip';
  chip.textContent = domain;
  liveList.appendChild(chip);
  liveCount.textContent = knownDomains.size;
}

// ── Raw capture details table ────────────────────────────────────────────
function renderCaptureDetails(domains) {
  if (!domains.length) {
    captureDetailsEl.classList.add('hidden');
    return;
  }
  captureDetailsCount.textContent = domains.length;
  captureDetailsBody.innerHTML = '';
  captureDetailsBody.appendChild(buildCaptureTable(domains));
  captureDetailsEl.classList.remove('hidden');
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
    const tr = document.createElement('tr');
    tr.className = 'domain-row';
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
    detailRow.className = 'url-detail hidden';
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
    });
    tbody.appendChild(tr);
    tbody.appendChild(detailRow);
  }
  table.appendChild(tbody);
  return table;
}

// ── Init: get active tab ───────────────────────────────────────────────
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

  for (const { domain } of (resp.domains || [])) addLiveChip(domain);

  if (resp.capturing) {
    if (resp.domains?.length) liveDiscovery.classList.remove('hidden');
    setCaptureUI('capturing');
  } else if (resp.domains?.length) {
    setCaptureUI('stopped');
    renderCaptureDetails(resp.domains);
  } else {
    setCaptureUI('idle');
  }
}

init().catch(console.error);

// ── Background messages ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tabId !== activeTabId) return;
  if (msg.type === 'newDomain') {
    addLiveChip(msg.domain);
    liveDiscovery.classList.remove('hidden');
  }
  if (msg.type === 'progress') {
    loadingTxt.textContent = msg.status;
  }
});

// ── Capture buttons ───────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  clearError();
  if (!activeTabUrl || /^(chrome|edge|about):/.test(activeTabUrl)) {
    showError('Cannot capture on browser internal pages.'); return;
  }
  knownDomains.clear();
  liveList.innerHTML = '';
  liveCount.textContent = '0';
  captureDetailsEl.classList.add('hidden');
  results.classList.add('hidden');
  await chrome.runtime.sendMessage({ type: 'startCapture', tabId: activeTabId, url: activeTabUrl });
  setCaptureUI('capturing');
  liveDiscovery.classList.remove('hidden');
});

stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stopCapture', tabId: activeTabId });
  // Fetch the full capture state (with subdomains + URLs) and render details table
  const resp = await chrome.runtime.sendMessage({ type: 'getCapture', tabId: activeTabId });
  setCaptureUI('stopped');
  renderCaptureDetails(resp?.domains || []);
});

resumeBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'resumeCapture', tabId: activeTabId });
  captureDetailsEl.classList.add('hidden');
  setCaptureUI('capturing');
  liveDiscovery.classList.remove('hidden');
});

clearBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCapture', tabId: activeTabId });
  knownDomains.clear();
  liveList.innerHTML = '';
  liveCount.textContent = '0';
  liveDiscovery.classList.add('hidden');
  captureDetailsEl.classList.add('hidden');
  setCaptureUI('idle');
  results.classList.add('hidden');
});

analyzeBtn.addEventListener('click', () => runAnalyzeCapture());

// ── Analyze captured domains with AI ───────────────────────────────────
async function runAnalyzeCapture() {
  clearError();
  const resp = await chrome.runtime.sendMessage({ type: 'getCapture', tabId: activeTabId });
  if (!resp?.domains?.length) { showError('No domains captured yet.'); return; }

  const domainMap = {};
  for (const { domain, subdomains, requestCount, urls } of resp.domains) {
    domainMap[domain] = { subdomains, requestCount, urls };
  }
  await runClassify(domainMap, resp.targetUrl || activeTabUrl);
}

// ── Manual URL categorization ─────────────────────────────────────────────
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

  const domainMap = {};
  for (const h of hostnames) {
    const reg = getRegisteredDomain(h) || h;
    if (!domainMap[reg]) domainMap[reg] = { subdomains: [], requestCount: 0, urls: [] };
    domainMap[reg].requestCount++;
    domainMap[reg].urls.push(`https://${h}`);
    if (h !== reg && !domainMap[reg].subdomains.includes(h)) domainMap[reg].subdomains.push(h);
  }

  await runClassify(domainMap, '');
});

// ── Common classify runner ───────────────────────────────────────────────
async function runClassify(domainMap, targetUrl) {
  results.classList.add('hidden');
  loading.classList.remove('hidden');
  loadingTxt.textContent = 'Starting…';

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'classify',
      domainMap,
      targetUrl,
      tabId: activeTabId,
    });
    if (!resp) { showError('No response from background worker.'); return; }
    if (resp.error) { showError(resp.error); return; }
    renderResults(resp);
  } catch (e) {
    showError('Error: ' + e.message);
  } finally {
    loading.classList.add('hidden');
  }
}

// ── Results rendering ──────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildTable(items) {
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
      <td class="sub-cell">${subs}</td>
      <td class="right">${item.request_count}</td>`;

    const detailRow = document.createElement('tr');
    detailRow.className = 'url-detail hidden';
    const detailCell = document.createElement('td');
    detailCell.colSpan = 3;
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

function buildSection(label, icon, items, isNoise) {
  const section = document.createElement('div');
  section.className = 'category-section' + (isNoise ? ' noise' : '');
  const header = document.createElement('div');
  header.className = 'category-header';
  header.innerHTML = `
    <span class="cat-icon">${icon}</span>
    <span class="cat-label">${label}</span>
    <span class="badge">${items.length}</span>`;
  section.appendChild(header);
  section.appendChild(buildTable(items));
  return section;
}

function renderResults(data) {
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
    depSects.appendChild(buildSection(items[0].label, CATEGORY_ICONS[cat] || '❓', items, false));
  }

  let noiseCount = 0;
  for (const cat of Object.keys(noisyGrouped)) {
    const items = noisyGrouped[cat];
    noiseCount += items.length;
    noiseSects.appendChild(buildSection(items[0].label, CATEGORY_ICONS[cat] || '❓', items, true));
  }
  noiseBadge.textContent = noiseCount;

  const cleanCount = data.results.filter(r => !r.is_noise).length;
  summary.innerHTML =
    `Analyzed <strong>${esc(data.target)}</strong> — ` +
    `<strong>${cleanCount}</strong> meaningful + <strong>${noiseCount}</strong> noise`;

  results.classList.remove('hidden');
}

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(whitelistDomains.join('\n')).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy whitelist'; }, 2000);
  });
});
