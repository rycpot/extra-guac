// Highlight words: marks the words of the global list and this site's list on the page,
// and keeps up as the page changes (infinite scroll, in-app navigation, live updates).
//
// Uses Chrome's highlight API (CSS.highlights): text ranges are coloured without
// touching the page's HTML, so nothing can break and removing them is instant. Each list
// becomes one pattern built like a tree of shared beginnings, so a long list costs
// about as much as a short one. Work runs in small slices when the browser is idle and
// pauses while the tab is hidden. Lists live in storage.local "hl" (see bg-highlight.js).
(() => {
  if (window.__ttHl || !globalThis.CSS?.highlights || !globalThis.Highlight) return;
  window.__ttHl = true;

  const MAX_MARKS = 5000; // past this, colouring costs more than it helps
  const SLICE_MS = 8;
  const host = location.hostname.toLowerCase().replace(/^www\./, "");
  const covers = (s) => host === s || host.endsWith(`.${s}`);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE", "SELECT", "OPTION", "TITLE", "HEAD"]);

  let groups = []; // { name, color, re, marks: Highlight }
  let total = 0, signature = "";
  let nodeMarks = new WeakMap(); // text node → its ranges, so a changed node is redone
  const styled = new Set(); // document and open shadow roots carrying the colours

  // ---- Lists → patterns ----------------------------------------------------------------

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function pattern(words, partial) {
    const root = {};
    for (const w of words) {
      let n = root;
      for (const c of w.toLowerCase()) n = n[c] ??= {};
      n[""] = true;
    }
    const build = (n) => {
      const keys = Object.keys(n).filter(Boolean);
      if (!keys.length) return "";
      const alts = keys.map((k) => esc(k) + build(n[k]));
      const s = alts.length > 1 ? `(?:${alts.join("|")})` : alts[0];
      return n[""] ? `(?:${s})?` : s;
    };
    // Whole words: no letter, digit or underscore right before or after. Partial: anywhere.
    return partial ? new RegExp(build(root), "giu") : new RegExp(`(?<![\\p{L}\\p{N}_])${build(root)}(?![\\p{L}\\p{N}_])`, "giu");
  }

  // The lists that apply to this page: this site's own list (drawn on top), then global.
  function listsFor(hl) {
    if (!hl?.enabled) return [];
    const out = [];
    const siteKey = Object.keys(hl.sites || {}).filter(covers).sort((a, b) => b.length - a.length)[0];
    const site = siteKey && hl.sites[siteKey];
    if (site?.on && site.words?.length) out.push({ name: "tt-hl-site", color: site.color, partial: !!site.partial, words: site.words });
    if (hl.global?.on && hl.global.words?.length && !(hl.exclude || []).some(covers)) {
      out.push({ name: "tt-hl-global", color: hl.global.color, partial: !!hl.global.partial, words: hl.global.words });
    }
    return out;
  }

  // ---- Colours ---------------------------------------------------------------------------

  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "") || [0, "ffd60a"];
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  // Under the extension's dark mode the page is drawn through invert(.93) then
  // hue-rotate(180deg) (dark.css). Working that filter backwards gives the colour to set
  // so that what shows on screen is the colour chosen.
  const HUE180 = [[-0.574, 1.43, 0.144], [0.426, 0.43, 0.144], [0.426, 1.43, -0.856]];
  const INV = 0.93;
  function inverse3(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [[A, -(b * i - c * h), b * f - c * e], [B, a * i - c * g, -(a * f - c * d)], [C, -(a * h - b * g), a * e - b * d]].map((r) => r.map((x) => x / det));
  }
  const HUE180_INV = inverse3(HUE180);
  // Not every colour can come out of that filter (a vivid yellow can't): then the nearest
  // one that can, same hue, paler first and only then a little darker.
  const beforeFilter = (c) => {
    const t = c.map((v) => v / 255);
    const grey = (t[0] + t[1] + t[2]) / 3;
    const undo = (x) => HUE180_INV.map((r) => r[0] * x[0] + r[1] * x[1] + r[2] * x[2]); // undo hue-rotate
    const lo = 1 - INV, hi = INV; // what invert(.93) can give
    for (const dim of [1, 0.95, 0.9, 0.85, 0.8, 0.7]) {
      for (let sat = 1; sat >= 0.35; sat -= 0.05) {
        const u = undo(t.map((v) => dim * (grey + sat * (v - grey))));
        if (u.every((v) => v >= lo - 1e-6 && v <= hi + 1e-6)) return u.map((v) => Math.round(255 * Math.max(0, Math.min(1, (v - INV) / (1 - 2 * INV)))));
      }
    }
    return c.map((v) => 255 - v);
  };

  function shown(hex) {
    const c = rgb(hex);
    const light = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.55;
    const text = light ? [0, 0, 0] : [255, 255, 255];
    const inverted = /invert/.test(getComputedStyle(document.documentElement).filter);
    const [bg, fg] = inverted ? [beforeFilter(c), beforeFilter(text)] : [c, text];
    return { bg: `rgb(${bg.join(" ")})`, fg: `rgb(${fg.join(" ")})` };
  }

  function css() {
    return groups.map((g) => {
      const c = shown(g.color);
      return `::highlight(${g.name}) { background-color: ${c.bg}; color: ${c.fg}; }`;
    }).join("\n");
  }

  // The colours as a stylesheet in the page, and in each open shadow root (page styles
  // don't reach into those).
  function style(scope) {
    const text = css();
    let el = scope === document ? document.getElementById("tt-hl-style") : scope.querySelector(":scope > style[data-tt-hl]");
    if (!el) {
      el = document.createElement("style");
      el.dataset.ttHl = "";
      if (scope === document) el.id = "tt-hl-style";
      (scope === document ? document.head || document.documentElement : scope).append(el);
    }
    if (el.textContent !== text) el.textContent = text;
    styled.add(scope);
  }

  // ---- Scanning --------------------------------------------------------------------------

  const queue = []; // TreeWalkers still to go through
  let scheduled = false;

  function accept(node) {
    if (node.nodeType === 1) {
      if (SKIP.has(node.tagName) || node.isContentEditable) return NodeFilter.FILTER_REJECT;
      if (node.shadowRoot && !styled.has(node.shadowRoot)) { enterShadow(node.shadowRoot); enter(node.shadowRoot); }
      return NodeFilter.FILTER_SKIP;
    }
    return node.data.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
  }

  function enter(root) {
    if (!groups.length) return;
    queue.push(document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, accept));
    schedule();
  }

  function enterShadow(shadow) {
    if (styled.has(shadow)) return;
    style(shadow);
    observer.observe(shadow, OBSERVE);
  }

  function mark(text) {
    unmark(text);
    if (total >= MAX_MARKS) return;
    const ranges = [];
    for (const g of groups) {
      g.re.lastIndex = 0;
      for (const m of text.data.matchAll(g.re)) {
        if (total >= MAX_MARKS) break;
        const r = new Range();
        r.setStart(text, m.index);
        r.setEnd(text, m.index + m[0].length);
        g.marks.add(r);
        ranges.push([g, r]);
        total++;
      }
    }
    if (ranges.length) nodeMarks.set(text, ranges);
  }

  function unmark(text) {
    const ranges = nodeMarks.get(text);
    if (!ranges) return;
    for (const [g, r] of ranges) if (g.marks.delete(r)) total--;
    nodeMarks.delete(text);
  }

  function schedule() {
    if (scheduled || document.hidden || !queue.length) return;
    scheduled = true;
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 50)))(work, { timeout: 500 });
  }

  function work() {
    scheduled = false;
    if (document.hidden) return;
    if (!document.getElementById("tt-hl-style")) style(document); // the page replaced <head>
    const end = performance.now() + SLICE_MS;
    while (queue.length && performance.now() < end) {
      const walker = queue[0];
      let node, n = 0;
      while ((node = walker.nextNode())) {
        mark(node);
        if (++n % 50 === 0 && performance.now() >= end) break;
      }
      if (!node) queue.shift();
    }
    schedule();
  }

  // Ranges of text that left the page are dropped now and then, so the count stays true.
  let lastPrune = 0;
  function prune(force = false) {
    if (!force && performance.now() - lastPrune < 2000) return;
    lastPrune = performance.now();
    for (const g of groups) {
      // Text the page replaced: the range is left empty or points at text that's gone.
      for (const r of g.marks) if (r.collapsed || !r.startContainer.isConnected) { g.marks.delete(r); total--; }
    }
  }

  // ---- Page changes ----------------------------------------------------------------------

  const OBSERVE = { childList: true, subtree: true, characterData: true };
  const changed = new Set();
  let changeTimer = 0;
  const observer = new MutationObserver((records) => {
    if (!groups.length) return;
    for (const rec of records) {
      if (rec.type === "characterData") changed.add(rec.target);
      else for (const n of rec.addedNodes) if (n.nodeType === 1 || n.nodeType === 3) changed.add(n);
    }
    if (!changeTimer) changeTimer = setTimeout(flush, 200);
  });

  function flush() {
    changeTimer = 0;
    if (!groups.length) return changed.clear();
    prune();
    for (const n of changed) {
      if (!n.isConnected) continue;
      if (n.nodeType === 3) {
        const p = n.parentElement;
        if (p && !SKIP.has(p.tagName) && !p.isContentEditable && n.data.trim().length > 1) mark(n);
        else unmark(n);
      } else enter(n);
    }
    changed.clear();
    schedule();
  }

  // ---- Settings ----------------------------------------------------------------------------

  function clear() {
    for (const g of groups) { g.marks.clear(); CSS.highlights.delete(g.name); }
    groups = [];
    total = 0;
    nodeMarks = new WeakMap();
    changed.clear();
    queue.length = 0;
    for (const scope of styled) (scope === document ? document.getElementById("tt-hl-style") : scope.querySelector(":scope > style[data-tt-hl]"))?.remove();
    styled.clear();
  }

  function apply(hl) {
    const lists = listsFor(hl);
    const sig = JSON.stringify(lists);
    if (sig === signature) return;
    signature = sig;
    clear();
    if (!lists.length) return observer.disconnect();
    groups = lists.map((l, i) => {
      const marks = new Highlight();
      marks.priority = lists.length - i; // the site's own list wins where both match
      CSS.highlights.set(l.name, marks);
      return { name: l.name, color: l.color, re: pattern(l.words, l.partial), marks };
    });
    style(document);
    observer.disconnect();
    observer.observe(document.documentElement, OBSERVE);
    if (document.body) enter(document.body);
  }

  // Dark mode switching on or off changes how colours have to be drawn.
  new MutationObserver(() => groups.length && [...styled].forEach(style))
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-tt-dark"] });

  document.addEventListener("visibilitychange", schedule);

  // For the popup: how many marks are on the page now.
  window.__ttHlCount = () => (prune(true), total);

  chrome.storage.local.get("hl").then(({ hl }) => apply(hl));
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c.hl && chrome.runtime?.id) apply(c.hl.newValue);
  });
})();
