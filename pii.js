// Hides sensitive text on the page. "blur" and "bars" paint over text with the
// CSS Custom Highlight API (the DOM is untouched); "mask" swaps characters in the
// page's own text nodes (so the page's font/size/colour apply) and restores them
// on hover or when turned off. Form fields get an attribute styled by CSS.
(() => {
  if (window.__piiBlur) return;
  window.__piiBlur = true;

  const R = globalThis.PIIRules;
  const root = document.documentElement;
  const PENDING = "data-pii-pending"; // hides the page until the first scan (see pii.css)
  const FIELD = "data-pii-field";
  const BLOCKS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "BUTTON", "CAPTION", "DD", "DETAILS", "DIALOG",
    "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
    "H5", "H6", "HEADER", "HR", "HTML", "LEGEND", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
    "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
  ]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SVG", "HEAD"]);
  const FIELD_TYPES = new Set(["text", "email", "tel", "number", "search", "url"]);

  const highlight = new Highlight();
  const blockMatches = new Map(); // block element -> [{ range, segs: [[textNode, start, end]] }]
  const masked = new Map(); // textNode -> { orig, masked, shown }
  const customBlock = new WeakMap();
  const styleEl = document.createElement("style");
  let settings = null, compiled = [], active = false, observer = null, timer = 0;
  let revealed = null, pointer = { x: -1, y: -1, target: null }, moveQueued = false;

  if (document.readyState === "loading") root.setAttribute(PENDING, "");
  const reveal = () => root.removeAttribute(PENDING);

  chrome.storage.local.get("pii").then(({ pii }) => apply(pii), reveal);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pii) apply(changes.pii.newValue);
  });
  document.addEventListener("DOMContentLoaded", () => {
    if (!settings) return; // apply() will scan once settings arrive
    if (active) rescanAll();
    reveal();
  }, { once: true });

  function apply(raw) {
    try {
      settings = R.withDefaults(raw);
      if (!settings.enabled || R.isExcluded(location.hostname, settings.excludedSites)) return stop();
      compiled = R.compile(settings);
      styleEl.textContent = css(settings);
      if (!styleEl.isConnected) root.append(styleEl);
      CSS.highlights.set("pii", highlight);
      if (!active) start();
      if (document.readyState !== "loading") rescanAll();
      else if (settings.hideUntilScanned) return; // DOMContentLoaded scans, then reveals
    } catch (e) {
      console.error("[PII blur]", e);
    }
    reveal();
  }

  function css(s) {
    const color = /^#[0-9a-f]{6}$/i.test(s.barColor) ? s.barColor : "#000000";
    const px = Math.min(Math.max(+s.blurPx || 8, 1), 30);
    if (s.style === "mask") return `[${FIELD}]:not(:hover){-webkit-text-security:disc!important}`;
    return s.style === "bars"
      ? `::highlight(pii){color:${color};background-color:${color}}
         [${FIELD}]:not(:hover){color:transparent!important;-webkit-text-fill-color:transparent!important;background:${color}!important}`
      : `::highlight(pii){color:transparent;text-shadow:0 0 ${px}px rgba(128,128,128,.95)}
         [${FIELD}]:not(:hover){filter:blur(${Math.max(px / 2, 1.5)}px)!important}`;
  }

  function start() {
    active = true;
    observer = new MutationObserver(onMutations);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    document.addEventListener("mousemove", onMove, { capture: true, passive: true });
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("input", onInput, true);
    timer = setInterval(tick, 1000);
  }

  function stop() {
    reveal();
    if (!active) return;
    active = false;
    observer.disconnect();
    document.removeEventListener("mousemove", onMove, { capture: true });
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("input", onInput, true);
    clearInterval(timer);
    highlight.clear();
    blockMatches.clear();
    revealed = null;
    unmaskAll();
    CSS.highlights.delete("pii");
    styleEl.remove();
    document.querySelectorAll(`[${FIELD}]`).forEach((el) => el.removeAttribute(FIELD));
  }

  // ---- Scanning -----------------------------------------------------------

  function isBlock(el) {
    if (BLOCKS.has(el.tagName)) return true;
    if (!el.tagName.includes("-")) return false;
    let b = customBlock.get(el);
    if (b === undefined) customBlock.set(el, (b = !getComputedStyle(el).display.startsWith("inline")));
    return b;
  }

  function blockOf(node) {
    for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
      if (isBlock(el)) return el;
    }
    return document.body || root;
  }

  const isField = (el) =>
    el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && FIELD_TYPES.has(el.type));

  function rescanAll() {
    highlight.clear();
    blockMatches.clear();
    revealed = null;
    unmaskAll();
    if (document.body) scan(document.body);
  }

  function clearBlock(block) {
    const ms = blockMatches.get(block);
    if (!ms) return;
    for (const m of ms) {
      if (m.range) highlight.delete(m.range);
      if (m === revealed) revealed = null;
    }
    blockMatches.delete(block);
  }

  // Re-scans everything under `block`. Text is matched per visual block, so a
  // label and its value in separate inline elements still match together.
  function scan(block) {
    clearBlock(block);
    let group = null;
    const flush = () => {
      if (group) addMatches(group.block, matchGroup(group.nodes));
      group = null;
    };
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
        if (isField(n)) checkField(n);
        return SKIP.has(n.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if (n.tagName === "BR") flush();
        else if (isBlock(n)) { flush(); clearBlock(n); }
        continue;
      }
      if (!n.data.trim() && !group) continue;
      const b = blockOf(n);
      if (group && group.block !== b) flush();
      (group ??= { block: b, nodes: [] }).nodes.push(n);
    }
    flush();
  }

  function matchGroup(nodes) {
    const starts = [];
    let text = "";
    for (const t of nodes) { starts.push(text.length); text += textOf(t); }
    const matches = R.findMatches(text, compiled).map(([s, e]) => {
      const segs = [];
      nodes.forEach((n, k) => {
        const a = Math.max(s, starts[k]), b = Math.min(e, starts[k] + n.length);
        if (a < b) segs.push([n, a - starts[k], b - starts[k]]);
      });
      return { segs, range: settings.style === "mask" ? null : rangeOf(segs) };
    });
    if (settings.style === "mask") maskNodes(nodes, matches);
    return matches;
  }

  function rangeOf(segs) {
    const r = new Range();
    r.setStart(segs[0][0], segs[0][1]);
    r.setEnd(segs[segs.length - 1][0], segs[segs.length - 1][2]);
    return r;
  }

  function addMatches(block, matches) {
    if (!matches.length) return;
    const list = blockMatches.get(block) || [];
    for (const m of matches) { list.push(m); if (m.range) highlight.add(m.range); }
    blockMatches.set(block, list);
  }

  // ---- Mask mode ----------------------------------------------------------

  // The page's text as it was before we masked it.
  function textOf(node) {
    const st = masked.get(node);
    if (st && (node.data === st.masked || node.data === st.shown)) return st.orig;
    if (st) masked.delete(node); // the page replaced the text itself
    return node.data;
  }

  // Masks in place, one character for one character, so offsets never shift.
  function maskNodes(nodes, matches) {
    const segsByNode = new Map();
    for (const m of matches) for (const [n, a, b] of m.segs) {
      if (!segsByNode.has(n)) segsByNode.set(n, []);
      segsByNode.get(n).push([a, b]);
    }
    const ch = settings.maskChar?.length === 1 ? settings.maskChar : "×"; // one UTF-16 unit keeps offsets
    for (const n of nodes) {
      const orig = textOf(n);
      const chars = orig.split("");
      for (const [a, b] of segsByNode.get(n) || []) {
        for (let i = a; i < b; i++) if (!/\s/.test(chars[i])) chars[i] = ch;
      }
      const out = chars.join("");
      if (out === orig) masked.delete(n);
      else masked.set(n, { orig, masked: out, shown: null });
      write(n, out);
    }
  }

  function write(node, data) {
    if (node.data === data) return;
    node.data = data;
    observer?.takeRecords(); // our own edits must not trigger a rescan
  }

  function unmaskAll() {
    for (const [n, st] of masked) if (n.data === st.masked || n.data === st.shown) n.data = st.orig;
    masked.clear();
    observer?.takeRecords();
  }

  function showMatch(m) {
    if (m.range) return highlight.delete(m.range);
    for (const [n, a, b] of m.segs) {
      const st = masked.get(n);
      if (!st) continue;
      st.shown = st.masked.slice(0, a) + st.orig.slice(a, b) + st.masked.slice(b);
      write(n, st.shown);
    }
  }

  function hideMatch(m) {
    if (m.range) return highlight.add(m.range);
    for (const [n] of m.segs) {
      const st = masked.get(n);
      if (st && n.data === st.shown) write(n, st.masked);
    }
  }

  function onMutations(records) {
    if (document.readyState === "loading" && settings?.hideUntilScanned) return; // full scan at DOMContentLoaded
    const roots = new Set();
    for (const r of records) {
      const n = r.type === "characterData" ? r.target.parentElement : r.target;
      if (n && n !== styleEl) roots.add(blockOf(n));
    }
    for (const b of roots) {
      if (!b.isConnected) continue;
      let covered = false;
      for (let p = b.parentElement; p && !covered; p = p.parentElement) covered = roots.has(p);
      if (!covered) scan(b);
    }
  }

  // ---- Form fields --------------------------------------------------------

  function fieldLabel(el) {
    return (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.placeholder || el.name || "").trim();
  }

  function checkField(el) {
    const value = el.value;
    let hit = false;
    if (value) {
      // "Phone number" label + value reads as "Phone number: 941…" so label rules match.
      const label = fieldLabel(el).replace(/[\s:]+$/, "");
      const prefix = label ? label + ": " : "";
      hit = R.findMatches(prefix + value, compiled).some(([, e]) => e > prefix.length);
    }
    if (el.hasAttribute(FIELD) !== hit) el.toggleAttribute(FIELD, hit);
  }

  function onInput(e) {
    if (e.target instanceof Element && isField(e.target)) checkField(e.target);
  }

  // Catches values set by scripts (which fire no input event) and drops stale ranges.
  function tick() {
    document.querySelectorAll("input, textarea").forEach((el) => isField(el) && checkField(el));
    for (const block of blockMatches.keys()) if (!block.isConnected) clearBlock(block);
    for (const n of masked.keys()) if (!n.isConnected) masked.delete(n);
  }

  // ---- Hover to reveal ----------------------------------------------------

  function onMove(e) {
    pointer = { x: e.clientX, y: e.clientY, target: e.target };
    if (!moveQueued) { moveQueued = true; requestAnimationFrame(updateReveal); }
  }

  function onMouseOut(e) {
    if (!e.relatedTarget) { pointer = { x: -1, y: -1, target: null }; updateReveal(); }
  }

  const under = (m) => [...(m.range || rangeOf(m.segs)).getClientRects()].some(
    (q) => pointer.x >= q.left && pointer.x <= q.right && pointer.y >= q.top && pointer.y <= q.bottom
  );

  function updateReveal() {
    moveQueued = false;
    if (revealed && under(revealed)) return;
    if (revealed) { hideMatch(revealed); revealed = null; }
    if (!(pointer.target instanceof Element)) return;
    const m = blockMatches.get(blockOf(pointer.target))?.find(under);
    if (m) { showMatch(m); revealed = m; }
  }
})();
