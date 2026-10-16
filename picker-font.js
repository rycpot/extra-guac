// "What font?": hover any text to see its font, click to get the details. The real
// family name is read from the font file itself (so renamed web fonts like
// "__Inter_e66fe9" show as "Inter"); the name is copied. Clicks don't reach the page.
// It goes by the text under the pointer, not the element on top there: pages often lay
// invisible links or layers over text (whole clickable cards), which have a font of their
// own but no text.
(() => {
  if (window.__ttFontPicker) return;

  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|math|emoji|fangsong|ui-[\w-]+|-apple-system|blinkmacsystemfont)$/i;
  const WEIGHTS = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, "").trim();
  const stackOf = (ff) => (ff.match(/("[^"]*"|'[^']*'|[^,]+)/g) || []).map(unquote).filter(Boolean);
  const hex = (rgb) => {
    const m = rgb.match(/[\d.]+/g) || [];
    return "#" + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("").toUpperCase();
  };

  // Is a font installed locally? (text width changes if it is)
  const ctx = document.createElement("canvas").getContext("2d");
  function installed(name) {
    const sample = "mmmmmmmmmmlliWW@#0O";
    return ["monospace", "serif", "sans-serif"].some((g) => {
      ctx.font = `72px ${g}`;
      const base = ctx.measureText(sample).width;
      ctx.font = `72px "${name}", ${g}`;
      return ctx.measureText(sample).width !== base;
    });
  }

  // The first family in the stack that actually renders: a loaded web font,
  // an installed font, or a generic family (the browser's default).
  function renderedFamily(stack) {
    const loaded = new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => unquote(f.family).toLowerCase()));
    for (const name of stack) {
      if (GENERIC.test(name)) return { name, kind: "generic" };
      if (loaded.has(name.toLowerCase())) return { name, kind: "web" };
      if (installed(name)) return { name, kind: "local" };
    }
    return { name: stack[0] || "", kind: "unknown" };
  }

  // @font-face rules from stylesheets we can read; hrefs of those we can't (cross-origin).
  function collectFaces() {
    const inline = [], sheets = [];
    const walk = (rules, base) => {
      for (const r of rules) {
        if (r instanceof CSSFontFaceRule) inline.push({ css: `@font-face{${r.style.cssText}}`, base });
        else if (r instanceof CSSImportRule && r.styleSheet) visit(r.styleSheet);
        else if (r.cssRules) walk(r.cssRules, base);
      }
    };
    const visit = (sheet) => {
      const base = sheet.href || location.href;
      try { walk(sheet.cssRules, base); } catch { if (sheet.href) sheets.push(sheet.href); }
    };
    for (const sheet of document.styleSheets) visit(sheet);
    for (const sheet of document.adoptedStyleSheets || []) visit(sheet);
    return { inline, sheets: [...new Set(sheets)] };
  }

  // The text under a point: the element holding it and the line box it's in. Tried in
  // turn: the character the browser finds there; the text of the elements stacked at the
  // point (not just the top one) and inside them; then the page's text at large. Each
  // step is capped, so it stays quick on big pages.
  const NEAR = 2; // px of slack around a line box
  const hasText = (n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim() !== "";
  function lineAt(node, x, y) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width > 1 && r.height > 1 && x >= r.left - NEAR && x <= r.right + NEAR && y >= r.top - NEAR && y <= r.bottom + NEAR) return r;
    }
    return null;
  }
  const seen = (el) => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  function textIn(el, x, y, limit) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n, i = 0; (n = walker.nextNode()) && i < limit; i++) {
      if (!hasText(n) || !n.parentElement || !seen(n.parentElement)) continue;
      const line = lineAt(n, x, y);
      if (line) return { el: n.parentElement, line };
    }
    return null;
  }
  function textAt(x, y, skip) {
    const caret = document.caretRangeFromPoint?.(x, y)?.startContainer;
    if (caret && hasText(caret) && caret.parentElement && !skip.contains(caret.parentElement)) {
      const line = lineAt(caret, x, y);
      if (line) return { el: caret.parentElement, line };
    }
    const stack = document.elementsFromPoint(x, y).filter((el) => !skip.contains(el) && el !== document.documentElement && el !== document.body);
    for (const el of stack.slice(0, 8)) {
      const found = textIn(el.shadowRoot || el, x, y, 150);
      if (found) return found;
    }
    // Last: the page's text at large, skipping elements whose box is elsewhere.
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const away = new Set();
    for (let n, i = 0; (n = walker.nextNode()) && i < 2000; i++) {
      const el = n.parentElement;
      if (!el || away.has(el) || !hasText(n)) continue;
      const r = el.getBoundingClientRect();
      if (x < r.left - NEAR || x > r.right + NEAR || y < r.top - NEAR || y > r.bottom + NEAR || skip.contains(el) || !seen(el)) { away.add(el); continue; }
      const line = lineAt(n, x, y);
      if (line) return { el, line };
    }
    return null;
  }

  // A line box cut down to what can be seen of it: within the window, and within every
  // ancestor that clips its overflow (a card hiding the end of a long line, say).
  function visiblePart(el, r) {
    let left = Math.max(r.left, 0), top = Math.max(r.top, 0);
    let right = Math.min(r.right, innerWidth), bottom = Math.min(r.bottom, innerHeight);
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === "fixed") break; // nothing above it clips it
      const clipX = cs.overflowX !== "visible", clipY = cs.overflowY !== "visible";
      if (!clipX && !clipY) continue;
      const b = a.getBoundingClientRect();
      if (clipX) { left = Math.max(left, b.left); right = Math.min(right, b.right); }
      if (clipY) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
    }
    return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : r;
  }

  window.__ttFontPicker = () => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .box { position: fixed; border: 1.5px solid #30d158; background: rgba(48,209,88,.10); border-radius: 2px; }
        .tag, .hint, .card { font: 500 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace; color: rgba(255,255,255,.92);
          background: rgba(12,12,12,.94); border-radius: 8px; }
        .tag { position: fixed; padding: 4px 8px; white-space: nowrap; }
        .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 7px 12px; }
        .card { position: fixed; width: 330px; padding: 12px 14px; pointer-events: auto; box-shadow: 0 10px 34px rgba(0,0,0,.45); }
        .name { font-size: 17px; font-weight: 600; margin: 0 22px 2px 0; word-break: break-word; }
        .sub { color: rgba(255,255,255,.66); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .sub i { width: 11px; height: 11px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.3); }
        dl { display: grid; grid-template-columns: 62px 1fr; gap: 3px 8px; margin: 0 0 10px; }
        dt { color: rgba(255,255,255,.44); }
        dd { margin: 0; overflow-wrap: anywhere; color: rgba(255,255,255,.8); }
        .note { color: #ffd60a; margin: -4px 0 10px; }
        .btns { display: flex; gap: 6px; }
        button { font: inherit; color: inherit; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; background: rgba(255,255,255,.1); }
        button:hover { background: rgba(255,255,255,.18); }
        .x { position: absolute; top: 8px; right: 8px; padding: 2px 7px; background: none; color: rgba(255,255,255,.6); font-size: 15px; }
        [hidden] { display: none !important; }
      </style>
      <div class="hint">Click text to see its font · Esc to cancel</div>
      <div class="box" hidden></div>
      <div class="tag" hidden></div>
      <div class="card" hidden></div>`;
    document.documentElement.append(host);
    (window.__egEsc ??= new Set()).add(close); // Esc from the side panel (bg-pickers.js "pageEscape")
    const box = root.querySelector(".box"), tag = root.querySelector(".tag"), card = root.querySelector(".card"), hint = root.querySelector(".hint");
    let current = null, picking = true;

    const styleOf = (el) => {
      const cs = getComputedStyle(el);
      const stack = stackOf(cs.fontFamily);
      return { cs, stack, rendered: renderedFamily(stack), weight: parseInt(cs.fontWeight, 10) || 400 };
    };

    // The text under the pointer (or, away from any text, the element there, which covers
    // form fields), outlined by its line. Worked out once per frame.
    let frame = 0, lastX = 0, lastY = 0, lastTarget = null;
    function hit(x, y, target) {
      const found = textAt(x, y, host);
      if (found) return { el: found.el, line: visiblePart(found.el, found.line) };
      const el = target instanceof Element && target !== host ? target : null;
      return el && { el, line: el.getBoundingClientRect() };
    }
    function onMove(e) {
      if (!picking) return;
      lastX = e.clientX;
      lastY = e.clientY;
      lastTarget = e.target;
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        if (!picking) return;
        const found = hit(lastX, lastY, lastTarget);
        if (!found) { box.hidden = tag.hidden = true; current = null; return; }
        const r = found.line;
        Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        box.hidden = tag.hidden = false;
        if (found.el === current) return;
        current = found.el;
        const { cs, rendered, weight } = styleOf(current);
        tag.textContent = `${rendered.name} · ${cs.fontSize} · ${weight}`;
        tag.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 260))}px`;
        tag.style.top = `${r.top > 30 ? r.top - 28 : Math.min(r.bottom + 4, innerHeight - 28)}px`;
      });
    }

    function block(e) {
      if (e.composedPath().includes(host)) return; // our card's buttons
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onClick(e) {
      if (e.composedPath().includes(host)) return;
      block(e);
      if (!picking) return close(); // a click outside the card closes it
      const found = hit(e.clientX, e.clientY, e.target);
      if (found) show(found.el, found.line);
    }

    function onKey(e) {
      if (e.key === "Escape") { block(e); close(); }
    }

    async function show(el, line) {
      picking = false;
      hint.hidden = tag.hidden = true;
      const { cs, stack, rendered, weight } = styleOf(el);
      const style = cs.fontStyle.startsWith("italic") || cs.fontStyle.startsWith("oblique") ? "italic" : "normal";
      const info = { css: rendered.name, stack, weight, style, size: cs.fontSize, lineHeight: cs.lineHeight, color: hex(cs.color), kind: rendered.kind };
      render(info, null, true);
      place(line || el.getBoundingClientRect());
      let result = null;
      if (rendered.kind === "web") {
        const { inline, sheets } = collectFaces();
        const res = await chrome.runtime.sendMessage({ type: "fontInspect", family: rendered.name, weight, style, faces: [], inline, sheets }).catch(() => null);
        result = res?.ok ? res.info : { error: res?.error || "Couldn't read the font file" };
      }
      render(info, result, false);
      const name = displayName(info, result);
      window.__ttCopy(name);
      chrome.runtime.sendMessage({ type: "pickedFont", value: `${name} · ${WEIGHTS[Math.round(weight / 100) * 100] || weight} · ${info.size}` });
    }

    const hidden = (names) => !names?.family || /^[a-z0-9_-]{6,}$/i.test(names.family) && /\d/.test(names.family) && !/\s/.test(names.family);
    function displayName(info, result) {
      const n = result?.names;
      return n && !hidden(n) ? n.typoFamily || n.family : info.css;
    }

    function render(info, result, loading) {
      const n = result?.names;
      const name = displayName(info, result);
      const weightName = n?.typoSubfamily || n?.subfamily || WEIGHTS[Math.round(info.weight / 100) * 100] || info.weight;
      const rows = [];
      if (name.toLowerCase() !== info.css.toLowerCase()) rows.push(["css name", info.css]);
      rows.push(["stack", info.stack.join(", ")]);
      if (result?.file) {
        const f = result.file;
        const file = decodeURIComponent((f.url.startsWith("data:") ? "embedded" : f.url.split("/").pop().split("?")[0]) || "font");
        rows.push(["file", `${file}${f.format ? ` · ${f.format}` : ""}${f.bytes ? ` · ${Math.round(f.bytes / 1024)} KB` : ""}`]);
      }
      if (n?.version) rows.push(["version", n.version.replace(/^Version\s*/i, "")]);
      if (n?.manufacturer || n?.designer) rows.push(["by", [n.manufacturer, n.designer].filter(Boolean).join(" · ")]);
      let note = "";
      if (loading) note = "reading the font file…";
      else if (info.kind === "local") note = "installed on this computer (not a web font)";
      else if (info.kind === "generic") note = "the browser's default font for this style";
      else if (result?.error || result?.file?.error) note = result.error || `couldn't read the file: ${result.file.error}`;
      else if (info.kind === "web" && !result?.file) note = "couldn't find the font file";
      else if (n && hidden(n)) note = "the real name is hidden by the font service";
      card.innerHTML = `<button class="x" title="Close">×</button>
        <div class="name"></div>
        <div class="sub"><span class="w"></span>·<span>${info.size} / ${info.lineHeight === "normal" ? "normal" : info.lineHeight}</span>·<i></i><span class="c"></span></div>
        ${note ? '<div class="note"></div>' : ""}
        <dl></dl>
        <div class="btns"><button data-copy="name">copy name</button><button data-copy="css">copy CSS</button></div>`;
      card.querySelector(".name").textContent = name;
      card.querySelector(".w").textContent = weightName;
      card.querySelector("i").style.background = info.color;
      card.querySelector(".c").textContent = info.color;
      if (note) card.querySelector(".note").textContent = note;
      const dl = card.querySelector("dl");
      for (const [k, v] of rows) {
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = k;
        dd.textContent = v;
        dl.append(dt, dd);
      }
      card.querySelector(".x").onclick = close;
      card.querySelector("[data-copy=name]").onclick = () => { window.__ttCopy(name); window.__ttFlash(`Copied ${name}`); };
      card.querySelector("[data-copy=css]").onclick = () => {
        const css = `font-family: ${info.stack.map((s) => (/\s/.test(s) && !GENERIC.test(s) ? `"${s}"` : s)).join(", ")};\n` +
          `font-weight: ${info.weight};\nfont-size: ${info.size};\nline-height: ${info.lineHeight};`;
        window.__ttCopy(css);
        window.__ttFlash("Copied CSS");
      };
      card.hidden = false;
    }

    function place(r) {
      const w = 330, h = card.offsetHeight || 200;
      card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
      card.style.top = `${r.bottom + 8 + h < innerHeight ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
    }

    const swallow = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu"];
    const events = [["mousemove", onMove], ["click", onClick], ["keydown", onKey], ...swallow.map((t) => [t, block])];
    events.forEach(([t, fn]) => addEventListener(t, fn, { capture: true, passive: false }));

    function close() {
      cancelAnimationFrame(frame);
      window.__egEsc?.delete(close);
      events.forEach(([t, fn]) => removeEventListener(t, fn, { capture: true }));
      host.remove();
    }
  };
})();
