// Auto-refresh: each tab can reload on a fixed or random interval (seconds) and
// watch for a keyword. Running state lives in storage.session under "refresh"
// ({ [tabId]: run }) so it survives the service worker being suspended. Timing
// comes from once-a-second ticks sent by the offscreen document.

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

async function saveRuns(runs) {
  await chrome.storage.session.set({ refresh: runs });
  const running = Object.keys(runs).length > 0;
  await toOffscreen({ type: "ticker", on: running }).catch(() => {});
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
  const runs = await getRuns();
  runs[tabId] = run;
  await saveRuns(runs);
  // The keyword may already be on the page.
  if (run.keyword) checkKeyword(tabId);
  updateBadge(tabId, run);
}

async function stopRefresh(tabId) {
  const runs = await getRuns();
  if (!runs[tabId]) return;
  delete runs[tabId];
  await saveRuns(runs);
  setBadge(+tabId, "");
}

async function stopAllRefresh() {
  const runs = await getRuns();
  for (const tabId of Object.keys(runs)) setBadge(+tabId, "");
  await saveRuns({});
}

let ticking = false;
async function onTick() {
  if (ticking) return;
  ticking = true;
  try {
    const runs = await getRuns();
    const now = Date.now();
    const reloads = [];
    let changed = false;
    for (const [id, run] of Object.entries(runs)) {
      const tabId = +id;
      if (run.loadingSince) {
        if (now - run.loadingSince < LOAD_TIMEOUT_MS) continue;
        run.loadingSince = 0; // page never finished loading; carry on anyway
        run.nextAt = now + nextDelay(run);
        changed = true;
      }
      if (now >= run.nextAt) {
        run.loadingSince = now;
        run.count++;
        changed = true;
        reloads.push(tabId);
      }
      updateBadge(tabId, run);
    }
    if (changed) await saveRuns(runs); // before reloading, so the load-complete handler sees it
    for (const tabId of reloads) chrome.tabs.reload(tabId).catch(() => stopRefresh(tabId));
  } finally {
    ticking = false;
  }
}

// When a refreshed page finishes loading: schedule the next refresh and look for the keyword.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const runs = await getRuns();
  const run = runs[tabId];
  if (!run?.loadingSince) return;
  run.loadingSince = 0;
  run.nextAt = Date.now() + nextDelay(run);
  await saveRuns(runs);
  if (run.keyword) {
    if (!(await checkKeyword(tabId))) setTimeout(() => checkKeyword(tabId), 2000); // late-loading content
  }
});

chrome.tabs.onRemoved.addListener((tabId) => stopRefresh(tabId));

async function checkKeyword(tabId) {
  const runs = await getRuns();
  const run = runs[tabId];
  if (!run?.keyword || run.found) return false;
  const found = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: (kw) => (document.body?.innerText || "").toLowerCase().includes(kw.toLowerCase()),
      args: [run.keyword],
    })
    .then((r) => r[0]?.result)
    .catch(() => false);
  if (found) await keywordFound(tabId, run);
  return found;
}

async function keywordFound(tabId, run) {
  const { refresh: prefs } = await TT.getSettings();
  const runs = await getRuns();
  if (!runs[tabId]) return;
  if (prefs.continueAfterMatch) {
    runs[tabId] = { ...runs[tabId], lastFoundAt: Date.now() };
    await saveRuns(runs);
  } else {
    delete runs[tabId];
    await saveRuns(runs);
    setBadge(tabId, "✓");
  }
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
