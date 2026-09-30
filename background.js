const NUKE_ID = "nuke";

// Suffixes where the registrable domain has three labels (e.g. foo.co.uk).
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "co.in", "co.za",
  "com.br", "com.mx", "com.ar", "com.cn", "com.hk", "com.sg", "com.tw", "com.tr",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "herokuapp.com", "web.app", "firebaseapp.com",
]);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: NUKE_ID,
    title: "Nuke (clear site data + reload)",
    contexts: ["action"],
  });
});

// Left click: hard refresh (same as Cmd/Ctrl+Shift+R).
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.reload(tab.id, { bypassCache: true });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
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
