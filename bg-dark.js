// Dark mode (settings.dark): "sites" turns it on only for the sites in dark.sites; "all"
// turns it on everywhere except dark.exclude. A site is a hostname without "www." and
// covers its subdomains. Pages that turn out to be dark already are remembered in
// storage.local "darkNative" and skipped from then on.
//
// dark.css + dark.js are registered at document_start for exactly those pages, so the
// page is dark from its first paint (no white flash). Switching a site on or off also
// updates its open tabs straight away.

const darkHandlers = {
  // From dark.js: this page is dark already. It stays as it is (and the site is skipped
  // from then on) unless the site was switched on on purpose.
  darkNative: async (_msg, sender) => {
    const site = darkSiteOf(sender.tab?.url);
    if (!site) return { keep: false };
    const { dark } = await TT.getSettings();
    if (covers(site, dark.force)) return { keep: true };
    const { darkNative = [] } = await chrome.storage.local.get("darkNative");
    if (!darkNative.includes(site)) await chrome.storage.local.set({ darkNative: [...darkNative, site].sort() });
    return { keep: false };
  },
  // Popup switch: dark mode on/off for this tab's site, in the current mode.
  darkSite: async ({ site, on }) => {
    const { dark } = await TT.getSettings();
    const toggle = (list, add) => (add ? [...new Set([...list, site])].sort() : list.filter((s) => s !== site));
    const next = dark.mode === "all" ? { exclude: toggle(dark.exclude, !on) } : { sites: toggle(dark.sites, on) };
    // Switching on a site that's dark already means "darken it anyway".
    const { darkNative = [] } = await chrome.storage.local.get("darkNative");
    const native = covers(site, darkNative);
    next.force = toggle(dark.force, on && (native || covers(site, dark.force)));
    await TT.updateSettings({ dark: next });
    if (on && native) await chrome.storage.local.set({ darkNative: darkNative.filter((s) => !(site === s || site.endsWith(`.${s}`))) });
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

// Whether dark mode applies to this site, given the settings and the remembered dark sites.
function darkOn(site, dark, darkNative) {
  if (!site || covers(site, darkNative)) return false;
  return dark.mode === "all" ? !covers(site, dark.exclude) : covers(site, dark.sites);
}

const sitePatterns = (sites) => sites
  .filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s))
  .flatMap((s) => [`*://${s}/*`, `*://*.${s}/*`]);

async function syncDarkScript() {
  const { dark } = await TT.getSettings();
  const { darkNative = [] } = await chrome.storage.local.get("darkNative");
  const script = { id: DARK_SCRIPT_ID, css: ["dark.css"], js: ["dark.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: true };
  if (dark.mode === "all") {
    script.matches = ["http://*/*", "https://*/*"];
    const skip = sitePatterns([...dark.exclude, ...darkNative]);
    if (skip.length) script.excludeMatches = skip;
  } else {
    script.matches = sitePatterns(dark.sites.filter((s) => !covers(s, darkNative)));
  }
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [DARK_SCRIPT_ID] });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [DARK_SCRIPT_ID] });
  if (script.matches.length) await chrome.scripting.registerContentScripts([script]);
}

// Brings every open tab in line with the settings, without reloading it.
async function syncDarkTabs() {
  const { dark } = await TT.getSettings();
  const { darkNative = [] } = await chrome.storage.local.get("darkNative");
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    const on = darkOn(darkSiteOf(tab.url), dark, darkNative);
    const target = { tabId: tab.id };
    // Already has the stylesheet (registered or added earlier)? Then only flip the switch.
    const [res] = await chrome.scripting.executeScript({
      target, args: [on],
      func: (on) => {
        const root = document.documentElement;
        const had = !!window.__ttDark;
        if (on) { if (root.getAttribute("data-tt-dark") === "off") root.removeAttribute("data-tt-dark"); }
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
  if (changes.darkNative) return void queueDarkSync(false); // the page already turned itself off
  const darkOf = (tt) => JSON.stringify(TT.merge(TT.DEFAULTS, tt).dark);
  if (changes.tt && darkOf(changes.tt.oldValue) !== darkOf(changes.tt.newValue)) queueDarkSync(true);
});

chrome.runtime.onInstalled.addListener(() => queueDarkSync(false));
