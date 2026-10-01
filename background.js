importScripts("pii-rules.js");

const NUKE_ID = "nuke";
const BLUR_ID = "pii-toggle";
const BLUR_SETTINGS_ID = "pii-settings";

// Suffixes where the registrable domain has three labels (e.g. foo.co.uk).
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "co.in", "co.za",
  "com.br", "com.mx", "com.ar", "com.cn", "com.hk", "com.sg", "com.tw", "com.tr",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "herokuapp.com", "web.app", "firebaseapp.com",
]);

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: NUKE_ID, title: "Nuke (clear site data + reload)", contexts: ["action"] });
  const s = await getBlurSettings();
  chrome.contextMenus.create({
    id: BLUR_ID, type: "checkbox", checked: s.enabled, title: "Blur sensitive data", contexts: ["action"],
  });
  chrome.contextMenus.create({ id: BLUR_SETTINGS_ID, title: "Blur settings…", contexts: ["action"] });
  syncBlurScript(s);
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await getBlurSettings();
  chrome.contextMenus.update(BLUR_ID, { checked: s.enabled });
  syncBlurScript(s);
});

// Left click: hard refresh (same as Cmd/Ctrl+Shift+R).
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.reload(tab.id, { bypassCache: true });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === BLUR_ID) {
    const s = await getBlurSettings();
    return chrome.storage.local.set({ pii: { ...s, enabled: info.checked } });
  }
  if (info.menuItemId === BLUR_SETTINGS_ID) return openBlurSettings();
  if (info.menuItemId !== NUKE_ID || !tab) return;
  try {
    await nuke(tab);
    flashBadge(tab.id, "✓", "#2e7d32");
  } catch (err) {
    console.error("Nuke failed:", err);
    flashBadge(tab.id, "✕", "#c62828");
  }
});

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

function flashBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 1500);
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
  if (before.enabled !== after.enabled) chrome.contextMenus.update(BLUR_ID, { checked: after.enabled });
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

// Tall window docked to the right edge of the browser, so the page stays visible
// while rules are edited (changes apply live).
async function openBlurSettings() {
  const { settingsWindowId } = await chrome.storage.session.get("settingsWindowId");
  if (settingsWindowId) {
    try { return await chrome.windows.update(settingsWindowId, { focused: true }); } catch {}
  }
  const cur = await chrome.windows.getLastFocused();
  const width = 560;
  const win = await chrome.windows.create({
    url: "options.html",
    type: "popup",
    width,
    height: cur.height ?? 900,
    top: cur.top ?? 0,
    left: Math.max(0, (cur.left ?? 0) + (cur.width ?? width) - width),
  });
  chrome.storage.session.set({ settingsWindowId: win.id });
}
