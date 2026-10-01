// Auto-refresh keyword watcher (extension world). Registered on every page while an
// auto-refresh with a keyword runs, but it only starts watching in tabs marked for it
// (sessionStorage, set by the background: per tab, and it survives the reloads). From
// the very start of each load it re-checks whenever the page changes and reports the
// keyword the moment it appears. The background also calls check() every second in
// every frame, which starts watching frames that weren't marked (e.g. cross-site iframes).
(() => {
  if (window.__ttRefreshWatch) return;
  const KEY = "__ttRefreshWatch";
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ");
  let keyword = "", observer = null, reported = false, timer = 0, lastScan = 0;

  // Visible text of the frame plus any open shadow roots, ignoring case and spacing.
  function has(kw) {
    const want = norm(kw).trim();
    if (!want) return false;
    if (norm(document.body?.innerText || "").includes(want)) return true;
    const roots = [document];
    while (roots.length) {
      for (const el of roots.pop().querySelectorAll("*")) {
        if (!el.shadowRoot) continue;
        if (norm(el.shadowRoot.textContent || "").includes(want)) return true;
        roots.push(el.shadowRoot);
      }
    }
    return false;
  }

  function scan() {
    clearTimeout(timer);
    timer = 0;
    lastScan = performance.now();
    if (reported || !keyword || !has(keyword)) return;
    reported = true; // once per page load; the background decides what happens next
    chrome.runtime.sendMessage({ type: "refreshHit", keyword }).catch(() => {});
  }

  function start(kw) {
    if (keyword === kw && observer) return;
    keyword = kw;
    observer?.disconnect();
    // Look right away, at most every 150 ms; changes in between are caught by a timer
    // (slowed to once a second in background tabs) or the background's next check.
    observer = new MutationObserver(() => {
      if (performance.now() - lastScan >= 150) scan();
      else if (!timer) timer = setTimeout(scan, 150);
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    scan();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    keyword = "";
    clearTimeout(timer);
    timer = 0;
  }

  // Called by the background every second. The pulse lets refresh-shim.js run the
  // page's pending animation frames first, so a background tab renders before we look.
  function check(kw) {
    if (kw) start(kw);
    if (!keyword) return false;
    document.dispatchEvent(new CustomEvent("tt-refresh-pulse"));
    return has(keyword);
  }

  window.__ttRefreshWatch = { check, stop };
  try {
    const kw = JSON.parse(sessionStorage.getItem(KEY) || "null")?.keyword;
    if (kw) start(kw);
  } catch {} // sandboxed frames have no sessionStorage
})();
