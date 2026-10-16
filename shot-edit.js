// Edit tools for a screenshot opened in a tab (shot-view.html): crop, rectangle, filled rectangle, arrow, line,
// highlighter (straight), text, numbered dots, blur, remove background and clean up, with a color (nine, nine of your own,
// or any color and opacity from the picker) and a line width, plus zoom.
//
// Every mark stays editable until the image leaves the tab: click it in any tool to select
// it, drag it to move it, drag its handles to reshape it (text: its corners change the size),
// change its color, width or font, or delete it. Marks are kept as shapes in the image's
// own pixels (an SVG layer over each part, so zoom costs nothing) and drawn into the image
// only when it's saved, copied or uploaded (exportItems). Crop is kept as a rectangle the
// same way. Blur is the exception: it changes the pixels straight away, since what's under
// it must not survive. Remove background and clean up change the pixels too (cutout.js, in
// cutout-worker.js). Undo and redo cover everything.
// Fonts uploaded for the text tool are kept in IndexedDB ("eg-fonts") for next time.
(() => {
  const COLORS = ["#000000", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#ff2d55", "#ffffff"];
  // Colors are "#rrggbb", or "#rrggbbaa" when see-through.
  const alphaOf = (c) => (c.length === 9 ? parseInt(c.slice(7), 16) / 255 : 1);
  const withAlpha = (hex, a) => (a >= 1 ? hex : hex + Math.round(a * 255).toString(16).padStart(2, "0"));
  // What's typed (with or without #, 3, 6 or 8 digits) or rgb(…) from the eyedropper.
  function toHex(t) {
    t = String(t).trim().toLowerCase();
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(t);
    if (rgb) return `#${rgb.slice(1, 4).map((n) => Math.min(255, +n).toString(16).padStart(2, "0")).join("")}`;
    t = t.replace(/^#/, "");
    if (/^[0-9a-f]{3}$/.test(t)) t = [...t].map((c) => c + c).join("");
    if (/^[0-9a-f]{8}$/.test(t) && t.endsWith("ff")) t = t.slice(0, 6);
    return /^([0-9a-f]{6}|[0-9a-f]{8})$/.test(t) ? `#${t}` : null;
  }
  const FONTS = {
    Inter: '"Inter", system-ui, sans-serif',
    System: "system-ui, sans-serif",
    Serif: 'Georgia, "Times New Roman", serif',
    Mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    Handwriting: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive',
  };
  const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
  const NS = "http://www.w3.org/2000/svg";
  // Widths hairline / thin / medium / thick, times the part's unit (1 for a normal screen, 2
  // for a high-density one, so marks look the same on both).
  const STROKE = [1, 2.5, 4.5, 7], MARKER = [10, 16, 24, 34], DOT = [6.5, 8, 10, 13];
  const TEXT_FS = 18; // a new text's size, times the unit; drag its corners to change it
  const LINE_H = 1.25; // text line height, as in the text box while typing
  const TOOL_KEYS = { c: "crop", r: "rect", f: "box", a: "arrow", l: "line", h: "marker", t: "text", n: "dot", b: "blur" };

  function start({ items, host, say, onChange, blur }) {
    const $ = (id) => document.getElementById(id);
    const main = $("main");
    const parts = [];
    let tool = "none", color = "#ff3b30", size = 1, font = "Inter", textFs = TEXT_FS, custom = "#ff2d55";
    let sel = null; // { p, id }
    let zoom = { fit: true, s: 1 };
    let history = [], hi = -1, savedAt = 0;
    let drag = null, cropDraft = null, textEd = null;
    let colorMoved = false, colorLive = false; // a color being tried out in the picker (setColor)
    let customFonts = [];
    const measureCtx = document.createElement("canvas").getContext("2d");

    // ---- Parts ---------------------------------------------------------------------------
    async function build() {
      for (const [i, it] of items.entries()) {
        const img = new Image();
        img.src = it.dataUrl;
        img.alt = it.name.split("/").pop();
        img.draggable = false;
        await img.decode().catch(() => {});
        const w = img.naturalWidth, h = img.naturalHeight;
        const el = Object.assign(document.createElement("div"), { className: "part" });
        const inner = Object.assign(document.createElement("div"), { className: "inner" });
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("class", "layer");
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        inner.append(img, svg);
        el.append(inner);
        host.append(el);
        // cut: its background removed (in the pixels); baseUrl: its pixels from before the first
        // cut, faint under it while Alt is held in clean up; cutSrc: the pixels the worker last made or saw.
        parts.push({ i, el, inner, img, svg, w, h, u: Math.max(1, Math.round(w / 900)), src: it.dataUrl, crop: null, objects: [], cut: false, baseUrl: null, cutSrc: null });
      }
    }
    const full = (p) => ({ x: 0, y: 0, w: p.w, h: p.h });
    const view = (p) => (cropDraft ? full(p) : p.crop || full(p));
    const partOf = (target) => parts.find((p) => p.el === target.closest?.(".part"));

    // ---- Zoom and layout -----------------------------------------------------------------
    // Fit: the whole shot between the bars (a long page in parts: the width only).
    function scale() {
      if (!zoom.fit) return zoom.s;
      const pad = 48;
      const aw = Math.max(80, main.clientWidth - pad), ah = Math.max(80, main.clientHeight - pad);
      const s = aw / Math.max(...parts.map((p) => view(p).w));
      return Math.min(1, parts.length === 1 ? Math.min(s, ah / view(parts[0]).h) : s);
    }
    function layout() {
      const s = scale();
      for (const p of parts) {
        const v = view(p);
        Object.assign(p.el.style, { width: `${v.w * s}px`, height: `${v.h * s}px` });
        Object.assign(p.inner.style, { width: `${p.w * s}px`, height: `${p.h * s}px`, transform: `translate(${-v.x * s}px, ${-v.y * s}px)` });
      }
      $("zoomPct").textContent = `${Math.round(s * 100)}%`;
      markerCursor();
      $("zoomFit").setAttribute("aria-pressed", String(zoom.fit));
      $("zoom1").setAttribute("aria-pressed", String(!zoom.fit && zoom.s === 1));
      renderAll();
    }
    function setZoom(s, anchor) {
      commitText();
      const old = scale();
      zoom = { fit: false, s: Math.min(8, Math.max(0.1, s)) };
      const r = main.getBoundingClientRect();
      const ax = (anchor?.x ?? r.left + r.width / 2) - r.left, ay = (anchor?.y ?? r.top + r.height / 2) - r.top;
      const dx = main.scrollLeft + ax, dy = main.scrollTop + ay;
      layout();
      const k = zoom.s / old;
      main.scrollTo(dx * k - ax, dy * k - ay);
    }
    const fit = () => { commitText(); zoom = { fit: true, s: 1 }; layout(); };
    const step = (dir) => {
      const s = scale();
      const next = dir > 0 ? ZOOMS.find((z) => z > s + 0.001) : [...ZOOMS].reverse().find((z) => z < s - 0.001);
      setZoom(next ?? s);
    };
    $("zoomIn").onclick = () => step(1);
    $("zoomOut").onclick = () => step(-1);
    $("zoomFit").onclick = fit;
    $("zoom1").onclick = () => setZoom(1);
    main.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(scale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX, y: e.clientY });
    }, { passive: false });
    addEventListener("resize", () => zoom.fit && layout());

    // ---- Drawing the marks ---------------------------------------------------------------
    const S = (tag, attrs, parent) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
      parent?.append(el);
      return el;
    };
    const strokeW = (p, o) => STROKE[o.size] * p.u;
    const markerW = (p, o) => MARKER[o.size] * p.u;
    const dotR = (p, o) => DOT[o.size] * p.u;
    const family = (name) => FONTS[name] || `"${name}", system-ui, sans-serif`;
    const norm = (o) => ({ x: Math.min(o.x, o.x + o.w), y: Math.min(o.y, o.y + o.h), w: Math.abs(o.w), h: Math.abs(o.h) });
    // Light colors get dark numbers and a dark ring on their dots.
    function onLight(c) {
      const n = parseInt(c.slice(1, 7), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      return 0.299 * r + 0.587 * g + 0.114 * b > 170;
    }
    const isLine = (o) => o.type === "line" || o.type === "arrow" || o.type === "marker";

    function arrowGeom(p, o) {
      const sw = strokeW(p, o);
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const hl = Math.min(len * 0.7, Math.max(sw * 3.6, 9 * p.u)), hw = hl * 0.55;
      const bx = o.x2 - ux * hl, by = o.y2 - uy * hl;
      return {
        sw,
        shaft: [o.x1, o.y1, bx + ux * hl * 0.25, by + uy * hl * 0.25],
        head: [[o.x2, o.y2], [bx - uy * hw, by + ux * hw], [bx + uy * hw, by - ux * hw]],
      };
    }
    // Text layout shared by the screen and the saved image: each line's baseline sits where
    // a CSS line box of LINE_H would put it, so the text doesn't jump after typing.
    function textLayout(o) {
      const fs = o.fs;
      measureCtx.font = `600 ${fs}px ${family(o.font)}`;
      const m = measureCtx.measureText("Hg");
      const asc = m.fontBoundingBoxAscent || fs * 0.8, desc = m.fontBoundingBoxDescent || fs * 0.2;
      const lh = fs * LINE_H, off = (lh - asc - desc) / 2 + asc;
      const lines = o.text.split("\n");
      const width = Math.max(...lines.map((l) => measureCtx.measureText(l).width), fs * 0.3);
      return { fs, lh, lines, width, height: lines.length * lh, base: (i) => o.y + off + i * lh };
    }
    function bbox(p, o) {
      if (o.type === "rect") return norm(o);
      if (o.type === "text") { const t = textLayout(o); return { x: o.x, y: o.y, w: t.width, h: t.height }; }
      if (o.type === "dot") { const r = dotR(p, o); return { x: o.x - r, y: o.y - r, w: 2 * r, h: 2 * r }; }
      const pad = o.type === "marker" ? markerW(p, o) / 2 : strokeW(p, o);
      return { x: Math.min(o.x1, o.x2) - pad, y: Math.min(o.y1, o.y2) - pad, w: Math.abs(o.x2 - o.x1) + 2 * pad, h: Math.abs(o.y2 - o.y1) + 2 * pad };
    }

    function objSvg(p, o, s) {
      const a = alphaOf(o.color);
      const g = S("g", { "data-id": o.id, class: sel?.id === o.id ? "sel" : null, opacity: a < 1 ? a : null });
      o = { ...o, color: o.color.slice(0, 7) };
      const hitW = 14 / s;
      if (o.type === "rect") {
        const r = norm(o), sw = strokeW(p, o);
        if (o.filled) S("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 2 * p.u, fill: o.color }, g);
        else {
          S("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: Math.max(sw, 2 * p.u), fill: "none", stroke: o.color, "stroke-width": sw }, g);
          S("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: "none", stroke: "transparent", "stroke-width": sw + hitW, "pointer-events": "stroke" }, g);
        }
      } else if (isLine(o)) {
        const marker = o.type === "marker", sw = marker ? markerW(p, o) : strokeW(p, o);
        if (o.type === "arrow") {
          const a = arrowGeom(p, o);
          S("line", { x1: a.shaft[0], y1: a.shaft[1], x2: a.shaft[2], y2: a.shaft[3], stroke: o.color, "stroke-width": sw, "stroke-linecap": "round" }, g);
          S("polygon", { points: a.head.map((q) => q.join(",")).join(" "), fill: o.color, stroke: o.color, "stroke-width": sw * 0.5, "stroke-linejoin": "round" }, g);
        } else S("line", { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, stroke: o.color, "stroke-width": sw, "stroke-linecap": marker ? "butt" : "round", opacity: marker ? 0.4 : null }, g);
        S("line", { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, stroke: "transparent", "stroke-width": Math.max(sw, hitW), "pointer-events": "stroke" }, g);
      } else if (o.type === "text") {
        const t = textLayout(o);
        const text = S("text", { fill: o.color, "font-family": family(o.font), "font-size": t.fs, "font-weight": 600, "xml:space": "preserve" }, g);
        t.lines.forEach((line, i) => { S("tspan", { x: o.x, y: t.base(i) }, text).textContent = line || " "; });
        S("rect", { x: o.x, y: o.y, width: t.width, height: t.height, fill: "transparent" }, g);
      } else if (o.type === "dot") {
        const r = dotR(p, o), light = onLight(o.color);
        S("circle", { cx: o.x, cy: o.y, r, fill: o.color, stroke: light ? "rgba(0,0,0,.35)" : "#fff", "stroke-width": Math.max(1, r * 0.13) }, g);
        S("text", { x: o.x, y: o.y, "text-anchor": "middle", "dominant-baseline": "central", fill: light ? "#000" : "#fff", "font-family": FONTS.Inter, "font-size": r * (o.n > 9 ? 0.95 : 1.15), "font-weight": 700 }, g).textContent = o.n;
      }
      return g;
    }

    function render(p) {
      const s = scale();
      p.svg.replaceChildren();
      for (const o of p.objects) if (!o.editing) p.svg.append(objSvg(p, o, s));
      const ui = S("g", {}, p.svg);
      const hr = 6 / s, hs = 2 / s;
      const handle = (x, y, name, attr = "data-handle") => S("circle", { cx: x, cy: y, r: hr, fill: "#fff", stroke: "#0a84ff", "stroke-width": hs, [attr]: name }, ui);
      const box = (b, pad) => S("rect", { x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, fill: "none", stroke: "#0a84ff", "stroke-width": 1.5 / s, "stroke-dasharray": `${5 / s} ${4 / s}`, "pointer-events": "none" }, ui);
      const o = sel?.p === p && p.objects.find((q) => q.id === sel.id);
      if (o && !o.editing) {
        if (o.type === "rect") {
          const r = norm(o);
          handle(r.x, r.y, "nw"); handle(r.x + r.w, r.y, "ne"); handle(r.x, r.y + r.h, "sw"); handle(r.x + r.w, r.y + r.h, "se");
        } else if (isLine(o)) {
          handle(o.x1, o.y1, "p1"); handle(o.x2, o.y2, "p2");
        } else if (o.type === "text") {
          const b = bbox(p, o), pad = 4 / s;
          box(b, pad);
          handle(b.x - pad, b.y - pad, "nw"); handle(b.x + b.w + pad, b.y - pad, "ne"); handle(b.x - pad, b.y + b.h + pad, "sw"); handle(b.x + b.w + pad, b.y + b.h + pad, "se");
        } else box(bbox(p, o), 4 / s);
      }
      if (drag?.kind === "blur" && drag.p === p) {
        const r = rectOf(drag.start, drag.cur);
        S("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: "rgba(138,180,255,.15)", stroke: "#8ab4ff", "stroke-width": 1.5 / s, "stroke-dasharray": `${6 / s} ${4 / s}`, "pointer-events": "none" }, ui);
      }
      if (cropDraft) {
        const c = cropDraft.get(p);
        S("path", { d: `M0 0H${p.w}V${p.h}H0Z M${c.x} ${c.y}v${c.h}h${c.w}v${-c.h}Z`, fill: "rgba(0,0,0,.55)", "fill-rule": "evenodd", "pointer-events": "none" }, ui);
        S("rect", { x: c.x, y: c.y, width: c.w, height: c.h, fill: "none", stroke: "#fff", "stroke-width": 1.5 / s, "pointer-events": "none" }, ui);
        for (const k of [1, 2]) {
          S("line", { x1: c.x + (c.w * k) / 3, y1: c.y, x2: c.x + (c.w * k) / 3, y2: c.y + c.h, stroke: "rgba(255,255,255,.35)", "stroke-width": 1 / s, "pointer-events": "none" }, ui);
          S("line", { x1: c.x, y1: c.y + (c.h * k) / 3, x2: c.x + c.w, y2: c.y + (c.h * k) / 3, stroke: "rgba(255,255,255,.35)", "stroke-width": 1 / s, "pointer-events": "none" }, ui);
        }
        handle(c.x, c.y, "nw", "data-crop"); handle(c.x + c.w, c.y, "ne", "data-crop"); handle(c.x, c.y + c.h, "sw", "data-crop"); handle(c.x + c.w, c.y + c.h, "se", "data-crop");
      }
    }
    const renderAll = () => parts.forEach(render);

    // ---- Saved image: the same marks, on a canvas ----------------------------------------
    // A see-through mark is drawn solid on its own layer, then laid on at its opacity (so an
    // arrow's head and shaft don't show darker where they overlap).
    let layerCanvas = null;
    function drawObj(ctx, p, o) {
      const a = alphaOf(o.color);
      if (a >= 1) return drawMark(ctx, p, o);
      layerCanvas ??= document.createElement("canvas");
      Object.assign(layerCanvas, { width: p.w, height: p.h });
      drawMark(layerCanvas.getContext("2d"), p, { ...o, color: o.color.slice(0, 7) });
      ctx.save();
      ctx.globalAlpha = a;
      ctx.drawImage(layerCanvas, 0, 0);
      ctx.restore();
    }
    function drawMark(ctx, p, o) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = ctx.fillStyle = o.color;
      if (o.type === "rect") {
        const r = norm(o), sw = strokeW(p, o);
        ctx.lineWidth = sw;
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, o.filled ? 2 * p.u : Math.max(sw, 2 * p.u));
        if (o.filled) ctx.fill();
        else ctx.stroke();
      } else if (o.type === "line" || o.type === "marker") {
        if (o.type === "marker") { ctx.globalAlpha = 0.4; ctx.lineCap = "butt"; }
        ctx.lineWidth = o.type === "marker" ? markerW(p, o) : strokeW(p, o);
        ctx.beginPath(); ctx.moveTo(o.x1, o.y1); ctx.lineTo(o.x2, o.y2); ctx.stroke();
      } else if (o.type === "arrow") {
        const a = arrowGeom(p, o);
        ctx.lineWidth = a.sw;
        ctx.beginPath(); ctx.moveTo(a.shaft[0], a.shaft[1]); ctx.lineTo(a.shaft[2], a.shaft[3]); ctx.stroke();
        ctx.lineWidth = a.sw * 0.5;
        ctx.beginPath(); ctx.moveTo(...a.head[0]); ctx.lineTo(...a.head[1]); ctx.lineTo(...a.head[2]); ctx.closePath(); ctx.fill(); ctx.stroke();
      } else if (o.type === "text") {
        const t = textLayout(o);
        ctx.font = `600 ${t.fs}px ${family(o.font)}`;
        ctx.textBaseline = "alphabetic";
        t.lines.forEach((line, i) => ctx.fillText(line, o.x, t.base(i)));
      } else if (o.type === "dot") {
        const r = dotR(p, o), light = onLight(o.color);
        ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = Math.max(1, r * 0.13);
        ctx.strokeStyle = light ? "rgba(0,0,0,.35)" : "#fff";
        ctx.stroke();
        ctx.fillStyle = light ? "#000" : "#fff";
        ctx.font = `700 ${r * (o.n > 9 ? 0.95 : 1.15)}px ${FONTS.Inter}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(o.n), o.x, o.y);
      }
      ctx.restore();
    }
    const toDataUrl = (blob) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    // opts (the editor's bottom bar): format "png" | "jpg" (else the shot's own), scale 1-3
    // (the picture is enlarged smoothly and the marks drawn at that size, so they stay sharp)
    // and target bytes (each part saved as a JPEG with its quality lowered just enough to fit,
    // and only if even quality 0.3 is too big, its pixels reduced too). Each item also
    // carries its size in bytes and, for a JPEG, the quality used. peek: only the size it
    // would be (no image), worked out from bands of the picture, so it's quick even for a
    // long page at 3x; stale: a function that says when a peek isn't wanted any more.
    async function exportItems(opts = {}) {
      if (!opts.peek) commitText(); // a size estimate (peek) leaves a text being typed alone
      const own = items[0].dataUrl.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png";
      const scale = [1, 2, 3].includes(opts.scale) ? opts.scale : 1;
      const target = opts.target > 0 ? opts.target : 0;
      const type = target || opts.format === "jpg" ? "image/jpeg" : opts.format === "png" ? "image/png" : own;
      const quality = ((await TT.getSettings()).shot?.quality ?? 92) / 100;
      const ext = type === "image/jpeg" ? "jpg" : "png";
      const jpegQ = type === "image/jpeg" ? quality : null;
      await Promise.all([...new Set(parts.flatMap((p) => p.objects.filter((o) => o.type === "text").map((o) => o.font)))]
        .map((f) => document.fonts.load(`600 24px ${family(f)}`).catch(() => {})));
      const out = [];
      for (const p of parts) { // one at a time: a long page at 3x is a lot of pixels
        if (opts.stale?.()) throw new Error("stale");
        const it = items[p.i];
        const name = it.name.replace(/\.(png|jpe?g)$/i, "") + "." + ext;
        if (!p.crop && !p.objects.length && scale === 1 && !target && type === own && p.src.startsWith(`data:${type}`)) {
          out.push({ ...it, dataUrl: p.src, bytes: Math.floor((p.src.length - p.src.indexOf(",") - 1) * 3 / 4), quality: jpegQ, width: p.img.naturalWidth, height: p.img.naturalHeight });
          continue;
        }
        const r = p.crop || full(p);
        // Within what a canvas can hold (32767px a side, about 268 million pixels).
        const k = Math.max(1, Math.min(scale, 32767 / Math.max(r.w, r.h), Math.sqrt(268e6 / (r.w * r.h))));
        const W = Math.round(r.w * k), H = Math.round(r.h * k);
        if (target) {
          const f = await fitToTarget(p, k, target, quality, !opts.peek, opts.stale);
          out.push({ ...it, name, ...(f.blob ? { dataUrl: await toDataUrl(f.blob) } : {}), bytes: f.bytes, quality: f.quality, width: f.width, height: f.height, shrunk: f.width < W });
        } else if (opts.peek) {
          const smp = await sizer(p, k, type, quality);
          out.push({ ...it, name, bytes: Math.round(await smp.est(quality)), quality: jpegQ, width: W, height: H });
        } else {
          const blob = await toBlob(renderOut(p, k), type, quality);
          out.push({ ...it, name, dataUrl: await toDataUrl(blob), bytes: blob.size, quality: jpegQ, width: W, height: H });
        }
      }
      return out;
    }
    // A JPEG has no see-through: where the background was removed, it's white.
    function onWhite(c) {
      const w = Object.assign(document.createElement("canvas"), { width: c.width, height: c.height });
      const x = w.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, w.width, w.height);
      x.drawImage(c, 0, 0);
      return w;
    }
    const toBlob = (c, type, q) => new Promise((res, rej) => (type === "image/jpeg" && parts.some((p) => p.cut) ? onWhite(c) : c)
      .toBlob((b) => (b ? res(b) : rej(new Error("The browser couldn't encode the image"))), type, q));
    // The part as it's saved, at k times its size: crop, and the marks drawn at that size.
    function renderOut(p, k) {
      const r = p.crop || full(p);
      const c = Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(r.w * k)), height: Math.max(1, Math.round(r.h * k)) });
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.scale(k, k);
      ctx.translate(-r.x, -r.y);
      ctx.drawImage(p.img, 0, 0);
      for (const o of p.objects) drawObj(ctx, p, o);
      return c;
    }
    // For size estimates: the marks alone at 1x (none: null), and a cache for sizer(), both
    // made again after an edit.
    const estCache = new WeakMap();
    function estState(p) {
      const key = history[hi];
      let st = estCache.get(p);
      if (!st || st.key !== key || st.src !== p.src) {
        let marks = null;
        if (p.objects.length) {
          marks = Object.assign(document.createElement("canvas"), { width: p.w, height: p.h });
          const x = marks.getContext("2d");
          for (const o of p.objects) drawObj(x, p, o);
        }
        estCache.set(p, (st = { key, src: p.src, marks, calib: new Map() }));
      }
      return st;
    }
    // The part (cropped, with its marks) at k times its size into ctx, with its top at y0:
    // the picture drawn the way renderOut() draws it, so the pixels match.
    function drawScaled(x, p, k, y0, marks) {
      const r = p.crop || full(p);
      x.setTransform(k, 0, 0, k, 0, y0);
      x.translate(-r.x, -r.y);
      x.drawImage(p.img, 0, 0);
      if (marks) x.drawImage(marks, 0, 0);
    }
    // Evenly spaced bands across the part at k times its size: the same rows of the picture
    // at any size, a whole number of JPEG's 16px blocks tall. ratio: how many times bigger
    // the whole is. A small picture is used whole.
    function sampleOf(p, k, marks) {
      const r = p.crop || full(p);
      const W = Math.max(1, Math.round(r.w * k)), H = Math.max(1, Math.round(r.h * k));
      const c = document.createElement("canvas");
      if (W * H <= 1.5e6) {
        Object.assign(c, { width: W, height: H });
        const x = Object.assign(c.getContext("2d"), { imageSmoothingQuality: "high" });
        drawScaled(x, p, k, 0, marks);
        return { canvas: c, ratio: 1, W, H, whole: true };
      }
      const bh = 16 * Math.max(1, Math.round(k)), bs = bh / k; // a band, in the sample and in the picture
      const n = Math.max(1, Math.min(Math.floor(r.h / bs / 2), Math.max(4, Math.floor(0.4e6 / (r.w * 16)))));
      Object.assign(c, { width: W, height: n * bh });
      const x = Object.assign(c.getContext("2d"), { imageSmoothingQuality: "high" });
      for (let i = 0; i < n; i++) {
        const y = ((r.h - bs) * (i + 0.5)) / n;
        x.save();
        x.beginPath();
        x.rect(0, i * bh, W, bh);
        x.clip();
        drawScaled(x, p, k, i * bh - y * k, marks);
        x.restore();
      }
      return { canvas: c, ratio: H / (n * bh), W, H, whole: false };
    }
    // How big the part would be at k times its size, as type at quality q: the bands, times
    // how far bands are off for this picture. That's measured once (per edit, type and size)
    // by making the whole picture: at 1x when it's enlarged (the bands' error stays about the
    // same when enlarged), or at k when it's made smaller.
    async function sizer(p, k, type, ceil) {
      const st = estState(p);
      const smp = sampleOf(p, k, st.marks);
      const bytes = async (c, q) => (await toBlob(c, type, q)).size;
      if (smp.whole) return { ...smp, est: (q) => bytes(smp.canvas, q) };
      const kc = Math.min(k, 1), key = `${type} ${ceil} ${kc.toFixed(4)}`;
      if (!st.calib.has(key)) {
        const ref = kc === k ? smp : sampleOf(p, kc, st.marks);
        const whole = Object.assign(document.createElement("canvas"), { width: ref.W, height: ref.H });
        drawScaled(Object.assign(whole.getContext("2d"), { imageSmoothingQuality: "high" }), p, kc, 0, st.marks);
        st.calib.set(key, (await bytes(whole, ceil)) / ((await bytes(ref.canvas, ceil)) * ref.ratio));
      }
      const C = st.calib.get(key);
      return { ...smp, est: async (q) => (await bytes(smp.canvas, q)) * smp.ratio * C };
    }
    // A target size is a ceiling: the JPEG quality from settings if that fits, else the highest
    // quality that does, down to 0.3 (below that, text turns to blocks); if even 0.3 is too big,
    // fewer pixels too, then the search again. The search runs on bands (sizer). exact:
    // then the part is drawn at the size found and made once at the quality found; if the
    // bands guessed low, the search runs again aiming lower.
    async function fitToTarget(p, k, target, ceil, exact, stale) {
      const MIN_Q = 0.3;
      let goal = target, last = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (stale?.()) throw new Error("stale");
        const smp = await sizer(p, k, "image/jpeg", ceil), est = smp.est;
        let q = ceil, bytes = await est(ceil);
        if (bytes > goal) {
          const low = await est(MIN_Q);
          if (low > goal) { k *= Math.max(0.1, Math.min(0.95, Math.sqrt(goal / low) * 0.97)); continue; }
          let lo = MIN_Q, hiQ = ceil;
          q = MIN_Q; bytes = low;
          for (let i = 0; i < 7 && hiQ - lo > 0.01; i++) {
            if (stale?.()) throw new Error("stale");
            const m = (lo + hiQ) / 2, b = await est(m);
            if (b <= goal) { q = m; bytes = b; lo = m; if (b >= goal * 0.97) break; } else hiQ = m;
          }
        }
        if (!exact) return { bytes: Math.round(bytes), quality: q, width: smp.W, height: smp.H };
        const c = renderOut(p, k);
        const blob = await toBlob(c, "image/jpeg", q);
        last = { blob, bytes: blob.size, quality: q, width: c.width, height: c.height };
        if (blob.size <= target) return last;
        goal *= (target / blob.size) * 0.98;
      }
      if (!exact) { const smp = await sizer(p, k, "image/jpeg", ceil); return { bytes: Math.round(await smp.est(MIN_Q)), quality: MIN_Q, width: smp.W, height: smp.H }; }
      if (last && last.blob.size <= target) return last;
      const c = renderOut(p, k);
      const blob = await toBlob(c, "image/jpeg", MIN_Q);
      return { blob, bytes: blob.size, quality: MIN_Q, width: c.width, height: c.height };
    }

    // ---- History -------------------------------------------------------------------------
    const snapshot = () => parts.map((p) => ({ src: p.src, cut: p.cut, crop: p.crop && { ...p.crop }, objects: structuredClone(p.objects) }));
    function commit() {
      history = history.slice(0, hi + 1);
      history.push(snapshot());
      hi++;
      if (history.length > 200) { history.shift(); hi--; savedAt--; }
      paintUndo();
      onChange?.();
    }
    function restore(i) {
      commitText();
      hi = i;
      const snap = history[i];
      parts.forEach((p, k) => {
        if (p.src !== snap[k].src) { p.src = snap[k].src; p.img.src = p.src; }
        p.cut = !!snap[k].cut;
        p.crop = snap[k].crop && { ...snap[k].crop };
        p.objects = structuredClone(snap[k].objects);
      });
      if (sel && !sel.p.objects.some((o) => o.id === sel.id)) sel = null;
      layout();
      paintBar();
      paintUndo();
      onChange?.();
    }
    const undo = () => hi > 0 && restore(hi - 1);
    const redo = () => hi < history.length - 1 && restore(hi + 1);
    function paintUndo() {
      $("undo").setAttribute("aria-disabled", String(hi <= 0));
      $("redo").setAttribute("aria-disabled", String(hi >= history.length - 1));
    }
    $("undo").onclick = undo;
    $("redo").onclick = redo;

    // ---- Selecting, drawing, moving ------------------------------------------------------
    const newId = () => Math.random().toString(36).slice(2, 10);
    const selected = () => sel && sel.p.objects.find((o) => o.id === sel.id);
    function select(p, o) {
      const before = sel?.p;
      sel = o ? { p, id: o.id } : null;
      if (before && before !== p) render(before);
      if (p) render(p);
      paintBar();
    }
    const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
    function toPt(p, e, clamp = false) {
      const r = p.inner.getBoundingClientRect();
      let x = ((e.clientX - r.left) * p.w) / r.width, y = ((e.clientY - r.top) * p.h) / r.height;
      if (clamp) { x = Math.min(Math.max(x, 0), p.w); y = Math.min(Math.max(y, 0), p.h); }
      return { x, y };
    }
    const nextDot = () => 1 + Math.max(0, ...parts.flatMap((p) => p.objects.filter((o) => o.type === "dot").map((o) => o.n)));
    function moveBy(o, orig, dx, dy) {
      if (isLine(o)) Object.assign(o, { x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy });
      else Object.assign(o, { x: orig.x + dx, y: orig.y + dy });
    }
    // Shift keeps lines at 45° steps and rectangles square.
    function snapEnd(start, pt, e) {
      if (!e.shiftKey) return pt;
      const dx = pt.x - start.x, dy = pt.y - start.y, len = Math.hypot(dx, dy);
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      return { x: start.x + Math.cos(a) * len, y: start.y + Math.sin(a) * len };
    }

    host.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".text-edit")) return;
      const p = partOf(e.target);
      if (!p) return;
      e.preventDefault();
      closePops();
      commitText();
      const pt = toPt(p, e);
      if (tool === "crop") return cropDown(p, pt, e);
      if (tool === "blur") { drag = { kind: "blur", p, start: toPt(p, e, true), cur: toPt(p, e, true) }; return; }
      if (tool === "clean") { cleanClick(p, toPt(p, e, true), e.altKey); return; }
      // A mark (or the handles of the selected one) is grabbed in any tool.
      const h = e.target.closest("[data-handle]");
      const cur = selected();
      if (h && cur && sel.p === p) {
        drag = { kind: "handle", p, obj: cur, handle: h.dataset.handle, orig: structuredClone(cur), box: cur.type === "text" ? bbox(p, cur) : null };
        return;
      }
      const g = e.target.closest("[data-id]");
      const hit = g && p.objects.find((o) => o.id === g.dataset.id);
      if (hit) {
        select(p, hit);
        drag = { kind: "move", p, obj: hit, start: pt, orig: structuredClone(hit) };
        return;
      }
      if (tool === "none") return select(null);
      if (tool === "text") return editText(p, { id: newId(), type: "text", x: pt.x, y: pt.y, text: "", color, fs: textFs * p.u, font }, true);
      if (tool === "dot") {
        const o = { id: newId(), type: "dot", x: pt.x, y: pt.y, n: nextDot(), color, size };
        p.objects.push(o);
        select(p, o);
        commit();
        return;
      }
      const at = toPt(p, e, true);
      const o = { id: newId(), type: tool, color, size };
      if (tool === "rect" || tool === "box") Object.assign(o, { type: "rect", x: at.x, y: at.y, w: 0, h: 0 }, tool === "box" && { filled: true });
      else Object.assign(o, { x1: at.x, y1: at.y, x2: at.x, y2: at.y });
      p.objects.push(o);
      sel = { p, id: o.id };
      drag = { kind: "create", p, obj: o, start: at };
      render(p);
    });

    addEventListener("pointermove", (e) => {
      if (!drag) return;
      const { p, obj: o } = drag;
      const pt = toPt(p, e, drag.kind === "create" || drag.kind === "blur" || drag.kind.startsWith("crop"));
      if (drag.kind === "create") {
        if (o.type === "rect") {
          let w = pt.x - drag.start.x, h = pt.y - drag.start.y;
          if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
          Object.assign(o, { w, h });
        } else if (o.type === "marker") {
          Object.assign(o, { x2: pt.x, y2: drag.start.y }); // the highlighter only runs across
        } else {
          const end = snapEnd(drag.start, pt, e);
          Object.assign(o, { x2: end.x, y2: end.y });
        }
      } else if (drag.kind === "move") {
        moveBy(o, drag.orig, pt.x - drag.start.x, pt.y - drag.start.y);
      } else if (drag.kind === "handle") {
        if (o.type === "rect") {
          const r = norm(drag.orig);
          const left = drag.handle.includes("w") ? pt.x : r.x, right = drag.handle.includes("e") ? pt.x : r.x + r.w;
          const top = drag.handle.includes("n") ? pt.y : r.y, bottom = drag.handle.includes("s") ? pt.y : r.y + r.h;
          Object.assign(o, { x: left, y: top, w: right - left, h: bottom - top });
        } else if (o.type === "text") {
          // The corner opposite the one dragged stays put; the size follows the width.
          const b = drag.box, hd = drag.handle;
          const ax = hd.includes("w") ? b.x + b.w : b.x, ay = hd.includes("n") ? b.y + b.h : b.y;
          const k = Math.min(Math.max(Math.abs(pt.x - ax) / b.w, (6 * p.u) / drag.orig.fs), (400 * p.u) / drag.orig.fs);
          o.fs = drag.orig.fs * k;
          o.x = hd.includes("w") ? ax - b.w * k : ax;
          o.y = hd.includes("n") ? ay - b.h * k : ay;
        } else if (o.type === "marker") {
          o[drag.handle === "p1" ? "x1" : "x2"] = pt.x;
        } else if (drag.handle === "p1") {
          const end = snapEnd({ x: o.x2, y: o.y2 }, pt, e);
          Object.assign(o, { x1: end.x, y1: end.y });
        } else {
          const end = snapEnd({ x: o.x1, y: o.y1 }, pt, e);
          Object.assign(o, { x2: end.x, y2: end.y });
        }
      } else if (drag.kind === "blur") {
        drag.cur = pt;
      } else if (drag.kind.startsWith("crop")) {
        cropMove(p, pt);
      }
      render(p);
    });

    const finish = async () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      const { p, obj: o } = d;
      if (d.kind === "create") {
        const b = o.type === "rect" ? norm(o) : null;
        const tiny = b ? b.w < 3 * p.u || b.h < 3 * p.u : Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 4 * p.u;
        if (tiny) {
          p.objects = p.objects.filter((q) => q !== o);
          sel = null;
        } else {
          if (b) Object.assign(o, b);
          if (o.type === "marker" && o.x2 < o.x1) [o.x1, o.x2] = [o.x2, o.x1];
          commit();
        }
        render(p);
        paintBar();
      } else if (d.kind === "move" || d.kind === "handle") {
        if (o.type === "rect") Object.assign(o, norm(o));
        if (o.type === "marker" && o.x2 < o.x1) [o.x1, o.x2] = [o.x2, o.x1];
        if (o.type === "text" && d.kind === "handle") textFs = o.fs / p.u;
        if (JSON.stringify(o) !== JSON.stringify(d.orig)) { commit(); if (o.type === "text") savePrefs(); }
        render(p);
      } else if (d.kind === "blur") {
        const r = rectOf(d.start, d.cur);
        render(p);
        if (r.w >= 4 && r.h >= 4) await applyBlur(p, r);
      } else render(p);
    };
    addEventListener("pointerup", finish);
    addEventListener("pointercancel", finish);

    host.addEventListener("dblclick", (e) => {
      const p = partOf(e.target);
      const g = e.target.closest("[data-id]");
      const o = p && g && p.objects.find((q) => q.id === g.dataset.id);
      if (o?.type === "text") editText(p, o, false);
    });

    // ---- Text ----------------------------------------------------------------------------
    function editText(p, o, isNew) {
      commitText();
      const s = scale();
      const el = Object.assign(document.createElement("div"), { className: "text-edit" });
      el.contentEditable = "plaintext-only";
      el.spellcheck = false;
      el.textContent = o.text;
      Object.assign(el.style, { left: `${o.x * s}px`, top: `${o.y * s}px`, fontSize: `${o.fs * s}px`, fontFamily: family(o.font), color: o.color });
      p.inner.append(el);
      o.editing = true;
      textEd = { p, o, el, isNew };
      sel = isNew ? null : { p, id: o.id };
      render(p);
      paintBar();
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") { e.preventDefault(); commitText(); }
      });
      el.addEventListener("blur", () => commitText());
    }
    function commitText() {
      if (!textEd) return;
      const { p, o, el, isNew } = textEd;
      textEd = null;
      const text = el.innerText.replace(/\n+$/, "");
      el.remove();
      delete o.editing;
      if (!text.trim()) {
        if (!isNew) { p.objects = p.objects.filter((q) => q !== o); sel = null; commit(); }
      } else if (isNew || text !== o.text) {
        o.text = text;
        if (isNew) p.objects.push(o);
        sel = { p, id: o.id };
        commit();
      }
      render(p);
      paintBar();
    }

    // ---- Crop ----------------------------------------------------------------------------
    function cropDown(p, pt, e) {
      const c = cropDraft.get(p);
      const h = e.target.closest("[data-crop]");
      const whole = c.x === 0 && c.y === 0 && c.w === p.w && c.h === p.h;
      if (h) drag = { kind: "crop-handle", p, handle: h.dataset.crop, orig: { ...c } };
      else if (!whole && pt.x > c.x && pt.x < c.x + c.w && pt.y > c.y && pt.y < c.y + c.h) drag = { kind: "crop-move", p, start: pt, orig: { ...c } };
      else {
        const at = toPt(p, e, true);
        drag = { kind: "crop-new", p, start: at };
        cropDraft.set(p, { x: at.x, y: at.y, w: 0, h: 0 });
      }
    }
    function cropMove(p, pt) {
      let c;
      if (drag.kind === "crop-new") c = rectOf(drag.start, pt);
      else if (drag.kind === "crop-move") {
        const o = drag.orig;
        c = { ...o, x: Math.min(Math.max(o.x + pt.x - drag.start.x, 0), p.w - o.w), y: Math.min(Math.max(o.y + pt.y - drag.start.y, 0), p.h - o.h) };
      } else {
        const o = drag.orig, hd = drag.handle;
        const left = hd.includes("w") ? pt.x : o.x, right = hd.includes("e") ? pt.x : o.x + o.w;
        const top = hd.includes("n") ? pt.y : o.y, bottom = hd.includes("s") ? pt.y : o.y + o.h;
        c = rectOf({ x: left, y: top }, { x: right, y: bottom });
      }
      cropDraft.set(p, c);
    }
    function applyCrop() {
      let changed = false;
      for (const p of parts) {
        const c = cropDraft.get(p);
        const r = { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
        const next = r.w < 8 || r.h < 8 || (r.x <= 0 && r.y <= 0 && r.w >= p.w && r.h >= p.h) ? null : r;
        if (JSON.stringify(next) !== JSON.stringify(p.crop)) { p.crop = next; changed = true; }
      }
      cropDraft = null;
      setTool("none");
      if (changed) commit();
    }
    const cancelCrop = () => { cropDraft = null; setTool("none"); };

    // ---- Blur (pixels, in the privacy blur style) ----------------------------------------
    async function applyBlur(p, rect) {
      try {
        const k = p.w / p.inner.getBoundingClientRect().width;
        const url = await blur.draw(p.img, { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }, k);
        p.src = url;
        p.img.src = url;
        await p.img.decode().catch(() => {});
        commit();
      } catch (err) { say(`Couldn't blur: ${err.message}`, true); }
    }

    // ---- Remove background and clean up (cutout.js, in cutout-worker.js) ------------------
    // The background goes from the pixels, as with blur, so undo brings it back. Clean up is
    // a click tool: a click takes away what's left of the background there (Alt-click brings
    // back a part that shouldn't have gone), with everything connected that looks like it,
    // stopping at the subject's outline. It works on any picture, cut out or not. The worker
    // keeps each part between clicks; it's sent the part again when it has changed since.
    let cutWorker = null, cutSeq = 0, cutting = false;
    const cutWaits = new Map();
    function cutAsk(msg, transfer = []) {
      if (!cutWorker) {
        cutWorker = new Worker("cutout-worker.js");
        cutWorker.onmessage = ({ data }) => { const w = cutWaits.get(data.id); cutWaits.delete(data.id); w?.(data); };
      }
      const id = ++cutSeq;
      return new Promise((resolve) => { cutWaits.set(id, resolve); cutWorker.postMessage({ ...msg, id }, transfer); });
    }
    const busy = (on) => { cutting = on; document.body.classList.toggle("cutting", on); $("cutBtn").setAttribute("aria-disabled", String(on)); };
    // The part's pixels from before any of this: shown faintly under it while restoring.
    function keepBase(p) {
      if (p.baseUrl) return;
      p.baseUrl = p.src;
      p.under = Object.assign(document.createElement("img"), { className: "under", src: p.baseUrl, alt: "", draggable: false });
      p.inner.prepend(p.under);
    }
    async function setPixels(p, blob) {
      const url = await toDataUrl(blob);
      p.src = p.cutSrc = url;
      p.cut = true;
      p.img.src = url;
      await p.img.decode().catch(() => {});
    }
    async function removeBackground() {
      if (cutting) return;
      commitText();
      busy(true);
      say("Removing the background…");
      let done = 0, rough = false, already = false;
      try {
        for (const p of parts) {
          const bitmap = await createImageBitmap(p.img);
          const r = await cutAsk({ type: "auto", key: p.i, bitmap }, [bitmap]);
          if (r.error) throw new Error(r.error);
          if (r.already) { already = true; continue; }
          keepBase(p);
          await setPixels(p, r.blob);
          if (r.quality && !r.quality.plain) rough = true;
          done++;
        }
      } catch (err) { busy(false); return say(`Couldn't remove the background: ${err.message}`, true); }
      busy(false);
      if (!done) return say(already ? "Its background is see-through already" : "There was no background to remove");
      $("cleanBtn").hidden = false;
      commit();
      setTool("clean");
      say(rough ? "Background removed, roughly: it looks busy · click what's left of it to clean up" : "Background removed · anything left? Click it to clean it up");
    }
    async function cleanClick(p, pt, back) {
      if (cutting) return;
      const cleanMode = back ? "restore" : "erase";
      busy(true);
      try {
        let bitmap = p.src !== p.cutSrc ? await createImageBitmap(p.img) : null;
        let r = await cutAsk({ type: "wand", key: p.i, x: pt.x, y: pt.y, mode: cleanMode, bitmap }, bitmap ? [bitmap] : []);
        if (r.stale) { // the worker doesn't have this part (yet): send it
          bitmap = await createImageBitmap(p.img);
          r = await cutAsk({ type: "wand", key: p.i, x: pt.x, y: pt.y, mode: cleanMode, bitmap }, [bitmap]);
        }
        if (r.error) throw new Error(r.error);
        if (r.none) return say(cleanMode === "erase" ? "Nothing to take away there" : "Nothing taken away there to bring back");
        keepBase(p);
        await setPixels(p, r.blob);
        commit();
        say(cleanMode === "erase" ? "Taken away · undo puts it back" : "Brought back");
      } catch (err) { say(`Couldn't clean up: ${err.message}`, true); }
      finally { busy(false); }
    }
    $("cutBtn").onclick = () => removeBackground();
    // While Alt is held with clean up on, what was taken away shows faintly, to click it back
    // (and the browser's menu doesn't take the focus when it's let go).
    const altHeld = (e) => {
      const on = tool === "clean" && e.altKey;
      if (e.key === "Alt" && tool === "clean") e.preventDefault();
      if (document.body.hasAttribute("data-alt") !== on) document.body.toggleAttribute("data-alt", on);
    };
    addEventListener("keydown", altHeld);
    addEventListener("keyup", altHeld);
    addEventListener("blur", () => document.body.removeAttribute("data-alt"));

    // ---- Header: tools, color, width, and what the tool needs ---------------------------
    const toolBtns = [...document.querySelectorAll(".b[data-tool]")];
    // Clicking the tool that's on switches it off (then clicks only select marks).
    for (const b of toolBtns) b.onclick = () => setTool(tool === b.dataset.tool ? "none" : b.dataset.tool);
    // The highlighter's pointer: an outlined capsule as tall as the stroke it will draw.
    function markerCursor() {
      if (tool !== "marker" || !parts.length) return document.body.style.removeProperty("--marker-cursor");
      const h = Math.round(Math.min(96, Math.max(14, MARKER[size] * parts[0].u * scale()))), w = Math.max(8, Math.round(h * 0.42));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 4}" height="${h + 4}"><rect x="2" y="2" width="${w}" height="${h}" rx="${w / 2}" fill="${color.slice(0, 7)}" fill-opacity=".25" stroke="#000" stroke-width="2.5"/><rect x="2" y="2" width="${w}" height="${h}" rx="${w / 2}" fill="none" stroke="#fff" stroke-width="1"/></svg>`;
      document.body.style.setProperty("--marker-cursor", `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(w / 2) + 2} ${Math.round(h / 2) + 2}, crosshair`);
    }
    function setTool(t) {
      commitText();
      closePops();
      if (cropDraft && t !== "crop") cropDraft = null;
      tool = t;
      document.body.dataset.tool = t;
      for (const b of toolBtns) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
      markerCursor();
      if (t === "crop") {
        cropDraft = new Map(parts.map((p) => [p, p.crop ? { ...p.crop } : full(p)]));
        sel = null;
        say("Drag to choose the part to keep, then Apply (Enter)");
      } else if (t === "blur") {
        sel = null;
        say(`Drag over what to hide · style: ${blur.styleText()}`);
      } else if (t === "clean") {
        sel = null;
        say("Click leftover background to remove it · Alt-click brings back what shouldn't have gone");
      }
      layout();
      paintBar();
    }

    // Pop-ups under the header buttons (one open at a time).
    function closePops() {
      settleColor();
      document.querySelectorAll("header .pop, header .menu").forEach((m) => m.remove());
    }
    function togglePop(wrap, build) {
      const open = wrap.querySelector(".pop, .menu");
      closePops();
      if (!open) wrap.append(build());
    }
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest("header .wrap")) closePops(); });

    // The color menu (color-menu.js): nine colors, My colors, and the picker beside them.
    // Its eyedropper is the "What color?" picker (picker-color.js) over this tab, with its
    // magnifier, with the soft edge pixels snapped to the colors either side.
    $("colorBtn").onclick = () => togglePop($("colorWrap"), () => {
      const menu = ColorMenu.build({
        value: (selected() || textEd?.o)?.color ?? color,
        presets: COLORS,
        say,
        onPick: (c, live) => { custom = c; setColor(c, live); },
        onDone: closePops,
        eyedrop: async (keepA) => {
          closePops();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // the menu gone from the screen
          let shot;
          try {
            shot = await chrome.tabs.captureVisibleTab((await chrome.windows.getCurrent()).id, { format: "png" });
          } catch (err) { return say(`Couldn't read the screen: ${err.message}`, true); }
          window.__ttColorPicker(shot, (picked) => {
            const c = picked && toHex(picked);
            if (c) { custom = withAlpha(c, keepA); setColor(custom); }
            $("colorBtn").click(); // back to the menu, showing it
          });
        },
      });
      menu.classList.add("pop", "colors-pop");
      return menu;
    });
    const lineIcon = (i) => `<svg viewBox="0 0 24 24"><path d="M5 19 19 5" stroke-width="${[1, 2, 3.2, 4.6][i]}"/></svg>`;
    $("sizeBtn").onclick = () => togglePop($("sizeWrap"), () => {
      const pop = Object.assign(document.createElement("div"), { className: "pop sizes-pop" });
      const cur = selected()?.size ?? size;
      ["Hairline", "Thin", "Medium", "Thick"].forEach((label, i) => {
        const b = Object.assign(document.createElement("button"), { className: "sz", title: label, innerHTML: lineIcon(i) });
        b.setAttribute("aria-pressed", String(i === cur));
        b.onclick = () => { setSize(i); closePops(); };
        pop.append(b);
      });
      return pop;
    });
    // live: while trying colors in the picker (dragging, typing a hex code); they become one
    // undo step, and are remembered, when it's let go, Enter is pressed or the menu closes.
    function setColor(c, live) {
      color = c;
      markerCursor();
      const o = selected();
      if (o && o.color !== c) { o.color = c; render(sel.p); colorMoved = true; }
      if (textEd) { textEd.o.color = c; textEd.el.style.color = c; }
      colorLive = true;
      if (!live) settleColor();
      paintBar();
    }
    function settleColor() {
      if (!colorLive) return;
      colorLive = false;
      if (colorMoved) commit();
      colorMoved = false;
      savePrefs();
    }
    function setSize(i) {
      size = i;
      markerCursor();
      const o = selected();
      if (o && o.type !== "text" && o.size !== i) { o.size = i; render(sel.p); commit(); }
      savePrefs();
      paintBar();
    }
    function setFont(name) {
      font = name;
      const o = selected();
      if (o?.type === "text" && o.font !== name) { o.font = name; document.fonts.load(`600 24px ${family(name)}`).finally(() => render(sel.p)); commit(); }
      if (textEd) { textEd.o.font = name; textEd.el.style.fontFamily = family(name); }
      savePrefs();
      paintBar();
    }
    const ctx = $("ctx");
    function paintBar() {
      const o = selected() || textEd?.o;
      const marks = tool !== "crop" && tool !== "blur" && tool !== "clean";
      $("colorWrap").hidden = !marks;
      $("colorNow").style.setProperty("--c", o?.color ?? color);
      // Widths for lines, shapes and dots; text is sized by dragging its corners, and a
      // filled rectangle has no line.
      $("sizeWrap").hidden = !marks || o?.type === "text" || o?.filled || (!o && (tool === "text" || tool === "box"));
      $("sizeNow").querySelector("path").setAttribute("stroke-width", [1, 2, 3.2, 4.6][o?.size ?? size]);
      ctx.replaceChildren();
      const btn = (label, fn, cls = "tbtn") => {
        const b = Object.assign(document.createElement("button"), { className: cls, textContent: label });
        b.onclick = fn;
        ctx.append(b);
        return b;
      };
      if (tool === "crop") {
        btn("Reset", () => { cropDraft = new Map(parts.map((p) => [p, full(p)])); renderAll(); });
        btn("Cancel", cancelCrop);
        btn("Apply", applyCrop, "tbtn primary");
      } else if (tool === "blur") {
        ctx.append(Object.assign(document.createElement("span"), { className: "muted", textContent: blur.styleText() }));
        btn("Change style", blur.openSettings).title = "Privacy blur settings";
      } else if (tool !== "clean") {
        if (tool === "text" || o?.type === "text") fontButton(o?.type === "text" ? o.font : font);
        if (selected()) btn("Delete", deleteSelected).title = "Delete this mark (Delete)";
      }
    }
    function deleteSelected() {
      const o = selected();
      if (!o) return;
      const p = sel.p;
      p.objects = p.objects.filter((q) => q !== o);
      sel = null;
      render(p);
      commit();
      paintBar();
    }

    // ---- Fonts ---------------------------------------------------------------------------
    let fontDbOpen = null;
    const fontDb = () => (fontDbOpen ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("eg-fonts", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("fonts", { keyPath: "name" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    async function fontStore(mode, fn) {
      const tx = (await fontDb()).transaction("fonts", mode);
      const req = fn(tx.objectStore("fonts"));
      return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(req?.result); tx.onerror = tx.onabort = () => reject(tx.error); });
    }
    async function addFace(name, blob) {
      const face = new FontFace(name, await blob.arrayBuffer());
      await face.load();
      document.fonts.add(face);
    }
    async function loadFonts() {
      try {
        const all = await fontStore("readonly", (s) => s.getAll());
        for (const f of all.sort((a, b) => a.at - b.at)) {
          try { await addFace(f.name, f.blob); customFonts.push(f.name); } catch {}
        }
      } catch {}
    }
    async function addFontFile(file) {
      if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) return say(`${file.name} isn't a font file (.ttf, .otf, .woff, .woff2)`, true);
      if (file.size > 10 * 1024 * 1024) return say(`${file.name} is too big (10 MB at most)`, true);
      const base = file.name.replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, " ").replace(/\s+/g, " ").trim() || "Custom font";
      let name = base;
      for (let n = 2; customFonts.includes(name) || FONTS[name]; n++) name = `${base} ${n}`;
      try {
        await addFace(name, file);
      } catch {
        return say(`${file.name} couldn't be read as a font`, true);
      }
      await fontStore("readwrite", (s) => s.put({ name, blob: file, at: Date.now() })).catch(() => {});
      customFonts.push(name);
      setFont(name);
      say(`Font “${name}” added. It's kept for next time.`);
    }
    async function removeFont(name) {
      await fontStore("readwrite", (s) => s.delete(name)).catch(() => {});
      customFonts = customFonts.filter((f) => f !== name);
      if (font === name) setFont("Inter");
      say(`Font “${name}” removed`);
    }
    function fontButton(current) {
      const wrap = Object.assign(document.createElement("span"), { className: "wrap" });
      const b = Object.assign(document.createElement("button"), { className: "tbtn", textContent: `${current} ▾`, title: "Font" });
      b.style.fontFamily = family(current);
      b.onclick = () => togglePop(wrap, () => fontMenu(current));
      wrap.append(b);
      ctx.append(wrap);
    }
    function fontMenu(current) {
      const m = Object.assign(document.createElement("div"), { className: "menu" });
      const group = (title, names, removable) => {
        if (!names.length) return;
        m.append(Object.assign(document.createElement("div"), { className: "ttl", textContent: title }));
        for (const n of names) {
          const row = Object.assign(document.createElement("div"), { className: "fi" });
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", String(n === current));
          const label = Object.assign(document.createElement("span"), { textContent: n });
          label.style.fontFamily = family(n);
          row.append(label);
          row.onclick = () => { closePops(); setFont(n); };
          if (removable) {
            const x = Object.assign(document.createElement("button"), { className: "x", textContent: "×", title: `Remove ${n}` });
            x.onclick = (e) => { e.stopPropagation(); closePops(); removeFont(n); };
            row.append(x);
          }
          m.append(row);
        }
      };
      group("Your fonts", customFonts, true);
      group("Fonts", Object.keys(FONTS), false);
      const add = Object.assign(document.createElement("div"), { className: "add" });
      add.innerHTML = "＋ Add a font file…<small>.ttf .otf .woff .woff2 · or drop one on the page · kept for next time</small>";
      add.onclick = () => { closePops(); $("fontFile").click(); };
      m.append(add);
      return m;
    }
    $("fontFile").onchange = () => {
      const f = $("fontFile").files[0];
      $("fontFile").value = "";
      if (f) addFontFile(f);
    };
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = [...(e.dataTransfer?.files || [])].find((x) => /\.(ttf|otf|woff2?)$/i.test(x.name));
      if (f) addFontFile(f);
    });

    // ---- Preferences (color, width, font, text size; My colors: color-menu.js) ----------------------
    const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
    async function loadPrefs() {
      const { shotEdit: pr } = await chrome.storage.local.get("shotEdit");
      if (HEX.test(pr?.color || "")) color = pr.color;
      if (HEX.test(pr?.custom || "")) custom = pr.custom;
      if ([0, 1, 2, 3].includes(pr?.size)) size = pr.size;
      if (pr?.font && (FONTS[pr.font] || customFonts.includes(pr.font))) font = pr.font;
      if (pr?.textFs >= 6 && pr.textFs <= 400) textFs = pr.textFs;
    }
    const savePrefs = () => chrome.storage.local.set({ shotEdit: { color, size, font, textFs, custom } }).catch(() => {});

    // ---- Keyboard ------------------------------------------------------------------------
    addEventListener("keydown", (e) => {
      if (textEd || e.target.closest?.("input, textarea, [contenteditable]")) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && k === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
      if (mod && k === "y") { e.preventDefault(); return redo(); }
      if (mod && (k === "=" || k === "+")) { e.preventDefault(); return step(1); }
      if (mod && k === "-") { e.preventDefault(); return step(-1); }
      if (mod && k === "0") { e.preventDefault(); return fit(); }
      if (mod && k === "1") { e.preventDefault(); return setZoom(1); }
      if (mod || e.altKey) return;
      if (cropDraft && e.key === "Enter") { e.preventDefault(); return applyCrop(); }
      if (e.key === "Escape") {
        if (document.querySelector("header .pop, header .menu")) return closePops();
        if (cropDraft) return cancelCrop();
        if (sel) return select(null);
        if (tool !== "none") return setTool("none");
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); return deleteSelected(); }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.key] && selected()) {
        e.preventDefault();
        const o = selected(), n = e.shiftKey ? 10 : 1;
        moveBy(o, structuredClone(o), arrows[e.key][0] * n * sel.p.u, arrows[e.key][1] * n * sel.p.u);
        render(sel.p);
        commit();
        return;
      }
      if (TOOL_KEYS[k]) setTool(tool === TOOL_KEYS[k] ? "none" : TOOL_KEYS[k]);
    });

    // ---- Start ---------------------------------------------------------------------------
    const ready = (async () => {
      await build();
      await loadFonts();
      await loadPrefs();
      commit();
      savedAt = hi;
      for (const id of ["tools", "edits", "zoom"]) $(id).hidden = false;
      setTool("none");
    })();

    return {
      ready,
      exportItems,
      edited: () => hi !== savedAt,
      cutOut: () => parts.some((p) => p.cut), // a background removed somewhere: see-through
      markSaved: () => { savedAt = hi; },
    };
  }

  globalThis.ShotEdit = { start };
})();
