// Word search's own tab: Extra Guac's theme setting (dark, light or the device's), then the game.
(() => {
  const apply = (tt) => {
    const t = tt?.theme;
    document.documentElement.dataset.theme = t === "light" || t === "auto" ? t : "dark";
  };
  chrome.storage.local.get("tt").then(({ tt }) => apply(tt), () => {});
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.tt) apply(c.tt.newValue); });
  WordSearch.mount(document.getElementById("ws"));
})();
