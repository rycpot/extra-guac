// Auto-refresh: each tab can reload on a fixed or random interval (seconds) and
// watch for a keyword. Running state lives in storage.session under "refresh"
// ({ [tabId]: run }) so it survives the service worker being suspended. Timing
// comes from once-a-second ticks sent by the offscreen document.
//
// Every change to the runs goes through updateRuns(), one at a time: the tick,
// page loads and keyword hits all fire concurrently, and an unserialized
// read-modify-write let a stale tick resurrect a run the keyword had stopped.
//
// The keyword is only looked for after the first refresh (text already on the
// page when you start doesn't count), then every second until the next refresh,
// in all frames and open shadow roots, so late-rendered content is caught.

const refreshHandlers = {
  refreshStart: ({ tabId, config }) => startRefresh(tabId, config),
  refreshStop: ({ tabId }) => stopRefresh(tabId),
  tick: () => onTick(),
};

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
    return result;
  });
  runsQueue = next.catch(() => {});
  return next;
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
    keyword: (config.keyword || "").trim(),
    count: 0,
    startedAt: Date.now(),
    loadingSince: 0,
    found: false,
  };
  if (run.max < run.min) [run.min, run.max] = [run.max, run.min];
  run.nextAt = Date.now() + nextDelay(run);
  await TT.updateSettings({ refresh: { mode: run.mode, fixed: run.fixed, min: run.min, max: run.max, keyword: run.keyword } });
  await updateRuns((runs) => { runs[tabId] = run; });
  updateBadge(tabId, run);
}

async function stopRefresh(tabId) {
  await updateRuns((runs) => { delete runs[tabId]; });
  setBadge(+tabId, "");
}

async function stopAllRefresh() {
  await updateRuns((runs) => {
    for (const tabId of Object.keys(runs)) {
      setBadge(+tabId, "");
      delete runs[tabId];
    }
  });
}

let ticking = false;
async function onTick() {
  if (ticking) return;
  ticking = true;
  try {
    const watch = [];
    const reloads = await updateRuns((runs) => {
      const now = Date.now();
      const due = [];
      for (const [id, run] of Object.entries(runs)) {
        const tabId = +id;
        if (run.loadingSince && now - run.loadingSince >= LOAD_TIMEOUT_MS) {
          run.loadingSince = 0; // page never finished loading; carry on anyway
          run.nextAt = now + nextDelay(run);
        }
        if (!run.loadingSince && now >= run.nextAt) {
          run.loadingSince = now;
          run.count++;
          due.push(tabId);
        } else if (!run.loadingSince && run.keyword && run.count > 0 && !run.matchedThisLoad) {
          watch.push(tabId);
        }
        updateBadge(tabId, run);
      }
      return due;
    });
    for (const tabId of reloads) chrome.tabs.reload(tabId).catch(() => stopRefresh(tabId));
    for (const tabId of watch) checkKeyword(tabId);
  } finally {
    ticking = false;
  }
}

// A refreshed page finished loading: schedule the next refresh and look for the keyword now
// (the tick keeps looking every second after this, for content that renders late).
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const run = await updateRuns((runs) => {
    const r = runs[tabId];
    if (!r?.loadingSince) return null;
    r.loadingSince = 0;
    r.matchedThisLoad = false;
    r.nextAt = Date.now() + nextDelay(r);
    return r;
  });
  if (run?.keyword) checkKeyword(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => stopRefresh(tabId));

const checking = new Set();

async function checkKeyword(tabId) {
  if (checking.has(tabId)) return;
  checking.add(tabId);
  try {
    const run = (await getRuns())[tabId];
    if (!run?.keyword || run.loadingSince || run.count === 0) return;
    const results = await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, func: pageHasText, args: [run.keyword] })
      .catch(() => []);
    if (results.some((r) => r?.result)) await keywordFound(tabId, run);
  } finally {
    checking.delete(tabId);
  }
}

// Injected: visible text of the frame plus any open shadow roots, ignoring case.
function pageHasText(keyword) {
  const kw = keyword.toLowerCase();
  if ((document.body?.innerText || "").toLowerCase().includes(kw)) return true;
  const roots = [document];
  while (roots.length) {
    for (const el of roots.pop().querySelectorAll("*")) {
      if (!el.shadowRoot) continue;
      if ((el.shadowRoot.textContent || "").toLowerCase().includes(kw)) return true;
      roots.push(el.shadowRoot);
    }
  }
  return false;
}

async function keywordFound(tabId, run) {
  const { refresh: prefs } = await TT.getSettings();
  const stillRunning = await updateRuns((runs) => {
    if (!runs[tabId] || runs[tabId].loadingSince) return false;
    if (prefs.continueAfterMatch) {
      runs[tabId].lastFoundAt = Date.now();
      runs[tabId].matchedThisLoad = true; // alert once per load, not every second
    } else {
      delete runs[tabId];
    }
    return true;
  });
  if (!stillRunning) return;
  if (!prefs.continueAfterMatch) setBadge(tabId, "✓");
  await chrome.storage.session.set({ [`refreshFound:${tabId}`]: { keyword: run.keyword, at: Date.now() } });

  if (prefs.sound) toOffscreen({ type: "play", url: prefs.sound }).catch(() => {});
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (prefs.notify) {
    chrome.notifications.create(`refresh-${tabId}-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Found "${run.keyword}"`,
      message: tab?.title || tab?.url || "Auto-refresh",
      contextMessage: prefs.continueAfterMatch ? "Auto-refresh keeps running" : "Auto-refresh stopped",
      priority: 2,
    });
  }
  if (prefs.focusTab && tab) focusTab(tab);
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
