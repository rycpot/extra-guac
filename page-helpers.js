// Helpers shared by the color and element pickers (injected first, same isolated world).
(() => {
  window.__ttCopy ??= function copyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-100px;opacity:0;";
    document.documentElement.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    if (!ok) navigator.clipboard?.writeText(text).catch(() => {});
  };
  window.__ttFlash ??= function flash(text, swatch) {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<div style="display:flex;align-items:center;gap:8px;max-width:70vw;padding:8px 13px;border-radius:9px;
      background:rgba(12,12,12,.92);color:rgba(255,255,255,.92);font:500 12px ui-monospace,'SF Mono',Menlo,monospace;
      box-shadow:0 6px 22px rgba(0,0,0,.4);transition:opacity .3s">
      ${swatch ? `<i style="width:12px;height:12px;border-radius:3px;background:${swatch}"></i>` : ""}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span></div>`;
    root.querySelector("span").textContent = text;
    document.documentElement.append(host);
    setTimeout(() => (root.firstElementChild.style.opacity = "0"), 1600);
    setTimeout(() => host.remove(), 1950);
  };
})();
