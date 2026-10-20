// Applies the saved UI language before first paint to avoid an RTL/LTR flash.
(function () {
  try {
    var l = window.localStorage.getItem('wf_locale');
    if (l === 'en' || l === 'ar') {
      document.documentElement.lang = l;
      document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    }
  } catch {
    /* storage unavailable */
  }
})();
