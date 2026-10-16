// Auto-refresh keyword watcher (extension world). Registered on every page while an
// auto-refresh with a keyword runs, but it only starts watching in tabs marked for it
// (sessionStorage, set by the background: per tab, and it survives the reloads). From
// the very start of each load it re-checks whenever the page changes and reports the
// first of its keywords to appear, the moment it does. The background also calls check()
// every second in every frame, which starts watching frames that weren't marked (e.g.
// cross-site iframes).
(() => {
  if (window.__ttRefreshWatch) return;
  const KEY = "__ttRefreshWatch";
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ");
  let keywords = [], observer = null, reported = false, timer = 0, lastScan = 0;

  // The first keyword in the visible text of the frame plus any open shadow roots,
  // ignoring case and spacing; "" if none.
  function find(kws) {
    const wants = kws.map((k) => [k, norm(k).trim()]).filter(([, w]) => w);
    if (!wants.length) return "";
    const texts = [norm(document.body?.innerText || "")];
    const roots = [document];
    while (roots.length) {
      for (const el of roots.pop().querySelectorAll("*")) {
        if (!el.shadowRoot) continue;
        texts.push(norm(el.shadowRoot.textContent || ""));
        roots.push(el.shadowRoot);
      }
    }
    return wants.find(([, w]) => texts.some((t) => t.includes(w)))?.[0] || "";
  }

  function scan() {
    clearTimeout(timer);
    timer = 0;
    lastScan = performance.now();
    if (reported || !keywords.length) return;
    const keyword = find(keywords);
    if (!keyword) return;
    reported = true; // once per page load; the background decides what happens next
    if (!chrome.runtime?.id) return void observer?.disconnect(); // cut off by an extension reload or update
    chrome.runtime.sendMessage({ type: "refreshHit", keyword }).catch(() => {});
  }

  function start(kws) {
    if (observer && kws.join("\n") === keywords.join("\n")) return;
    keywords = kws;
    observer?.disconnect();
    // Look right away, at most every 150 ms; changes in between are caught by a timer
    // or the background's next check.
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
    keywords = [];
    clearTimeout(timer);
    timer = 0;
  }

  // Called by the background every second; returns the keyword found, or "".
  function check(kws) {
    if (kws?.length) start(kws);
    return find(keywords);
  }

  window.__ttRefreshWatch = { check, stop };
  try {
    const kws = JSON.parse(sessionStorage.getItem(KEY) || "null")?.keywords;
    if (kws?.length) start(kws);
  } catch {} // sandboxed frames have no sessionStorage
})();
