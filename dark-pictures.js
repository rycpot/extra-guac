// Dark mode's background pictures, for dark.js (the page) and dark-frame.js (frames
// embedded in it). An element whose stylesheet gives it a background picture is marked
// (data-tt-dark-media) so dark.css flips it back like <img>; a picture on its ::before or
// ::after marks just that part (data-tt-dark-before/-after). SVG images (mostly logos
// and icons drawn in one dark color) stay inverted so they don't vanish on the dark page.
//
// Pictures turn up late: lazy loading sets a class or style when an element scrolls into
// view, and stylesheets load after the page has started. So changed elements are looked
// at again (in batches), the whole page after a new stylesheet and a few times early on,
// and every mark is checked again each time: an element that loses its picture, grows to
// page size or comes to hold a <canvas> is unmarked.
(() => {
  if (window.__ttDarkPictures) return;

  const PICTURE = /url\((?!["']?data:image\/svg)/;
  // Elements that can't show a background picture of their own (SVG drawing parts are
  // most of the elements on icon-heavy pages).
  const ALL = "*:not(svg *, svg, script, style, link, meta, title, noscript, template, br, wbr, option, source, track)";
  const SOME = 3000; // changed elements looked at one by one; more than that is a whole-page pass
  const WHOLE_EVERY = 2000; // ms between whole-page passes, at least (30× what the last one took)
  const SLICE = 8; // ms of work before letting the page run, after the first pass

  window.__ttDarkPictures = (onAdded) => {
    const root = document.documentElement;

    // Page-sized boxes (body, html, full-page wrappers) are never flipped back as a whole:
    // that would undo the dark mode for everything inside them.
    const pageSized = (el) => {
      if (el === root || el === document.body) return true;
      const r = el.getBoundingClientRect();
      return r.width >= innerWidth * 0.9 && r.height >= innerHeight;
    };
    const has = (style) => { const bg = style.backgroundImage; return !!bg && bg !== "none" && PICTURE.test(bg); };
    const flag = (el, name, on) => { if (el.hasAttribute(name) !== on) el.toggleAttribute(name, on); };

    // A <canvas> is page content (documents, grids, charts) that stays dark with the page;
    // flipping back a box around one would turn it light again.
    function canvasHolders() {
      const out = new Set();
      for (const canvas of document.querySelectorAll("canvas")) {
        for (let el = canvas.parentElement; el && !out.has(el); el = el.parentElement) out.add(el);
      }
      return out;
    }

    function mark(el, holders) {
      if (el.localName === "img") {
        flag(el, "data-tt-dark-keep", /\.svg(\?|#|$)/i.test(el.currentSrc || el.src));
        return;
      }
      flag(el, "data-tt-dark-media", has(getComputedStyle(el)) && !holders.has(el) && !pageSized(el));
      flag(el, "data-tt-dark-before", has(getComputedStyle(el, "::before")));
      flag(el, "data-tt-dark-after", has(getComputedStyle(el, "::after")));
    }

    // Every element marked so far, then the given ones (or the whole page). The first pass
    // runs in one go, before the page is shown; later ones in slices between the page's
    // own work, so a big page doesn't stutter.
    let nextWhole = 0, busy = false;
    const pause = () => (window.scheduler?.yield ? scheduler.yield() : new Promise((r) => setTimeout(r)));
    async function pass(els, sliced = true) {
      const holders = canvasHolders();
      const all = !els;
      if (all) els = root.querySelectorAll(ALL); // not <html> itself: its picture is dark.js's (pagePicture)
      let work = 0, from = performance.now(), n = 0;
      for (const el of [...root.querySelectorAll("[data-tt-dark-media]"), ...els]) {
        if (el.isConnected) mark(el, holders);
        if (sliced && ++n % 64 === 0 && performance.now() - from > SLICE) {
          work += performance.now() - from;
          await pause();
          from = performance.now();
        }
      }
      work += performance.now() - from;
      if (all) nextWhole = performance.now() + Math.max(WHOLE_EVERY, 30 * work);
    }

    // Changes are gathered and looked at a moment later, at most every quarter second (an
    // animation can change a style every frame).
    const changed = new Set();
    let whole = false, timer = 0;
    function later(ms = 250) {
      if (!timer) timer = setTimeout(run, ms);
    }
    async function run() {
      timer = 0;
      if (busy) return later(); // a pass is still going
      busy = true;
      try { await gather(); } finally { busy = false; }
    }
    function gather() {
      const els = new Set();
      for (const el of changed) {
        if (!el.isConnected) continue;
        if (el !== root && el.matches(ALL)) els.add(el);
        for (const d of el.querySelectorAll(ALL)) { els.add(d); if (els.size > SOME) break; }
        if (els.size > SOME) break;
      }
      changed.clear();
      if (whole || els.size > SOME) {
        const wait = nextWhole - performance.now();
        if (wait > 0) { whole = true; return later(wait); }
        whole = false;
        return pass();
      }
      return pass(els);
    }
    const sheet = (n) => n.localName === "style" || (n.localName === "link" && /stylesheet/i.test(n.rel));
    const observer = new MutationObserver((records) => {
      let added = 0;
      for (const r of records) {
        if (r.type === "attributes") { changed.add(r.target); continue; }
        if (r.target.localName === "style") { whole = true; continue; } // CSS written into a <style>
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          added++;
          if (!sheet(n)) changed.add(n);
          else {
            whole = true; // a new stylesheet can give any element a picture
            if (n.localName === "link") n.addEventListener("load", () => { whole = true; later(); }, { once: true });
          }
        }
      }
      if (changed.size || whole) later();
      if (added >= 15) onAdded?.();
    });

    return {
      start() {
        pass(null, false);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
        for (const t of [1000, 2500, 5000]) setTimeout(() => { whole = true; later(0); }, t);
      },
      // Everything again (late stylesheets: after the page has loaded).
      again() { whole = true; later(0); },
    };
  };
})();
