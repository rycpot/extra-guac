// Screenshots: the visible tab, a dragged area, or the full page (scrolled and stitched).
// Files go to Downloads, or a sub-folder of it chosen in settings.

const captureHandlers = {
  shot: async ({ tabId, mode }) => {
    const tab = await chrome.tabs.get(tabId);
    if (mode === "area") return startAreaSelection(tab);
    if (mode === "full") return captureFullPage(tab);
    return captureTab(tab);
  },
  // Sent by area.js once the user confirms the selection.
  areaSelected: async ({ rect, viewportWidth }, sender) => captureArea(sender.tab, rect, viewportWidth),
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
  return { files: [await saveShot(dataUrl, tab, shot)] };
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
  return { files: [await saveShot(await canvasToDataUrl(canvas, shot), tab, shot)] };
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
  const files = [];
  const parts = Math.ceil(total / MAX_PART_HEIGHT);
  for (let p = 0; p < parts; p++) {
    const top = p * MAX_PART_HEIGHT;
    const canvas = new OffscreenCanvas(width, Math.min(MAX_PART_HEIGHT, total - top));
    const ctx = canvas.getContext("2d");
    for (const s of slices) ctx.drawImage(s.bmp, 0, Math.round(s.y * scale) - top);
    files.push(await saveShot(await canvasToDataUrl(canvas, shot), tab, shot, parts > 1 ? p + 1 : 0));
  }
  return { files, truncated, screens: MAX_SCREENS };
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

async function saveShot(dataUrl, tab, shot, part = 0) {
  const ext = shot.format === "jpeg" ? "jpg" : "png";
  let host = "page";
  try { host = new URL(tab.url).hostname.replace(/^www\./, "") || host; } catch {}
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const name = `${host.replace(/[^\w.-]/g, "_")}_${stamp}${part ? `_part${part}` : ""}.${ext}`;
  const folder = TT.cleanFolder(shot.folder);
  const filename = folder ? `${folder}/${name}` : name;
  await chrome.downloads.download({ url: dataUrl, filename, conflictAction: "uniquify", saveAs: false });
  return filename;
}

function setBadge(tabId, text, color = "#30d158") {
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}
