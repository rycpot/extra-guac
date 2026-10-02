// Dark mode (settings.dark): off everywhere unless dark.enabled. Then "sites" turns it on
// only for the sites in dark.sites; "all" turns it on everywhere except dark.exclude. A site is a hostname without "www." and
// covers its subdomains. Pages that are dark on their own are left as they are, page by
// page (dark.js), unless their site is in dark.force ("darken anyway").
//
// dark.css + dark.js are registered at document_start for exactly those pages, so the
// page is dark from its first paint (no white flash). Switching a site on or off also
// updates its open tabs straight away.

const darkHandlers = {
  // From dark.js: this page is dark already. It's left as it is unless its site is
  // on the "darken anyway" list.
  darkNative: async (_msg, sender) => {
    const site = darkSiteOf(sender.tab?.url);
    const { dark } = await TT.getSettings();
    return { keep: !!site && covers(site, dark.force) };
  },
  // Popup switch: dark mode on/off for this tab's site, in the current mode.
  darkSite: async ({ site, on }) => {
    const { dark } = await TT.getSettings();
    const toggle = (list, add) => (add ? [...new Set([...list, site])].sort() : list.filter((s) => s !== site));
    const next = dark.mode === "all" ? { exclude: toggle(dark.exclude, !on) } : { sites: toggle(dark.sites, on) };
    // A site that's dark on its own stays as it is; "darken anyway" is in settings.
    await TT.updateSettings({ dark: next });
  },
};

const DARK_SCRIPT_ID = "tt-dark";

function darkSiteOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, "") : "";
  } catch { return ""; }
}

const covers = (site, list) => list.some((s) => site === s || site.endsWith(`.${s}`));

// Whether dark mode applies to this site.
function darkOn(site, dark) {
  if (!site || !dark.enabled) return false;
  return dark.mode === "all" ? !covers(site, dark.exclude) : covers(site, dark.sites);
}

const sitePatterns = (sites) => sites
  .filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s))
  .flatMap((s) => [`*://${s}/*`, `*://*.${s}/*`]);

async function syncDarkScript() {
  const { dark } = await TT.getSettings();
  const script = { id: DARK_SCRIPT_ID, css: ["dark.css"], js: ["dark.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: true };
  if (!dark.enabled) {
    script.matches = [];
  } else if (dark.mode === "all") {
    script.matches = ["http://*/*", "https://*/*"];
    const skip = sitePatterns(dark.exclude);
    if (skip.length) script.excludeMatches = skip;
  } else {
    script.matches = sitePatterns(dark.sites);
  }
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [DARK_SCRIPT_ID] });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [DARK_SCRIPT_ID] });
  if (script.matches.length) await chrome.scripting.registerContentScripts([script]);
}

// Brings every open tab in line with the settings, without reloading it.
async function syncDarkTabs() {
  const { dark } = await TT.getSettings();
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    const on = darkOn(darkSiteOf(tab.url), dark);
    const target = { tabId: tab.id };
    // Already has the stylesheet (registered or added earlier)? Then only flip the switch.
    const [res] = await chrome.scripting.executeScript({
      target, args: [on],
      func: (on) => {
        const root = document.documentElement;
        const had = !!window.__ttDark;
        // A page that's dark on its own stays off either way.
        if (on) { if (root.getAttribute("data-tt-dark") === "off" && !window.__ttDarkPage) root.removeAttribute("data-tt-dark"); }
        else if (had) root.setAttribute("data-tt-dark", "off");
        return had;
      },
    }).catch(() => []);
    if (on && res && !res.result) {
      await chrome.scripting.insertCSS({ target, files: ["dark.css"] }).catch(() => {});
      await chrome.scripting.executeScript({ target, files: ["dark.js"] }).catch(() => {});
    }
  }
}

let darkSync = Promise.resolve();
const queueDarkSync = (tabs) => (darkSync = darkSync.then(async () => {
  await syncDarkScript();
  if (tabs) await syncDarkTabs();
}).catch(() => {}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const darkOf = (tt) => JSON.stringify(TT.merge(TT.DEFAULTS, tt).dark);
  if (changes.tt && darkOf(changes.tt.oldValue) !== darkOf(changes.tt.newValue)) queueDarkSync(true);
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.storage.local.remove("darkNative"); // 2.12.0 remembered whole sites as dark; now it's per page
  // Before the main switch (2.13), dark mode was in use if "all" was picked or sites were listed.
  const { tt } = await chrome.storage.local.get("tt");
  const old = tt?.dark;
  if (old && old.enabled === undefined) await TT.updateSettings({ dark: { enabled: old.mode === "all" || !!old.sites?.length } });
  queueDarkSync(false);
});
