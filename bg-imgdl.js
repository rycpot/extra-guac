// Save images on click (settings.imgDl = { enabled, modifier, format, folder }): imgdl.js
// is registered on web pages while it's on and sends "imgDownload" with the image's
// address (and, for a thumbnail linking to its full-size picture, the shown one as a
// fallback). The image is fetched with the page's cookies (fetchImage, bg-upload.js), turned
// into PNG, JPG or WebP if asked (via a canvas; SVG stays SVG), and saved to Downloads or
// a sub-folder of it, without a Save As dialog.

const IMGDL_SCRIPT_ID = "tt-imgdl";
const IMGDL_TYPES = { png: ["image/png"], jpg: ["image/jpeg", 0.92], webp: ["image/webp", 0.9] };

const imgDlHandlers = {
  imgDownload: async ({ url, fallback }, sender) => {
    try {
      return await saveClickedImage(url, sender.tab, !fallback);
    } catch (err) {
      if (!fallback) throw err;
      return saveClickedImage(fallback, sender.tab);
    }
  },
};

// direct: if the extension can't fetch it, hand the address to Chrome's downloader (whose
// failure can't be seen here, so not when there's a fallback to try).
async function saveClickedImage(url, tab, direct = true) {
  const { imgDl } = await TT.getSettings();
  const folder = TT.cleanFolder(imgDl.folder);
  const target = IMGDL_TYPES[imgDl.format];
  let file;
  try {
    file = await fetchImage(url, tab);
  } catch (err) {
    // Some sites refuse the extension's own request; Chrome's downloader may still get it.
    if (!direct || target || !/^https?:/i.test(url)) throw err;
    const name = fetchName(url);
    await chrome.downloads.download({ url, filename: folder ? `${folder}/${name}` : name, conflictAction: "uniquify", saveAs: false });
    return { name };
  }
  let { blob, name } = file;
  if (target && blob.type !== target[0] && blob.type !== "image/svg+xml") {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (imgDl.format === "jpg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, bmp.width, bmp.height); } // JPG has no transparency
    ctx.drawImage(bmp, 0, 0);
    blob = await canvas.convertToBlob({ type: target[0], ...(target[1] ? { quality: target[1] } : {}) });
    name = name.replace(/\.[^.]+$/, "") + `.${imgDl.format}`;
  }
  const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  await chrome.downloads.download({ url: dataUrl, filename: folder ? `${folder}/${name}` : name, conflictAction: "uniquify", saveAs: false });
  return { name };
}

function fetchName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop()).replace(/[^\w.-]/g, "_").slice(0, 80) || "image"; } catch { return "image"; }
}

async function syncImgDlScript() {
  const { imgDl } = await TT.getSettings();
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [IMGDL_SCRIPT_ID] });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [IMGDL_SCRIPT_ID] });
  if (!imgDl.enabled) return; // copies in open tabs read the setting and stand down
  await chrome.scripting.registerContentScripts([{
    id: IMGDL_SCRIPT_ID, js: ["imgdl.js"], matches: ["http://*/*", "https://*/*"],
    runAt: "document_idle", allFrames: true, persistAcrossSessions: true,
  }]);
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["imgdl.js"] }).catch(() => {});
  }
}

let imgDlSync = Promise.resolve();
const queueImgDlSync = () => (imgDlSync = imgDlSync.then(syncImgDlScript).catch(() => {}));

chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local" || !c.tt) return;
  const on = (tt) => TT.merge(TT.DEFAULTS, tt).imgDl.enabled;
  if (on(c.tt.oldValue) !== on(c.tt.newValue)) queueImgDlSync();
});
chrome.runtime.onInstalled.addListener(() => queueImgDlSync());
