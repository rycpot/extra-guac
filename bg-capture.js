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
  // Copy: the picture comes back as a PNG for the page to put on the clipboard. View: it opens
  // in a new tab, not saved. Both still go in the screenshot history.
  areaSelected: async ({ rect, viewportWidth, action, host }, sender) => {
    if (action === "copy" || action === "view") {
      const cap = await captureArea(sender.tab, rect, viewportWidth, action === "copy" ? "png" : "");
      const historyId = SHOTS.newId();
      await recordShot(cap, sender.tab, historyId).catch(() => {});
      if (action === "copy") return { dataUrl: cap.items[0].dataUrl };
      return void (await openShotView(cap.items, cap.label, sender.tab.url, sender.tab, historyId));
    }
    return finishShot(sender.tab, action === "upload" ? "cloud" : "local", await captureArea(sender.tab, rect, viewportWidth), host);
  },
  // From the card.
  shotSave: async ({ items }) => ({ files: await saveItems(items) }),
  // source: the page the shot is of, when uploading from the shot-view tab (for the history).
  // what: "QR code" for QR codes (the card and the QR page), else a screenshot.
  shotUpload: ({ items, host, source, what }, sender) => uploadShot(items, host, source ? { ...sender.tab, url: source } : sender.tab, what),
  // From the card: open the shot in a new tab (shot-view.html), without saving it. The
  // image is kept here only until that tab asks for it.
  shotView: ({ items, label, historyId }, sender) => openShotView(items, label, sender.tab?.url || "", sender.tab, historyId),
  // Screenshot history (popup): edit, upload, delete one, or clear them all.
  shotHistoryOpen: async ({ id }) => {
    const meta = await shotMeta(id);
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await openShotView(await SHOTS.itemsOf(id), meta.label || "screenshot", meta.source, tab, id);
  },
  // From the shot-view tab: the shot was edited and has left the tab (saved, copied or
  // uploaded), so its history entry becomes the edited version.
  shotHistoryReplace: ({ id, items }) => replaceShot(id, items),
  shotHistoryUpload: async ({ id, host }) => {
    const meta = await shotMeta(id);
    return uploadShot(await SHOTS.itemsOf(id), host, { url: meta.source });
  },
  shotHistoryDelete: ({ id }) => dropShots((s) => s.id === id),
  shotHistoryClear: () => dropShots(() => true),
  // From the image controls (imgzoom.js): an image on the page, in the screenshot editor, to
  // mark up or cut out (fetched as the image upload does, with the page's cookies).
  imgEdit: async ({ src }, sender) => {
    if (!src) throw new Error("No image here");
    const { blob, name } = await fetchImage(src, sender.tab, sender.frameId);
    await openShotView([{ name, dataUrl: await blobToDataUrl(blob) }], "Image from the page", sender.tab?.url || "", sender.tab);
  },
  // From an Image annotate tab: an image dropped, pasted or chosen there, kept until the tab
  // reloads with it. It goes in the screenshot history only once it's saved, copied or
  // uploaded (shotHistoryAdd).
  shotViewPut: ({ items, label }) => ({ id: holdShotView({ items, label, fresh: true }) }),
  shotHistoryAdd: async ({ items, label }) => {
    const id = SHOTS.newId();
    await recordShot({ items, label }, null, id);
    const { shotHistory = [] } = await chrome.storage.local.get("shotHistory");
    return { id: shotHistory.some((s) => s.id === id) ? id : "" }; // "" with the history off
  },
  shotViewGet: ({ id }) => {
    const v = shotViews.get(id);
    shotViews.delete(id);
    if (!v) throw new Error("This screenshot isn't available any more");
    return v;
  },
};

const shotViews = new Map(); // id → { items, label } on their way to a shot-view tab

// Opens a shot in a new tab (shot-view.html) without saving it; the image is kept here
// only until that tab asks for it.
// historyId: the shot's screenshot history entry, which its edits replace.
async function openShotView(items, label, source, tab, historyId) {
  const id = holdShotView({ items, label, source: source || "", historyId: historyId || "" });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`shot-view.html#${id}`), ...(tab ? { index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId } : {}) });
}

function holdShotView(v) {
  const id = crypto.randomUUID();
  shotViews.set(id, v);
  setTimeout(() => shotViews.delete(id), 60000); // never picked up: drop it
  return id;
}

// ---- Screenshot history (shot-store.js): every shot goes in, the newest 10 stay ----
async function recordShot(cap, tab, id) {
  if ((await TT.getSettings()).shot?.history === false) return;
  const entry = await SHOTS.record({ items: cap.items, label: cap.label, source: tab?.url || "" }, id);
  let dropped = [];
  await editLocal(["shotHistory"], ({ shotHistory = [] }) => {
    const list = [entry, ...shotHistory.filter((s) => s.id !== entry.id)];
    dropped = list.slice(SHOTS.KEEP);
    return { shotHistory: list.slice(0, SHOTS.KEEP) };
  });
  for (const s of dropped) await SHOTS.remove(s.id).catch(() => {});
}
// An edited shot takes its entry's place under a new id: backups upload each id once, so the
// edited pixels go up as new files, and the original's (what a blur hid) go from this
// computer at once and from Drive once no kept snapshot uses them.
async function replaceShot(oldId, items) {
  const meta = (await chrome.storage.local.get("shotHistory")).shotHistory?.find((s) => s.id === oldId);
  if (!meta || !items?.length) return { id: "" }; // not in the history (any more)
  const entry = await SHOTS.record({ items, label: meta.label, source: meta.source }, SHOTS.newId(), meta.at);
  let placed = false;
  await editLocal(["shotHistory"], ({ shotHistory = [] }) => {
    const i = shotHistory.findIndex((s) => s.id === oldId);
    if (i < 0) return null;
    placed = true;
    return { shotHistory: shotHistory.map((s, k) => (k === i ? { ...entry, edited: true } : s)) };
  });
  await SHOTS.remove(placed ? oldId : entry.id).catch(() => {});
  return { id: placed ? entry.id : "" };
}
async function shotMeta(id) {
  const { shotHistory = [] } = await chrome.storage.local.get("shotHistory");
  const meta = shotHistory.find((s) => s.id === id);
  if (!meta) throw new Error("That screenshot isn't in the history any more");
  return meta;
}
async function dropShots(match) {
  let dropped = [];
  await editLocal(["shotHistory"], ({ shotHistory = [] }) => {
    dropped = shotHistory.filter(match);
    return { shotHistory: shotHistory.filter((s) => !match(s)) };
  });
  for (const s of dropped) await SHOTS.remove(s.id).catch(() => {});
}
// List entries whose images aren't on this computer go (a settings file has no images);
// at start-up, images no entry points at go too (not right after a restore, so "undo last
// restore" still finds them).
async function tidyShots({ orphans = false } = {}) {
  const have = new Set(await SHOTS.keys().catch(() => []));
  let ids = new Set();
  await editLocal(["shotHistory"], ({ shotHistory }) => {
    if (!Array.isArray(shotHistory)) return null;
    const kept = shotHistory.filter((s) => have.has(s.id));
    ids = new Set(kept.map((s) => s.id));
    return kept.length === shotHistory.length ? null : { shotHistory: kept };
  });
  if (orphans) for (const id of have) if (!ids.has(id)) await SHOTS.remove(id).catch(() => {});
}
chrome.runtime.onStartup.addListener(() => tidyShots({ orphans: true }).catch(() => {}));
// Switching the history off deletes what it kept.
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local" || !c.tt) return;
  const on = (tt) => TT.merge(TT.DEFAULTS, tt).shot.history !== false;
  if (on(c.tt.oldValue) && !on(c.tt.newValue)) dropShots(() => true).catch(() => {});
});

// A capture is { items: [{ name, dataUrl }], label, truncated? }; name includes the folder.
// host: the one already picked (area ☁); otherwise the one from settings, and with "show
// both hosts" the card lets you pick.
async function finishShot(tab, action, cap, host) {
  const historyId = SHOTS.newId();
  recordShot(cap, tab, historyId).catch(() => {});
  const extra = { truncated: !!cap.truncated, screens: MAX_SCREENS };
  if (action !== "preview" && action !== "cloud") return { files: await saveItems(cap.items), ...extra };
  const { upload } = await TT.getSettings();
  const hosts = uploadHostsOn(upload), choices = TT.uploadChoices(upload);
  if (host && !hosts.includes(host)) host = null;
  const msg = { type: "egShotCard", items: cap.items, label: cap.label, historyId, hosts, choices, host: host || (choices.length === 1 ? choices[0] : null), ...extra };
  if (action === "cloud") {
    if (!hosts.length) throw new Error("Turn on imglink or X02 in upload images to upload screenshots");
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

// Chrome can only capture what its window shows, so the tab asked for must still be the one
// on screen: if another tab was brought up meanwhile (switching tabs during a full-page
// capture, say), it stops rather than capture the wrong one. Captures run one at a time,
// spaced out for Chrome's limit, however many are asked for at once.
let captureQueue = Promise.resolve();
function grab(tab, format = "png", quality) {
  const run = captureQueue.then(async () => {
    const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const [shown] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (shown?.id !== tab.id) throw new Error("The tab changed before it could be captured; stay on it until it's done");
    lastCaptureAt = Date.now();
    return chrome.tabs.captureVisibleTab(tab.windowId, format === "jpeg" ? { format, quality } : { format: "png" });
  });
  captureQueue = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureTab(tab) {
  const { shot } = await TT.getSettings();
  const dataUrl = await grab(tab, shot.format, shot.quality);
  return { items: [{ name: shotName(tab, shot), dataUrl }], label: "visible tab" };
}

async function startAreaSelection(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["page-helpers.js", "area.js"] });
}

async function captureArea(tab, rect, viewportWidth, format = "") {
  let { shot } = await TT.getSettings();
  if (format) shot = { ...shot, format }; // the clipboard takes PNG
  await sleep(80); // let the selection overlay disappear from the screen
  const bmp = await toBitmap(await grab(tab));
  const scale = bmp.width / viewportWidth; // device pixels per CSS pixel (includes zoom)
  const w = Math.max(1, Math.round(rect.width * scale));
  const h = Math.max(1, Math.round(rect.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, Math.round(rect.x * scale), Math.round(rect.y * scale), w, h, 0, 0, w, h);
  return { items: [{ name: shotName(tab, shot), dataUrl: await canvasToDataUrl(canvas, shot) }], label: `area · ${w} × ${h}` };
}

// The row of pixels that's stretched down below a scrolling panel, from row y of a screen.
// Only plain columns (the same color from row `from` down to y: backgrounds, sidebars,
// borders) carry on down as they are. Columns with a picture or text in them would smear
// into stripes, so they take the plain color around them instead: the color on both sides
// of them when that's the same, else the row's most common plain color (white if none).
function fillRow(bmp, y, from) {
  const w = bmp.width, h = y - from + 1;
  const c = new OffscreenCanvas(w, h);
  const cx = c.getContext("2d");
  cx.drawImage(bmp, 0, from, w, h, 0, 0, w, h);
  const img = cx.getImageData(0, 0, w, h);
  const d = img.data, row = (h - 1) * w * 4;
  const plain = new Uint8Array(w);
  const counts = new Map();
  for (let x = 0; x < w; x++) {
    const i = row + x * 4;
    let same = true;
    for (let r = 0; r < h - 1 && same; r++) {
      const j = (r * w + x) * 4;
      same = Math.abs(d[j] - d[i]) <= 2 && Math.abs(d[j + 1] - d[i + 1]) <= 2 && Math.abs(d[j + 2] - d[i + 2]) <= 2;
    }
    plain[x] = same ? 1 : 0;
  }
  // A plain stretch only a few columns wide is a still bit of a picture, not a background.
  for (let x = 0; x < w; ) {
    let end = x;
    while (end < w && plain[end] === plain[x]) end++;
    if (plain[x] && end - x < 4) plain.fill(0, x, end);
    x = end;
  }
  for (let x = 0; x < w; x++) {
    if (!plain[x]) continue;
    const i = row + x * 4, key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bg = 0xffffff, most = 0;
  for (const [key, n] of counts) if (n > most) { most = n; bg = key; }
  const out = new ImageData(w, 1);
  const o = out.data;
  const color = (x) => (d[row + x * 4] << 16) | (d[row + x * 4 + 1] << 8) | d[row + x * 4 + 2];
  for (let x = 0; x < w; ) {
    if (plain[x]) {
      o.set(d.subarray(row + x * 4, row + x * 4 + 3), x * 4);
      o[x * 4 + 3] = 255;
      x++;
      continue;
    }
    let end = x;
    while (end < w && !plain[end]) end++;
    const left = x > 0 ? color(x - 1) : null, right = end < w ? color(end) : null;
    const pick = left !== null && (left === right || right === null) ? left : right !== null && left === null ? right : bg;
    for (; x < end; x++) o.set([pick >> 16, (pick >> 8) & 255, pick & 255, 255], x * 4);
  }
  const strip = new OffscreenCanvas(w, 1);
  strip.getContext("2d").putImageData(out, 0, 0);
  return strip;
}

// Scrolls the page one screen at a time, capturing each, then stitches them.
// Fixed/sticky elements (headers, chat bubbles) are hidden after the first screen, also ones
// that only turn fixed once the page is scrolled,
// so they appear once instead of on every slice.
// Pages that don't scroll as a whole (app layouts like cloud consoles and webmail, where
// only a panel scrolls) scroll their biggest on-screen scrolling panel instead: the
// image is the first screen with that panel stretched to its full length, and what's
// below the panel (if anything) at the bottom.
async function captureFullPage(tab) {
  const { shot } = await TT.getSettings();
  let frameId = 0; // the frame that's scrolled: the top one, or one a page is built inside
  const run = (func, args = [], frame = frameId) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frame] }, func, args }).then((r) => r[0]?.result);

  const page = await beginInBestFrame(tab.id, run, (f) => (frameId = f));
  const slices = [];
  let truncated = false; // stopped at MAX_SCREENS before reaching the end of the page
  // Side-by-side scrolling panels (page.others) scroll along with the main one, by the
  // smallest panel height at a time, until every one of them has reached its end.
  const others = page.others || [];
  // (A couple of pixels short, so slices overlap: a panel's edge seldom falls on a whole
  // device pixel, and its edge rows are covered by the next slice.)
  const minH = Math.min(page.viewHeight, ...others.map((o) => o.height));
  const step = minH > 20 ? minH - 2 : Math.max(1, minH);
  try {
    for (let y = 0, i = 0; ; i++) {
      if (i >= MAX_SCREENS) { truncated = true; break; }
      const pos = await run(pageScrollTo, [y, i > 0]);
      const prev = slices[slices.length - 1];
      if (prev && pos.y <= prev.y && (pos.others || []).every((o, k) => o.y <= prev.others[k].y)) break; // nothing scrolled any further
      slices.push({ y: pos.y, others: pos.others || [], bmp: await toBitmap(await grab(tab)) });
      const done = (pos.y + page.viewHeight) / pos.height;
      setBadge(tab.id, `${Math.min(99, Math.round(Math.min(done, ...(pos.others || []).map((o, k) => (o.y + others[k].height) / o.height)) * 100))}%`);
      const allDone = pos.y + page.viewHeight >= pos.height && (pos.others || []).every((o, k) => o.y + others[k].height >= o.height - 1);
      if (allDone) break;
      y += step;
    }
  } finally {
    await run(pageEnd).catch(() => {});
    setBadge(tab.id, "");
  }

  const scale = slices[0].bmp.width / page.viewWidth;
  const last = slices[slices.length - 1];
  // Panels in device pixels: snapped inwards to whole pixels, and kept within the screen
  // (rounded sizes can reach a pixel past it, which would leave a blank line at a seam).
  const bw = slices[0].bmp.width, bh = slices[0].bmp.height;
  const px = (b) => {
    if (!b) return null;
    const x = Math.max(0, Math.ceil(b.left * scale)), y = Math.max(0, Math.ceil(b.top * scale));
    const r = Math.min(bw, Math.floor((b.left + b.width) * scale)), btm = Math.min(bh, Math.floor((b.top + b.height) * scale));
    return { x, y, w: Math.max(1, r - x), h: Math.max(1, btm - y) };
  };
  const box = px(page.box); // the main scrolling panel, in device pixels
  // Every panel: where it is, and where each slice had it scrolled to.
  const panels = box ? [
    { box, ys: slices.map((s) => s.y), cssH: page.viewHeight },
    ...others.map((o, k) => ({ box: px(o), ys: slices.map((s) => s.others[k]?.y || 0), cssH: o.height })),
  ] : [];
  const ends = panels.map((p) => p.box.y + Math.round(p.ys[p.ys.length - 1] * scale) + p.box.h);
  const below = box ? slices[0].bmp.height - (box.y + box.h) : 0; // window area under the main panel
  const contentEnd = box ? Math.max(...ends) : 0;
  const total = box
    ? contentEnd + Math.max(0, below)
    : Math.round((last.y + page.viewHeight) * scale);
  const width = slices[0].bmp.width;
  const items = [];
  const parts = Math.ceil(total / MAX_PART_HEIGHT);
  let fill = null; // the row stretched down below the main panel (made once, if needed)
  for (let p = 0; p < parts; p++) {
    const top = p * MAX_PART_HEIGHT;
    const canvas = new OffscreenCanvas(width, Math.min(MAX_PART_HEIGHT, total - top));
    const ctx = canvas.getContext("2d");
    if (box) {
      ctx.fillStyle = "#fff"; // never transparent (JPEG would turn that black)
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // First screen down to the main panel's bottom edge (header, sidebars).
      const edge = box.y + box.h;
      ctx.drawImage(slices[0].bmp, 0, 0, width, edge, 0, -top, width, edge);
      // Below that, everything carries on down: the last screen's row of pixels just
      // above that edge, stretched to the full length (sidebars, margins, and a shorter
      // panel's own end). A row a little above the edge, without smoothing, so nothing
      // below it bleeds in. The panels are drawn over it.
      if (contentEnd > edge) {
        fill ||= fillRow(last.bmp, Math.max(box.y, edge - 3), Math.max(box.y, edge - 3 - Math.round(24 * scale)));
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(fill, 0, 0, width, 1, 0, edge - top, width, contentEnd - edge);
        ctx.imageSmoothingEnabled = true;
      }
      // Each panel, slice by slice, at the height it was scrolled to.
      for (const pn of panels) {
        const b = pn.box;
        slices.forEach((s, i) => ctx.drawImage(s.bmp, b.x, b.y, b.w, b.h, b.x, b.y + Math.round(pn.ys[i] * scale) - top, b.w, b.h));
      }
      // Whatever was under the main panel (a footer), at the very end.
      if (below > 0) ctx.drawImage(last.bmp, 0, edge, width, below, 0, contentEnd - top, width, below);
    } else for (const s of slices) ctx.drawImage(s.bmp, 0, Math.round(s.y * scale) - top);
    items.push({ name: shotName(tab, shot, parts > 1 ? p + 1 : 0), dataUrl: await canvasToDataUrl(canvas, shot) });
  }
  return { items, truncated, label: parts > 1 ? `full page · ${parts} parts` : "full page" };
}

// When the window doesn't scroll, the scrolling panel may be in the top page or inside an
// iframe (pages built in a frame from another site, e.g. task tools). Every frame reports
// its biggest scrolling panel; the biggest on screen wins. Its position is the frame's
// panel position plus where each iframe around it sits, one parent at a time.
async function beginInBestFrame(tabId, run, setFrame) {
  const probes = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageBegin, args: [true] }).catch(() => []);
  const top = probes.find((p) => p.frameId === 0)?.result;
  const candidates = probes.filter((p) => p.result?.panel && p.result.panel.extra > 5 && (p.frameId === 0 || p.result.inFrame));
  const best = candidates.sort((a, b) => b.result.panel.area - a.result.panel.area)[0];
  if (!top || top.rootScrolls || !best || best.frameId === 0) return run(pageBegin, [], 0);
  const offset = await frameOffset(tabId, best.frameId).catch(() => null);
  if (!offset) return run(pageBegin, [], 0);
  setFrame(best.frameId);
  const page = await run(pageBegin, [], best.frameId);
  if (!page?.box) { setFrame(0); return run(pageBegin, [], 0); }
  const move = (b) => ({ ...b, left: b.left + offset.x, top: b.top + offset.y });
  return { ...page, viewWidth: top.viewWidth, box: move(page.box), others: (page.others || []).map(move) };
}

// Where a frame's top-left corner is in the tab, adding up each enclosing iframe's position.
async function frameOffset(tabId, frameId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  let x = 0, y = 0;
  for (let f = byId.get(frameId); f && f.frameId !== 0; f = byId.get(f.parentFrameId)) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [f.parentFrameId] }, func: pageFrameRects });
    const rects = res?.result || [];
    const key = (u) => { try { const p = new URL(u); return [p.href, p.origin + p.pathname, p.origin]; } catch { return [u, u, u]; } };
    const want = key(f.url);
    // Same address, then same page, then same site; else the biggest iframe there.
    const match = [0, 1, 2].map((i) => rects.filter((r) => key(r.src)[i] === want[i])).find((m) => m.length === 1)?.[0]
      || [...rects].sort((a, b) => b.area - a.area)[0];
    if (!match) return null;
    x += match.left;
    y += match.top;
  }
  return { x, y };
}

// ---- Functions injected into the page (must be self-contained) ----

// probe: only report the frame's biggest scrolling panel (read-only; run in every frame to
// choose one). Otherwise set the frame up for capturing: in the top frame the window, or
// the panel when the window doesn't scroll; in a frame chosen for its panel (pages built
// inside an iframe), that panel, or the frame's own document when that's what scrolls.
function pageBegin(probe = false) {
  const root = document.scrollingElement || document.documentElement;
  const inFrame = window !== window.top;
  const rootScrolls = root.scrollHeight > innerHeight + 5;
  // The on-screen element with overflow-y auto/scroll and the most content below its fold,
  // breadth-first from <body>, through open shadow roots (web components).
  // Other big scrolling panels beside it (a task panel next to the results) scroll along.
  let best = null, side = [];
  if (inFrame && rootScrolls) best = root;
  else if (!rootScrolls) {
    const found = [];
    const queue = [document.body];
    while (queue.length) {
      const el = queue.shift();
      if (!el || el.nodeType !== 1) continue;
      const sh = el.scrollHeight, ch = el.clientHeight;
      if (sh > ch + 5 && ch > 50 && el.clientWidth > 40) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const onScreen = r.left >= -18 && r.right <= innerWidth + 18 && r.top >= -18 && r.bottom <= innerHeight + 18;
        if (/auto|scroll|overlay/.test(cs.overflowY) && cs.pointerEvents !== "none" && onScreen) { found.push({ el, r }); continue; }
      }
      queue.push(...el.children, ...(el.shadowRoot ? el.shadowRoot.children : []));
    }
    const main = found.sort((a, b) => b.el.scrollHeight - a.el.scrollHeight)[0];
    best = main?.el || null;
    if (main) {
      const apart = (a, b) => a.right <= b.left + 2 || b.right <= a.left + 2; // side by side, not on top
      side = found.filter((f) => f !== main && f.el.clientHeight >= 100 && f.el.clientWidth >= 100 && apart(f.r, main.r)).slice(0, 3).map((f) => f.el);
    }
  }
  if (probe) {
    return { rootScrolls, inFrame, viewWidth: innerWidth, viewHeight: innerHeight,
      panel: best && { area: best.clientWidth * best.clientHeight, extra: best.scrollHeight - best.clientHeight } };
  }

  const style = document.createElement("style");
  style.textContent = "html,body{scroll-behavior:auto!important;scrollbar-width:none!important}" +
    "::-webkit-scrollbar{display:none!important}[data-eg-shot-hide]{visibility:hidden!important}";
  document.documentElement.append(style);
  // Boxes that scroll inside what's captured (a log, a code listing, a comments box with its
  // own scrollbar) are stretched to their full length for the capture, so what's hidden in
  // them shows too. Innermost first, so a box inside another one counts at its full length.
  // Fixed and sticky parts, and endless lists (over 20,000 px hidden), stay as they are.
  const stretched = [];
  const container = best && best !== root ? best : document.body;
  const all = [];
  const collect = (r) => { for (const el of r.querySelectorAll("*")) { all.push(el); if (el.shadowRoot) collect(el.shadowRoot); } };
  if (container) collect(container);
  let budget = 60000;
  for (const el of all.reverse()) {
    if (/^(TEXTAREA|SELECT|IFRAME|FRAME|HTML|BODY)$/.test(el.tagName) || side.includes(el)) continue;
    const hiddenPx = el.scrollHeight - el.clientHeight;
    if (hiddenPx <= 5 || el.clientHeight < 1 || hiddenPx > 20000 || hiddenPx > budget) continue;
    const cs = getComputedStyle(el);
    if (!/auto|scroll|overlay/.test(cs.overflowY)) continue;
    let pinned = false;
    for (let a = el; a && a !== container; a = a.parentElement || a.getRootNode().host) {
      const pos = getComputedStyle(a).position;
      if (pos === "fixed" || pos === "sticky") { pinned = true; break; }
    }
    if (pinned) continue;
    stretched.push({ el, top: el.scrollTop, style: el.getAttribute("style") }); // put back exactly as it was
    const h = parseFloat(cs.height) + hiddenPx + "px";
    el.style.setProperty("height", h, "important");
    el.style.setProperty("min-height", h, "important"); // so a flex layout doesn't squeeze it back
    el.style.setProperty("max-height", "none", "important");
    if (el.scrollHeight > el.clientHeight + 1) el.style.setProperty("overflow-y", "hidden", "important");
    budget -= hiddenPx;
  }
  window.__ttShot = { style, hidden: [], x: scrollX, y: scrollY, stretched };
  const result = { viewWidth: innerWidth, viewHeight: innerHeight, height: root.scrollHeight };
  if (!best || (!inFrame && rootScrolls)) return result; // the window scrolls (or nothing does): as usual
  const prevBehavior = [best.style.getPropertyValue("scroll-behavior"), best.style.getPropertyPriority("scroll-behavior")];
  best.style.setProperty("scroll-behavior", "auto", "important");
  // A panel inside a web component: the page's stylesheet doesn't reach in there, so its
  // scrollbars are hidden from inside too.
  const shadow = best.getRootNode() instanceof ShadowRoot ? best.getRootNode() : null;
  let shadowStyle = null;
  if (shadow) {
    shadowStyle = document.createElement("style");
    shadowStyle.textContent = "*{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}";
    shadow.append(shadowStyle);
  }
  const sideStyles = [];
  for (const el of side) {
    const rn = el.getRootNode();
    if (rn instanceof ShadowRoot && rn !== shadow && !sideStyles.some((x) => x.parentNode === rn)) {
      const st2 = document.createElement("style");
      st2.textContent = "*{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}";
      rn.append(st2);
      sideStyles.push(st2);
    }
  }
  const sides = side.map((el) => {
    const prev = [el.style.getPropertyValue("scroll-behavior"), el.style.getPropertyPriority("scroll-behavior")];
    el.style.setProperty("scroll-behavior", "auto", "important");
    return { el, y0: el.scrollTop, prev };
  });
  Object.assign(window.__ttShot, { el: best, elY: best.scrollTop, prevBehavior, shadowStyle, sides, sideStyles });
  // The panel's visible content area (inside its borders, without a horizontal scrollbar).
  const r = best === root ? { left: 0, top: 0 } : best.getBoundingClientRect();
  const box = best === root
    ? { left: 0, top: 0, width: root.clientWidth, height: root.clientHeight }
    : { left: r.left + best.clientLeft, top: r.top + best.clientTop, width: best.clientWidth, height: best.clientHeight };
  const others = side.map((el) => {
    const q = el.getBoundingClientRect();
    return { left: q.left + el.clientLeft, top: q.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
  });
  return { ...result, viewHeight: box.height, height: best.scrollHeight, box, others };
}

// In a parent frame: where its iframes' content areas are on screen (through open shadow
// roots), to place a child frame's panel within the tab.
function pageFrameRects() {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        out.push({ src: el.src || "", left: r.left + el.clientLeft + parseFloat(cs.paddingLeft || 0), top: r.top + el.clientTop + parseFloat(cs.paddingTop || 0), area: r.width * r.height });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
}

async function pageScrollTo(y, hideFixed) {
  const st = window.__ttShot;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // Scrolling a panel: only sticky parts inside it repeat (the header and sidebars
  // outside it are drawn once from the first screen anyway).
  const hideNew = () => {
    st.seen ||= new Set();
    let found = 0;
    for (const el of [st.el || document.body, ...(st.sides || []).map((s) => s.el)].flatMap((p) => [...p.querySelectorAll("*")])) {
      if (st.seen.has(el)) continue;
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") {
        // Hidden by a marker and the capture's stylesheet rather than the element's own style,
        // which some pages rewrite as they scroll.
        st.seen.add(el);
        st.hidden.push(el);
        el.setAttribute("data-eg-shot-hide", "");
        found++;
      }
    }
    return found;
  };
  if (hideFixed && !st.seen) hideNew();
  if (st.el) st.el.scrollTop = y;
  else window.scrollTo(0, y);
  for (const s of st.sides || []) s.el.scrollTop = y;
  // Give lazy content and repaint a moment.
  await frame();
  await new Promise((r) => setTimeout(r, 120));
  // A header that only turns fixed once the page is scrolled (it was part of the page on
  // the first screen, and is there in the picture already) is hidden too.
  if (hideFixed && hideNew()) await frame();
  if (st.el) return { y: st.el.scrollTop, height: st.el.scrollHeight, others: (st.sides || []).map((s) => ({ y: s.el.scrollTop, height: s.el.scrollHeight })) };
  const root = document.scrollingElement || document.documentElement;
  return { y: scrollY, height: root.scrollHeight };
}

function pageEnd() {
  const st = window.__ttShot;
  if (!st) return;
  for (const el of st.hidden) el.removeAttribute("data-eg-shot-hide");
  st.style.remove();
  for (const { el, top, style } of st.stretched || []) {
    if (style === null) el.removeAttribute("style");
    else el.setAttribute("style", style);
    el.scrollTop = top;
  }
  st.shadowStyle?.remove();
  for (const x of st.sideStyles || []) x.remove();
  for (const s of st.sides || []) {
    s.el.scrollTop = s.y0;
    if (s.prev[0]) s.el.style.setProperty("scroll-behavior", ...s.prev);
    else s.el.style.removeProperty("scroll-behavior");
  }
  if (st.el) {
    st.el.scrollTop = st.elY;
    if (st.prevBehavior[0]) st.el.style.setProperty("scroll-behavior", ...st.prevBehavior);
    else st.el.style.removeProperty("scroll-behavior");
  }
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
