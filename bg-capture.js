// Screenshots: the visible tab, a dragged area, or the full page (scrolled and stitched).
// Files go to Downloads, or a sub-folder of it chosen in settings.
//
// What happens to a tab or full-page shot is set per kind in settings (shot.tab /
// shot.full): "preview" shows it in a card on the page (shot-card.js) with save and
// upload, "local" saves it straight away, "cloud" uploads it straight away to the
// host (the one picked in settings → image upload; with "show both hosts" the card asks
// which) and the card shows the link. An area shot is saved with ✓
// or uploaded with ☁ on the selection.

const captureHandlers = {
  shot: async ({ tabId, mode }) => {
    const tab = await chrome.tabs.get(tabId);
    if (mode === "area") return startAreaSelection(tab);
    const { shot } = await TT.getSettings();
    const cap = mode === "full" ? await captureFullPage(tab) : await captureTab(tab);
    return finishShot(tab, shot[mode === "full" ? "full" : "tab"], cap);
  },
  // Sent by area.js once the user confirms the selection (✓ save, ☁ upload).
  areaSelected: async ({ rect, viewportWidth, action, host }, sender) =>
    finishShot(sender.tab, action === "upload" ? "cloud" : "local", await captureArea(sender.tab, rect, viewportWidth), host),
  // From the card.
  shotSave: async ({ items }) => ({ files: await saveItems(items) }),
  shotUpload: ({ items, host }, sender) => uploadShot(items, host, sender.tab),
};

// A capture is { items: [{ name, dataUrl }], label, truncated? }; name includes the folder.
// host: the one already picked (area ☁); otherwise the one from settings, and with "show
// both hosts" the card lets you pick.
async function finishShot(tab, action, cap, host) {
  const extra = { truncated: !!cap.truncated, screens: MAX_SCREENS };
  if (action !== "preview" && action !== "cloud") return { files: await saveItems(cap.items), ...extra };
  const { upload } = await TT.getSettings();
  const hosts = uploadHostsOn(upload), choices = TT.uploadChoices(upload);
  if (host && !hosts.includes(host)) host = null;
  const msg = { type: "egShotCard", items: cap.items, label: cap.label, hosts, choices, host: host || (choices.length === 1 ? choices[0] : null), ...extra };
  if (action === "cloud") {
    if (!hosts.length) throw new Error("Turn on imglink or x02 in upload images to upload screenshots");
    msg.auto = msg.host ? "upload" : "pick"; // both hosts offered: the card asks which
  }
  const shown = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shot-card.js"] })
    .then(() => chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }))
    .then((got) => got === true, () => false);
  // "pick": upload mode with both hosts offered, so nothing is uploading yet.
  if (shown) return { card: msg.auto === "pick" ? "pick" : action, ...extra };
  // Pages the card can't be shown on: save it, or upload it with a notification.
  if (action === "preview") return { files: await saveItems(cap.items), ...extra };
  const to = msg.host || choices[0];
  const res = await uploadShot(cap.items, to, tab);
  chrome.notifications.create(`upload|${res.links[0]}`, {
    type: "basic", iconUrl: "icons/icon128.png",
    title: `Screenshot uploaded to ${to}${res.copied ? " · link copied" : ""}`,
    message: res.links.join("\n"), contextMessage: "Click to open",
  });
  return { card: "notified", ...extra };
}

const saveItems = async (items) => {
  const files = [];
  for (const it of items) {
    await chrome.downloads.download({ url: it.dataUrl, filename: it.name, conflictAction: "uniquify", saveAs: false });
    files.push(it.name);
  }
  return files;
};

const MAX_PART_HEIGHT = 16000; // device pixels per image; Chrome canvases fail beyond ~32k
const MAX_SCREENS = 80; // guards against infinite-scroll pages
const CAPTURE_GAP_MS = 550; // Chrome allows ~2 captureVisibleTab calls per second

let lastCaptureAt = 0;

async function grab(windowId, format = "png", quality) {
  const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, format === "jpeg" ? { format, quality } : { format: "png" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureTab(tab) {
  const { shot } = await TT.getSettings();
  const dataUrl = await grab(tab.windowId, shot.format, shot.quality);
  return { items: [{ name: shotName(tab, shot), dataUrl }], label: "visible tab" };
}

async function startAreaSelection(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["area.js"] });
}

async function captureArea(tab, rect, viewportWidth) {
  const { shot } = await TT.getSettings();
  await sleep(80); // let the selection overlay disappear from the screen
  const bmp = await toBitmap(await grab(tab.windowId));
  const scale = bmp.width / viewportWidth; // device pixels per CSS pixel (includes zoom)
  const w = Math.max(1, Math.round(rect.width * scale));
  const h = Math.max(1, Math.round(rect.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, Math.round(rect.x * scale), Math.round(rect.y * scale), w, h, 0, 0, w, h);
  return { items: [{ name: shotName(tab, shot), dataUrl: await canvasToDataUrl(canvas, shot) }], label: `area · ${w} × ${h}` };
}

// Scrolls the page one screen at a time, capturing each, then stitches them.
// Fixed/sticky elements (headers, chat bubbles) are hidden after the first screen
// so they appear once instead of on every slice.
async function captureFullPage(tab) {
  const { shot } = await TT.getSettings();
  const run = (func, args = []) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }).then((r) => r[0]?.result);

  const page = await run(pageBegin);
  const slices = [];
  let truncated = false; // stopped at MAX_SCREENS before reaching the end of the page
  try {
    for (let y = 0, i = 0; ; i++) {
      if (i >= MAX_SCREENS) { truncated = true; break; }
      const pos = await run(pageScrollTo, [y, i > 0]);
      if (i > 0 && pos.y <= slices[slices.length - 1].y) break; // couldn't scroll any further
      slices.push({ y: pos.y, bmp: await toBitmap(await grab(tab.windowId)) });
      setBadge(tab.id, `${Math.min(99, Math.round(((pos.y + page.viewHeight) / pos.height) * 100))}%`);
      if (pos.y + page.viewHeight >= pos.height) break;
      y = pos.y + page.viewHeight;
    }
  } finally {
    await run(pageEnd).catch(() => {});
    setBadge(tab.id, "");
  }

  const scale = slices[0].bmp.width / page.viewWidth;
  const last = slices[slices.length - 1];
  const total = Math.round((last.y + page.viewHeight) * scale);
  const width = slices[0].bmp.width;
  const items = [];
  const parts = Math.ceil(total / MAX_PART_HEIGHT);
  for (let p = 0; p < parts; p++) {
    const top = p * MAX_PART_HEIGHT;
    const canvas = new OffscreenCanvas(width, Math.min(MAX_PART_HEIGHT, total - top));
    const ctx = canvas.getContext("2d");
    for (const s of slices) ctx.drawImage(s.bmp, 0, Math.round(s.y * scale) - top);
    items.push({ name: shotName(tab, shot, parts > 1 ? p + 1 : 0), dataUrl: await canvasToDataUrl(canvas, shot) });
  }
  return { items, truncated, label: parts > 1 ? `full page · ${parts} parts` : "full page" };
}

// ---- Functions injected into the page (must be self-contained) ----

function pageBegin() {
  const root = document.scrollingElement || document.documentElement;
  const style = document.createElement("style");
  style.textContent = "html,body{scroll-behavior:auto!important;scrollbar-width:none!important}" +
    "::-webkit-scrollbar{display:none!important}";
  document.documentElement.append(style);
  window.__ttShot = { style, hidden: [], x: scrollX, y: scrollY };
  return { viewWidth: innerWidth, viewHeight: innerHeight, height: root.scrollHeight };
}

async function pageScrollTo(y, hideFixed) {
  const st = window.__ttShot;
  if (hideFixed && !st.hidden.length) {
    for (const el of document.querySelectorAll("body *")) {
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") {
        st.hidden.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
        el.style.setProperty("visibility", "hidden", "important");
      }
    }
    if (!st.hidden.length) st.hidden.push(null); // remember that we've looked
  }
  window.scrollTo(0, y);
  // Give lazy content and repaint a moment.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
  const root = document.scrollingElement || document.documentElement;
  return { y: scrollY, height: root.scrollHeight };
}

function pageEnd() {
  const st = window.__ttShot;
  if (!st) return;
  for (const h of st.hidden) {
    if (!h) continue;
    const [el, value, priority] = h;
    if (value) el.style.setProperty("visibility", value, priority);
    else el.style.removeProperty("visibility");
  }
  st.style.remove();
  window.scrollTo(st.x, st.y);
  delete window.__ttShot;
}

// ---- Helpers ----

async function toBitmap(dataUrl) {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

async function canvasToDataUrl(canvas, shot) {
  const type = shot.format === "jpeg" ? "image/jpeg" : "image/png";
  const blob = await canvas.convertToBlob({ type, quality: shot.quality / 100 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Downloads-relative file name (with the settings folder) for a shot of this tab.
function shotName(tab, shot, part = 0) {
  const ext = shot.format === "jpeg" ? "jpg" : "png";
  let host = "page";
  try { host = new URL(tab.url).hostname.replace(/^www\./, "") || host; } catch {}
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const name = `${host.replace(/[^\w.-]/g, "_")}_${stamp}${part ? `_part${part}` : ""}.${ext}`;
  const folder = TT.cleanFolder(shot.folder);
  return folder ? `${folder}/${name}` : name;
}

function setBadge(tabId, text, color = "#30d158") {
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}
