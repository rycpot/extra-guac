// "What color?": shows a frozen screenshot of the tab with a crosshair; a magnifier card
// sits beside the pointer (below right, or the other side near the window's edges) with
// the color under it; clicking copies that color's hex. Esc cancels. The page underneath
// never receives the click. Given onPick (the screenshot tab's eyedropper, shot-edit.js), the
// click hands the color to it instead of copying it, and Esc hands it null.
// The magnifier shows CELLS × CELLS page pixels, one color each.
// Edges are drawn with in-between screen pixels (the soft gray around text, say), which
// are a blend of the two colors either side rather than a color on the page. Each is
// shown and picked as the closer of those two colors. Holding Alt/Option shows and picks
// the exact pixels.
(() => {
  if (window.__ttColorPicker) return;
  const CELLS = 17; // page pixels across the magnifier
  const VIEW = 150; // the magnifier's size, CSS pixels
  const GAP = 22; // between the pointer and the card
  window.__ttColorPicker = (dataUrl, onPick) => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .layer { position: fixed; inset: 0; cursor: crosshair; background-size: 100% 100%; }
        .card { position: fixed; padding: 7px 7px 0; border-radius: 14px; overflow: hidden; pointer-events: none;
          background: rgba(30,30,30,.96); box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 8px 26px rgba(0,0,0,.45); }
        canvas { display: block; width: ${VIEW}px; height: ${VIEW}px; border-radius: 8px; }
        .center { position: absolute; left: ${7 + VIEW / 2}px; top: ${7 + VIEW / 2}px; width: ${VIEW / CELLS}px;
          height: ${VIEW / CELLS}px; transform: translate(-50%,-50%); border: 1.5px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.6); }
        .strip { margin: 7px -7px 0; padding: 8px 0; text-align: center; font: 600 12.5px ui-monospace, "SF Mono", Menlo, monospace; }
        .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 7px 12px; border-radius: 8px;
          background: rgba(12,12,12,.88); color: rgba(255,255,255,.88); font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; }
      </style>
      <div class="layer"></div>
      <div class="hint">Click to ${onPick ? "pick" : "copy"} a color · hold ${/Mac/.test(navigator.platform) ? "⌥ option" : "Alt"} for the exact pixel · Esc to cancel</div>
      <div class="card" hidden><canvas></canvas><span class="center"></span><div class="strip"></div></div>`;
    const layer = root.querySelector(".layer");
    const card = root.querySelector(".card");
    const strip = root.querySelector(".strip");
    const canvas = root.querySelector("canvas");
    const size = canvas.width = canvas.height = Math.round(VIEW * devicePixelRatio);
    const zoom = canvas.getContext("2d");
    const cells = new ImageData(CELLS, CELLS);
    const small = Object.assign(document.createElement("canvas"), { width: CELLS, height: CELLS });
    layer.style.backgroundImage = `url("${dataUrl}")`;
    document.documentElement.append(host);
    (window.__egEsc ??= new Set()).add(cleanup); // Esc from the side panel (bg-pickers.js "pageEscape")

    const img = new Image();
    const full = document.createElement("canvas");
    const ctx = full.getContext("2d", { willReadFrequently: true });
    let scale = 1, current = null;
    let cx = 0, cy = 0, exact = false; // the pointer
    img.onload = () => {
      full.width = img.naturalWidth;
      full.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      scale = img.naturalWidth / innerWidth;
    };
    img.src = dataUrl;

    const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

    function onMove(e) {
      if (!full.width) return;
      cx = e.clientX;
      cy = e.clientY;
      exact = e.altKey;
      render();
    }

    // Each cell is a page pixel, shown as the screenshot pixel at its top left (snapped
    // unless Alt is held); the middle one is the color being picked.
    function render() {
      const half = (CELLS - 1) / 2, x0 = Math.floor(cx) - half, y0 = Math.floor(cy) - half;
      const read = area(Math.floor(x0 * scale) - SNAP_REACH, Math.floor(y0 * scale) - SNAP_REACH,
        Math.ceil(CELLS * scale) + 2 * SNAP_REACH + 1, Math.ceil(CELLS * scale) + 2 * SNAP_REACH + 1);
      for (let j = 0; j < CELLS; j++) {
        for (let i = 0; i < CELLS; i++) {
          const x = Math.floor((x0 + i) * scale), y = Math.floor((y0 + j) * scale);
          const color = read(x, y) ? (exact ? read(x, y) : snap(read, x, y)) : [0, 0, 0];
          const k = (j * CELLS + i) * 4;
          cells.data.set([...color, read(x, y) ? 255 : 0], k);
          if (i === half && j === half) current = read(x, y) ? hex(color) : null;
        }
      }
      small.getContext("2d").putImageData(cells, 0, 0);
      zoom.imageSmoothingEnabled = false;
      zoom.clearRect(0, 0, size, size);
      zoom.drawImage(small, 0, 0, size, size);
      zoom.strokeStyle = "rgba(128,128,128,.28)";
      zoom.lineWidth = 1;
      zoom.beginPath();
      for (let i = 1; i < CELLS; i++) {
        const at = Math.round((i * size) / CELLS) + 0.5;
        zoom.moveTo(at, 0); zoom.lineTo(at, size);
        zoom.moveTo(0, at); zoom.lineTo(size, at);
      }
      zoom.stroke();
      const [r, g, b] = current ? cells.data.slice(((half * CELLS) + half) * 4) : [0, 0, 0];
      strip.textContent = current || "—";
      strip.style.background = current || "transparent";
      strip.style.color = 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#000" : "#fff";
      // Below right of the pointer, or on the other side where that runs off the window.
      card.hidden = false;
      const w = card.offsetWidth, h = card.offsetHeight;
      card.style.left = `${cx + GAP + w > innerWidth - 4 ? Math.max(4, cx - GAP - w) : cx + GAP}px`;
      card.style.top = `${cy + GAP + h > innerHeight - 4 ? Math.max(4, cy - GAP - h) : cy + GAP}px`;
    }

    // Reads a block of the screenshot once; returns a lookup for pixels inside it.
    function area(x0, y0, w, h) {
      x0 = Math.max(0, x0);
      y0 = Math.max(0, y0);
      w = Math.max(1, Math.min(full.width - x0, w));
      h = Math.max(1, Math.min(full.height - y0, h));
      const data = ctx.getImageData(x0, y0, w, h).data;
      return (x, y) => {
        if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return null;
        const i = ((y - y0) * w + (x - x0)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
    }

    // An edge pixel blended from the colors either side of it gives way to the closer of
    // the two. Along each direction (across, down, both diagonals) it follows the change out
    // to where the color settles; it's a blend when it lies on the line between the two
    // settled colors, and they differ clearly (so smooth gradients and photos keep their
    // in-between shades). Where several directions say so, the sharpest edge wins.
    const SNAP_REACH = 4, AXES = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    function snap(read, x, y) {
      const here = read(x, y);
      // Out from the pixel in one direction until the color stops changing.
      const settle = (dx, dy) => {
        let color = here, moved = false;
        for (let k = 1; k <= SNAP_REACH; k++) {
          const next = read(x + dx * k, y + dy * k);
          if (!next || dist(next, color) < 10) break;
          color = next;
          moved = true;
        }
        return moved ? color : null;
      };
      let best = null;
      for (const [dx, dy] of AXES) {
        const a = settle(-dx, -dy), b = settle(dx, dy);
        if (!a || !b) continue; // settled already on one side
        const span = dist(a, b);
        if (span < 48) continue;
        const ab = [0, 1, 2].map((i) => b[i] - a[i]);
        const t = ab.reduce((sum, v, i) => sum + v * (here[i] - a[i]), 0) / span ** 2;
        const off = dist(here, a.map((v, i) => v + t * ab[i]));
        if (t <= 0.03 || t >= 0.97 || off > Math.max(10, span * 0.12)) continue;
        if (!best || span > best.span) best = { span, to: t < 0.5 ? a : b };
      }
      return best ? best.to : here;
    }

    function onAlt(e) {
      if (e.key !== "Alt" || card.hidden) return;
      exact = e.type === "keydown";
      render();
    }

    function block(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onClick(e) {
      block(e);
      if (!current) return;
      const value = current;
      cleanup();
      if (onPick) return onPick(value);
      window.__ttCopy(value);
      window.__ttFlash(`Copied ${value}`, value);
      chrome.runtime.sendMessage({ type: "pickedColor", value });
    }

    function onKey(e) {
      if (e.key === "Escape") { block(e); cleanup(); onPick?.(null); }
      else onAlt(e);
    }

    const events = [["mousemove", onMove], ["click", onClick], ["mousedown", block], ["mouseup", block],
      ["pointerdown", block], ["pointerup", block], ["contextmenu", block], ["wheel", block], ["keydown", onKey], ["keyup", onAlt]];
    events.forEach(([t, fn]) => addEventListener(t, fn, { capture: true, passive: false }));

    function cleanup() {
      window.__egEsc?.delete(cleanup);
      events.forEach(([t, fn]) => removeEventListener(t, fn, { capture: true }));
      host.remove();
    }
  };

})();
