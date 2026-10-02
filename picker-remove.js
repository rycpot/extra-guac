// "Remove elements": hover highlights the element under the cursor in red; a click
// removes it from this page and from every future load of the site (bg-remove.js), and
// picking carries on so several can go in one session. ↑ selects the parent, ↓ goes back
// down, Ctrl/Cmd+Z puts back the last one removed in this session, Esc or Enter (or
// "done") finishes. Clicks never reach the page.
//
// A panel in the corner lists everything removed on this site by a readable name.
// Pointing at an entry shows that element outlined (and scrolls to it), the eye turns a
// removal off or on again, × deletes it, and "show all" outlines every removed element.
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

  // A name people can recognise in a list: what the element says, else what it is.
  function labelFor(el) {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const said = clean(el.getAttribute("aria-label")) || clean(el.getAttribute("alt")) || clean(el.getAttribute("title"))
      || clean(el.getAttribute("placeholder")) || clean(el.innerText);
    if (said) return `${el.localName} “${said.length > 48 ? `${said.slice(0, 47)}…` : said}”`;
    const img = el.querySelector?.("img[alt]:not([alt=''])");
    if (img) return `${el.localName} with image “${clean(img.alt).slice(0, 40)}”`;
    const r = el.getBoundingClientRect();
    return `${el.localName} ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);

  window.__ttRemovePicker = () => {
    window.__ttRemovePicker.active?.();
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .box { position: fixed; border: 1.5px solid #ff453a; background: rgba(255,69,58,.18); border-radius: 2px; transition: all .06s ease-out; }
        .box.peek { border-style: dashed; background: rgba(255,69,58,.1); }
        .tag { position: fixed; max-width: min(70vw, 560px); padding: 4px 8px; border-radius: 6px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; background: rgba(12,12,12,.92); color: rgba(255,255,255,.92);
          font: 500 11.5px ui-monospace, "SF Mono", Menlo, monospace; }
        .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 6px 12px; border-radius: 10px; white-space: nowrap;
          background: rgba(12,12,12,.9); color: rgba(255,255,255,.88); font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; }
        .panel { position: fixed; bottom: 16px; right: 16px; width: 320px; max-height: min(46vh, 420px); display: flex; flex-direction: column;
          border-radius: 14px; overflow: hidden; pointer-events: auto; background: rgba(18,18,18,.95); color: rgba(255,255,255,.9);
          font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; box-shadow: 0 10px 34px rgba(0,0,0,.45); }
        .panel.left { right: auto; left: 16px; }
        .head { display: flex; align-items: center; gap: 6px; padding: 9px 8px 9px 12px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .title b { font-weight: 600; }
        button { font: inherit; color: inherit; border: 0; border-radius: 7px; padding: 4px 8px; cursor: pointer; background: rgba(255,255,255,.1); }
        button:hover { background: rgba(255,255,255,.18); }
        button.plain { background: none; color: rgba(255,255,255,.55); padding: 3px 6px; }
        button.plain:hover { color: #fff; background: rgba(255,255,255,.1); }
        button.on { background: rgba(255,69,58,.28); color: #ffb3ae; }
        ul { list-style: none; margin: 0; padding: 4px; overflow-y: auto; scrollbar-width: thin; }
        li { display: flex; align-items: center; gap: 2px; padding: 3px 3px 3px 8px; border-radius: 8px; }
        li:hover { background: rgba(255,255,255,.07); }
        li .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        li.off .name { opacity: .45; text-decoration: line-through; }
        li .x:hover { color: #ff6961; }
        .empty { padding: 12px; color: rgba(255,255,255,.5); }
        svg { width: 14px; height: 14px; display: block; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      </style>
      <div class="hint">Click to remove · ↑ parent · Ctrl+Z undo · Esc done</div>
      <div class="box" hidden></div>
      <div class="tag" hidden></div>
      <div class="panel">
        <div class="head">
          <span class="title"></span>
          <button class="plain side" title="Move to the other corner">⇆</button>
          <button class="show" title="Show every removed element on this page, outlined">show all</button>
          <button class="done">done</button>
        </div>
        <ul></ul>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const box = $(".box"), tag = $(".tag"), panel = $(".panel"), list = $("ul");
    $(".done").onclick = cleanup;
    $(".side").onclick = () => panel.classList.toggle("left");
    document.documentElement.append(host);

    const EYE = `<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const EYE_OFF = `<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 21.5 12a15 15 0 0 1-2.7 3.5M6.6 6.7A15 15 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

    let current = null;
    let site = "", items = [], showAll = false;
    const trail = []; // elements visited with ↑, for ↓
    const removed = []; // { el, selector, prev } in this session, for undo
    const inline = new Map(); // selector → [{ el, prev }] hidden inline until the site's stylesheet has it

    const usable = (el) => el instanceof Element && el !== host && el !== document.documentElement && el !== document.body;

    // Elements hidden straight away by this session go back to the site's stylesheet, which
    // knows about "off" and "show all".
    function release(selector) {
      for (const { el, prev } of inline.get(selector) || []) {
        if (prev[0]) el.style.setProperty("display", ...prev);
        else el.style.removeProperty("display");
      }
      inline.delete(selector);
    }

    async function load() {
      const res = await send("removeList");
      if (!res?.ok) return;
      ({ site, items, show: showAll } = res);
      render();
    }

    function render() {
      const on = items.filter((r) => r.enabled).length;
      $(".title").innerHTML = "";
      $(".title").append(Object.assign(document.createElement("b"), { textContent: site }), ` · ${on}`);
      $(".title").title = `${on} removed on ${site}${items.length > on ? `, ${items.length - on} off` : ""}`;
      $(".show").classList.toggle("on", showAll);
      $(".show").disabled = !items.length;
      list.replaceChildren();
      if (!items.length) {
        list.innerHTML = `<li class="empty">Click anything on the page to remove it.</li>`;
        return;
      }
      for (const r of [...items].reverse()) {
        const li = document.createElement("li");
        li.classList.toggle("off", !r.enabled);
        li.innerHTML = `<span class="name"></span><button class="plain eye"></button><button class="plain x" title="Delete: the element comes back">✕</button>`;
        const name = li.querySelector(".name");
        name.textContent = r.label || r.selector;
        name.title = `${r.selector}${r.site !== site ? `\n(removed on all of ${r.site})` : ""}`;
        const eye = li.querySelector(".eye");
        eye.innerHTML = r.enabled ? EYE_OFF : EYE;
        eye.title = r.enabled ? "Removed · click to show it again (stays in the list)" : "Shown · click to remove it again";
        eye.onclick = async () => {
          release(r.selector);
          await send("removeToggle", { site: r.site, selector: r.selector, enabled: !r.enabled });
          await load();
        };
        li.querySelector(".x").onclick = async () => {
          release(r.selector);
          unpeek();
          const i = removed.findIndex((e) => e.selector === r.selector);
          if (i >= 0) removed.splice(i, 1);
          await send("removeUndo", { site: r.site, selector: r.selector });
          await load();
        };
        li.onmouseenter = () => peek(r);
        li.onmouseleave = unpeek;
        list.append(li);
      }
    }

    // Pointing at an entry: show that element, scroll to it and frame it.
    let peeking = null;
    async function peek(r) {
      peeking = r.selector;
      for (const { el } of inline.get(r.selector) || []) el.style.setProperty("display", "revert", "important");
      if (r.enabled && !showAll) await send("removePeek", { selector: r.selector });
      if (peeking !== r.selector) return;
      let el = null;
      try { el = document.querySelector(r.selector); } catch {}
      const rect = el?.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) {
        box.hidden = true;
        tag.hidden = false;
        tag.textContent = "not on this page";
        Object.assign(tag.style, { left: "", top: "" });
        place(tag, panel.getBoundingClientRect());
        return;
      }
      if (rect.bottom < 0 || rect.top > innerHeight) el.scrollIntoView({ block: "center" });
      frame(el, true);
    }

    function unpeek() {
      if (!peeking) return;
      const sel = peeking;
      peeking = null;
      for (const { el } of inline.get(sel) || []) el.style.setProperty("display", "none", "important");
      send("removePeek", { selector: null });
      show(null);
    }

    function place(t, r) {
      t.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 300))}px`;
      t.style.top = `${r.top > 30 ? r.top - 26 : Math.min(r.bottom + 4, innerHeight - 26)}px`;
    }

    function frame(el, isPeek = false) {
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      box.classList.toggle("peek", isPeek);
      box.hidden = tag.hidden = false;
      tag.textContent = isPeek ? labelFor(el) : selectorFor(el) || el.localName;
      place(tag, r);
    }

    function show(el) {
      current = el;
      if (!el) { box.hidden = tag.hidden = true; return; }
      frame(el);
    }

    function onMove(e) {
      if (peeking) return;
      if (e.target === host) { if (current) show(null); return; } // over the panel
      if (!usable(e.target) || e.target === current) return;
      trail.length = 0;
      show(e.target);
    }

    function block(e) {
      if (e.composedPath().includes(host)) return; // the panel
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

    async function remove() {
      if (!usable(current)) return;
      const el = current;
      const selector = selectorFor(el);
      if (!selector) return window.__ttFlash("Couldn't make an address for that element");
      const label = labelFor(el);
      // Gone at once; the site's stylesheet takes over as soon as the list is saved.
      const prev = [el.style.getPropertyValue("display"), el.style.getPropertyPriority("display")];
      el.style.setProperty("display", "none", "important");
      inline.set(selector, [...(inline.get(selector) || []), { el, prev }]);
      removed.push({ el, selector });
      trail.length = 0;
      show(null);
      await send("removeAdd", { selector, label });
      await load();
    }

    async function undo() {
      const last = removed.pop();
      if (!last) return;
      release(last.selector);
      const r = items.find((e) => e.selector === last.selector);
      await send("removeUndo", { site: r?.site, selector: last.selector });
      await load();
    }

    $(".show").onclick = async () => {
      // Elements hidden inline this session would stay hidden: hand them to the stylesheet.
      if (!showAll) for (const sel of [...inline.keys()]) release(sel);
      await send("removeShow", { site, on: !showAll });
      await load();
    };

    const swallow = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "submit"];
    const events = [["mouseover", onMove], ["click", onClick], ["keydown", onKey], ...swallow.map((t) => [t, block])];
    events.forEach(([t, fn]) => addEventListener(t, fn, { capture: true, passive: false }));
    addEventListener("scroll", onScroll, true);
    function onScroll() { if (current) show(current); }

    function cleanup() {
      events.forEach(([t, fn]) => removeEventListener(t, fn, { capture: true }));
      removeEventListener("scroll", onScroll, true);
      if (peeking) unpeek();
      host.remove();
      window.__ttRemovePicker.active = null;
      if (removed.length) window.__ttFlash(`Removed ${removed.length} element${removed.length === 1 ? "" : "s"} on this site`);
    }
    window.__ttRemovePicker.active = cleanup;
    load();
  };
})();
