// Auto-refresh: each tab can reload on a fixed or random interval (seconds) and
// watch for a keyword. Running state lives in storage.session under "refresh"
// ({ [tabId]: run }) so it survives the service worker being suspended. Timing
// comes from once-a-second ticks sent by the offscreen document.
//
// Every change to the runs goes through updateRuns(), one at a time: the tick,
// page loads and keyword hits all fire concurrently, and an unserialized
// read-modify-write let a stale tick resurrect a run the keyword had stopped.
//
// Up to 20 keywords (the enabled ones from the popup); any of them counts, at any
// moment: already there when you start, while a page is still loading, or between
// refreshes. refresh-watch.js runs in every frame of the tab from the start of each
// load and reports one the moment it appears; every tick
// the background also asks each frame (all frames and open shadow roots), and once
// more right before each refresh, which is skipped if it's there.
//
// Keyword watching only works while the tab is in front: Chrome pauses rendering in
// background tabs, so many pages never show their content there.
//
// Watched tabs are marked in sessionStorage (per tab, survives reloads). The watcher
// is registered for all pages while a keyword run exists and acts only in marked tabs.

const refreshHandlers = {
  refreshStart: ({ tabId, config }) => startRefresh(tabId, config),
  refreshStop: ({ tabId }) => stopRefresh(tabId),
  refreshKeywords: ({ tabId, keywords }) => setRunKeywords(tabId, keywords),
  refreshHit: ({ keyword }, sender) => onPageHit(sender.tab?.id, keyword),
  tick: () => onTick(),
};

const WATCH_KEY = "__ttRefreshWatch";
const WATCH_SCRIPTS = [
  { id: "tt-refresh-watch", js: ["refresh-watch.js"], matches: ["<all_urls>"], allFrames: true, runAt: "document_start", persistAcrossSessions: false },
];

const LOAD_TIMEOUT_MS = 60000;

async function getRuns() {
  const { refresh } = await chrome.storage.session.get("refresh");
  return refresh || {};
}

let runsQueue = Promise.resolve();

// Runs `fn(runs)` exclusively; fn mutates runs and may return a value.
function updateRuns(fn) {
  const next = runsQueue.then(async () => {
    const runs = await getRuns();
    const result = await fn(runs);
    await chrome.storage.session.set({ refresh: runs });
    await toOffscreen({ type: "ticker", on: Object.keys(runs).length > 0 }).catch(() => {});
    await syncWatchScripts(Object.values(runs).some((r) => r.keywords?.length));
    return result;
  });
  runsQueue = next.catch(() => {});
  return next;
}

let watchScriptsOn = null; // unknown after the service worker restarts

// After an update or browser restart the runs are gone; drop scripts left registered
// (including the page shim of 2.5.0, which tried to make background tabs render).
getRuns().then((runs) => syncWatchScripts(Object.values(runs).some((r) => r.keywords?.length)));

let watchSync = Promise.resolve();

// Registers or drops the watch script, one change at a time.
function syncWatchScripts(on) {
  watchSync = watchSync.then(async () => {
    if (on === watchScriptsOn) return;
    const ids = [...WATCH_SCRIPTS.map((s) => s.id), "tt-refresh-shim"];
    const have = (await chrome.scripting.getRegisteredContentScripts({ ids })).map((s) => s.id);
    if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have });
    if (on) await chrome.scripting.registerContentScripts(WATCH_SCRIPTS);
    watchScriptsOn = on;
  }).catch(() => {});
  return watchSync;
}

// Marks (or unmarks) every frame of the tab for watching. Unmarking also stops the
// watcher already running in the page.
async function markTab(tabId, keywords) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [WATCH_KEY, keywords || []],
    func: (key, kws) => {
      try {
        if (kws.length) sessionStorage.setItem(key, JSON.stringify({ keywords: kws }));
        else sessionStorage.removeItem(key);
      } catch {}
      if (kws.length) window.__ttRefreshWatch?.check(kws); // switch a running watcher over
      else window.__ttRefreshWatch?.stop();
    },
  }).catch(() => {});
}

// Trimmed, non-empty, no repeats (ignoring case), at most TT.MAX_KEYWORDS.
function cleanKeywords(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((k) => String(k).trim())
    .filter((k) => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()))
    .slice(0, TT.MAX_KEYWORDS);
}

// Puts the watcher into the page that's already loaded (later loads get the registered copy).
async function injectWatch(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["refresh-watch.js"] }).catch(() => {});
}

function nextDelay(run) {
  const secs = run.mode === "random"
    ? run.min + Math.random() * Math.max(0, run.max - run.min)
    : run.fixed;
  return Math.max(1, secs) * 1000;
}

async function startRefresh(tabId, config) {
  const run = {
    mode: config.mode === "random" ? "random" : "fixed",
    fixed: Math.max(1, +config.fixed || 30),
    min: Math.max(1, +config.min || 20),
    max: Math.max(1, +config.max || 45),
    keywords: cleanKeywords(config.keywords),
    count: 0,
    startedAt: Date.now(),
    loadingSince: 0,
    matchedThisLoad: false,
  };
  if (run.max < run.min) [run.min, run.max] = [run.max, run.min];
  run.nextAt = Date.now() + nextDelay(run);
  await TT.updateSettings({ refresh: { mode: run.mode, fixed: run.fixed, min: run.min, max: run.max } });
  await updateRuns((runs) => { runs[tabId] = run; }); // also registers the watch script
  updateBadge(tabId, run);
  await watchTab(tabId, run.keywords);
}

async function watchTab(tabId, keywords) {
  await markTab(tabId, keywords);
  if (!keywords.length) return;
  await injectWatch(tabId);
  checkKeyword(tabId); // already there counts too
}

// Keywords enabled, disabled or deleted in the popup while the tab is refreshing.
async function setRunKeywords(tabId, keywords) {
  const list = cleanKeywords(keywords);
  const run = await updateRuns((runs) => {
    if (runs[tabId]) runs[tabId].keywords = list;
    return runs[tabId];
  });
  if (run) await watchTab(tabId, list);
}

// Whether this run should be looking for its keywords right now.
const watching = (run) => !!run?.keywords?.length && !run.matchedThisLoad;

async function stopRefresh(tabId) {
  const run = await updateRuns((runs) => {
    const r = runs[tabId];
    delete runs[tabId];
    return r;
  });
  setBadge(+tabId, "");
  if (run?.keywords?.length) markTab(+tabId, null);
}

async function stopAllRefresh() {
  const stopped = await updateRuns((runs) => {
    const ids = Object.keys(runs).filter((id) => runs[id].keywords?.length);
    for (const tabId of Object.keys(runs)) {
      setBadge(+tabId, "");
      delete runs[tabId];
    }
    return ids;
  });
  for (const id of stopped) markTab(+id, null);
}

let ticking = false;
const refreshing = new Set(); // tabs whose refresh is being prepared

async function onTick() {
  if (ticking) return;
  ticking = true;
  try {
    const { due, watch } = await updateRuns((runs) => {
      const now = Date.now();
      const due = [], watch = [];
      for (const [id, run] of Object.entries(runs)) {
        const tabId = +id;
        if (run.loadingSince && now - run.loadingSince >= LOAD_TIMEOUT_MS) {
          run.loadingSince = 0; // page never finished loading; carry on anyway
          run.nextAt = now + nextDelay(run);
        }
        if (!run.loadingSince && now >= run.nextAt) {
          if (!refreshing.has(tabId)) due.push(tabId);
        } else if (watching(run)) {
          watch.push(tabId);
        }
        updateBadge(tabId, run);
      }
      return { due, watch };
    });
    for (const tabId of watch) checkKeyword(tabId);
    for (const tabId of due) refreshTab(tabId);
  } finally {
    ticking = false;
  }
}

// One last look for the keyword, then reload (unless it was there).
async function refreshTab(tabId) {
  refreshing.add(tabId);
  try {
    const run = (await getRuns())[tabId];
    if (!run) return;
    if (watching(run) && (await checkKeyword(tabId))) return;
    const go = await updateRuns((runs) => {
      const r = runs[tabId];
      if (!r) return false;
      r.loadingSince = Date.now();
      r.matchedThisLoad = false;
      r.count++;
      return true;
    });
    if (go) await chrome.tabs.reload(tabId).catch(() => stopRefresh(tabId));
  } finally {
    refreshing.delete(tabId);
  }
}

// A refreshed page finished loading: schedule the next refresh and look for the keyword now
// (the page's watcher has been looking since the load started, and the tick keeps asking).
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const run = await updateRuns((runs) => {
    const r = runs[tabId];
    if (!r?.loadingSince) return null;
    r.loadingSince = 0;
    r.nextAt = Date.now() + nextDelay(r);
    return r;
  });
  if (run?.keywords?.length) checkKeyword(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => stopRefresh(tabId));

// The page's watcher saw one of the keywords.
async function onPageHit(tabId, keyword) {
  if (tabId == null) return;
  const run = (await getRuns())[tabId];
  const match = watching(run) && run.keywords.find((k) => k.toLowerCase() === String(keyword).toLowerCase());
  if (match) await keywordFound(tabId, run, match);
}

const checking = new Map(); // tabId -> in-flight check (joined, not repeated)
const CHECK_TIMEOUT_MS = 5000;

// Looks for the keywords now; reports a hit. Resolves to whether one was found.
function checkKeyword(tabId) {
  if (checking.has(tabId)) return checking.get(tabId);
  const p = (async () => {
    const run = (await getRuns())[tabId];
    if (!watching(run)) return false;
    const found = await pageHas(tabId, run.keywords);
    if (found) await keywordFound(tabId, run, found);
    return !!found;
  })().finally(() => checking.delete(tabId));
  checking.set(tabId, p);
  return p;
}

// The first keyword the tab's page (any frame) shows, or "", asked of each frame's
// watcher; frames without one (loaded before it was registered) get it injected. Frozen
// or busy tabs can answer slowly; give up after a few seconds rather than hold up the refresh.
async function pageHas(tabId, keywords) {
  const ask = () => Promise.race([
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [keywords],
      func: (kws) => (window.__ttRefreshWatch ? window.__ttRefreshWatch.check(kws) : null),
    }).catch(() => []),
    new Promise((r) => setTimeout(() => r([]), CHECK_TIMEOUT_MS)),
  ]);
  let results = await ask();
  if (results.some((r) => r?.result === null)) {
    await injectWatch(tabId);
    results = await ask();
  }
  return results.find((r) => r?.result)?.result || "";
}

async function keywordFound(tabId, run, keyword) {
  const { refresh: prefs } = await TT.getSettings();
  const stillRunning = await updateRuns((runs) => {
    if (!runs[tabId] || runs[tabId].matchedThisLoad) return false; // already reported
    if (prefs.continueAfterMatch) {
      runs[tabId].lastFoundAt = Date.now();
      runs[tabId].matchedThisLoad = true; // alert once per load, not every second
    } else {
      delete runs[tabId];
    }
    return true;
  });
  if (!stillRunning) return;
  if (prefs.sound) toOffscreen({ type: "play", url: prefs.sound }).catch(() => {});
  if (!prefs.continueAfterMatch) {
    setBadge(tabId, "✓");
    markTab(tabId, null);
  }
  await chrome.storage.session.set({ [`refreshFound:${tabId}`]: { keyword, at: Date.now() } });
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (prefs.notify) {
    chrome.notifications.create(`refresh-${tabId}-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Found "${keyword}"`,
      message: tab?.title || tab?.url || "Auto-refresh",
      contextMessage: prefs.continueAfterMatch ? "Auto-refresh keeps running" : "Auto-refresh stopped",
      priority: 2,
    });
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  const m = id.match(/^refresh-(\d+)-/);
  if (!m) return;
  const tab = await chrome.tabs.get(+m[1]).catch(() => null);
  if (tab) focusTab(tab);
  chrome.notifications.clear(id);
});

function focusTab(tab) {
  chrome.tabs.update(tab.id, { active: true });
  chrome.windows.update(tab.windowId, { focused: true });
}

function updateBadge(tabId, run) {
  if (run.loadingSince) return setBadge(tabId, "…", "#8e8e93");
  const secs = Math.max(0, Math.ceil((run.nextAt - Date.now()) / 1000));
  setBadge(tabId, secs >= 3600 ? `${Math.floor(secs / 3600)}h` : secs >= 100 ? `${Math.floor(secs / 60)}m` : String(secs), "#30d158");
}
