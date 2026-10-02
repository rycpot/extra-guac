// Dark mode, in the page alongside dark.css (top frame of sites where it's on):
// - pages that are already dark are left alone ("off") and reported, so they're skipped
//   from then on;
// - elements whose stylesheet gives them a background picture are marked so dark.css
//   flips them back like <img>; SVG images (mostly logos and icons drawn in one dark
//   colour) stay inverted so they don't vanish on the dark page.
(() => {
  if (window.__ttDark) return;
  window.__ttDark = true;
  const root = document.documentElement;

  // ---- Already dark? -------------------------------------------------------------

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
  // Light text on a dark page means the site is dark already.
  function alreadyDark() {
    const bg = luminance(pageColor());
    const text = luminance(rgb(getComputedStyle(document.body || root).color));
    return bg < 0.35 && text > bg;
  }

  // Stays darkened (inverted) if the site was switched on on purpose.
  let checked = false;
  function check() {
    if (checked || !document.body) return;
    checked = true;
    if (!alreadyDark()) return;
    chrome.runtime.sendMessage({ type: "darkNative" }).then((r) => {
      if (!r?.keep) root.setAttribute("data-tt-dark", "off");
    }, () => root.setAttribute("data-tt-dark", "off"));
  }

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
    if (root.getAttribute("data-tt-dark") === "off") return;
    markTree(root);
    observer.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  // Late stylesheets can change the page colour; look once more when everything has loaded.
  addEventListener("load", () => { checked = false; check(); }, { once: true });
})();
