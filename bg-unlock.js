// Copy & right-click unlock (unlock.js) for the sites you switch it on for. There's no
// switch for everywhere: only for one site at a time, from the tools.
// - Remembered sites (settings.unlock.sites) stay unlocked on every visit.
// - The others ("remember" unticked) only until Chrome is closed: they're kept in
//   storage.session and their script isn't kept across restarts.
// A site is a hostname without "www." and covers its subdomains. unlock.js is registered
// in the page's own world at document_start, so it's in place before the page's scripts;
// switching a site on or off also updates its open tabs straight away, without a reload.

const unlockHandlers = {
  // Popup: on/off for a site, remembered or for this session. Off forgets it (and any
  // entry covering it) from both lists.
  unlockSite: ({ site, on, remember }) => setUnlock(site, on, remember),
};

const UNLOCK_IDS = { saved: "eg-unlock", session: "eg-unlock-session" };
const UNLOCK_KEY = Symbol.for("extra-guac.unlock").description;

const unlockSiteOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, "") : "";
  } catch { return ""; }
};
const unlockCovers = (site, list) => !!site && list.some((s) => site === s || site.endsWith(`.${s}`));
const unlockPatterns = (sites) => sites
  .filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s))
  .flatMap((s) => [`*://${s}/*`, `*://*.${s}/*`]);

async function unlockLists() {
  const { unlock } = await TT.getSettings();
  const { unlockSession = [] } = await chrome.storage.session.get("unlockSession");
  return { saved: unlock.sites, session: unlockSession };
}

async function setUnlock(site, on, remember) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(site || "")) throw new Error("Not on a web page");
  const { saved, session } = await unlockLists();
  const keep = (list) => list.filter((s) => !(s === site || site.endsWith(`.${s}`)));
  const add = (list) => [...new Set([...list, site])].sort();
  const nextSaved = on && remember ? add(keep(saved)) : keep(saved);
  const nextSession = on && !remember ? add(keep(session)) : keep(session);
  await chrome.storage.session.set({ unlockSession: nextSession });
  await TT.updateSettings({ unlock: { sites: nextSaved } });
  await queueUnlockSync(true);
}

async function syncUnlockScripts() {
  const { saved, session } = await unlockLists();
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: Object.values(UNLOCK_IDS) });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map((s) => s.id) });
  const base = { js: ["unlock.js"], world: "MAIN", runAt: "document_start", allFrames: true };
  const scripts = [];
  if (saved.length) scripts.push({ ...base, id: UNLOCK_IDS.saved, matches: unlockPatterns(saved), persistAcrossSessions: true });
  if (session.length) scripts.push({ ...base, id: UNLOCK_IDS.session, matches: unlockPatterns(session), persistAcrossSessions: false });
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

// Open tabs: unlocked or locked again to match, without reloading.
async function syncUnlockTabs() {
  const { saved, session } = await unlockLists();
  const all = [...saved, ...session];
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    const on = unlockCovers(unlockSiteOf(tab.url), all);
    const target = { tabId: tab.id, allFrames: true };
    if (on) await chrome.scripting.executeScript({ target, files: ["unlock.js"], world: "MAIN" }).catch(() => {});
    else {
      await chrome.scripting.executeScript({
        target, world: "MAIN", args: [UNLOCK_KEY],
        func: (key) => window[Symbol.for(key)]?.off(),
      }).catch(() => {});
    }
  }
}

let unlockSync = Promise.resolve();
const queueUnlockSync = (tabs) => (unlockSync = unlockSync.then(async () => {
  await syncUnlockScripts();
  if (tabs) await syncUnlockTabs();
}).catch(() => {}));

// Lists changed elsewhere (settings, a restored backup): scripts and open tabs follow.
chrome.storage.onChanged.addListener((changes, area) => {
  const sitesOf = (tt) => JSON.stringify(TT.merge(TT.DEFAULTS, tt).unlock.sites);
  if (area === "local" && changes.tt && sitesOf(changes.tt.oldValue) !== sitesOf(changes.tt.newValue)) queueUnlockSync(true);
  if (area === "session" && changes.unlockSession) queueUnlockSync(true);
});

chrome.runtime.onInstalled.addListener(() => queueUnlockSync(true));
chrome.runtime.onStartup.addListener(() => queueUnlockSync(false));
