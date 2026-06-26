// Set the theme and UI scale before paint to avoid a flash.
// Must be an external file: MV3's default CSP (script-src 'self') blocks inline scripts.
(function () {
  const saved = localStorage.getItem('theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved || (sysDark ? 'dark' : 'light');

  // Font-size / UI scale (chosen in Options), applied via the --ui-scale var.
  const scale = localStorage.getItem('uiScale');
  if (scale) document.documentElement.style.setProperty('--ui-scale', scale);
})();
