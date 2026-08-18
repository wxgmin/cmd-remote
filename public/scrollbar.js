// scrollbar.js — visual-only scrollbar indicator.
// Shows a slim thumb on the right edge of a scrollable element while content
// overflows. Purely decorative: it NEVER intercepts touches, so native
// swipe/momentum scrolling always works. Fades out after scrolling stops.
(function () {
  const CSS = '.sbi{position:absolute;top:0;right:2px;width:4px;border-radius:2px;background:rgba(139,92,246,.55);pointer-events:none;opacity:0;transition:opacity .25s ease;z-index:30}';
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  function makeIndicator() {
    const el = document.createElement('div');
    el.className = 'sbi';
    document.body.appendChild(el);
    return el;
  }

  // Creates a controller bound to one scrollable element.
  // Usage: const sb = ScrollbarIndicator.bind(el); sb.update(); (call after
  // content changes); sb.destroy(); (on page switch).
  function bind(el) {
    if (!el) return null;
    const ind = makeIndicator();
    let hideTimer = null;

    function place() {
      const r = el.getBoundingClientRect();
      ind.style.top = (r.top + 4) + 'px';
      ind.style.height = Math.max(24, r.height - 8) + 'px';
      ind.style.right = (window.innerWidth - r.right + 2) + 'px';
    }

    function update() {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) { ind.style.opacity = '0'; return; }
      const ratio = el.scrollTop / max;
      const h = Math.max(24, el.clientHeight * (el.clientHeight / el.scrollHeight));
      place();
      ind.style.height = h + 'px';
      ind.style.top = (el.getBoundingClientRect().top + 4 + ratio * (el.clientHeight - h - 8)) + 'px';
      ind.style.opacity = '1';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { ind.style.opacity = '0'; }, 700);
    }

    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    // Track content changes (e.g. xterm writes, image loads).
    const ro = new ResizeObserver(update);
    try { ro.observe(el); } catch {}

    return {
      update,
      destroy() {
        clearTimeout(hideTimer);
        el.removeEventListener('scroll', update);
        window.removeEventListener('resize', update);
        try { ro.disconnect(); } catch {}
        ind.remove();
      },
    };
  }

  window.ScrollbarIndicator = { bind };
})();
