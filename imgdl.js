// Save images on click (settings.imgDl): holding the chosen key (Option/Alt, Ctrl/⌘ or
// Shift) and clicking an image saves it (bg-imgdl.js does the saving and any conversion).
// Finds <img> (the size actually shown), images covered by another layer, CSS background
// images and inline SVG. A thumbnail that links to its full-size picture (search results
// keep the original's address in the link as ?imgurl=…, and many sites link a preview
// straight to the image file) saves the full-size one, or the shown one if that fails.
// The click never reaches the page, so links aren't followed and
// Chrome's own Alt+click link download doesn't happen.
(() => {
  if (window.__ttImgDl) return;
  window.__ttImgDl = true;

  let enabled = false, modifier = "alt";
  function apply(settings) {
    const d = settings?.imgDl || {};
    enabled = !!d.enabled;
    modifier = ["alt", "ctrl", "shift"].includes(d.modifier) ? d.modifier : "alt";
  }
  chrome.storage.local.get("tt").then(({ tt }) => apply(tt));
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.tt && chrome.runtime?.id) apply(c.tt.newValue); });

  // "ctrl" also means ⌘ (on a Mac, Ctrl+click is the right-click menu).
  const held = (e) => (modifier === "alt" ? e.altKey : modifier === "ctrl" ? e.ctrlKey || e.metaKey : e.shiftKey);

  const bgUrl = (el) => {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg !== "none" && /url\(["']?(.*?)["']?\)/.exec(bg);
    return m ? new URL(m[1], document.baseURI).href : "";
  };
  const svgUrl = (svg) => {
    const copy = svg.cloneNode(true);
    if (!copy.getAttribute("xmlns")) copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(copy))))}`;
  };

  const IMG_FILE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;
  const decode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
  // The full-size picture the nearest enclosing link points to, if it points to one.
  function linkedOriginal(el) {
    const a = el.closest?.("a[href]");
    if (!a) return "";
    // The address may be encoded once more inside another link (a redirect), so look twice.
    const m = /[?&]imgurl=([^&]+)/.exec(a.href) || /[?&]imgurl=([^&]+)/.exec(decode(a.href));
    const orig = m && decode(m[1]);
    if (orig && /^https?:\/\//i.test(orig)) return orig;
    try {
      const u = new URL(a.href);
      return /^https?:$/.test(u.protocol) && IMG_FILE.test(u.pathname) ? u.href : "";
    } catch { return ""; }
  }

  // { url, fallback }: what to save, and what to save instead if that can't be fetched.
  function imageAt(e) {
    // What was clicked, then whatever else sits under the pointer (an image is often
    // covered by a transparent layer or a link box).
    const under = [...e.composedPath().filter((n) => n instanceof Element), ...document.elementsFromPoint(e.clientX, e.clientY)];
    for (const el of under.slice(0, 12)) {
      if (el === document.body || el === document.documentElement) break;
      let shown = "";
      if (el instanceof HTMLImageElement) shown = el.currentSrc || el.src;
      else if (el instanceof SVGSVGElement && !el.ownerSVGElement) return { url: svgUrl(el) };
      else if (el instanceof SVGElement && el.ownerSVGElement) return { url: svgUrl(el.ownerSVGElement) };
      else shown = bgUrl(el);
      if (!shown) continue;
      const orig = linkedOriginal(el);
      return orig && orig !== shown ? { url: orig, fallback: shown } : { url: shown };
    }
    return null;
  }

  function flash(text) {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<div style="max-width:70vw;padding:8px 13px;border-radius:9px;background:rgba(12,12,12,.92);color:rgba(255,255,255,.92);
      font:500 12px system-ui,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity .3s"></div>`;
    root.firstChild.textContent = text;
    document.documentElement.append(host);
    setTimeout(() => (root.firstChild.style.opacity = "0"), 1800);
    setTimeout(() => host.remove(), 2150);
  }

  function onClick(e) {
    if (!enabled || e.button !== 0 || !held(e) || !chrome.runtime?.id) return;
    const found = imageAt(e);
    if (!found) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({ type: "imgDownload", ...found }).then(
      (res) => flash(res?.ok ? `Saved ${res.name}` : `Couldn't save the image${res?.error ? `: ${res.error}` : ""}`),
      () => flash("Couldn't save the image"),
    );
  }
  addEventListener("click", onClick, true);
  // Keep the page's own handlers (and link navigation) out of a key+click on an image.
  for (const type of ["mousedown", "mouseup", "auxclick"]) {
    addEventListener(type, (e) => {
      if (enabled && e.button === 0 && held(e) && imageAt(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }
})();
