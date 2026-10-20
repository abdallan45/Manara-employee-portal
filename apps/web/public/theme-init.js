// Applies the saved light / dark theme before first paint (dark is the default), so a light choice never
// flashes dark. lib/theme.tsx takes over after load. Same storage key as THEME_STORAGE_KEY there.
(function () {
  try {
    if (window.localStorage.getItem('wf_theme') === 'light') {
      var el = document.documentElement;
      el.setAttribute('data-theme', 'light');
      el.classList.remove('dark');
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', '#f5f5f9');
    }
  } catch {
    /* storage unavailable */
  }
})();
