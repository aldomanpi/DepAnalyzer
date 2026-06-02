// Set the theme before paint to avoid a flash of the wrong theme.
// Must be an external file: MV3's default CSP (script-src 'self') blocks inline scripts.
(function () {
  const saved = localStorage.getItem('theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved || (sysDark ? 'dark' : 'light');
})();
