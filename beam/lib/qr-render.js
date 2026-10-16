// QR codes in Extra Guac's own look: avocado-half eyes with a pit, every square a small leaf
// in two avocado greens, on the cream of the flesh, with an icon in the middle (the avocado,
// your own, or none). Dense codes (long content) are drawn as ridges instead: dots that join
// their neighbors into lines, with the small alignment marks as little avocado halves. Used by the QR page (qr.html) and the offscreen page (for the popup and
// the right-click menu). Needs beam/lib/qrcode.min.js (the squares) and beam/lib/jsQR.min.js
// (the check: every code is read back before it's used; an icon that stops it scanning is
// made smaller, then left out).
(() => {
  const C = { ink: "#26480f", ink2: "#355f17", bg: "#f6f2cf", flesh: "#e9e3a0", pit: "#3f2410" };
  const QZ = 4, U = 10; // quiet zone in squares; one square in SVG units
  const MAX = 500; // the most a code holds, in bytes (UTF-8): beyond it, codes get hard to scan
  const DENSE = 45; // squares across above which a code is drawn as ridges
  const size = (text) => new TextEncoder().encode(String(text || "")).length;

  // The squares, at the highest error correction (about 30% of the code can be covered).
  function matrix(text) {
    if (size(text) > MAX) throw new Error(`Over ${MAX}: shorten it to make a code`);
    const q = new QRCode(document.createElement("div"), { text, width: 32, height: 32, correctLevel: QRCode.CorrectLevel.H })._oQRCode;
    const n = q.getModuleCount();
    return { n, dark: (r, c) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c) };
  }
  // The centers of the alignment marks (the small 5×5 squares of codes past version 1),
  // as the QR standard spaces them, without the three under the corner eyes.
  function alignments(n) {
    const v = (n - 17) / 4;
    if (v < 2) return [];
    const count = Math.floor(v / 7) + 2, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (count * 2 - 2)) * 2;
    const pos = [6];
    for (let p = n - 7; pos.length < count; p -= step) pos.splice(1, 0, p);
    const out = [];
    for (const r of pos) for (const c of pos) if (!((r < 9 && c < 9) || (r < 9 && c > n - 10) || (r > n - 10 && c < 9))) out.push([r, c]);
    return out;
  }
  // Clockwise, like the bridges between ridge dots, so where they overlap stays filled.
  const circle = (cx, cy, R) => `M${cx - R},${cy}a${R},${R} 0 1 1 ${2 * R},0a${R},${R} 0 1 1 ${-2 * R},0Z`;

  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // A square with two opposite corners fully round: a leaf, turned either way.
  function leaf(x, y, s, flip, k = 0.45) {
    const r = s * k;
    return flip
      ? `M${x},${y + s}L${x},${y + r}A${r},${r} 0 0 1 ${x + r},${y}L${x + s},${y}L${x + s},${y + s - r}A${r},${r} 0 0 1 ${x + s - r},${y + s}Z`
      : `M${x},${y}L${x + s - r},${y}A${r},${r} 0 0 1 ${x + s},${y + r}L${x + s},${y + s}L${x + r},${y + s}A${r},${r} 0 0 1 ${x},${y + s - r}Z`;
  }
  // An avocado half: an egg, narrow end turned towards the code's outer corner. It keeps
  // the 7-square width across its middle that scanners look for.
  function egg(cx, cy, R, rot, tip = 0.13) {
    const a = (rot * Math.PI) / 180, pts = [];
    for (let i = 0; i < 72; i++) {
      const t = (i / 72) * Math.PI * 2;
      const x = R * Math.cos(t) * (1 + tip * Math.sin(t)), y = R * Math.sin(t) * (1 - (tip ? 0.04 : 0) * Math.abs(Math.cos(t)));
      pts.push(`${(cx + x * Math.cos(a) - y * Math.sin(a)).toFixed(2)},${(cy + x * Math.sin(a) + y * Math.cos(a)).toFixed(2)}`);
    }
    return `M${pts.join("L")}Z`;
  }

  // The code as an SVG string. icon: an image data URL for the middle (or none); iconScale:
  // how much of the space kept for it the icon takes (1 = all), the whole image always fitting
  // in it; style: "auto" (ridges when dense) or "leaf".
  function svg(text, { icon = null, iconScale = 1, style = "auto" } = {}) {
    const { n, dark } = matrix(text);
    const ridges = style !== "leaf" && n > DENSE;
    const S = (n + 2 * QZ) * U, X = (c) => (c + QZ) * U;
    const inEye = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    const mid = (n - 1) / 2;
    const half = icon && iconScale > 0 ? Math.max(1, Math.round((n * 0.105 + 0.5) * iconScale)) : -1; // the middle kept clear, in squares from the center
    const inIcon = (r, c) => half >= 0 && Math.abs(r - mid) <= half && Math.abs(c - mid) <= half;
    const rnd = (r, c) => hash(`${text}|${r}|${c}`) % 2;
    // Ridges: the alignment marks are drawn whole (as dots, scanners can't find them).
    const marks = ridges ? alignments(n).filter(([r, c]) => !inIcon(r, c)) : [];
    const inMark = (r, c) => marks.some(([a, b]) => Math.abs(r - a) <= 2 && Math.abs(c - b) <= 2);
    // Dense codes (long text) get fuller, squarer leaves: more dark to read in each square.
    const round = n <= 45 ? 0.45 : n <= 65 ? 0.32 : n <= 89 ? 0.22 : 0.14, inset = n <= 45 ? 0.3 : 0.1;
    let out = `<rect width="${S}" height="${S}" rx="${(S * 0.06).toFixed(1)}" fill="${C.bg}"/>`;
    if (ridges) {
      // One path, so joins don't show seams: a dot per square, bridged to the square on its
      // right and below when that's dark too.
      const on = (r, c) => dark(r, c) && !inEye(r, c) && !inIcon(r, c) && !inMark(r, c);
      const R = U * 0.4;
      let d = "";
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (!on(r, c)) continue;
          const cx = X(c) + U / 2, cy = X(r) + U / 2;
          d += circle(cx, cy, R);
          if (on(r, c + 1)) d += `M${cx},${cy - R}H${cx + U}V${cy + R}H${cx}Z`;
          if (on(r + 1, c)) d += `M${cx - R},${cy}H${cx + R}V${cy + U}H${cx - R}Z`;
        }
      }
      out += `<path d="${d}" fill="${C.ink}"/>`;
      for (const [r, c] of marks) {
        const cx = X(c) + U / 2, cy = X(r) + U / 2;
        out += `<path d="${circle(cx, cy, 2.5 * U)} ${circle(cx, cy, 1.5 * U)}" fill="${C.ink}" fill-rule="evenodd"/>`
          + `<path d="${circle(cx, cy, 1.5 * U)}" fill="${C.flesh}"/><circle cx="${cx}" cy="${cy}" r="${0.62 * U}" fill="${C.pit}"/>`;
      }
    } else {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (dark(r, c) && !inEye(r, c) && !inIcon(r, c)) out += `<path d="${leaf(X(c) + inset, X(r) + inset, U - 2 * inset, (r + c) % 2, round)}" fill="${rnd(r, c) ? C.ink : C.ink2}"/>`;
        }
      }
    }
    // Dense codes get round avocado halves: scanners measure the squares' size from these
    // corners, and on a big code an egg's lean adds up to squares read in the wrong place.
    const tip = n <= DENSE ? 0.13 : 0;
    [[0, 0, 45], [0, n - 7, 135], [n - 7, 0, -45]].forEach(([r, c, rot]) => {
      const cx = X(c) + 3.5 * U, cy = X(r) + 3.5 * U;
      out += `<path d="${egg(cx, cy, 3.5 * U, rot, tip)} ${egg(cx, cy, 2.5 * U, rot, tip)}" fill="${C.ink}" fill-rule="evenodd"/>`
        + `<path d="${egg(cx, cy, 2.5 * U, rot, tip)}" fill="${C.flesh}"/>`
        // The pit is one solid dark disc: a camera sees a shine on it, or a lighter brown, as light,
        // which breaks the dark middle scanners find the code by.
        + `<circle cx="${cx}" cy="${cy}" r="${1.55 * U}" fill="${C.pit}"/>`;
    });
    if (half >= 0) {
      // The icon's space: the whole image, as large as fits in it.
      const L = (2 * half + 1) * U, x = X(mid) + U / 2 - L / 2, pad = L * 0.08, box = L - 2 * pad;
      out += `<image href="${icon}" x="${(x + pad).toFixed(1)}" y="${(x + pad).toFixed(1)}" width="${box.toFixed(1)}" height="${box.toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">${out}</svg>`;
  }

  async function image(svgText) {
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
    await img.decode();
    return img;
  }
  // A PNG data URL, size pixels square.
  async function png(svgText, size = 1024) {
    const img = await image(svgText);
    const c = Object.assign(document.createElement("canvas"), { width: size, height: size });
    c.getContext("2d").drawImage(img, 0, 0, size, size);
    return c.toDataURL("image/png");
  }
  // Read back as a phone would: large, small, and small and a little blurred (sizes in
  // pixels per square, so a long text, with many more squares, gets the same test).
  async function scans(svgText, text) {
    const img = await image(svgText);
    const squares = img.naturalWidth / U;
    for (const [px, blur] of [[10, 0], [4, 0], [4, 0.8]]) {
      const size = Math.round(squares * px);
      const c = Object.assign(document.createElement("canvas"), { width: size, height: size });
      const x = c.getContext("2d", { willReadFrequently: true });
      x.fillStyle = "#fff";
      x.fillRect(0, 0, size, size);
      if (blur) x.filter = `blur(${blur}px)`;
      x.drawImage(img, 0, 0, size, size);
      const got = jsQR(x.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: "dontInvert" });
      if (!got || new TextDecoder().decode(new Uint8Array(got.binaryData)) !== text) return false;
    }
    return true;
  }
  // The code, checked: with the icon as asked, else a smaller one, else none. A dense code
  // that doesn't read back as ridges is tried with leaves before its icon is made smaller.
  // fit: the icon's empty (transparent) edges trimmed first, so what's left fills its space.
  // clean: the icon's background removed first (Extra Guac's cutout.js, where it's loaded).
  async function make(text, { icon = null, fit = false, clean = false } = {}) {
    if (!text) throw new Error("Nothing to put in the QR code");
    if (icon && clean && self.EGCutout) icon = await self.EGCutout.cleanUrl(icon).catch(() => icon);
    if (icon && fit) icon = await fitIcon(icon).catch(() => icon);
    const styles = matrix(text).n > DENSE ? ["auto", "leaf"] : ["auto"];
    for (const iconScale of icon ? [1, 0.7, 0] : [0]) {
      for (const style of styles) {
        const s = svg(text, { icon, iconScale, style });
        if (await scans(s, text)) return { svg: s, iconScale, ok: true, style };
      }
    }
    return { svg: svg(text), iconScale: 0, ok: false };
  }

  // What goes in the code for each kind of content.
  function payload(kind, v = {}) {
    if (kind === "url") {
      const u = String(v.url || "").trim();
      // A scheme of its own (http:, ftp:…) stays; a bare address gets https://, also one with
      // a port (example.com:8080/path, localhost:3000), which only looks like a scheme.
      const hostPort = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d+([/?#]|$)/i.test(u);
      return u && (hostPort || !/^[a-z][a-z0-9+.-]*:/i.test(u)) ? `https://${u}` : u;
    }
    if (kind === "phone") { const p = String(v.phone || "").replace(/[^\d+]/g, ""); return p ? `tel:${p}` : ""; }
    if (kind === "email") {
      const to = String(v.to || "").trim();
      if (!to) return "";
      const q = [["subject", v.subject], ["body", v.body]].filter(([, x]) => x).map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join("&");
      return `mailto:${to}${q ? `?${q}` : ""}`;
    }
    return String(v.text || "");
  }
  // The kind of content a code holds, from what's in it.
  const kindOf = (p) => (/^tel:/i.test(p) ? "phone" : /^mailto:/i.test(p) ? "email" : /^https?:\/\/\S+$/i.test(p) ? "url" : "text");

  // An image as a data URL (an image inside an SVG drawn to a canvas has to be embedded).
  const dataUrls = new Map();
  async function dataUrlOf(url) {
    if (!dataUrls.has(url)) {
      dataUrls.set(url, fetch(url).then((r) => r.blob()).then((blob) => new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(blob);
      })));
    }
    return dataUrls.get(url);
  }
  // An icon with its transparent edges trimmed, centered on a square (a PNG data URL): drawn
  // to fit, its visible part fills the space, and nothing of it is cut off. Images without
  // transparent edges come back as they are (a white or colored background is kept: it may
  // be the design).
  const fitted = new Map();
  function fitIcon(url) {
    if (!fitted.has(url)) fitted.set(url, (async () => {
      // createImageBitmap rather than an <img>: it decodes in a hidden page too (the offscreen
      // one, for the popup and the menu), where an image's decode() can wait for ever.
      const img = await createImageBitmap(await (await fetch(url)).blob());
      const k = Math.min(1, 512 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(img, 0, 0, w, h);
      const px = x.getImageData(0, 0, w, h).data;
      let top = h, left = w, right = -1, bottom = -1;
      for (let y = 0; y < h; y++) {
        for (let i = 0; i < w; i++) {
          if (px[(y * w + i) * 4 + 3] > 12) { // not (nearly) transparent
            if (i < left) left = i;
            if (i > right) right = i;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }
      if (right < 0 || (left === 0 && top === 0 && right === w - 1 && bottom === h - 1)) return url;
      const cw = right - left + 1, ch = bottom - top + 1, side = Math.max(cw, ch);
      const out = Object.assign(document.createElement("canvas"), { width: side, height: side });
      out.getContext("2d").drawImage(c, left, top, cw, ch, (side - cw) / 2, (side - ch) / 2, cw, ch);
      return out.toDataURL("image/png");
    })());
    return fitted.get(url);
  }

  // The extension's avocado (in the extension only).
  const avocado = () => dataUrlOf(chrome.runtime.getURL("icons/icon128.png"));

  globalThis.EGQR = { svg, png, scans, make, fitIcon, payload, kindOf, avocado, dataUrlOf, size, MAX, COLORS: C };
})();
