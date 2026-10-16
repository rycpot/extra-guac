// Open other sites' links in a new tab.
// Sites (settings.newTab.sites, switched on one at a time from the tools): link-tabs.js
// opens links to other sites in a new tab. A site is a hostname without "www." and covers
// its subdomains. The script is registered for those sites only, and switching a site on
// adds it to that site's open tabs straight away; it reads the list itself, so switching
// off needs nothing more.

const newTabHandlers = {
  newTabSite: ({ site, on }) => setNewTabSite(site, on),
  // A link just opened in a new tab (link-tabs.js), kept a short while per tab so the popup
  // can offer to treat that site as part of this one.
  newTabOpened: ({ site, host, base }, sender) => {
    const ok = (v) => typeof v === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v);
    if (sender.tab?.id == null || !ok(site) || !ok(host) || !ok(base)) return;
    return chrome.storage.session.set({ [`newTabLast:${sender.tab.id}`]: { site, host, base, at: Date.now() } });
  },
};
chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(`newTabLast:${tabId}`).catch(() => {}); });

const NEWTAB_ID = "eg-newtab";

async function setNewTabSite(site, on) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(site || "")) throw new Error("Not on a web page");
  const { newTab } = await TT.getSettings();
  const keep = newTab.sites.filter((s) => !(s === site || site.endsWith(`.${s}`)));
  await TT.updateSettings({ newTab: { sites: on ? [...new Set([...keep, site])].sort() : keep } });
  await queueNewTabSync(true);
}

async function syncNewTabScript() {
  const { newTab } = await TT.getSettings();
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [NEWTAB_ID] });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [NEWTAB_ID] });
  const matches = unlockPatterns(newTab.sites);
  if (matches.length) {
    await chrome.scripting.registerContentScripts([{ id: NEWTAB_ID, js: ["link-tabs.js"], matches, runAt: "document_start", persistAcrossSessions: true }]);
  }
}

// Open tabs on a listed site get the script now (it does nothing twice).
async function syncNewTabTabs() {
  const { newTab } = await TT.getSettings();
  if (!newTab.sites.length) return;
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    if (!unlockCovers(unlockSiteOf(tab.url), newTab.sites)) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["link-tabs.js"] }).catch(() => {});
  }
}

let newTabSync = Promise.resolve();
const queueNewTabSync = (tabs) => (newTabSync = newTabSync.then(async () => {
  await syncNewTabScript();
  if (tabs) await syncNewTabTabs();
}).catch(() => {}));

// Lists changed elsewhere (settings, a restored backup).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.tt) return;
  const of = (tt) => TT.merge(TT.DEFAULTS, tt).newTab;
  const before = of(changes.tt.oldValue), after = of(changes.tt.newValue);
  if (JSON.stringify(before.sites) !== JSON.stringify(after.sites)) queueNewTabSync(true);
});

chrome.runtime.onInstalled.addListener(() => queueNewTabSync(true));
chrome.runtime.onStartup.addListener(() => queueNewTabSync(false));
