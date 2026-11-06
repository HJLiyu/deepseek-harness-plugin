// Injected only into the owned top-level page; never forwards page content.
(() => {
  if (location.hostname !== '127.0.0.1' || window !== window.top) return;
  const start = () => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    let previous = '';
    const report = () => {
      const requested = document.documentElement.dataset.theme;
      const mode = requested === 'dark' || requested === 'light' ? requested : 'auto';
      const theme = mode === 'dark' || mode === 'auto' && system.matches ? 'dark' : 'light';
      const signature = mode + ':' + theme;
      if (signature === previous) return;
      previous = signature;
      window.chrome.webview.postMessage({ type: 'appearance', mode, theme });
    };
    new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    system.addEventListener('change', report);
    report();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
