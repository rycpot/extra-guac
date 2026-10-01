// Auto redirect: auto rules rewrite a tab's URL as it starts navigating; manual rules
// run from the page's right-click menu ("Redirect with rules").
//
// Loop guard, per tab:
// - a navigation to a URL we redirected to in the last 15 s is never redirected again
//   (so a rule whose output still matches it can't bounce forever);
// - more than 4 redirects in 10 s stops redirecting that tab for a minute and says so.

const recentRedirects = new Map(); // tabId -> [{ to, at }]
const pausedTabs = new Map(); // tabId -> until

chrome.webNavigation.onBeforeNavigate.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0 || tabId < 0) return;
  const { redirect } = await TT.getSettings();
  if (!redirect.enabled || !redirect.rules.some((r) => r.auto && r.on !== false && r.find)) return;
  const result = Redirects.apply(url, redirect.rules, { autoOnly: true });
  if (result.url !== url) redirectTab(tabId, url, result.url);
});

async function redirectTab(tabId, from, to) {
  const now = Date.now();
  if ((pausedTabs.get(tabId) || 0) > now) return false;
  const recent = (recentRedirects.get(tabId) || []).filter((r) => now - r.at < 15000);
  if (recent.some((r) => r.to === from)) return false; // we sent the tab here; leave it
  if (recent.filter((r) => now - r.at < 10000).length >= 4) {
    pausedTabs.set(tabId, now + 60000);
    chrome.notifications.create(`redirect-loop-${tabId}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Stopped a redirect loop",
      message: "Your redirect rules kept rewriting this tab, so redirecting is paused there for a minute. Check the rules in settings.",
    });
    return false;
  }
  recent.push({ to, at: now });
  recentRedirects.set(tabId, recent);
  await chrome.tabs.update(tabId, { url: to });
  return true;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  recentRedirects.delete(tabId);
  pausedTabs.delete(tabId);
});

// Right-click → "Redirect with rules" (or "go" in the popup): every enabled rule,
// manual and auto, on this page. Returns whether the tab was redirected.
async function runManualRedirect(tab) {
  const { redirect } = await TT.getSettings();
  const result = Redirects.apply(tab.url || "", redirect.rules);
  if (result.url === tab.url) {
    setBadge(tab.id, "✕", "#ff453a");
    setTimeout(() => setBadge(tab.id, ""), 1500);
    return false;
  }
  recentRedirects.delete(tab.id); // a manual run is deliberate: don't let the loop guard block it
  return redirectTab(tab.id, tab.url, result.url);
}
