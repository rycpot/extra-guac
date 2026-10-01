// Hides sensitive text on the page:
// - "blur" wraps each match in a <tt-pii> element blurred with CSS filter (hover is pure CSS);
// - "bars" paints over matches with the CSS Custom Highlight API (DOM untouched);
// - "mask" swaps characters in the page's own text nodes (so the page's font/size/colour
//   apply) and restores them on hover or when turned off.
// Form fields get an attribute styled by CSS. Everything is undone when turned off.
//
// After the extension updates or reloads, a copy already running in a tab is cut off
// from it (it can no longer hear "turned off"). So: a newly injected copy tells any
// older one to stand down (it undoes everything first), and a copy that notices it
// has been cut off undoes everything by itself.
(() => {
  document.dispatchEvent(new CustomEvent("tt-pii-takeover"));
  let retired = false;
  document.addEventListener("tt-pii-takeover", retire, { once: true });

  const R = globalThis.PIIRules;
  const root = document.documentElement;
  const PENDING = "data-pii-pending"; // hides the page until the first scan (see pii.css)
  const FIELD = "data-pii-field";
  const WRAP = "TT-PII";
  const BLOCKS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "BUTTON", "CAPTION", "DD", "DETAILS", "DIALOG",
    "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
    "H5", "H6", "HEADER", "HR", "HTML", "LEGEND", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
    "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
  ]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SVG", "HEAD"]);
  const INERT = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "IMG", "IFRAME", "SVG", "VIDEO", "CANVAS"]);
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
  const onStorage = (changes, area) => {
    if (area === "local" && changes.pii) apply(changes.pii.newValue);
  };
  chrome.storage.onChanged.addListener(onStorage);

  function retire() {
    if (retired) return;
    retired = true;
    try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
    stop();
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (!settings) return; // apply() will scan once settings arrive
    if (active) rescanAll();
    reveal();
  }, { once: true });

  function apply(raw) {
    if (retired) return;
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
    if (s.style === "bars") {
      return `::highlight(pii){color:${color};background-color:${color};text-shadow:none;text-decoration-color:transparent}
         [${FIELD}]:not(:hover){color:transparent!important;-webkit-text-fill-color:transparent!important;background:${color}!important}`;
    }
    const blur = `filter:blur(${Math.max(px / 2, 1.5)}px)!important;transition:filter .15s ease!important`;
    return `tt-pii{display:inline-block!important;${blur}}
       tt-pii:hover{filter:none!important}
       [${FIELD}]{${blur}}
       [${FIELD}]:hover{filter:none!important}`;
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
    unwrapAll();
    CSS.highlights.delete("pii");
    styleEl.remove();
    document.querySelectorAll(`[${FIELD}]`).forEach((el) => el.removeAttribute(FIELD));
  }

  // ---- Scanning -----------------------------------------------------------

  function isBlock(el) {
    if (BLOCKS.has(el.tagName)) return true;
    if (!el.tagName.includes("-") || el.tagName === WRAP) return false;
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
    if (settings.style !== "blur") unwrapAll();
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
    const fresh = new Map([[block, []]]); // every block re-scanned here -> its new matches
    let group = null;
    const flush = () => {
      if (group) {
        if (!fresh.has(group.block)) fresh.set(group.block, []);
        fresh.get(group.block).push(...matchGroup(group.nodes));
      }
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
        else if (isBlock(n)) { flush(); fresh.set(n, []); }
        continue;
      }
      if (!n.data.trim() && !group) continue;
      const b = blockOf(n);
      if (group && group.block !== b) flush();
      (group ??= { block: b, nodes: [] }).nodes.push(n);
    }
    flush();
    for (const [b, matches] of fresh) reconcile(b, matches);
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
      return { segs, range: settings.style === "bars" ? rangeOf(segs) : null };
    });
    if (settings.style === "mask") maskNodes(nodes, matches);
    if (settings.style === "blur") wrapMatches(nodes, matches);
    return matches;
  }

  // ---- Blur mode ----------------------------------------------------------

  // Wraps each match in <tt-pii>, leaving already-correct wrappers untouched so a
  // rescan of unchanged text changes nothing on the page.
  function wrapMatches(nodes, matches) {
    const whole = new Set();
    for (const m of matches) for (const [n, a, b] of m.segs) if (a === 0 && b === n.length) whole.add(n);
    for (const n of nodes) {
      if (n.parentElement?.tagName === WRAP && !whole.has(n)) unwrap(n.parentElement);
    }
    // Last match first: splitting a text node keeps the offsets before the split valid.
    for (let i = matches.length - 1; i >= 0; i--) {
      matches[i].segs = matches[i].segs.map(([n, a, b]) => {
        if (n.parentElement?.tagName === WRAP && a === 0 && b === n.length) return [n, a, b];
        const r = new Range();
        r.setStart(n, a);
        r.setEnd(n, b);
        const w = document.createElement("tt-pii");
        r.surroundContents(w);
        observer?.takeRecords(); // our own edits must not trigger a rescan
        return [w.firstChild, 0, w.firstChild.length];
      });
    }
  }

  function unwrap(w) {
    w.replaceWith(...w.childNodes);
    observer?.takeRecords();
  }

  function unwrapAll() {
    document.querySelectorAll("tt-pii").forEach(unwrap);
  }

  function rangeOf(segs) {
    const r = new Range();
    r.setStart(segs[0][0], segs[0][1]);
    r.setEnd(segs[segs.length - 1][0], segs[segs.length - 1][2]);
    return r;
  }

  const sameMatch = (a, b) =>
    a.segs.length === b.segs.length && a.segs.every((s, i) => s.every((v, j) => v === b.segs[i][j]));

  // Keeps matches that are unchanged instead of removing and re-adding them, so
  // pages that change constantly don't make the highlight repaint (flicker).
  function reconcile(block, matches) {
    const old = blockMatches.get(block) || [];
    const kept = matches.map((m) => {
      const i = old.findIndex((o) => o && sameMatch(o, m));
      if (i < 0) { if (m.range) highlight.add(m.range); return m; }
      const o = old[i];
      old[i] = null;
      return o;
    });
    for (const o of old) {
      if (!o) continue;
      if (o.range) highlight.delete(o.range);
      if (o === revealed) revealed = null;
    }
    if (kept.length) blockMatches.set(block, kept);
    else blockMatches.delete(block);
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
        for (let i = a; i < b; i++) if (!R.isGap(chars[i])) chars[i] = ch;
      }
      const out = chars.join("");
      const prev = masked.get(n);
      if (prev && prev.masked === out && n.data === prev.shown) continue; // being hovered: leave revealed
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
    // Re-scan only what changed: an added block is scanned on its own; the
    // surrounding block only when inline text inside it was added or removed.
    const roots = new Set();
    for (const r of records) {
      if (r.type === "characterData") { roots.add(blockOf(r.target)); continue; }
      if (r.target === styleEl) continue;
      let inlineChanged = false;
      for (const n of r.addedNodes) {
        if (isInert(n)) continue;
        if (n.nodeType === 1 && isBlock(n)) roots.add(n);
        else inlineChanged = true;
      }
      for (const n of r.removedNodes) {
        if (!isInert(n) && !(n.nodeType === 1 && isBlock(n))) inlineChanged = true;
      }
      if (inlineChanged) roots.add(blockOf(r.target));
    }
    for (const b of roots) {
      if (!b.isConnected) continue;
      let covered = false;
      for (let p = b.parentElement; p && !covered; p = p.parentElement) covered = roots.has(p);
      if (!covered) scan(b);
    }
  }

  // Nodes that can't change any text: scripts, images, iframes, empty elements, whitespace.
  function isInert(n) {
    if (n.nodeType === 3) return !n.data.trim();
    if (n.nodeType !== 1) return true;
    return INERT.has(n.tagName.toUpperCase()) || (!n.firstChild && !isField(n));
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
    if (!chrome.runtime?.id) return retire(); // the extension was updated or removed
    document.querySelectorAll("input, textarea").forEach((el) => isField(el) && checkField(el));
    for (const block of blockMatches.keys()) if (!block.isConnected) clearBlock(block);
    for (const n of masked.keys()) if (!n.isConnected) masked.delete(n);
  }

  // ---- Hover to reveal ----------------------------------------------------

  function onMove(e) {
    if (settings?.style === "blur") return; // CSS :hover handles blur
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
