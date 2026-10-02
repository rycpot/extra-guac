// Clipboard history (settings.clip): text copied or cut on web pages, newest first.
//
// Storage: each entry is its own key, "clip:<id>" = { id, text, at, site, pinned, trimmed },
// and "clipIndex" lists them newest first as { id, at, pinned }, so saving a copy writes
// one small entry and the index, never the whole history. The id is a hash of the text:
// copying the same text again moves it to the top instead of adding a duplicate.
// Pinned entries never expire and don't count towards the limit; with settings.clip.menu
// they're offered in the right-click menu (see syncMenus in background.js).
//
// Capture: clip.js (and clip-main.js for site copy buttons) is registered on web pages
// while history is on, except on excluded sites. Chrome pages only: copies made in other
// apps aren't seen. Password fields are never saved (clip.js).

const CLIP_SCRIPT_IDS = ["tt-clip", "tt-clip-main"];
const CLIP_MAX_CHARS = 20000;
const CLIP_LIMITS = [50, 100, 200, 500];
const CLIP_MENU_MAX = 20;

const clipHandlers = {
  clipAdd: ({ text }, sender) => addClip(text, sender.tab?.url || sender.url),
  clipPin: ({ id, pinned }) => editClip(id, (e) => (e.pinned = !!pinned)),
  clipDelete: ({ id }) => inClipQueue(async () => {
    const index = await clipIndex();
    await chrome.storage.local.remove(`clip:${id}`);
    await chrome.storage.local.set({ clipIndex: index.filter((e) => e.id !== id) });
  }),
  // Everything except pinned entries.
  clipClear: () => inClipQueue(async () => {
    const index = await clipIndex();
    await chrome.storage.local.remove(index.filter((e) => !e.pinned).map((e) => `clip:${e.id}`));
    await chrome.storage.local.set({ clipIndex: index.filter((e) => e.pinned) });
  }),
  clipList: async () => ({ items: await clipItems() }),
};

let clipQueue = Promise.resolve();
const inClipQueue = (fn) => {
  const run = clipQueue.then(fn);
  clipQueue = run.catch(() => {});
  return run;
};

const clipIndex = async () => (await chrome.storage.local.get("clipIndex")).clipIndex || [];

// All entries, newest first, pinned ones included (callers sort as they like).
async function clipItems() {
  const index = await clipIndex();
  if (!index.length) return [];
  const got = await chrome.storage.local.get(index.map((e) => `clip:${e.id}`));
  return index.map((e) => got[`clip:${e.id}`]).filter(Boolean);
}

async function clipHash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const clipSite = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : ""; } catch { return ""; } };
const clipCovers = (site, list) => list.some((s) => site === s || site.endsWith(`.${s}`));

function addClip(raw, url) {
  return inClipQueue(async () => {
    const { clip } = await TT.getSettings();
    const site = clipSite(url);
    if (!clip.enabled || !site || clipCovers(site, clip.exclude)) return;
    let text = String(raw ?? "");
    if (!text.trim()) return;
    const trimmed = text.length > CLIP_MAX_CHARS;
    if (trimmed) text = text.slice(0, CLIP_MAX_CHARS);
    const id = await clipHash(text);
    const index = await clipIndex();
    const had = index.find((e) => e.id === id);
    const entry = { id, text, at: Date.now(), site, pinned: !!had?.pinned, trimmed };
    const next = [{ id, at: entry.at, pinned: entry.pinned }, ...index.filter((e) => e.id !== id)];
    const { keep, drop } = pruneClips(next, clip);
    await chrome.storage.local.set({ [`clip:${id}`]: entry, clipIndex: keep });
    if (drop.length) await chrome.storage.local.remove(drop.map((e) => `clip:${e.id}`));
  });
}

// Unpinned entries past the limit, or older than the age limit, go.
function pruneClips(index, clip, now = Date.now()) {
  const limit = CLIP_LIMITS.includes(Number(clip.limit)) ? Number(clip.limit) : 200;
  const maxAge = Number(clip.maxAgeDays) > 0 ? Number(clip.maxAgeDays) * 864e5 : Infinity;
  const keep = [], drop = [];
  let unpinned = 0;
  for (const e of index) {
    if (e.pinned) keep.push(e);
    else if (unpinned < limit && now - e.at < maxAge) { keep.push(e); unpinned++; }
    else drop.push(e);
  }
  return { keep, drop };
}

function editClip(id, fn) {
  return inClipQueue(async () => {
    const key = `clip:${id}`;
    const entry = (await chrome.storage.local.get(key))[key];
    if (!entry) return;
    fn(entry);
    const index = (await clipIndex()).map((e) => (e.id === id ? { ...e, pinned: !!entry.pinned } : e));
    await chrome.storage.local.set({ [key]: entry, clipIndex: index });
  });
}

// Applies new limits (and drops expired entries now and then).
function pruneNow() {
  return inClipQueue(async () => {
    const { clip } = await TT.getSettings();
    const { keep, drop } = pruneClips(await clipIndex(), clip);
    if (!drop.length) return;
    await chrome.storage.local.set({ clipIndex: keep });
    await chrome.storage.local.remove(drop.map((e) => `clip:${e.id}`));
  });
}

// ---- Backups: the whole history goes into snapshots and the settings file ----------------

const clipExport = clipItems;

function clipImport(items) {
  return inClipQueue(async () => {
    const old = await clipIndex();
    await chrome.storage.local.remove(old.map((e) => `clip:${e.id}`));
    const valid = (Array.isArray(items) ? items : []).filter((e) => e && typeof e.id === "string" && typeof e.text === "string");
    const set = { clipIndex: valid.map((e) => ({ id: e.id, at: Number(e.at) || Date.now(), pinned: !!e.pinned })) };
    for (const e of valid) set[`clip:${e.id}`] = { id: e.id, text: e.text.slice(0, CLIP_MAX_CHARS), at: Number(e.at) || Date.now(), site: String(e.site || ""), pinned: !!e.pinned, trimmed: !!e.trimmed };
    await chrome.storage.local.set(set);
  });
}

// ---- Page scripts ------------------------------------------------------------------------

const clipPatterns = (sites) => sites
  .filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s))
  .flatMap((s) => [`*://${s}/*`, `*://*.${s}/*`]);

async function syncClipScripts() {
  const { clip } = await TT.getSettings();
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: CLIP_SCRIPT_IDS });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map((s) => s.id) });
  if (!clip.enabled) return;
  const base = { matches: ["http://*/*", "https://*/*"], runAt: "document_start", allFrames: true, persistAcrossSessions: true };
  const skip = clipPatterns(clip.exclude);
  if (skip.length) base.excludeMatches = skip;
  await chrome.scripting.registerContentScripts([
    { ...base, id: "tt-clip", js: ["clip.js"] },
    { ...base, id: "tt-clip-main", js: ["clip-main.js"], world: "MAIN" },
  ]);
  // Tabs already open get it now (copies are ignored on excluded sites anyway).
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    if (clipCovers(clipSite(tab.url), clip.exclude)) continue;
    const target = { tabId: tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ["clip.js"] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ["clip-main.js"], world: "MAIN" }).catch(() => {});
  }
}

let clipSync = Promise.resolve();
const queueClipSync = () => (clipSync = clipSync.then(syncClipScripts).catch(() => {}));

// ---- Right-click menu: pinned entries ------------------------------------------------------

// Menu items for syncMenus: pinned entries, newest first, when the menu is switched on.
async function clipMenuItems(s) {
  if (!s.clip.enabled || !s.clip.menu) return [];
  const pinned = (await clipItems()).filter((e) => e.pinned).slice(0, CLIP_MENU_MAX);
  return pinned.map((e) => ({ id: `clippin:${e.id}`, title: e.text.replace(/\s+/g, " ").trim().slice(0, 40) || "(blank)" }));
}

// Clicked: typed into the field that was right-clicked, or copied if it wasn't a field.
async function onClipMenu(info, tab) {
  const id = String(info.menuItemId).slice("clippin:".length);
  const entry = (await chrome.storage.local.get(`clip:${id}`))[`clip:${id}`];
  if (!entry) return;
  if (info.editable) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      args: [entry.text],
      func: (text) => {
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        if (!el) return false;
        // insertText keeps the field's undo history and fires the page's input events.
        if (document.execCommand("insertText", false, text)) return true;
        if ("value" in el && el.setRangeText) {
          el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
        return false;
      },
    }).catch(() => []);
    if (res?.result) return;
  }
  await copyToClipboard(entry.text, tab);
}

chrome.storage.onChanged.addListener(async (c, area) => {
  if (area !== "local") return;
  if (c.tt) {
    const of = (tt) => TT.merge(TT.DEFAULTS, tt).clip;
    const [before, after] = [of(c.tt.oldValue), of(c.tt.newValue)];
    if (before.enabled !== after.enabled || JSON.stringify(before.exclude) !== JSON.stringify(after.exclude)) queueClipSync();
    if (before.limit !== after.limit || before.maxAgeDays !== after.maxAgeDays) pruneNow();
    if (before.enabled !== after.enabled || before.menu !== after.menu) syncMenus(TT.merge(TT.DEFAULTS, c.tt.newValue));
  }
  if (c.clipIndex) {
    const pins = (v) => JSON.stringify((v || []).filter((e) => e.pinned).map((e) => e.id));
    if (pins(c.clipIndex.oldValue) !== pins(c.clipIndex.newValue)) syncMenus(await TT.getSettings());
  }
});

chrome.runtime.onInstalled.addListener(() => queueClipSync());
chrome.runtime.onStartup.addListener(() => pruneNow());
