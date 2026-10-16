// Zoom & rotate images (settings.imgZoom = { enabled, modifier }): imgzoom.js is registered
// on web pages while it's on, and "Image controls" is added to the image right-click menu
// (see syncMenus in background.js), which tells the page to show the controls.

const IMG_SCRIPT_ID = "tt-img";

async function syncImgScript() {
  const { imgZoom } = await TT.getSettings();
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [IMG_SCRIPT_ID] });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [IMG_SCRIPT_ID] });
  if (!imgZoom.enabled) return; // copies in open tabs see the setting and stand down
  await chrome.scripting.registerContentScripts([{
    id: IMG_SCRIPT_ID, js: ["imgzoom.js"], matches: ["http://*/*", "https://*/*"],
    runAt: "document_idle", allFrames: true, persistAcrossSessions: true,
  }]);
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["imgzoom.js"] }).catch(() => {});
  }
}

let imgSync = Promise.resolve();
const queueImgSync = () => (imgSync = imgSync.then(syncImgScript).catch(() => {}));

// Right-click → "Image controls": the frame that was clicked shows (or hides) them.
function onImgControlsMenu(info, tab) {
  chrome.tabs.sendMessage(tab.id, { type: "ttImgControls" }, { frameId: info.frameId ?? 0 }).catch(() => {});
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local" || !c.tt) return;
  const of = (tt) => TT.merge(TT.DEFAULTS, tt).imgZoom;
  const [before, after] = [of(c.tt.oldValue), of(c.tt.newValue)];
  if (before.enabled !== after.enabled) {
    queueImgSync();
    syncMenus(TT.merge(TT.DEFAULTS, c.tt.newValue));
  }
});
chrome.runtime.onInstalled.addListener(() => queueImgSync());
