// Refresh on focus: a tab whose address matches an entry (settings.focus.entries, see
// shared.js for patterns and expiry) is refreshed when you come back to it: switching to
// its tab, or to its window from another window or app. Normal or hard (cache bypassed)
// per entry.
// The threshold is time away: coming back sooner than that leaves the tab as it is, so
// flicking between tabs doesn't keep reloading it. A tab you leave is stamped when another
// tab in its window takes over, or when its window loses focus (to another window or app);
// one that was never shown yet (opened in the background) counts from when it loaded.
// A tab that's still loading isn't refreshed, nor one Chrome is about to reload anyway (a
// tab it had discarded to save memory).
// Kept in storage.session, so it outlives the background worker going to sleep:
// "focusLeft:<tabId>", "focusLoad:<tabId>" and "focusSeen" (each window's active tab and
// the focused window).

const focusLeftKey = (tabId) => `focusLeft:${tabId}`;
const focusLoadKey = (tabId) => `focusLoad:${tabId}`;

async function focusEntryFor(url) {
  const { focus } = await TT.getSettings();
  const now = Date.now();
  return focus.entries.find((e) => TT.focusState(e, now) === "on" && TT.focusMatches(e.pattern, url));
}

// Events one at a time, in order (leaving one tab and arriving at another are two events,
// and switching to a tab in another window reports both the tab and the window).
let focusQueue = Promise.resolve();
const focusQueued = (fn) => (focusQueue = focusQueue.then(fn).catch(() => {}));
const focusRecent = new Map(); // tabId → when it was last refreshed here

const focusSeen = async () => (await chrome.storage.session.get("focusSeen")).focusSeen || { tabs: {}, win: null };
const focusLeave = (tabId, at) => tabId != null && chrome.storage.session.set({ [focusLeftKey(tabId)]: at });

async function focusArrive(tabId) {
  const now = Date.now();
  if (now - (focusRecent.get(tabId) || 0) < 2000) return; // the same arrival reported twice
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active || tab.discarded || tab.status === "loading" || !/^https?:/i.test(tab.url || "")) return;
  const entry = await focusEntryFor(tab.url);
  if (!entry) return;
  const keys = [focusLeftKey(tabId), focusLoadKey(tabId)];
  const got = await chrome.storage.session.get(keys);
  const since = got[keys[0]] || got[keys[1]] || 0;
  if (now - since < TT.focusThresholdMs(entry)) return; // not away long enough
  focusRecent.set(tabId, now);
  await chrome.tabs.reload(tabId, { bypassCache: !!entry.hard });
}

// Another tab in a window: the one before it is left, this one is arrived at.
const focusOnTab = ({ tabId, windowId }) => focusQueued(async () => {
  const seen = await focusSeen();
  const before = seen.tabs[windowId];
  if (before !== tabId) await focusLeave(before, Date.now());
  seen.tabs[windowId] = tabId;
  await chrome.storage.session.set({ focusSeen: seen });
  await focusArrive(tabId);
});
chrome.tabs.onActivated.addListener(focusOnTab);

// Another window (or app): the window before it is left, this one's tab is arrived at.
const focusOnWindow = (windowId) => focusQueued(async () => {
  const seen = await focusSeen();
  if (seen.win === windowId) return;
  if (seen.win != null && seen.win !== chrome.windows.WINDOW_ID_NONE) await focusLeave(seen.tabs[seen.win], Date.now());
  seen.win = windowId;
  if (windowId === chrome.windows.WINDOW_ID_NONE) return void (await chrome.storage.session.set({ focusSeen: seen }));
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab) seen.tabs[windowId] = tab.id;
  await chrome.storage.session.set({ focusSeen: seen });
  if (tab) await focusArrive(tab.id);
});
chrome.windows.onFocusChanged.addListener(focusOnWindow);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") chrome.storage.session.set({ [focusLoadKey(tabId)]: Date.now() }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  focusRecent.delete(tabId);
  chrome.storage.session.remove([focusLeftKey(tabId), focusLoadKey(tabId)]).catch(() => {});
});
chrome.windows.onRemoved.addListener((windowId) => focusQueued(async () => {
  const seen = await focusSeen();
  delete seen.tabs[windowId];
  if (seen.win === windowId) seen.win = null;
  await chrome.storage.session.set({ focusSeen: seen });
}));
