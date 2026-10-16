// Dark mode, in the page alongside dark.css (top frame of sites where it's on):
// - pages that are already dark are left alone ("off"), page by page;
// - light pages with a dark theme of their own get that instead of inverting ("native");
// - background pictures are marked so dark.css flips them back like <img> (dark-pictures.js);
// - frames embedded in the page ask here whether it's inverted (dark-frame.js).
(() => {
  if (window.__ttDark) return;
  window.__ttDark = true;
  const root = document.documentElement;

  // ---- Already dark? -------------------------------------------------------------
  // Decided per page, not per site (one dark page doesn't make a whole site dark). Pages
  // found dark are remembered in the site's own localStorage, which can be read before
  // the first paint, so a known dark page is never inverted, not even for a frame.

  // A CSS color as [r, g, b, alpha] (0–255, alpha 0–1); [] if it isn't one. Colors can be
  // given in any form (oklch(), lab(), color(), …) and are read as such, so the browser
  // turns them into sRGB by painting one pixel.
  let probe = null;
  function rgb(c) {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(c);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4] / (m[5] ? 100 : 1)];
    if (c === "transparent") return [0, 0, 0, 0];
    try {
      probe ??= Object.assign(new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true }), { globalCompositeOperation: "copy" });
      probe.fillStyle = "#0000";
      probe.fillStyle = c; // not a color: stays transparent
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
      return a ? [r, g, b, a / 255] : [];
    } catch { return []; }
  }
  const COLORS = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/g;
  const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // Background colors count as solid colors or the average of a gradient. A picture
  // ("url(…)") says nothing usable about brightness, so it's skipped. Some sites put a
  // dark color on body and then cover nearly all of it with light content (or a light
  // picture), so the page's own background color alone can't be trusted.
  function backgroundLight(cs) {
    const img = cs.backgroundImage;
    if (img && img !== "none" && /url\(/.test(img)) return undefined; // picture: unknown
    const c = rgb(cs.backgroundColor);
    if (c.length >= 3 && (c[3] ?? 1) > 0.5) return luminance(c);
    if (img && img !== "none") {
      const stops = (img.match(COLORS) || []).map(rgb).filter((s) => s.length >= 3 && (s[3] ?? 1) > 0.5);
      if (stops.length) return stops.reduce((sum, s) => sum + luminance(s), 0) / stops.length;
    }
    return null; // transparent: look further back
  }
  // What is actually painted at a point of the screen: the first element under it (or
  // behind it) with a background. Transparent all the way down = white.
  function lightAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    // A drawing surface, video or picture: its pixels can't be read, so it says nothing.
    if (hit && /^(canvas|video|img|picture|iframe|embed|object)$/.test(hit.localName)) return undefined;
    for (let el = hit; el; el = el.parentElement) {
      // Below a short body the page shows body's color (dark.css's white on html is ours).
      if (el === root && document.body) {
        const l = backgroundLight(getComputedStyle(document.body));
        if (l !== null) return l;
      }
      const l = backgroundLight(getComputedStyle(el));
      if (l !== null) return l; // a number, or undefined for a picture
    }
    return 1;
  }
  // Light text, weighted by how much of it there is (sampled), 0–1.
  function textLight() {
    let total = 0, light = 0;
    const els = document.body.querySelectorAll("p, li, a, span, td, h1, h2, h3, h4, div");
    for (let i = 0; i < els.length && total < 4000; i += Math.max(1, Math.floor(els.length / 400))) {
      const el = els[i], len = el.firstChild?.nodeType === 3 ? el.firstChild.data.trim().length : 0;
      if (!len) continue;
      total += len;
      if (luminance(rgb(getComputedStyle(el).color)) > 0.6) light += len;
    }
    return total ? light / total : 0;
  }
  // What the page says about itself: a strict <meta name="color-scheme">, color-scheme on
  // the root, or a dark/light class or data-theme/-mode/-color-mode on html or body.
  // true = dark, false = light, null = it doesn't say.
  function declared() {
    const meta = document.querySelector('meta[name="color-scheme"]')?.content.trim().toLowerCase();
    if (meta === "dark" || meta === "only dark") return true;
    if (meta === "light" || meta === "only light") return false;
    if (getComputedStyle(root).colorScheme.trim() === "dark") return true;
    for (const el of [root, document.body]) {
      if (!el) continue;
      if (el.classList.contains("dark")) return true;
      if (el.classList.contains("light")) return false;
      for (const key of ["theme", "mode", "colorMode", "colorScheme"]) {
        const v = el.dataset[key]?.toLowerCase();
        if (v === "dark") return true;
        if (v === "light") return false;
      }
    }
    return null;
  }
  // Too early to judge: no real content yet, or no styles loaded.
  // (Content can be all position:fixed, which leaves body 0 px tall, so look at the boxes.)
  function ready() {
    const body = document.body;
    if (!body) return false;
    const content = [...body.children].some((c) => {
      if (/^(SCRIPT|STYLE|LINK|NOSCRIPT|TEMPLATE)$/.test(c.tagName)) return false;
      const r = c.getBoundingClientRect();
      return r.width >= 32 && r.height >= 32;
    });
    return content && (document.styleSheets.length > 0 || !!root.style.backgroundColor || !!body.style.backgroundColor);
  }
  // Dark when it says so; otherwise when nearly all of what's on screen is dark (a 7×6 grid
  // of points over the viewport; one light page area among dark ones is enough to call it
  // light). Too few readable points (pictures, canvas): decide by the text.
  function alreadyDark() {
    const said = declared();
    if (said !== null) return said;
    return screenDark();
  }
  function screenDark() {
    return own(screenDarkNow);
  }
  function screenDarkNow() {
    if (!ready()) return null;
    let dark = 0, known = 0;
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 6; j++) {
        const l = lightAt(innerWidth * (i + 0.5) / 7, innerHeight * (j + 0.5) / 6);
        if (l === undefined) continue;
        known++;
        if (l < 0.4) dark++;
      }
    }
    if (known >= 6) return dark / known >= 0.8;
    return textLight() > 0.6;
  }

  const KEY = "__ttDarkPages";
  const known = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  function remember(path, dark) {
    try {
      const list = known().filter((p) => p !== path);
      if (dark) list.push(path);
      localStorage.setItem(KEY, JSON.stringify(list.slice(-300)));
    } catch {} // storage blocked: just no head start next time
  }

  // "off" set here (page is dark) vs by the tools (site switched off): only undo our own.
  let selfOff = false;
  const setSelfOff = (on) => {
    if (on && !root.hasAttribute("data-tt-dark")) { root.setAttribute("data-tt-dark", "off"); selfOff = true; }
    if (!on && selfOff) { if (root.getAttribute("data-tt-dark") === "off") root.removeAttribute("data-tt-dark"); selfOff = false; }
  };

  // ---- The site's own dark theme ------------------------------------------------------
  // Many sites ship a dark theme switched by a "dark" class or a data-theme/-mode/... value
  // on <html> (and some on inner elements, like Claude's .cds-root), or by color-scheme
  // (CSS light-dark()). On a light page those are switched to dark and the page measured
  // in the same moment, before anything is painted: dark now → keep the site's own theme
  // instead of inverting ("native"); not → undo every change and invert. A site that keeps
  // resetting its theme gets it put back a few times, then is inverted instead. Pages where
  // it worked are remembered (localStorage) and switched before the first paint.

  const ATTRS = ["data-theme", "data-mode", "data-color-mode", "data-bs-theme", "data-color-scheme"];
  const NATIVE_KEY = "__ttDarkNativePages";
  const SOFT = /^(light|auto|system|)$/i; // values we may replace; a theme's own name we leave
  let native = null; // { changes: [[element, what, old value]], resets }
  const tried = new Set(); // paths where it didn't work this visit

  function applyNative() {
    const changes = [];
    const set = (el, name, value) => {
      const old = el.getAttribute(name);
      if (old === value) return;
      changes.push([el, name, old]);
      el.setAttribute(name, value);
    };
    if (!root.classList.contains("dark")) { changes.push([root, "class", null]); root.classList.add("dark"); }
    for (const a of ATTRS) { const v = root.getAttribute(a); if (v === null || SOFT.test(v)) set(root, a, "dark"); }
    for (const el of document.querySelectorAll(ATTRS.map((a) => `[${a}="light" i]`).join(","))) {
      if (el !== root) for (const a of ATTRS) if (/^light$/i.test(el.getAttribute(a) || "")) set(el, a, "dark");
    }
    if (root.style.getPropertyValue("color-scheme") !== "dark") {
      changes.push([root, "color-scheme", root.style.getPropertyValue("color-scheme")]);
      root.style.setProperty("color-scheme", "dark");
    }
    return changes;
  }
  function undoNative(changes) {
    for (const [el, what, old] of changes.reverse()) {
      if (what === "class") el.classList.remove("dark");
      else if (what === "color-scheme") old ? el.style.setProperty("color-scheme", old) : el.style.removeProperty("color-scheme");
      else if (old === null) el.removeAttribute(what);
      else el.setAttribute(what, old);
    }
    if (!root.getAttribute("style")) root.removeAttribute("style");
  }
  const nativeKnown = () => { try { return JSON.parse(localStorage.getItem(NATIVE_KEY) || "[]"); } catch { return []; } };
  function rememberNative(path, works) {
    try {
      const list = nativeKnown().filter((p) => p !== path);
      if (works) list.push(path);
      localStorage.setItem(NATIVE_KEY, JSON.stringify(list.slice(-300)));
    } catch {}
  }
  function startNative(changes) {
    native = { changes, resets: 0 };
    root.setAttribute("data-tt-dark", "native");
    window.__ttNativeOn = true;
  }
  function stopNative(fallBackToInvert) {
    if (!native) return;
    undoNative(native.changes);
    native = null;
    window.__ttNativeOn = false;
    if (fallBackToInvert && root.getAttribute("data-tt-dark") === "native") root.removeAttribute("data-tt-dark");
  }
  // Light page: try its own dark theme. True if it's on now.
  function tryNative(path) {
    if (native || tried.has(path)) return !!native;
    const changes = applyNative();
    if (changes.length && screenDark() === true) {
      startNative(changes);
      rememberNative(path, true);
      return true;
    }
    undoNative(changes);
    tried.add(path);
    rememberNative(path, false);
    return false;
  }
  // Native theme in use: put back what the site reset, and check it still looks dark.
  function keepNative(path) {
    const before = native.changes.length;
    native.changes.push(...applyNative());
    if (native.changes.length > before && ++native.resets > 10) return giveUp(path); // the site keeps undoing it
    if (screenDark() === false) giveUp(path);
  }
  function giveUp(path) {
    stopNative(true);
    tried.add(path);
    rememberNative(path, false);
  }
  // The tools switched dark mode off (data-tt-dark set to "off" over "native"), or back on.
  new MutationObserver(() => {
    const v = root.getAttribute("data-tt-dark");
    if (native && v !== "native") stopNative(false);
    else if (!native && v === null) setTimeout(check, 50);
  }).observe(root, { attributes: true, attributeFilter: ["data-tt-dark"] });

  let page = location.pathname;
  if (known().includes(page)) setSelfOff(true); // before the first paint
  else if (nativeKnown().includes(page)) startNative(applyNative());

  // Stays inverted if the site is on the "darken anyway" list.
  let checking = false;
  // After the extension is reloaded or updated, this copy is cut off from it (no
  // chrome.runtime): it leaves the page as it is and stops checking.
  const cutOff = () => !chrome.runtime?.id;

  // ---- Frames in the page -------------------------------------------------------------
  // Frames embedded in the page are drawn inverted with it; dark-frame.js inside them
  // flips their own pictures back, so it asks here (through the background) whether the
  // page is inverted, and is told when that changes.
  const inverted = () => !root.hasAttribute("data-tt-dark");
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "darkTopState") reply({ inverted: inverted() });
  });
  let told = inverted();
  new MutationObserver(() => {
    if (inverted() === told || cutOff()) return;
    told = inverted();
    if (window.frames.length) chrome.runtime.sendMessage({ type: "darkTopChanged", inverted: told }).catch(() => {});
  }).observe(root, { attributes: true, attributeFilter: ["data-tt-dark"] });

  function check() {
    if (checking || !document.body || cutOff()) return;
    pageColor(); // the site's theme may have changed it
    const path = location.pathname;
    if (native) return keepNative(path);
    const dark = alreadyDark();
    if (dark === null) return; // nothing to judge yet; the later checks will
    window.__ttDarkPage = dark;
    remember(path, dark);
    if (!dark) {
      if (root.getAttribute("data-tt-dark") === "off" && !selfOff) return; // switched off in the tools
      setSelfOff(false);
      tryNative(path);
      return;
    }
    checking = true;
    let asked;
    try { asked = chrome.runtime.sendMessage({ type: "darkNative" }); } catch { asked = Promise.reject(); }
    asked.then(
      (r) => setSelfOff(!r?.keep),
      () => setSelfOff(true),
    ).finally(() => (checking = false));
  }

  // In-page navigation (one page of an app can be dark, the next light) and the site's
  // own theme switch: look again.
  function recheck() {
    if (location.pathname !== page) { page = location.pathname; photoCanvas(); }
    setTimeout(check, 50);
  }
  // Apps build their page after loading (often over a loading screen of another color),
  // so look again a few times early on and whenever a lot of new content appears.
  let lastBig = 0;
  function bigChange() {
    const now = Date.now();
    if (now - lastBig < 2000) return;
    lastBig = now;
    setTimeout(check, 300);
  }
  window.navigation?.addEventListener("navigatesuccess", recheck);
  setInterval(() => location.pathname !== page && recheck(), 1000);
  const themeWatch = new MutationObserver(recheck);

  // ---- Background pictures and canvases --------------------------------------------

  const PICTURE = /url\((?!["']?data:image\/svg)/;
  const pictures = window.__ttDarkPictures?.(bigChange); // dark-pictures.js

  // A <canvas> stays dark with the page (documents, sheets, charts), except on map sites,
  // where it shows maps and satellite photos: there it's flipped back (dark.css).
  const PHOTO_CANVAS = /^(maps\.google\.[a-z.]+|earth\.google\.com|maps\.apple\.com)\/|^(www\.)?(google\.[a-z.]+|bing\.com)\/maps\b/;
  const photoCanvas = () => root.toggleAttribute("data-tt-dark-canvas", PHOTO_CANVAS.test(location.hostname + location.pathname));
  photoCanvas();

  // The page's own background picture goes to its own layer (dark.css, html::before).
  // Its color goes to the color layer, as for every page (pageColor).
  function pagePicture() {
    own(() => {
      for (const el of [document.body, root]) {
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (!PICTURE.test(cs.backgroundImage)) continue;
        const color = [document.body, root].map((e) => e && getComputedStyle(e).backgroundColor)
          .find((c) => c && (rgb(c)[3] ?? 1) > 0.5) || "#fff";
        for (const [name, value] of [["image", cs.backgroundImage], ["position", cs.backgroundPosition],
          ["size", cs.backgroundSize], ["repeat", cs.backgroundRepeat]]) root.style.setProperty(`--tt-dark-bg-${name}`, value);
        root.setAttribute("data-tt-dark-bg", "");
        setPage(color);
        return;
      }
    });
  }

  // ---- The page's background color ---------------------------------------------------
  // dark.css draws it on a layer of its own and gives <html> the color it turns into once
  // inverted, which Chrome shows (unfiltered) where it hasn't drawn the page yet in fast
  // scrolling and in the bounce past either end. The page's own background on <html> is
  // read by lifting that rule for a moment (data-tt-dark-peek; nothing is painted meanwhile).
  function own(read) {
    root.setAttribute("data-tt-dark-peek", "");
    try { return read(); } finally { root.removeAttribute("data-tt-dark-peek"); }
  }
  // What a color looks like through dark.css's invert(0.93) hue-rotate(180deg).
  const HUE180 = [[-0.574, 1.43, 0.144], [0.426, 0.43, 0.144], [0.426, 1.43, -0.856]];
  const throughFilter = (c) => {
    const v = c.map((x) => 0.93 - 0.86 * x / 255);
    return HUE180.map((r) => Math.round(255 * Math.min(1, Math.max(0, r[0] * v[0] + r[1] * v[1] + r[2] * v[2]))));
  };
  function setPage(color, image = "none") {
    let c = rgb(color);
    if (c.length < 3) c = [255, 255, 255, 1];
    c = c.slice(0, 3).map((v) => Math.round(v * c[3] + 255 * (1 - c[3]))); // on white
    const vars = { "--tt-dark-page": `rgb(${c.join(" ")})`, "--tt-dark-page-image": image, "--tt-dark-under": `rgb(${throughFilter(c).join(" ")})` };
    for (const [name, value] of Object.entries(vars)) if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  }
  function pageColor() {
    if (root.hasAttribute("data-tt-dark-bg")) return; // set with the picture
    const [color, image] = own(() => { const cs = getComputedStyle(root); return [cs.backgroundColor, cs.backgroundImage]; });
    setPage(color, PICTURE.test(image) ? "none" : image);
  }

  function start() {
    pagePicture();
    pageColor();
    check();
    for (const t of [300, 1000, 2500, 5000]) setTimeout(check, t);
    pictures?.start();
    const theme = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode", "data-color-mode", "data-bs-theme", "data-color-scheme", "data-dark-theme"] };
    themeWatch.observe(root, theme);
    if (document.body) themeWatch.observe(document.body, theme);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  // Late stylesheets can change the page color; look once more when everything has loaded.
  addEventListener("load", () => { if (!root.hasAttribute("data-tt-dark-bg")) pagePicture(); pageColor(); pictures?.again(); recheck(); }, { once: true });
})();
