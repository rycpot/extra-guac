importScripts("pii-rules.js", "shared.js", "bg-capture.js", "bg-refresh.js", "bg-shortener.js", "bg-media.js");

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
  chrome.contextMenus?.removeAll(); // the right-click menu from earlier versions is gone
  syncBlurScript(await getBlurSettings());
});

chrome.runtime.onStartup.addListener(async () => {
  syncBlurScript(await getBlurSettings());
  setAwakeIcon(false); // keep-awake doesn't survive a browser restart
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
      reasons: ["AUDIO_PLAYBACK", "USER_MEDIA", "BLOBS"],
      justification: "Runs auto-refresh timers, plays the keyword alert sound and applies tab volume.",
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
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "co.in", "co.za",
  "com.br", "com.mx", "com.ar", "com.cn", "com.hk", "com.sg", "com.tw", "com.tr",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "herokuapp.com", "web.app", "firebaseapp.com",
]);

async function nuke(tab) {
  const url = new URL(tab.url);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Unsupported page: ${tab.url}`);

  const host = url.hostname;
  const domain = registrableDomain(host);

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

  // 2. Every cookie on the domain and its subdomains. Their hosts also tell us
  //    which subdomain origins likely hold storage.
  const hosts = new Set([host, domain, `www.${domain}`]);
  const cookies = await chrome.cookies.getAll({ domain });
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
  await chrome.tabs.reload(tab.id, { bypassCache: true });
}

function registrableDomain(host) {
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host; // IP / localhost
  const parts = host.split(".");
  const n = MULTI_PART_SUFFIXES.has(parts.slice(-2).join(".")) ? 3 : 2;
  return parts.slice(-n).join(".");
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

// ---- Settings window --------------------------------------------------------
// A tall window docked to the right edge of the browser, so the page stays visible
// (blur rules apply live). `section` picks the left-nav entry, e.g. "blur".
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
  const width = Math.min(900, cur.width ?? 900);
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width,
    height: cur.height ?? 900,
    top: cur.top ?? 0,
    left: Math.max(0, (cur.left ?? 0) + (cur.width ?? width) - width),
  });
  await chrome.storage.session.set({ settingsWindowId: win.id });
}
