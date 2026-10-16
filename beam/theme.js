// Beam's own tab inside Extra Guac follows Extra Guac's theme setting (dark, light or the
// device's); the web page is always dark (page.css).
(() => {
  if (location.protocol !== "chrome-extension:" || !globalThis.chrome?.storage) return;
  document.title = "Beam · Extra Guac";
  const apply = (tt) => {
    const t = tt?.theme;
    document.documentElement.dataset.theme = t === "light" || t === "auto" ? t : "dark";
  };
  chrome.storage.local.get("tt").then(({ tt }) => apply(tt), () => {});
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.tt) apply(c.tt.newValue); });
})();
