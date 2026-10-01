// "What element?": highlights the element under the cursor; click (or Enter) copies
// its CSS selector, or in XPath mode opens a card offering the shortest unique XPath
// and the structural one. Every pointer/click event is swallowed at the window
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
        .card { position: fixed; width: min(560px, calc(100vw - 16px)); padding: 12px 14px; border-radius: 8px; pointer-events: auto;
          background: rgba(12,12,12,.94); color: rgba(255,255,255,.92); box-shadow: 0 10px 34px rgba(0,0,0,.45);
          font: 500 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace; box-sizing: border-box; }
        .title { font-weight: 600; margin: 0 22px 8px 0; }
        .row { display: grid; grid-template-columns: 70px 1fr auto; gap: 8px; align-items: start; margin-bottom: 6px; }
        .row dt { color: rgba(255,255,255,.44); padding-top: 4px; }
        .row dd { margin: 0; padding-top: 4px; overflow-wrap: anywhere; color: rgba(255,255,255,.85); }
        .foot { color: rgba(255,255,255,.44); margin-top: 4px; }
        button { font: inherit; color: inherit; border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; background: rgba(255,255,255,.1); }
        button:hover { background: rgba(255,255,255,.18); }
        .x { position: absolute; top: 8px; right: 8px; padding: 2px 7px; background: none; color: rgba(255,255,255,.6); font-size: 15px; }
      </style>
      <div class="hint">Click to ${format === "xpath" ? "choose an XPath" : "copy the CSS selector"} · ↑ parent · Esc to cancel</div>
      <div class="box" hidden></div>
      <div class="tag" hidden></div>
      <div class="card" hidden></div>`;
    const box = root.querySelector(".box");
    const tag = root.querySelector(".tag");
    const card = root.querySelector(".card");
    const hint = root.querySelector(".hint");
    document.documentElement.append(host);

    let current = null;
    let choices = null; // the XPath card's options once an element is clicked
    const trail = []; // elements visited with ↑, for ↓

    // In XPath mode a label (or anything inside one) stands for the control it labels,
    // like the reference XPath extension, which sees the click the label forwards to it.
    // The label stays highlighted, since the control is often a hidden radio or checkbox.
    const target = (el) => (format === "xpath" && el.closest("label")?.control) || el;
    const anchor = (el) => (target(el) === el ? el : el.closest("label"));

    function show(el) {
      current = el;
      if (!el) { box.hidden = tag.hidden = true; return; }
      const r = anchor(el).getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      box.hidden = tag.hidden = false;
      tag.textContent = selectorFor(target(el));
      tag.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 300))}px`;
      tag.style.top = `${r.top > 30 ? r.top - 26 : Math.min(r.bottom + 4, innerHeight - 26)}px`;
    }

    const selectorFor = (el) => (format === "xpath" ? xPath(el) : cssPath(el));

    function onMove(e) {
      const el = e.target;
      if (choices || !(el instanceof Element) || el === host || el === current) return;
      trail.length = 0;
      show(el);
    }

    function block(e) {
      if (e.composedPath().includes(host)) return; // the card's buttons
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onClick(e) {
      if (e.composedPath().includes(host)) return;
      block(e);
      if (choices) return cleanup(); // a click outside the card closes it
      if (e.target instanceof Element && e.target !== current && !trail.length) show(e.target);
      pick();
    }

    function onKey(e) {
      if (e.key === "Escape") { block(e); cleanup(); }
      else if (choices) { if (e.key === "Enter") { block(e); copy(choices[0][1]); } }
      else if (e.key === "Enter" && current) { block(e); pick(); }
      else if (e.key === "ArrowUp" && current?.parentElement && current.parentElement !== document.documentElement) {
        block(e); trail.push(current); show(current.parentElement);
      } else if (e.key === "ArrowDown" && trail.length) { block(e); show(trail.pop()); }
    }

    function pick() {
      if (!current) return;
      if (format === "xpath") return choose(target(current), anchor(current));
      copy(selectorFor(current));
    }

    function copy(value) {
      cleanup();
      window.__ttCopy(value);
      window.__ttFlash(`Copied ${value}`);
      chrome.runtime.sendMessage({ type: "pickedSelector", value, format });
    }

    // Freeze the highlight and offer both XPaths (one row when they're the same).
    function choose(el, near) {
      const path = xPath(el);
      const short = shortXPath(el) || path;
      choices = short === path ? [["XPath", path]] : [["Shortest", short], ["Path", path]];
      hint.hidden = tag.hidden = true;
      card.innerHTML = `<button class="x" title="Close">×</button><div class="title">Pick an XPath</div><dl></dl>
        <div class="foot">Enter copies the first · Esc closes</div>`;
      for (const [label, value] of choices) {
        const row = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
        const btn = document.createElement("button");
        row.className = "row";
        dt.textContent = label;
        dd.textContent = value;
        btn.textContent = "Copy";
        btn.onclick = () => copy(value);
        row.append(dt, dd, btn);
        card.querySelector("dl").append(row);
      }
      card.querySelector(".x").onclick = cleanup;
      card.hidden = false;
      const r = near.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
      card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
      card.style.top = `${r.bottom + 8 + h < innerHeight ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
    }

    const swallow = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "submit"];
    const events = [["mouseover", onMove], ["click", onClick], ["keydown", onKey], ...swallow.map((t) => [t, block])];
    events.forEach(([t, fn]) => addEventListener(t, fn, { capture: true, passive: false }));
    addEventListener("scroll", onScroll, true);
    function onScroll() { if (current && !choices) show(current); }

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
      steps.unshift(step(node));
    }
    return "/" + steps.join("/");
  }

  const nameOf = (node) => (node.namespaceURI === "http://www.w3.org/1999/xhtml" ? node.localName : `*[name()="${node.localName}"]`);

  function step(node) {
    const parent = node.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.localName === node.localName) : [node];
    return same.length > 1 ? `${nameOf(node)}[${same.indexOf(node) + 1}]` : nameOf(node);
  }

  // Shortest XPath that matches only this element, trying the most stable kinds first:
  // id, test ids, other meaningful attributes, single classes (not generated ones, nor
  // state classes like hover/active that another highlighter may have just added), then
  // path suffixes.
  // Within the first kind that has a hit, the shortest wins.
  const TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];
  const ATTRS = ["name", "aria-label", "title", "alt", "placeholder", "for", "role", "type", "href", "src"];
  function shortXPath(el) {
    const tag = nameOf(el);
    const usable = (v) => v && v.length <= 80 && !(v.includes('"') && v.includes("'"));
    const byAttr = (names) => [...el.attributes]
      .filter((a) => names(a.name) && usable(a.value))
      .map((a) => `//${tag}[@${a.name}=${xpathString(a.value)}]`);
    const suffixes = [], steps = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      steps.unshift(step(node));
      suffixes.push("//" + steps.join("/"));
    }
    const tiers = [
      el.id && usable(el.id) ? [`//*[@id=${xpathString(el.id)}]`] : [],
      byAttr((n) => TEST_ATTRS.includes(n)),
      byAttr((n) => ATTRS.includes(n) || (n.startsWith("data-") && !TEST_ATTRS.includes(n))),
      [...el.classList].filter((c) => usable(c) && !/\d{3}|^(css|sc|jsx|svelte)-|hover|focus|active|highlight|selected/i.test(c))
        .map((c) => `//${tag}[contains(@class, ${xpathString(c)})]`),
      suffixes,
    ];
    for (const tier of tiers) {
      const hit = tier.filter((xp) => only(xp, el)).sort((a, b) => a.length - b.length)[0];
      if (hit) return hit;
    }
    return null;
  }

  function only(xp, el) {
    try {
      const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return r.snapshotLength === 1 && r.snapshotItem(0) === el;
    } catch {
      return false;
    }
  }

  const xpathString = (s) => (s.includes('"') ? `'${s}'` : `"${s}"`);
})();
