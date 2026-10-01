// "What color?": shows a frozen screenshot of the tab with a magnifier under the
// cursor; clicking copies that pixel's hex. Esc cancels. The page underneath
// never receives the click.
(() => {
  if (window.__ttColorPicker) return;
  window.__ttColorPicker = (dataUrl) => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .layer { position: fixed; inset: 0; cursor: none; background-size: 100% 100%; }
        .loupe { position: fixed; width: 132px; height: 132px; border-radius: 50%; overflow: hidden; pointer-events: none;
          border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.5), 0 6px 22px rgba(0,0,0,.45); }
        canvas { width: 100%; height: 100%; image-rendering: pixelated; display: block; }
        .center { position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; transform: translate(-50%,-50%);
          border: 1.5px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.6); }
        .tag { position: fixed; pointer-events: none; display: flex; align-items: center; gap: 7px; padding: 5px 9px;
          border-radius: 7px; background: rgba(12,12,12,.9); color: rgba(255,255,255,.92);
          font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; }
        .tag i { width: 12px; height: 12px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.3); }
        .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 7px 12px; border-radius: 8px;
          background: rgba(12,12,12,.88); color: rgba(255,255,255,.88); font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; }
      </style>
      <div class="layer"></div>
      <div class="hint">Click to copy a color · Esc to cancel</div>
      <div class="loupe" hidden><canvas width="11" height="11"></canvas><span class="center"></span></div>
      <div class="tag" hidden><i></i><span></span></div>`;
    const layer = root.querySelector(".layer");
    const loupe = root.querySelector(".loupe");
    const zoom = root.querySelector("canvas").getContext("2d");
    const tag = root.querySelector(".tag");
    layer.style.backgroundImage = `url("${dataUrl}")`;
    document.documentElement.append(host);

    const img = new Image();
    const full = document.createElement("canvas");
    const ctx = full.getContext("2d", { willReadFrequently: true });
    let scale = 1, current = null;
    img.onload = () => {
      full.width = img.naturalWidth;
      full.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      scale = img.naturalWidth / innerWidth;
    };
    img.src = dataUrl;

    const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

    function onMove(e) {
      if (!full.width) return;
      const px = Math.floor(e.clientX * scale), py = Math.floor(e.clientY * scale);
      zoom.imageSmoothingEnabled = false;
      zoom.clearRect(0, 0, 11, 11);
      zoom.drawImage(full, px - 5, py - 5, 11, 11, 0, 0, 11, 11);
      const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
      current = hex(r, g, b);
      // The loupe is centred on the cursor: its middle square is the pixel being picked.
      loupe.hidden = tag.hidden = false;
      loupe.style.left = `${e.clientX - 66}px`;
      loupe.style.top = `${e.clientY - 66}px`;
      tag.style.left = `${e.clientX - 40}px`;
      tag.style.top = `${e.clientY + 74 > innerHeight - 30 ? e.clientY - 104 : e.clientY + 74}px`;
      tag.querySelector("i").style.background = current;
      tag.querySelector("span").textContent = current;
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
      window.__ttCopy(value);
      window.__ttFlash(`Copied ${value}`, value);
      chrome.runtime.sendMessage({ type: "pickedColor", value });
    }

    function onKey(e) {
      if (e.key === "Escape") { block(e); cleanup(); }
    }

    const events = [["mousemove", onMove], ["click", onClick], ["mousedown", block], ["mouseup", block],
      ["pointerdown", block], ["pointerup", block], ["contextmenu", block], ["wheel", block], ["keydown", onKey]];
    events.forEach(([t, fn]) => addEventListener(t, fn, { capture: true, passive: false }));

    function cleanup() {
      events.forEach(([t, fn]) => removeEventListener(t, fn, { capture: true }));
      host.remove();
    }
  };

})();
