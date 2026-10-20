// Word search's own tab, and the same page on rycpot.github.io/wordsearch: Extra Guac's theme
// setting (dark, light or the device's; the web page is dark), then the game and its rooms.
(() => {
  const apply = (tt) => {
    const t = tt?.theme;
    document.documentElement.dataset.theme = t === "light" || t === "auto" ? t : "dark";
  };
  if (globalThis.chrome?.storage?.local) {
    chrome.storage.local.get("tt").then(({ tt }) => apply(tt), () => {});
    chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.tt) apply(c.tt.newValue); });
  }
  const api = WordSearch.mount(document.getElementById("ws"), { onRoom: (btn) => WordSearchRoom.menu(btn) });
  WordSearchRoom.init(api, document.querySelector(".ws-page"));
})();
