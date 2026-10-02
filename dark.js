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
  // Background colours count as solid colours or the average of a gradient. A picture
  // ("url(…)") says nothing usable about brightness, so it's skipped. Some sites put a
  // dark colour on body and then cover nearly all of it with light content (or a light
  // picture), so the page's own background colour alone can't be trusted.
  function backgroundLight(cs) {
    const img = cs.backgroundImage;
    if (img && img !== "none" && /url\(/.test(img)) return undefined; // picture: unknown
    const c = rgb(cs.backgroundColor);
    if (c.length >= 3 && (c[3] ?? 1) > 0.5) return luminance(c);
    if (img && img !== "none") {
      const stops = (img.match(/rgba?\([^)]*\)/g) || []).map(rgb).filter((s) => s.length >= 3 && (s[3] ?? 1) > 0.5);
      if (stops.length) return stops.reduce((sum, s) => sum + luminance(s), 0) / stops.length;
    }
    return null; // transparent: look further back
  }
  // What is actually painted at a point of the screen: the first element under it (or
  // behind it) with a background. Transparent all the way down = white.
  function lightAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    // A drawing surface, video or picture: its pixels can't be read, so it says nothing.
    if (hit && /^(canvas|video|img|picture|iframe|embed|object)$/.test(hit.localName)) return undefined;
    for (let el = hit; el; el = el.parentElement) {
      // Below a short body the page shows body's colour (dark.css's white on html is ours).
      if (el === root && document.body) {
        const l = backgroundLight(getComputedStyle(document.body));
        if (l !== null) return l;
      }
      const l = backgroundLight(getComputedStyle(el));
      if (l !== null) return l; // a number, or undefined for a picture
    }
    return 1;
  }
  // Light text, weighted by how much of it there is (sampled), 0–1.
  function textLight() {
    let total = 0, light = 0;
    const els = document.body.querySelectorAll("p, li, a, span, td, h1, h2, h3, h4, div");
    for (let i = 0; i < els.length && total < 4000; i += Math.max(1, Math.floor(els.length / 400))) {
      const el = els[i], len = el.firstChild?.nodeType === 3 ? el.firstChild.data.trim().length : 0;
      if (!len) continue;
      total += len;
      if (luminance(rgb(getComputedStyle(el).color)) > 0.6) light += len;
    }
    return total ? light / total : 0;
  }
  // Dark when most of what's on screen is dark: a 7×6 grid of points over the viewport.
  // Too few readable points (pictures everywhere) or a split screen: decide by the text.
  function alreadyDark() {
    let dark = 0, known = 0;
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 6; j++) {
        const l = lightAt(innerWidth * (i + 0.5) / 7, innerHeight * (j + 0.5) / 6);
        if (l === undefined) continue;
        known++;
        if (l < 0.4) dark++;
      }
    }
    const share = known ? dark / known : 0;
    if (known >= 10 && (share >= 0.65 || share <= 0.35)) return share >= 0.65;
    return textLight() > 0.6;
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
  // Apps build their page after loading (often over a loading screen of another colour),
  // so look again a few times early on and whenever a lot of new content appears.
  let lastBig = 0;
  function bigChange() {
    const now = Date.now();
    if (now - lastBig < 2000) return;
    lastBig = now;
    setTimeout(check, 300);
  }
  window.navigation?.addEventListener("navigatesuccess", recheck);
  setInterval(() => location.pathname !== page && recheck(), 1000);
  const themeWatch = new MutationObserver(recheck);

  // ---- Background pictures ---------------------------------------------------------

  const PICTURE = /url\((?!["']?data:image\/svg)/;
  // Page-sized boxes (body, html, full-page wrappers) are never flipped back as a whole:
  // that would undo the dark mode for everything inside them.
  const pageSized = (el) => {
    if (el === root || el === document.body) return true;
    const r = el.getBoundingClientRect();
    return r.width >= innerWidth * 0.9 && r.height >= innerHeight;
  };
  function mark(el) {
    if (el.nodeType !== 1 || el.hasAttribute("data-tt-dark-media") || pageSized(el)) return;
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
        if (batch.length >= 15) bigChange();
      });
    }
  });

  // The page's own background picture goes to its own layer (dark.css, html::before).
  function pagePicture() {
    for (const el of [document.body, root]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (!PICTURE.test(cs.backgroundImage)) continue;
      const colour = [document.body, root].map((e) => e && getComputedStyle(e).backgroundColor)
        .find((c) => c && (rgb(c)[3] ?? 1) > 0.5) || "#fff";
      for (const [name, value] of [["color", colour], ["image", cs.backgroundImage], ["position", cs.backgroundPosition],
        ["size", cs.backgroundSize], ["repeat", cs.backgroundRepeat]]) root.style.setProperty(`--tt-dark-bg-${name}`, value);
      root.setAttribute("data-tt-dark-bg", "");
      return;
    }
  }

  function start() {
    pagePicture();
    check();
    for (const t of [300, 1000, 2500, 5000]) setTimeout(check, t);
    markTree(root);
    observer.observe(root, { childList: true, subtree: true });
    const theme = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode", "data-dark-theme"] };
    themeWatch.observe(root, theme);
    if (document.body) themeWatch.observe(document.body, theme);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  // Late stylesheets can change the page colour; look once more when everything has loaded.
  addEventListener("load", () => { if (!root.hasAttribute("data-tt-dark-bg")) pagePicture(); recheck(); }, { once: true });
})();
