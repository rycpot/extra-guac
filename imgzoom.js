// Zoom & rotate images (settings.imgZoom). Holding the chosen key (Option/Alt by default,
// ⌘ on a Mac / Ctrl elsewhere, or Shift) and scrolling over an image zooms it, always
// around the image's own centre, wherever the cursor is. Zooming brings up faint controls at the bottom-right of
// the window (they go again 3 s after the last zoom unless pointed at); right-click an
// image → "Image controls" shows them until closed: rotate left, rotate right, back to 1:1, a
// zoom slider (10%–500%) and ✕. Only the image's inline styles change; 1:1 puts them back.
//
// Zooming follows how far you scroll (a trackpad's small steps zoom a little, a mouse
// notch more) and glides there frame by frame. A gesture keeps zooming through its
// momentum even after the key is let go, so the page never scrolls in the middle of it.
(() => {
  if (window.__ttImgZoom) return;
  window.__ttImgZoom = true;

  const MIN = 0.1, MAX = 5;
  const SENSITIVITY = 0.0022; // zoom per pixel scrolled: one mouse notch (~100px) ≈ ×1.25
  const GESTURE_MS = 260; // events this soon after a zoom belong to the same gesture
  let enabled = false, modifier = "alt";
  const state = new Map(); // img → { scale, target, rot, saved, raf }

  function apply(settings) {
    const z = settings?.imgZoom || {};
    enabled = !!z.enabled;
    modifier = ["alt", "ctrl", "shift"].includes(z.modifier) ? z.modifier : "alt";
    if (!enabled) { for (const img of [...state.keys()]) reset(img); hideControls(); }
  }
  chrome.storage.local.get("tt").then(({ tt }) => apply(tt));
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.tt && chrome.runtime?.id) apply(c.tt.newValue); });

  const imageIn = (e) => e.composedPath().find((n) => n instanceof HTMLImageElement) || null;
  // "ctrl" is ⌘ on a Mac (where Ctrl+click is the right-click menu and a trackpad pinch
  // reports Ctrl) and Ctrl everywhere else.
  const MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  const held = (e) => (modifier === "alt" ? e.altKey : modifier === "ctrl" ? (MAC ? e.metaKey : e.ctrlKey) : e.shiftKey);
  const clamp = (v) => Math.min(MAX, Math.max(MIN, v));

  // ---- Transform -------------------------------------------------------------------------

  const PROPS = ["transform", "transform-origin", "transition", "position", "z-index", "will-change"];
  function stateOf(img) {
    let st = state.get(img);
    if (!st) {
      st = { scale: 1, target: 1, rot: 0, raf: 0, saved: PROPS.map((p) => [p, img.style.getPropertyValue(p), img.style.getPropertyPriority(p)]) };
      state.set(img, st);
    }
    return st;
  }

  function paint(img, st) {
    img.style.setProperty("transform-origin", "center center", "important");
    img.style.setProperty("transition", "none", "important"); // the glide is done here, frame by frame
    img.style.setProperty("will-change", "transform", "important");
    img.style.setProperty("transform", `rotate(${st.rot}deg) scale(${st.scale})`, "important");
    if (getComputedStyle(img).position === "static") img.style.setProperty("position", "relative", "important");
    img.style.setProperty("z-index", "2147483000", "important"); // above its neighbours while changed
  }

  // Glides the shown scale towards the target (a third of the way each frame).
  function animate(img, st) {
    if (st.raf) return;
    const step = () => {
      st.raf = 0;
      if (!state.has(img)) return;
      const diff = st.target - st.scale;
      st.scale = Math.abs(diff) < 0.002 ? st.target : st.scale + diff * 0.35;
      if (st.scale === 1 && st.target === 1 && st.rot % 360 === 0) return reset(img);
      paint(img, st);
      syncControls();
      if (st.scale !== st.target) st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  }

  function reset(img) {
    const st = state.get(img);
    if (!st) return;
    cancelAnimationFrame(st.raf);
    for (const [p, v, prio] of st.saved) v ? img.style.setProperty(p, v, prio) : img.style.removeProperty(p);
    if (!img.getAttribute("style")) img.removeAttribute("style");
    state.delete(img);
    syncControls();
  }

  function zoomTo(img, scale, instant = false) {
    const st = stateOf(img);
    st.target = clamp(scale);
    if (instant) st.scale = st.target;
    animate(img, st);
  }

  function rotate(img, by) {
    const st = stateOf(img);
    st.rot += by;
    paint(img, st);
    animate(img, st);
  }

  // ---- Scrolling ---------------------------------------------------------------------------

  let gesture = { img: null, at: 0 };
  addEventListener("wheel", (e) => {
    if (!enabled) return;
    const img = imageIn(e);
    const ongoing = gesture.img && img === gesture.img && performance.now() - gesture.at < GESTURE_MS;
    if (!img || (!held(e) && !ongoing)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Pixels scrolled, whatever unit the device reports. Only the up/down movement counts:
    // a Magic Mouse or trackpad swipe is never perfectly vertical, and letting its sideways
    // part in makes the zoom jitter in and out. macOS turns Shift+scroll sideways, so with
    // Shift the sideways movement is used when there's no vertical.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    const raw = (modifier === "shift" && !e.deltaY ? e.deltaX : e.deltaY) * unit;
    const d = Math.max(-120, Math.min(120, raw)); // one event never jumps more than a notch
    gesture = { img, at: performance.now() };
    autoShow(img); // the %, 1:1 and the rest show up while zooming
    if (!d) return;
    const st = stateOf(img);
    let target = clamp(st.target * Math.exp(-d * SENSITIVITY));
    if (Math.abs(target - 1) < 0.015) target = 1; // settles on 100% when passing it
    zoomTo(img, target);
  }, { capture: true, passive: false });

  // ---- Controls (fixed at the bottom-right of the window) -----------------------------------

  let lastRightClicked = null;
  addEventListener("contextmenu", (e) => { lastRightClicked = imageIn(e); }, true);

  let host = null, root = null, shownFor = null;
  // Shown by zooming (not the menu): they go 3 s after the last zoom, unless the pointer is
  // on them, which keeps them until closed.
  let auto = false, autoTimer = 0;
  const AUTO_HIDE_MS = 3000;
  function autoShow(img) {
    if (shownFor !== img) {
      showControls(img);
      auto = true;
    }
    if (!auto) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { if (auto) hideControls(); }, AUTO_HIDE_MS);
  }
  const ICON = {
    left: '<path d="M8 4.5 4.5 8 8 11.5"/><path d="M4.5 8H14a5.5 5.5 0 0 1 0 11h-3"/>',
    right: '<path d="M16 4.5 19.5 8 16 11.5"/><path d="M19.5 8H10a5.5 5.5 0 0 0 0 11h3"/>',
    close: '<path d="M7 7l10 10M17 7 7 17"/>',
  };

  function buildControls() {
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    host.setAttribute("data-eg-zoom", ""); // the screenshot card (shot-card.js) sits above it
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .bar { display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 12px; background: rgba(16,16,16,.8);
          color: #fff; font: 600 11px system-ui, sans-serif; opacity: .3; box-shadow: 0 4px 18px rgba(0,0,0,.3); }
        /* Stays faint even while used; only the button under the pointer is marked, lightly. */
        button { all: unset; height: 26px; min-width: 26px; display: grid; place-items: center; border-radius: 8px; cursor: pointer; }
        button:hover { background: rgba(255,255,255,.12); }
        .one { padding: 0 6px; font-size: 11px; letter-spacing: .02em; }
        .x { min-width: 20px; height: 20px; margin-left: 2px; }
        svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        .x svg { width: 11px; height: 11px; }
        input { width: 96px; margin: 0 4px; accent-color: #fff; cursor: pointer; }
        .pct { min-width: 34px; text-align: right; padding-right: 2px; font-variant-numeric: tabular-nums; font-weight: 500; }
      </style>
      <div class="bar">
        <button class="left" title="Rotate left 90°"><svg viewBox="0 0 24 24">${ICON.left}</svg></button>
        <button class="right" title="Rotate right 90°"><svg viewBox="0 0 24 24">${ICON.right}</svg></button>
        <button class="one" title="Back to normal (100%, not rotated)">1:1</button>
        <input type="range" min="10" max="500" step="1" value="100" title="Zoom">
        <span class="pct">100%</span>
        <button class="x" title="Close the controls (Esc)"><svg viewBox="0 0 24 24">${ICON.close}</svg></button>
      </div>`;
    const $ = (s) => root.querySelector(s);
    $(".left").onclick = () => shownFor && rotate(shownFor, -90);
    $(".right").onclick = () => shownFor && rotate(shownFor, 90);
    $(".one").onclick = () => shownFor && reset(shownFor);
    $(".x").onclick = hideControls;
    $(".bar").addEventListener("pointerenter", () => { auto = false; clearTimeout(autoTimer); }); // touched: stays
    $("input").oninput = (e) => shownFor && zoomTo(shownFor, e.target.value / 100, true);
    // Scrolling over the controls zooms too, no key needed.
    $(".bar").addEventListener("wheel", (e) => {
      if (!shownFor) return;
      e.preventDefault();
      const d = Math.max(-120, Math.min(120, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
      zoomTo(shownFor, stateOf(shownFor).target * Math.exp(-d * SENSITIVITY));
    }, { passive: false });
    addEventListener("keydown", (e) => { if (e.key === "Escape" && shownFor) hideControls(); }, true);
  }

  function showControls(img) {
    if (!img?.isConnected) return;
    auto = false;
    clearTimeout(autoTimer);
    if (!host) buildControls();
    shownFor = img;
    document.documentElement.append(host);
    syncControls();
  }

  function hideControls() {
    shownFor = null;
    auto = false;
    clearTimeout(autoTimer);
    host?.remove();
  }

  function syncControls() {
    if (!shownFor || !root) return;
    if (!shownFor.isConnected) return hideControls();
    const pct = Math.round((state.get(shownFor)?.scale ?? 1) * 100);
    const input = root.querySelector("input");
    if (root.activeElement !== input) input.value = pct;
    root.querySelector(".pct").textContent = `${pct}%`;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "ttImgControls" || !enabled) return;
    if (shownFor && shownFor === lastRightClicked) hideControls(); // the menu again: hide
    else showControls(lastRightClicked);
  });
})();
