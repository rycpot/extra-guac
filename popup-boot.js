// Chrome shows the side panel blank, white in a light Chrome, until its page has loaded. So
// popup.html loads near-empty, in the theme's background, and only then takes its styles, its
// UI (the template) and its scripts, in their order. The popup opens sooner the same way.
(() => {
  try { document.documentElement.dataset.theme = localStorage.getItem("theme") || "dark"; } catch {}
  const STYLES = ["popup.css", "beam/beam.css", "wordsearch/wordsearch.css"];
  const SCRIPTS = ["shared.js", "endings.js", "pad-store.js", "shot-store.js", "upload-thumbs.js", "beam/beam.js",
    "wordsearch/wordsearch.js", "popup.js", "popup-sessions.js", "us-meta.js", "popup-userscripts.js"];
  const style = (href) => new Promise((resolve) => {
    document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href, onload: resolve, onerror: resolve }));
  });
  addEventListener("load", async () => {
    await Promise.all(STYLES.map(style));
    const ui = document.getElementById("ui");
    ui.replaceWith(ui.content);
    for (const src of SCRIPTS) document.body.append(Object.assign(document.createElement("script"), { src, async: false }));
  }, { once: true });
})();
