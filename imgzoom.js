// Zoom & rotate images (settings.imgZoom). Holding the chosen key (Option/Alt by default,
// or Ctrl or Shift) and scrolling over an image zooms it, always around the image's own
// centre, wherever the cursor is. Right-click an image → "Image controls" shows four
// faint controls at its bottom-right: rotate left, rotate right, reset, and a zoom slider
// (10%–500%). Only the image's inline transform is changed; reset puts it back as it was.
(() => {
  if (window.__ttImgZoom) return;
  window.__ttImgZoom = true;

  const MIN = 0.1, MAX = 5, STEP = 1.12;
  let enabled = false, modifier = "alt";
  const state = new Map(); // img → { scale, rot, saved: original inline styles }

  function apply(settings) {
    const z = settings?.imgZoom || {};
    enabled = !!z.enabled;
    modifier = ["alt", "ctrl", "shift"].includes(z.modifier) ? z.modifier : "alt";
    if (!enabled) { for (const img of [...state.keys()]) reset(img); hideControls(); }
  }
  chrome.storage.local.get("tt").then(({ tt }) => apply(tt));
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.tt && chrome.runtime?.id) apply(c.tt.newValue); });

  const imageIn = (e) => e.composedPath().find((n) => n instanceof HTMLImageElement) || null;
  const held = (e) => (modifier === "alt" ? e.altKey : modifier === "ctrl" ? e.ctrlKey : e.shiftKey);

  // ---- Transform -------------------------------------------------------------------------

  const PROPS = ["transform", "transform-origin", "transition", "position", "z-index"];
  function stateOf(img) {
    let st = state.get(img);
    if (!st) {
      st = { scale: 1, rot: 0, saved: PROPS.map((p) => [p, img.style.getPropertyValue(p), img.style.getPropertyPriority(p)]) };
      state.set(img, st);
    }
    return st;
  }

  function render(img, st) {
    if (st.scale === 1 && st.rot % 360 === 0) return reset(img);
    img.style.setProperty("transform-origin", "center center", "important");
    img.style.setProperty("transition", "transform .08s ease-out", "important");
    img.style.setProperty("transform", `rotate(${st.rot}deg) scale(${st.scale})`, "important");
    // Drawn above its neighbours while zoomed or turned.
    if (getComputedStyle(img).position === "static") img.style.setProperty("position", "relative", "important");
    img.style.setProperty("z-index", "2147483000", "important");
    syncControls();
  }

  function reset(img) {
    const st = state.get(img);
    if (!st) return;
    for (const [p, v, prio] of st.saved) v ? img.style.setProperty(p, v, prio) : img.style.removeProperty(p);
    if (!img.getAttribute("style")) img.removeAttribute("style");
    state.delete(img);
    syncControls();
  }

  function zoomTo(img, scale) {
    const st = stateOf(img);
    st.scale = Math.min(MAX, Math.max(MIN, Math.round(scale * 100) / 100));
    if (Math.abs(st.scale - 1) < 0.04) st.scale = 1; // snaps back to 100%
    render(img, st);
  }

  function rotate(img, by) {
    const st = stateOf(img);
    st.rot += by;
    render(img, st);
  }

  // Modifier + scroll over an image. Shift turns vertical scrolling into horizontal on
  // some systems, so either direction counts.
  addEventListener("wheel", (e) => {
    if (!enabled || !held(e)) return;
    const img = imageIn(e);
    if (!img) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const d = e.deltaY || e.deltaX;
    if (!d) return;
    zoomTo(img, stateOf(img).scale * (d < 0 ? STEP : 1 / STEP));
  }, { capture: true, passive: false });

  // ---- Controls ---------------------------------------------------------------------------

  let lastRightClicked = null;
  addEventListener("contextmenu", (e) => { lastRightClicked = imageIn(e); }, true);

  let host = null, root = null, shownFor = null, raf = 0;
  const ICON = {
    left: '<path d="M9 7H5V3"/><path d="M5.5 7A8 8 0 1 1 4 13"/>',
    right: '<path d="M15 7h4V3"/><path d="M18.5 7A8 8 0 1 0 20 13"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/>',
  };

  function buildControls() {
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;top:0;";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .bar { display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 12px; background: rgba(16,16,16,.78);
          color: #fff; font: 500 11px system-ui, sans-serif; opacity: .22; transition: opacity .15s; box-shadow: 0 4px 18px rgba(0,0,0,.3); }
        .bar:hover, .bar:focus-within { opacity: 1; }
        button { all: unset; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; cursor: pointer; }
        button:hover { background: rgba(255,255,255,.16); }
        svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        input { width: 96px; margin: 0 4px; accent-color: #fff; cursor: pointer; }
        .pct { min-width: 34px; text-align: right; padding-right: 4px; font-variant-numeric: tabular-nums; }
      </style>
      <div class="bar">
        <button class="left" title="Rotate left 90°"><svg viewBox="0 0 24 24">${ICON.left}</svg></button>
        <button class="right" title="Rotate right 90°"><svg viewBox="0 0 24 24">${ICON.right}</svg></button>
        <button class="reset" title="Back to normal"><svg viewBox="0 0 24 24">${ICON.reset}</svg></button>
        <input type="range" min="10" max="500" step="5" value="100" title="Zoom">
        <span class="pct">100%</span>
      </div>`;
    const $ = (s) => root.querySelector(s);
    $(".left").onclick = () => shownFor && rotate(shownFor, -90);
    $(".right").onclick = () => shownFor && rotate(shownFor, 90);
    $(".reset").onclick = () => shownFor && reset(shownFor);
    $("input").oninput = (e) => shownFor && zoomTo(shownFor, e.target.value / 100);
    // Scrolling over the controls moves the slider, no key needed.
    root.querySelector(".bar").addEventListener("wheel", (e) => {
      if (!shownFor) return;
      e.preventDefault();
      zoomTo(shownFor, stateOf(shownFor).scale * ((e.deltaY || e.deltaX) < 0 ? STEP : 1 / STEP));
    }, { passive: false });
    addEventListener("keydown", (e) => { if (e.key === "Escape" && shownFor) hideControls(); }, true);
  }

  function showControls(img) {
    if (!img?.isConnected) return;
    if (!host) buildControls();
    shownFor = img;
    document.documentElement.append(host);
    syncControls();
    cancelAnimationFrame(raf);
    const follow = () => { if (!shownFor) return; place(); raf = requestAnimationFrame(follow); };
    follow();
  }

  function hideControls() {
    shownFor = null;
    cancelAnimationFrame(raf);
    host?.remove();
  }

  // Bottom-right corner of the image's visible part, inside it.
  function place() {
    if (!shownFor.isConnected) return hideControls();
    const r = shownFor.getBoundingClientRect();
    const bar = root.querySelector(".bar").getBoundingClientRect();
    const right = Math.min(r.right, innerWidth) - 10, bottom = Math.min(r.bottom, innerHeight) - 10;
    host.style.left = `${Math.max(4, right - bar.width)}px`;
    host.style.top = `${Math.max(4, bottom - bar.height)}px`;
  }

  function syncControls() {
    if (!shownFor || !root) return;
    const pct = Math.round((state.get(shownFor)?.scale ?? 1) * 100);
    root.querySelector("input").value = pct;
    root.querySelector(".pct").textContent = `${pct}%`;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "ttImgControls" || !enabled) return;
    if (shownFor && shownFor === lastRightClicked) hideControls(); // the menu again: hide
    else showControls(lastRightClicked);
  });
})();
