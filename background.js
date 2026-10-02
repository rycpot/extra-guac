importScripts(
  "pii-rules.js", "shared.js", "redirect-rules.js",
  "bg-capture.js", "bg-refresh.js", "bg-shortener.js", "bg-media.js", "bg-pickers.js", "bg-redirect.js", "bg-upload.js",
  "bg-remove.js", "bg-dark.js", "bg-backup.js", "bg-highlight.js", "bg-clip.js",
);

// Messages from the popup, settings window, page overlays and the offscreen document.
// Each handler returns a value (or throws); the sender gets { ok, ...result } or { ok: false, error }.
const handlers = {
  hardRefresh: ({ tabId }) => chrome.tabs.reload(tabId, { bypassCache: true }),
  nuke: async ({ tabId }) => { await nuke(await chrome.tabs.get(tabId)); },
  openSettings: ({ section }) => openSettings(section),
  stopAll: () => stopAll(),
  ...captureHandlers,
  ...refreshHandlers,
  ...shortenerHandlers,
  ...mediaHandlers,
  ...pickerHandlers,
  ...uploadHandlers,
  ...removeHandlers,
  ...darkHandlers,
  ...backupHandlers,
  ...hlHandlers,
  ...clipHandlers,
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = msg?.target !== "offscreen" && handlers[msg?.type];
  if (!handler) return;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((r) => reply({ ok: true, ...(r && typeof r === "object" ? r : {}) }))
    .catch((err) => {
      console.error(`[${msg.type}]`, err);
      reply({ ok: false, error: err?.message || String(err) });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  // On an update, copies of the blur script in open tabs are cut off from the extension
  // (they undo themselves); inject the new one right away so pages stay blurred.
  const pii = await getBlurSettings();
  syncBlurScript(pii, pii.enabled);
  syncMenus(await TT.getSettings());
});

chrome.runtime.onStartup.addListener(async () => {
  syncBlurScript(await getBlurSettings());
  syncMenus(await TT.getSettings());
  setAwakeIcon(false); // keep-awake doesn't survive a browser restart
});

// ---- Right-click menus --------------------------------------------------------
// Pages get "Redirect with rules" while auto redirect is on and has manual rules.
// Images get "Upload image to catbox/x02" for the hosts switched on in the popup;
// with both on, the item branches into the two hosts.

let menuSync = Promise.resolve();
function syncMenus(s) {
  menuSync = menuSync.then(async () => {
    await chrome.contextMenus.removeAll();
    const manual = s.redirect.enabled && s.redirect.rules.some((r) => !r.auto && r.on !== false && r.find);
    if (manual) chrome.contextMenus.create({ id: "redirect", title: "Redirect with rules", contexts: ["page"] });
    const hosts = ["catbox", "x02"].filter((h) => s.upload[h] && (h !== "x02" || s.upload.x02Verified));
    if (hosts.length === 1) {
      chrome.contextMenus.create({ id: `upload:${hosts[0]}`, title: `Upload image to ${hosts[0]}`, contexts: ["image"] });
    } else if (hosts.length === 2) {
      chrome.contextMenus.create({ id: "upload", title: "Upload image to", contexts: ["image"] });
      for (const h of hosts) chrome.contextMenus.create({ id: `upload:${h}`, parentId: "upload", title: h, contexts: ["image"] });
    }
    // Pinned clipboard entries (bg-clip.js), when that's switched on.
    const pins = await clipMenuItems(s);
    if (pins.length) {
      const contexts = ["page", "editable", "selection", "link", "image"];
      chrome.contextMenus.create({ id: "clippin", title: "Paste pinned", contexts });
      for (const p of pins) chrome.contextMenus.create({ id: p.id, parentId: "clippin", title: p.title, contexts });
    }
  }).catch((err) => console.error("menus", err));
  return menuSync;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.tt) return;
  const before = TT.merge(TT.DEFAULTS, changes.tt.oldValue);
  const after = TT.merge(TT.DEFAULTS, changes.tt.newValue);
  if (JSON.stringify([before.redirect, before.upload]) !== JSON.stringify([after.redirect, after.upload])) syncMenus(after);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "redirect") return runManualRedirect(tab);
  if (String(info.menuItemId).startsWith("clippin:")) return onClipMenu(info, tab);
  const m = String(info.menuItemId).match(/^upload:(\w+)$/);
  if (m && info.srcUrl) uploadImage(m[1], info.srcUrl, tab);
});

// Turns off everything that is running: auto-refresh, keep awake, tab volume and blur.
async function stopAll() {
  await stopAllRefresh();
  await stopAwake();
  await stopAllVolume();
  const { pii } = await chrome.storage.local.get("pii");
  if (pii?.enabled) await chrome.storage.local.set({ pii: { ...pii, enabled: false } });
}

// ---- Offscreen document ----------------------------------------------------
// One hidden page drives timers (service-worker timers die when it is suspended),
// plays alert sounds and holds tab-volume audio graphs.

let offscreenCreating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenCreating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK", "USER_MEDIA", "BLOBS", "CLIPBOARD"],
      justification: "Runs auto-refresh timers, plays the keyword alert sound, applies tab volume and copies uploaded links.",
    })
    .finally(() => (offscreenCreating = null));
  await offscreenCreating;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
  if (res && res.ok === false) throw new Error(res.error);
  return res;
}

// ---- Nuke ------------------------------------------------------------------

// Suffixes where the registrable domain has three labels (e.g. foo.co.uk).
// Progress for the popup: storage.session "nuke:<tabId>" = { step, total, label }.
async function nukeProgress(tabId, step, label) {
  await chrome.storage.session.set({ [`nuke:${tabId}`]: { step, total: 4, label } });
}

async function nuke(tab) {
  const url = new URL(tab.url);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Nuke only works on http(s) pages");
  try {
    await nukeSteps(tab, url);
  } finally {
    setTimeout(() => chrome.storage.session.remove(`nuke:${tab.id}`), 1500);
  }
}

async function nukeSteps(tab, url) {
  const host = url.hostname;
  const scope = await siteScope(host);
  await nukeProgress(tab.id, 1, "page storage");

  // 1. sessionStorage isn't covered by browsingData; clear it (and localStorage) in-page.
  await chrome.scripting
    .executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        try { sessionStorage.clear(); } catch {}
        try { localStorage.clear(); } catch {}
      },
    })
    .catch(() => {});

  await nukeProgress(tab.id, 2, "cookies");
  // 2. The cookies this page gets, plus, when the site is known (see siteScope), every
  //    cookie on that site and its subdomains. Their hosts also tell us which subdomain
  //    origins likely hold storage.
  const hosts = new Set([host]);
  if (scope.known) hosts.add(scope.domain).add(`www.${scope.domain}`);
  const inScope = (d) => {
    const h = d.replace(/^\./, "").toLowerCase();
    return scope.known ? h === scope.domain || h.endsWith(`.${scope.domain}`) : h === host;
  };
  // getAll({ url }) is exactly what this page is sent (the host's own cookies and its
  // site's domain-wide ones); getAll({ domain }) adds the site's other subdomains.
  const seen = new Map();
  for (const c of [...await chrome.cookies.getAll({ url: url.href }), ...(scope.known ? await chrome.cookies.getAll({ domain: scope.domain }) : [])]) {
    if (!inScope(c.domain)) continue;
    seen.set(`${c.storeId}|${c.domain}|${c.path}|${c.name}|${JSON.stringify(c.partitionKey || null)}`, c);
  }
  const cookies = [...seen.values()];
  await Promise.all(
    cookies.map((c) => {
      const cHost = c.domain.replace(/^\./, "");
      hosts.add(cHost);
      return chrome.cookies
        .remove({
          url: `http${c.secure ? "s" : ""}://${cHost}${c.path}`,
          name: c.name,
          storeId: c.storeId,
          ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
        })
        .catch(() => {});
    })
  );

  await nukeProgress(tab.id, 3, "cache & site data");
  // 3. All per-origin storage for every known origin on the domain.
  const port = url.port ? `:${url.port}` : "";
  const origins = [...new Set([...hosts].flatMap((h) =>
    [`https://${h}`, `http://${h}`, `https://${h}${port}`, `http://${h}${port}`]
  ))];
  await chrome.browsingData.remove(
    { origins, since: 0 },
    {
      cache: true,
      cacheStorage: true,
      cookies: true,
      fileSystems: true,
      indexedDB: true,
      localStorage: true,
      serviceWorkers: true,
      webSQL: true,
    }
  );

  // 4. Hard reload.
  await nukeProgress(tab.id, 4, "reloading");
  await chrome.tabs.reload(tab.id, { bypassCache: true });
  await chrome.storage.session.set({ [`nuke:${tab.id}`]: { step: 4, total: 4, label: "done", done: true } });
}

// How far Nuke may reach beyond the page's own host. A site's subdomains can belong to
// other people (alice.blogspot.com and bob.blogspot.com, a.example.com.de and
// b.example.com.de), so guessing the site from the last two or three labels can wipe
// other sites' data. Chrome itself never stores a domain-wide cookie for a public suffix
// (it checks the full Public Suffix List), so a domain-wide cookie that exists on a parent
// domain proves that parent is a real site run by one owner. Nuke goes up to the highest
// such parent; with no such proof it stays on the exact host.
async function siteScope(host) {
  host = host.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return { domain: host, known: false }; // IP / localhost
  // Domain-wide cookies this page is sent: they sit on the host or on one of its parents.
  const proven = new Set((await chrome.cookies.getAll({ url: `https://${host}/` }).catch(() => []))
    .concat(await chrome.cookies.getAll({ url: `http://${host}/` }).catch(() => []))
    .filter((c) => !c.hostOnly)
    .map((c) => c.domain.replace(/^\./, "").toLowerCase()));
  const labels = host.split(".");
  for (let i = labels.length - 2; i >= 0; i--) { // highest parent first, never a bare TLD
    const candidate = labels.slice(i).join(".");
    if (proven.has(candidate)) return { domain: candidate, known: true };
  }
  return { domain: host, known: false };
}

// ---- Blur sensitive data ---------------------------------------------------

async function getBlurSettings() {
  const { pii } = await chrome.storage.local.get("pii");
  return PIIRules.withDefaults(pii);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.pii) return;
  const before = PIIRules.withDefaults(changes.pii.oldValue);
  const after = PIIRules.withDefaults(changes.pii.newValue);
  if (before.enabled !== after.enabled || before.excludedSites !== after.excludedSites) {
    syncBlurScript(after, after.enabled && !before.enabled);
  }
});

// The content script is registered only while blurring is on, so it costs nothing when off.
// Tabs that already loaded it react to setting changes themselves (including turning off).
async function syncBlurScript(s, injectOpenTabs = false) {
  await chrome.scripting.unregisterContentScripts({ ids: ["pii"] }).catch(() => {});
  if (!s.enabled) return;
  await chrome.scripting.registerContentScripts([{
    id: "pii",
    js: ["pii-rules.js", "pii.js"],
    css: ["pii.css"],
    matches: ["<all_urls>"],
    excludeMatches: PIIRules.sitePatterns(s.excludedSites),
    runAt: "document_start",
    allFrames: true,
    matchOriginAsFallback: true,
  }]).catch((err) => console.error("Registering blur script failed:", err));
  if (!injectOpenTabs) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file:///*"] });
  for (const t of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: t.id, allFrames: true }, files: ["pii-rules.js", "pii.js"] })
      .catch(() => {});
  }
}

// ---- Toolbar icon: popup or side panel (settings → general) ---------------------
// The popup closes whenever it loses focus; the side panel stays open while you use
// other tabs or the settings window. Both show popup.html.

function applyOpenIn(openIn) {
  const panel = openIn === "panel";
  chrome.action.setPopup({ popup: panel ? "" : "popup.html" });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel }).catch(() => {});
}

TT.getSettings().then((s) => applyOpenIn(s.openIn));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tt) applyOpenIn(TT.merge(TT.DEFAULTS, changes.tt.newValue).openIn);
});

// ---- Settings window --------------------------------------------------------
// A tall window docked to one edge of the browser, so the page stays visible (blur
// rules apply live): the left edge when the tools open in the side panel (which sits
// on the right), otherwise the right. `section` picks the left-nav entry, e.g. "blur".
async function openSettings(section = "general") {
  const url = chrome.runtime.getURL(`settings.html#${section}`);
  const { settingsWindowId } = await chrome.storage.session.get("settingsWindowId");
  if (settingsWindowId) {
    try {
      const [tab] = await chrome.tabs.query({ windowId: settingsWindowId });
      await chrome.tabs.update(tab.id, { url });
      return void (await chrome.windows.update(settingsWindowId, { focused: true }));
    } catch {}
  }
  const cur = await chrome.windows.getLastFocused();
  const panel = (await TT.getSettings()).openIn === "panel";
  const width = Math.min(900, cur.width ?? 900);
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width,
    height: cur.height ?? 900,
    top: cur.top ?? 0,
    left: panel ? cur.left ?? 0 : Math.max(0, (cur.left ?? 0) + (cur.width ?? width) - width),
  });
  await chrome.storage.session.set({ settingsWindowId: win.id });
}
