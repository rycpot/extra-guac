// "Remove elements": hover highlights the element under the cursor in red; a click
// removes it from this page and from every future load of the site (bg-remove.js), and
// picking carries on so several can go in one session. ↑ selects the parent, ↓ goes back
// down, Ctrl/Cmd+Z puts back the last one removed in this session, Esc or Enter (or
// "done") finishes. Clicks never reach the page.
(() => {
  if (window.__ttRemovePicker) return;

  // A selector that finds this element again on later loads: id, then readable classes
  // and attributes, with position only as a last resort. Numbered ids and generated
  // class names change between loads, so they're left out.
  const OPTIONS = {
    ignoreGeneratedClassNames: true,
    blacklist: [/\d{4,}/, /^\[(style|src|href|alt|title|srcset|width|height|aria-[\w-]+|data-[\w-]*(id|key|index|time)[\w-]*)[=\]]/i],
  };
  const unique = (sel, el) => { try { const all = document.querySelectorAll(sel); return all.length === 1 && all[0] === el; } catch { return false; } };
  // Says something about the element itself (id, class or attribute), not just where it sits.
  const named = (sel) => /[#.[]/.test(sel) && !/:root|nth-child/.test(sel);

  function generate(el, selectors) {
    try { return CssSelectorGenerator.getCssSelector(el, { ...OPTIONS, selectors }); } catch { return ""; }
  }

  function selectorFor(el) {
    let sel = generate(el, ["id", "class", "attribute", "tag", "nthchild"]);
    // "p:nth-child(1)" may be unique on this page but would hide every first paragraph on
    // the site's other pages: anchor a position-only selector to the nearest ancestor that
    // can be named, e.g. "#sidebar > p:nth-child(1)".
    if (!named(sel)) {
      const step = (n) => `${n.localName}:nth-child(${[...n.parentElement.children].indexOf(n) + 1})`;
      const path = [step(el)];
      let anchor = "";
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const own = generate(a, ["id", "class", "attribute", "tag"]);
        if (named(own) && unique(own, a)) { anchor = own; break; }
        path.unshift(step(a));
      }
      sel = `${anchor || "body"} > ${path.join(" > ")}`;
    }
    return !/[{}]/.test(sel) && unique(sel, el) ? sel : "";
  }

  window.__ttRemovePicker = () => {
    window.__ttRemovePicker.active?.();
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .box { position: fixed; border: 1.5px solid #ff453a; background: rgba(255,69,58,.18); border-radius: 2px; transition: all .06s ease-out; }
        .tag { position: fixed; max-width: min(70vw, 560px); padding: 4px 8px; border-radius: 6px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; background: rgba(12,12,12,.92); color: rgba(255,255,255,.92);
          font: 500 11.5px ui-monospace, "SF Mono", Menlo, monospace; }
        .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
          padding: 6px 6px 6px 12px; border-radius: 10px; white-space: nowrap;
          background: rgba(12,12,12,.9); color: rgba(255,255,255,.88); font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; }
        .count { color: #ff6961; }
        /* Only "done" takes the mouse; the rest of the bar lets you pick what's under it. */
        button { font: inherit; color: inherit; border: 0; border-radius: 7px; padding: 4px 10px; cursor: pointer; background: rgba(255,255,255,.12); pointer-events: auto; }
        button:hover { background: rgba(255,255,255,.2); }
      </style>
      <div class="hint"><span>Click to remove · ↑ parent · Ctrl+Z undo · Esc done</span><span class="count"></span><button class="done">done</button></div>
      <div class="box" hidden></div>
      <div class="tag" hidden></div>`;
    const box = root.querySelector(".box"), tag = root.querySelector(".tag"), count = root.querySelector(".count");
    root.querySelector(".done").onclick = cleanup;
    document.documentElement.append(host);

    let current = null;
    const trail = []; // elements visited with ↑, for ↓
    const removed = []; // { el, selector, prev } in this session, for undo

    const usable = (el) => el instanceof Element && el !== host && el !== document.documentElement && el !== document.body;

    function show(el) {
      current = el;
      if (!el) { box.hidden = tag.hidden = true; return; }
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      box.hidden = tag.hidden = false;
      tag.textContent = selectorFor(el) || el.localName;
      tag.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 300))}px`;
      tag.style.top = `${r.top > 30 ? r.top - 26 : Math.min(r.bottom + 4, innerHeight - 26)}px`;
    }

    function onMove(e) {
      if (!usable(e.target) || e.target === current) return;
      trail.length = 0;
      show(e.target);
    }

    function block(e) {
      if (e.composedPath().includes(host)) return; // the hint's "done" button
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onClick(e) {
      if (e.composedPath().includes(host)) return;
      block(e);
      if (usable(e.target) && e.target !== current && !trail.length) show(e.target);
      remove();
    }

    function onKey(e) {
      if (e.key === "Escape" || e.key === "Enter") { block(e); cleanup(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { block(e); undo(); }
      else if (e.key === "ArrowUp" && usable(current?.parentElement)) { block(e); trail.push(current); show(current.parentElement); }
      else if (e.key === "ArrowDown" && trail.length) { block(e); show(trail.pop()); }
    }

    function remove() {
      if (!usable(current)) return;
      const selector = selectorFor(current);
      if (!selector) return window.__ttFlash("Couldn't make an address for that element");
      // Gone at once; the site's stylesheet takes over as soon as the list is saved.
      const prev = [current.style.getPropertyValue("display"), current.style.getPropertyPriority("display")];
      current.style.setProperty("display", "none", "important");
      removed.push({ el: current, selector, prev });
      chrome.runtime.sendMessage({ type: "removeAdd", selector }).catch(() => {});
      trail.length = 0;
      show(null);
      count.textContent = `${removed.length} removed`;
    }

    function undo() {
      const last = removed.pop();
      if (!last) return;
      if (last.prev[0]) last.el.style.setProperty("display", ...last.prev);
      else last.el.style.removeProperty("display");
      chrome.runtime.sendMessage({ type: "removeUndo", selector: last.selector }).catch(() => {});
      count.textContent = removed.length ? `${removed.length} removed` : "";
    }

    const swallow = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "submit"];
    const events = [["mouseover", onMove], ["click", onClick], ["keydown", onKey], ...swallow.map((t) => [t, block])];
    events.forEach(([t, fn]) => addEventListener(t, fn, { capture: true, passive: false }));
    addEventListener("scroll", onScroll, true);
    function onScroll() { if (current) show(current); }

    function cleanup() {
      events.forEach(([t, fn]) => removeEventListener(t, fn, { capture: true }));
      removeEventListener("scroll", onScroll, true);
      host.remove();
      window.__ttRemovePicker.active = null;
      if (removed.length) window.__ttFlash(`Removed ${removed.length} element${removed.length === 1 ? "" : "s"} on this site`);
    }
    window.__ttRemovePicker.active = cleanup;
  };
})();
