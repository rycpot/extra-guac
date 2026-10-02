// Highlight words (storage.local "hl"):
//   { enabled, global: { on, color, words }, exclude: [site], sites: { site: { on, color, words } } }
// A site is a hostname without "www." and covers its subdomains. hl.js is registered only
// where something can be highlighted: everywhere (minus excluded sites without a list of
// their own) when the global list is in use, otherwise just the sites with a list that's on.
// hl.js follows changes by itself; open tabs that don't have it yet get it injected.

const HL_SCRIPT_ID = "tt-hl";

const hlHandlers = {
  // Popup rows: kind "exclude" (global list off for this site) or "site" (its own list on/off).
  hlSite: async ({ site, kind, on }) => {
    const hl = await getHl();
    if (kind === "exclude") {
      const list = new Set(hl.exclude);
      if (on) list.add(site);
      else list.delete(site);
      hl.exclude = [...list].sort();
    } else if (hl.sites[site]) {
      hl.sites[site].on = !!on;
    }
    await chrome.storage.local.set({ hl });
  },
  hlEnable: async ({ on }) => {
    const hl = await getHl();
    hl.enabled = !!on;
    await chrome.storage.local.set({ hl });
  },
};

async function getHl() {
  const { hl } = await chrome.storage.local.get("hl");
  return TT.hlOf(hl);
}

const hlPatterns = (sites) => sites
  .filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s))
  .flatMap((s) => [`*://${s}/*`, `*://*.${s}/*`]);

const hlCovers = (site, list) => list.some((s) => site === s || site.endsWith(`.${s}`));
const ownLists = (hl) => Object.keys(hl.sites).filter((s) => hl.sites[s].on && hl.sites[s].words.length);
const globalActive = (hl) => hl.enabled && hl.global.on && hl.global.words.length > 0;

function hlWanted(site, hl) {
  if (!site || !hl.enabled) return false;
  return hlCovers(site, ownLists(hl)) || (globalActive(hl) && !hlCovers(site, hl.exclude));
}

async function syncHlScript() {
  const hl = await getHl();
  const script = { id: HL_SCRIPT_ID, js: ["hl.js"], runAt: "document_idle", allFrames: true, persistAcrossSessions: true, matches: [] };
  if (hl.enabled) {
    if (globalActive(hl)) {
      script.matches = ["http://*/*", "https://*/*"];
      const own = ownLists(hl);
      const skip = hlPatterns(hl.exclude.filter((s) => !hlCovers(s, own)));
      if (skip.length) script.excludeMatches = skip;
    } else {
      script.matches = hlPatterns(ownLists(hl));
    }
  }
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [HL_SCRIPT_ID] });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [HL_SCRIPT_ID] });
  if (script.matches.length) await chrome.scripting.registerContentScripts([script]);
}

async function syncHlTabs() {
  const hl = await getHl();
  if (!hl.enabled) return; // copies already in tabs clear themselves
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    if (!hlWanted(darkSiteOf(tab.url), hl)) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["hl.js"] }).catch(() => {});
  }
}

let hlSync = Promise.resolve();
const queueHlSync = (tabs) => (hlSync = hlSync.then(async () => {
  await syncHlScript();
  if (tabs) await syncHlTabs();
}).catch(() => {}));

chrome.storage.onChanged.addListener((c, area) => area === "local" && c.hl && queueHlSync(true));
chrome.runtime.onInstalled.addListener(() => queueHlSync(false));
