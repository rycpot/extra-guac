// Copy & right-click unlock, in the page's own world (registered for the sites it's on;
// bg-unlock.js). The page's own listeners aren't stopped (that would break menus, editors
// and drag & drop): the page's code still runs, it just can't cancel a copy, a right-click
// or a text selection. Its own right-click menu still opens; so does Chrome's.
//
// - preventDefault() and returnValue = false are ignored for copy, cut, contextmenu and
//   selectstart, and for Ctrl/⌘ + C / X / A. Inside text fields and editors (contenteditable)
//   they're left alone, as web apps there handle copy and right-click themselves.
// - "return false" from on<event> handlers (oncontextmenu="return false") is ignored too.
// - A mousedown canceled page-wide (window, document, html or body) to stop selecting is
//   ignored on text only; buttons, links and other controls keep their own mousedown.
// - user-select: none is lifted, except on form controls and buttons.
// - A selection made invisible with a transparent ::selection color is shown again.
//
// window[Symbol.for("extra-guac.unlock")].off() / .on() switch it without a reload.
(() => {
  const KEY = Symbol.for("extra-guac.unlock");
  if (window[KEY]) return window[KEY].on();
  let on = true;
  const root = document.documentElement;

  const CANCEL = new Set(["copy", "cut", "contextmenu", "selectstart"]);
  const CONTROL = "button, input, textarea, select, option, a[href], label, summary, video, audio, canvas, iframe, [role=button], [role=slider], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [draggable=true], [contenteditable]:not([contenteditable=false])";
  const PAGE_WIDE = (t) => t === window || t === document || t === root || t === document.body;
  const elementOf = (n) => (n?.nodeType === 1 ? n : n?.parentElement || null);
  const editable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const target = (e) => elementOf(e.composedPath?.()[0] || e.target);

  // Whether the page may not cancel this event (and the handler that's running now).
  function protect(e) {
    if (!on || !e) return false;
    const t = e.type;
    // (Chrome aims copy and cut at the field or editor they come from, else at the selected text.)
    if (t === "copy" || t === "cut" || t === "contextmenu") return !editable(target(e));
    if (t === "selectstart") return !target(e)?.closest?.(CONTROL);
    if (t === "keydown" || t === "keyup" || t === "keypress") {
      return (e.ctrlKey || e.metaKey) && !e.altKey && /^[cxa]$/i.test(e.key || "") && !editable(target(e));
    }
    if (t === "mousedown") {
      if (e.button !== 0 || !PAGE_WIDE(e.currentTarget)) return false;
      const el = target(e);
      return !!el && !el.closest(CONTROL) && !editable(el);
    }
    return false;
  }

  // preventDefault and the old returnValue = false: ignored while protected.
  const preventDefault = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () {
    if (!protect(this)) return preventDefault.call(this);
  };
  const rv = Object.getOwnPropertyDescriptor(Event.prototype, "returnValue");
  if (rv?.set) {
    Object.defineProperty(Event.prototype, "returnValue", {
      ...rv,
      set(v) { if (v !== false || !protect(this)) rv.set.call(this, v); },
    });
  }

  // "return false" from an on<event> handler cancels without calling preventDefault. Just
  // before the event reaches them, the handlers on its way are wrapped to drop that
  // (only while switched on; otherwise they're passed through as they are).
  const wrapped = new WeakSet();
  function defuse(node, type) {
    const prop = `on${type}`;
    let h;
    try { h = node[prop]; } catch { return; }
    if (typeof h !== "function" || wrapped.has(h)) return;
    const w = function (ev) {
      const r = h.apply(this, arguments);
      return r === false && protect(ev) ? undefined : r;
    };
    wrapped.add(w);
    try { node[prop] = w; } catch {}
  }
  const WATCH = ["copy", "cut", "contextmenu", "selectstart", "keydown", "keyup", "keypress", "mousedown"];
  for (const type of WATCH) {
    window.addEventListener(type, (e) => {
      if (!on) return;
      if (CANCEL.has(type) || type === "mousedown") {
        // mousedown: page-wide handlers only (see protect).
        const path = type === "mousedown" ? [window, document, root, document.body] : e.composedPath();
        for (const n of path) if (n) defuse(n, type);
      } else if ((e.ctrlKey || e.metaKey) && /^[cxa]$/i.test(e.key || "")) {
        for (const n of e.composedPath()) defuse(n, type);
      }
    }, true);
  }

  // Selecting text: lift user-select: none (not on form controls, buttons and the like).
  const STYLE_ID = "eg-unlock-style";
  const css = `
    html[data-eg-unlock] body, html[data-eg-unlock] body *:not(input, textarea, select, button, [role=button], [role=slider], [draggable=true]) {
      -webkit-user-select: text !important; user-select: text !important;
    }
    html[data-eg-unlock~=sel] body *::selection { background: rgb(51 144 255 / .35) !important; }`;
  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || root).append(s);
  }
  // At document_start there's no <head> yet; the style is added as soon as there is.
  if (document.head) addStyle();
  else new MutationObserver((_, o) => { if (document.head) { o.disconnect(); if (on) addStyle(); } }).observe(root, { childList: true });

  // A selection hidden with a transparent ::selection color: shown again (only then).
  let selFixed = false;
  document.addEventListener("selectionchange", () => {
    if (!on || selFixed) return;
    const el = elementOf(getSelection()?.anchorNode);
    if (!el || editable(el)) return;
    const bg = getComputedStyle(el, "::selection").backgroundColor;
    const alpha = /rgba?\(([^)]+)\)/.exec(bg)?.[1].split(/[\s,/]+/).filter(Boolean)[3];
    if (bg === "transparent" || (alpha !== undefined && parseFloat(alpha) === 0)) {
      selFixed = true;
      setAttr();
    }
  });

  const setAttr = () => root.setAttribute("data-eg-unlock", selFixed ? "on sel" : "on");
  setAttr();

  Object.defineProperty(window, KEY, {
    value: {
      on() { on = true; setAttr(); if (document.head) addStyle(); },
      off() { on = false; root.removeAttribute("data-eg-unlock"); document.getElementById(STYLE_ID)?.remove(); },
    },
  });
})();
