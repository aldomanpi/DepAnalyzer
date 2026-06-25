(async () => {
  const keyInput   = document.getElementById('api-key');
  const saveBtn    = document.getElementById('save-key');
  const keyFlash   = document.getElementById('key-flash');
  const clearBtn   = document.getElementById('clear-cache');
  const cacheFlash = document.getElementById('cache-flash');
  const cacheStat  = document.getElementById('cache-size');

  // Load saved key
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) keyInput.value = apiKey;

  // Load cache size
  async function refreshCacheSize() {
    const resp = await chrome.runtime.sendMessage({ type: 'getCacheStats' });
    cacheStat.textContent = resp?.size ?? '?';
  }
  refreshCacheSize();

  function flash(el, cls, msg) {
    el.className = `flash ${cls}`;
    el.textContent = msg;
    setTimeout(() => { el.className = 'flash'; el.textContent = ''; }, 3000);
  }

  // Save key
  saveBtn.addEventListener('click', async () => {
    const val = keyInput.value.trim();
    if (!val) { flash(keyFlash, 'error', 'Please enter an API key.'); return; }
    if (!val.startsWith('sk-')) {
      flash(keyFlash, 'error', 'Key should start with \'sk-\'.'); return;
    }
    await chrome.storage.local.set({ apiKey: val });
    flash(keyFlash, 'success', 'API key saved.');
  });

  // Clear cache
  clearBtn.addEventListener('click', async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'clearCache' });
    if (resp?.ok) {
      flash(cacheFlash, 'success', 'Cache cleared.');
      cacheStat.textContent = '0';
    } else {
      flash(cacheFlash, 'error', resp?.error || 'Failed to clear cache.');
    }
  });
})();
