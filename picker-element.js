// "What element?": highlights the element under the cursor; click (or Enter) copies
// its CSS selector or XPath. Every pointer/click event is swallowed at the window
// before the page sees it, so buttons and links don't fire while picking.
// ↑ selects the parent, ↓ goes back down, Esc cancels.
(() => {
  if (window.__ttElementPicker) return;
  window.__ttElementPicker = (format) => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .box { position: fixed; border: 1.5px solid #30d158; background: rgba(48,209,88,.12); border-radius: 2px;
          transition: all .06s ease-out; }
        .tag { position: fixed; max-width: min(70vw, 560px); padding: 4px 8px; border-radius: 6px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; background: rgba(12,12,12,.92); color: rgba(255,255,255,.92);
          font: 500 11.5px ui-monospace, "SF Mono", Menlo, monospace; }
        .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 7px 12px; border-radius: 8px;
          background: rgba(12,12,12,.88); color: rgba(255,255,255,.88); font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; }
      </style>
      <div class="hint">Click to copy the ${format === "xpath" ? "XPath" : "CSS selector"} · ↑ parent · Esc to cancel</div>
      <div class="box" hidden></div>
      <div class="tag" hidden></div>`;
    const box = root.querySelector(".box");
    const tag = root.querySelector(".tag");
    document.documentElement.append(host);

    let current = null;
    const trail = []; // elements visited with ↑, for ↓

    function show(el) {
      current = el;
      if (!el) { box.hidden = tag.hidden = true; return; }
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      box.hidden = tag.hidden = false;
      tag.textContent = selectorFor(el);
      tag.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 300))}px`;
      tag.style.top = `${r.top > 30 ? r.top - 26 : Math.min(r.bottom + 4, innerHeight - 26)}px`;
    }

    const selectorFor = (el) => (format === "xpath" ? xPath(el) : cssPath(el));

    function onMove(e) {
      const el = e.target;
      if (!(el instanceof Element) || el === current) return;
      trail.length = 0;
      show(el);
    }

    function block(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onClick(e) {
      block(e);
      if (e.target instanceof Element && e.target !== current && !trail.length) show(e.target);
      pick();
    }

    function onKey(e) {
      if (e.key === "Escape") { block(e); cleanup(); }
      else if (e.key === "Enter" && current) { block(e); pick(); }
      else if (e.key === "ArrowUp" && current?.parentElement && current.parentElement !== document.documentElement) {
        block(e); trail.push(current); show(current.parentElement);
      } else if (e.key === "ArrowDown" && trail.length) { block(e); show(trail.pop()); }
    }

    function pick() {
      if (!current) return;
      const value = selectorFor(current);
      cleanup();
      window.__ttCopy(value);
      window.__ttFlash(`Copied ${value}`);
      chrome.runtime.sendMessage({ type: "pickedSelector", value, format });
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
    }
  };

  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };

  // Same library and options as the reference element-selector extension, so the
  // selectors match what it produces (e.g. ".button--variant-primary.button--intent-primary:nth-child(1)").
  function cssPath(el) {
    try {
      return CssSelectorGenerator.getCssSelector(el, { selectors: ["class", "tag", "nthchild", "nthoftype"] });
    } catch {
      return el.localName;
    }
  }

  // XPath from the nearest ancestor with a unique id (or from the root), with indexes
  // only where siblings share a tag. SVG and other namespaced tags use name().
  function xPath(el) {
    const steps = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.id && unique(`#${CSS.escape(node.id)}`)) {
        steps.unshift(`//*[@id=${xpathString(node.id)}]`);
        return steps.join("/");
      }
      const name = node.namespaceURI === "http://www.w3.org/1999/xhtml" ? node.localName : `*[name()="${node.localName}"]`;
      const parent = node.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.localName === node.localName) : [node];
      steps.unshift(same.length > 1 ? `${name}[${same.indexOf(node) + 1}]` : name);
    }
    return "/" + steps.join("/");
  }

  const xpathString = (s) => (s.includes('"') ? `'${s}'` : `"${s}"`);
})();
