// Dark mode, in the page alongside dark.css (top frame of sites where it's on):
// - pages that are already dark are left alone ("off"), page by page;
// - elements whose stylesheet gives them a background picture are marked so dark.css
//   flips them back like <img>; SVG images (mostly logos and icons drawn in one dark
//   colour) stay inverted so they don't vanish on the dark page.
(() => {
  if (window.__ttDark) return;
  window.__ttDark = true;
  const root = document.documentElement;

  // ---- Already dark? -------------------------------------------------------------
  // Decided per page, not per site (one dark page doesn't make a whole site dark). Pages
  // found dark are remembered in the site's own localStorage, which can be read before
  // the first paint, so a known dark page is never inverted, not even for a frame.

  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // The colour the page is painted on: body, then html; transparent means white.
  function pageColor() {
    for (const el of [document.body, root]) {
      if (!el) continue;
      const c = rgb(getComputedStyle(el).backgroundColor);
      if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c;
    }
    return [255, 255, 255];
  }
  // Light text on a dark page means the page is dark already.
  function alreadyDark() {
    const bg = luminance(pageColor());
    const text = luminance(rgb(getComputedStyle(document.body || root).color));
    return bg < 0.35 && text > bg;
  }

  const KEY = "__ttDarkPages";
  const known = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  function remember(path, dark) {
    try {
      const list = known().filter((p) => p !== path);
      if (dark) list.push(path);
      localStorage.setItem(KEY, JSON.stringify(list.slice(-300)));
    } catch {} // storage blocked: just no head start next time
  }

  // "off" set here (page is dark) vs by the tools (site switched off): only undo our own.
  let selfOff = false;
  const setSelfOff = (on) => {
    if (on && !root.hasAttribute("data-tt-dark")) { root.setAttribute("data-tt-dark", "off"); selfOff = true; }
    if (!on && selfOff) { if (root.getAttribute("data-tt-dark") === "off") root.removeAttribute("data-tt-dark"); selfOff = false; }
  };

  let page = location.pathname;
  if (known().includes(page)) setSelfOff(true); // before the first paint

  // Stays inverted if the site is on the "darken anyway" list.
  let checking = false;
  function check() {
    if (checking || !document.body) return;
    const path = location.pathname, dark = alreadyDark();
    window.__ttDarkPage = dark;
    remember(path, dark);
    if (!dark) return setSelfOff(false);
    checking = true;
    chrome.runtime.sendMessage({ type: "darkNative" }).then(
      (r) => setSelfOff(!r?.keep),
      () => setSelfOff(true),
    ).finally(() => (checking = false));
  }

  // In-page navigation (one page of an app can be dark, the next light) and the site's
  // own theme switch: look again.
  function recheck() {
    if (location.pathname !== page) page = location.pathname;
    setTimeout(check, 50);
  }
  window.navigation?.addEventListener("navigatesuccess", recheck);
  setInterval(() => location.pathname !== page && recheck(), 1000);
  const themeWatch = new MutationObserver(recheck);

  // ---- Background pictures ---------------------------------------------------------

  const PICTURE = /url\((?!["']?data:image\/svg)/;
  function mark(el) {
    if (el.nodeType !== 1 || el.hasAttribute("data-tt-dark-media")) return;
    if (el.localName === "img") {
      if (/\.svg(\?|#|$)/i.test(el.currentSrc || el.src)) el.setAttribute("data-tt-dark-keep", "");
      return;
    }
    const bg = getComputedStyle(el).backgroundImage;
    if (bg !== "none" && PICTURE.test(bg)) el.setAttribute("data-tt-dark-media", "");
  }
  function markTree(node) {
    if (node.nodeType !== 1) return;
    mark(node);
    for (const el of node.querySelectorAll("*")) mark(el);
  }

  // Added content is looked at in batches, once per frame.
  let pending = [], scheduled = false;
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) pending.push(n);
    if (!scheduled && pending.length) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const batch = pending;
        pending = [];
        for (const n of batch) if (n.isConnected) markTree(n);
      });
    }
  });

  function start() {
    check();
    markTree(root);
    observer.observe(root, { childList: true, subtree: true });
    const theme = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode", "data-dark-theme"] };
    themeWatch.observe(root, theme);
    if (document.body) themeWatch.observe(document.body, theme);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  // Late stylesheets can change the page colour; look once more when everything has loaded.
  addEventListener("load", recheck, { once: true });
})();
