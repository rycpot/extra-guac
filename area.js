// Area screenshot overlay: drag a box over the visible page, resize it with the
// handles or move it by dragging inside, then save it with ✓ (or Enter) or upload it with
// ☁ (to the default image host; the card shows the link) at its bottom-right. ✕ or Esc
// cancels. Runs in a closed shadow root so page CSS can't touch it.
// Injected by bg-capture.js (startAreaSelection), which takes the shot on "areaSelected".
(() => {
  if (window.__ttArea) return;
  window.__ttArea = true;

  const MIN = 6;
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(0,0,0,.35);
        font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; }
      .layer.has-sel { background: transparent; }
      .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 7px 12px;
        border-radius: 8px; background: rgba(12,12,12,.88); color: rgba(255,255,255,.88); pointer-events: none; }
      .sel { position: absolute; border: 1.5px solid #fff; outline: 1px solid rgba(0,0,0,.5);
        box-shadow: 0 0 0 100vmax rgba(0,0,0,.35); cursor: move; }
      .size { position: absolute; left: 0; top: -24px; padding: 2px 6px; border-radius: 5px;
        background: rgba(12,12,12,.88); color: rgba(255,255,255,.88); white-space: nowrap; pointer-events: none; }
      .h { position: absolute; width: 10px; height: 10px; background: #fff; border: 1px solid rgba(0,0,0,.6); border-radius: 2px; }
      .h[data-d=nw] { left: -6px; top: -6px; cursor: nwse-resize; }
      .h[data-d=n]  { left: calc(50% - 5px); top: -6px; cursor: ns-resize; }
      .h[data-d=ne] { right: -6px; top: -6px; cursor: nesw-resize; }
      .h[data-d=e]  { right: -6px; top: calc(50% - 5px); cursor: ew-resize; }
      .h[data-d=se] { right: -6px; bottom: -6px; cursor: nwse-resize; }
      .h[data-d=s]  { left: calc(50% - 5px); bottom: -6px; cursor: ns-resize; }
      .h[data-d=sw] { left: -6px; bottom: -6px; cursor: nesw-resize; }
      .h[data-d=w]  { left: -6px; top: calc(50% - 5px); cursor: ew-resize; }
      .bar { position: absolute; display: flex; gap: 6px; cursor: default; }
      .bar button { width: 32px; height: 32px; border: 0; border-radius: 8px; cursor: pointer;
        display: grid; place-items: center; background: rgba(12,12,12,.9); color: rgba(255,255,255,.9);
        box-shadow: 0 2px 10px rgba(0,0,0,.35); }
      .bar button:hover { background: rgba(40,40,40,.95); }
      .bar .yes { color: #30d158; }
      .bar .up[aria-disabled=true] { opacity: .45; cursor: default; }
      .pick { position: absolute; bottom: calc(100% + 8px); left: 0; display: flex; gap: 4px; padding: 4px; border-radius: 10px;
        background: rgba(12,12,12,.94); box-shadow: 0 4px 14px rgba(0,0,0,.35); }
      .pick button { width: auto; height: 28px; padding: 0 12px; font: 500 12px system-ui, sans-serif; background: transparent; box-shadow: none; }
      .pick button:hover { background: rgba(255,255,255,.12); }
      /* Why ☁ is off, shown at once on hover (the browser's own tooltip waits a second). */
      .tip { position: absolute; bottom: calc(100% + 8px); padding: 6px 10px; border-radius: 8px; white-space: nowrap;
        background: rgba(12,12,12,.94); color: rgba(255,255,255,.92); font: 500 12px system-ui, sans-serif;
        box-shadow: 0 4px 14px rgba(0,0,0,.35); pointer-events: none; }
      svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
      [hidden] { display: none !important; }
    </style>
    <div class="layer">
      <div class="hint">Drag to select an area · Esc to cancel</div>
      <div class="sel" hidden>
        <span class="size"></span>
        ${["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((d) => `<i class="h" data-d="${d}"></i>`).join("")}
      </div>
      <div class="bar" hidden>
        <button class="up" title="Upload"><svg viewBox="0 0 24 24"><path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.2 4.7 4.7 0 0 0 7 18.5Z"/></svg></button>
        <button class="no" title="Cancel (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <button class="yes" title="Save (Enter)"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
      </div>
    </div>`;
  document.documentElement.append(host);

  const layer = root.querySelector(".layer");
  const sel = root.querySelector(".sel");
  const size = root.querySelector(".size");
  const bar = root.querySelector(".bar");
  const hint = root.querySelector(".hint");
  let rect = null; // { x, y, width, height } in CSS pixels of the viewport
  let drag = null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function render() {
    const has = !!rect && rect.width >= MIN && rect.height >= MIN;
    layer.classList.toggle("has-sel", !!rect);
    sel.hidden = !rect;
    bar.hidden = !has || !!drag;
    if (drag) root.querySelector(".pick")?.remove();
    hint.hidden = !!rect;
    if (!rect) return;
    Object.assign(sel.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    const inside = rect.y < 26; // no room above the box: show the size inside it
    size.style.top = inside ? "4px" : "-24px";
    size.style.left = inside ? "4px" : "0";
    // Buttons at the bottom-right, just below the box; inside it when there's no room below.
    const below = rect.y + rect.height + 8;
    const barWidth = 108;
    bar.style.left = `${clamp(rect.x + rect.width - barWidth, 4, innerWidth - barWidth - 4)}px`;
    bar.style.top = `${below + 32 <= innerHeight ? below : rect.y + rect.height - 40}px`;
  }

  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || bar.contains(e.composedPath()[0])) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    const t = e.composedPath()[0];
    const start = rect && { ...rect };
    if (t.classList?.contains("h")) drag = { kind: "resize", dir: t.dataset.d, x0: e.clientX, y0: e.clientY, start };
    else if (rect && (t === sel || sel.contains(t))) drag = { kind: "move", x0: e.clientX, y0: e.clientY, start };
    else {
      drag = { kind: "new", x0: e.clientX, y0: e.clientY };
      rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
    }
    render();
  });

  layer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const x = clamp(e.clientX, 0, innerWidth), y = clamp(e.clientY, 0, innerHeight);
    const dx = x - drag.x0, dy = y - drag.y0;
    if (drag.kind === "new") {
      rect = { x: Math.min(x, drag.x0), y: Math.min(y, drag.y0), width: Math.abs(dx), height: Math.abs(dy) };
    } else if (drag.kind === "move") {
      const s = drag.start;
      rect = { ...s, x: clamp(s.x + dx, 0, innerWidth - s.width), y: clamp(s.y + dy, 0, innerHeight - s.height) };
    } else {
      const s = drag.start, d = drag.dir;
      let l = s.x, t = s.y, r = s.x + s.width, b = s.y + s.height;
      if (d.includes("w")) l = clamp(s.x + dx, 0, r - MIN);
      if (d.includes("e")) r = clamp(r + dx, l + MIN, innerWidth);
      if (d.includes("n")) t = clamp(s.y + dy, 0, b - MIN);
      if (d.includes("s")) b = clamp(b + dy, t + MIN, innerHeight);
      rect = { x: l, y: t, width: r - l, height: b - t };
    }
    render();
  });

  layer.addEventListener("pointerup", () => {
    if (!drag) return;
    drag = null;
    if (rect && (rect.width < MIN || rect.height < MIN)) rect = null;
    render();
  });

  // ☁ goes to the host picked in settings → image upload; with "show both hosts" it opens a
  // small picker of the two. None on: it says where to turn one on.
  const up = root.querySelector(".up");
  let canUpload = false, choices = [];
  const NO_HOST = "Turn on imglink or x02 in upload images to upload";
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.textContent = NO_HOST;
  tip.hidden = true;
  bar.append(tip);
  up.addEventListener("pointerenter", () => {
    tip.hidden = canUpload;
    // Grow towards the side with room: leftwards from the bar's right edge, unless that's off-screen.
    const room = bar.getBoundingClientRect().right;
    tip.style.left = room > 360 ? "auto" : "0";
    tip.style.right = room > 360 ? "0" : "auto";
  });
  up.addEventListener("pointerleave", () => { tip.hidden = true; });
  chrome.storage.local.get("tt").then(({ tt }) => {
    const u = tt?.upload || {};
    const on = [u.imglink && "imglink", u.x02 && u.x02Verified && "x02"].filter(Boolean); // as TT.uploadChoices
    choices = on.includes(u.menu) ? [u.menu] : on;
    canUpload = on.length > 0;
    // Usable: the normal tooltip. Off: no title (it would show late, on top), our own instead.
    if (canUpload) up.title = choices.length === 1 ? `Upload to ${choices[0]}` : "Upload to…";
    else up.removeAttribute("title");
    up.setAttribute("aria-label", canUpload ? up.title : NO_HOST);
    up.setAttribute("aria-disabled", String(!canUpload));
  });
  up.addEventListener("click", () => {
    if (!canUpload) return;
    if (choices.length === 1) return confirm("upload", choices[0]);
    if (root.querySelector(".pick")) return root.querySelector(".pick").remove();
    const pick = document.createElement("div");
    pick.className = "pick";
    for (const h of choices) {
      const b = document.createElement("button");
      b.textContent = h;
      b.title = `Upload to ${h}`;
      b.onclick = () => confirm("upload", h);
      pick.append(b);
    }
    bar.append(pick);
  });
  root.querySelector(".no").addEventListener("click", cancel);
  root.querySelector(".yes").addEventListener("click", () => confirm());
  addEventListener("keydown", onKey, true);

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    if (e.key === "Enter" && rect && !drag) { e.preventDefault(); e.stopPropagation(); confirm(); }
  }

  function cleanup() {
    removeEventListener("keydown", onKey, true);
    host.remove();
    delete window.__ttArea;
  }

  function cancel() {
    cleanup();
  }

  function confirm(action = "save", host = null) {
    const chosen = { ...rect };
    cleanup();
    // Wait until the overlay is gone from the screen before the tab is captured.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chrome.runtime.sendMessage({ type: "areaSelected", rect: chosen, viewportWidth: innerWidth, action, host });
    }));
  }

  render();
})();
