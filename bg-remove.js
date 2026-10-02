// Remove elements. Each site (hostname without "www.") keeps a list of CSS selectors in
// storage.local "removed": { site: [{ selector, at }] }; they're hidden on every page of
// that site and its subdomains, in the top frame.
//
// No flicker, ever: remove-apply.js is registered at document_start for exactly the sites
// that have removals. It keeps the page transparent and asks for "removeAttach", which
// adds the hiding rules as a browser-level (user) stylesheet to that document before
// answering; only then is the page shown. User stylesheets can't be overridden or taken
// out by the page, and they survive in-page navigation. Pages already open are updated
// whenever a list or the "show removed" switch changes.
//
// "Show removed" ("removedShow": { site: true }, cleared when Chrome starts) puts that
// site's removed elements back with a red dashed outline instead of hiding them.

const removeHandlers = {
  removeAttach: (_msg, sender) => attachDocument(sender),
  removeAdd: ({ selector }, sender) => editRemoved(sender, (list) => {
    if (!list.some((r) => r.selector === selector)) list.push({ selector, at: Date.now() });
  }),
  removeUndo: ({ selector }, sender) => editRemoved(sender, (list) => {
    const i = list.findIndex((r) => r.selector === selector);
    if (i >= 0) list.splice(i, 1);
  }),
  pickRemove: async ({ tabId }) => {
    await attachDocument({ tab: await chrome.tabs.get(tabId), frameId: 0 });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["vendor/css-selector-generator.js", "page-helpers.js", "picker-remove.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__ttRemovePicker() });
  },
  removeShow: async ({ site, on }) => {
    const { removedShow = {} } = await chrome.storage.local.get("removedShow");
    if (on) removedShow[site] = true;
    else delete removedShow[site];
    await chrome.storage.local.set({ removedShow });
  },
};

const REMOVE_SCRIPT_ID = "tt-remove";
const siteOf = (host = "") => host.toLowerCase().replace(/^www\./, "");
const hostOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname : ""; } catch { return ""; } };
// Every stored site that covers this host: the site itself and its parent domains.
const sitesFor = (host, removed) => { const h = siteOf(host); return h ? Object.keys(removed).filter((s) => h === s || h.endsWith(`.${s}`)) : []; };

function cssFor(host, removed, removedShow) {
  const show = sitesFor(host, removed).some((s) => removedShow[s]) || !!removedShow[siteOf(host)];
  const rule = show
    ? "{ outline: 2px dashed #ff453a !important; outline-offset: -2px !important; box-shadow: inset 0 0 0 100vmax rgba(255, 69, 58, .14) !important; }"
    : "{ display: none !important; }";
  // One rule per selector, so a selector the page's HTML no longer suits can't break the others.
  return sitesFor(host, removed).flatMap((s) => removed[s].map((r) => `${r.selector} ${rule}`)).join("\n");
}

async function editRemoved(sender, fn) {
  const site = siteOf(hostOf(sender.tab?.url || sender.url));
  if (!site) return;
  const { removed = {} } = await chrome.storage.local.get("removed");
  const list = removed[site] || [];
  fn(list);
  if (list.length) removed[site] = list;
  else delete removed[site];
  await chrome.storage.local.set({ removed });
}

// ---- Documents with the stylesheet ------------------------------------------------
// "removeDocs" (storage.session) remembers which CSS each document got, by documentId,
// so it can be swapped when lists change (removeCSS needs the exact text inserted).

let removeQueue = Promise.resolve();
const inRemoveQueue = (fn) => (removeQueue = removeQueue.then(fn).catch(() => {}));

async function setDocumentCss(docs, documentId, tabId, host, css) {
  const old = docs[documentId]?.css || "";
  if (old === css) return;
  const target = { tabId, documentIds: [documentId] };
  try {
    if (css) await chrome.scripting.insertCSS({ target, css, origin: "USER" }); // new rules first: no gap
    if (old) await chrome.scripting.removeCSS({ target, css: old, origin: "USER" });
    docs[documentId] = { tabId, host, css };
  } catch {
    delete docs[documentId]; // that document is gone
  }
}

function attachDocument(sender) {
  return inRemoveQueue(async () => {
    const host = hostOf(sender.tab?.url || sender.url);
    const documentId = sender.documentId || (await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: sender.frameId ?? 0 }).catch(() => null))?.documentId;
    if (!host || !documentId) return;
    const { removed = {}, removedShow = {} } = await chrome.storage.local.get(["removed", "removedShow"]);
    const { removeDocs = {} } = await chrome.storage.session.get("removeDocs");
    await setDocumentCss(removeDocs, documentId, sender.tab.id, host, cssFor(host, removed, removedShow));
    if (!removeDocs[documentId]) removeDocs[documentId] = { tabId: sender.tab.id, host, css: "" };
    await chrome.storage.session.set({ removeDocs });
  });
}

function refreshDocuments() {
  return inRemoveQueue(async () => {
    const { removed = {}, removedShow = {} } = await chrome.storage.local.get(["removed", "removedShow"]);
    const { removeDocs = {} } = await chrome.storage.session.get("removeDocs");
    for (const [id, d] of Object.entries(removeDocs)) await setDocumentCss(removeDocs, id, d.tabId, d.host, cssFor(d.host, removed, removedShow));
    await chrome.storage.session.set({ removeDocs });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => inRemoveQueue(async () => {
  const { removeDocs = {} } = await chrome.storage.session.get("removeDocs");
  for (const [id, d] of Object.entries(removeDocs)) if (d.tabId === tabId) delete removeDocs[id];
  await chrome.storage.session.set({ removeDocs });
}));

// ---- Early script, only on sites with removals ----------------------------------------

async function syncRemoveScript(removed) {
  const matches = Object.keys(removed)
    .filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s))
    .flatMap((s) => [`*://${s}/*`, `*://*.${s}/*`]);
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [REMOVE_SCRIPT_ID] });
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: [REMOVE_SCRIPT_ID] });
  if (matches.length) {
    await chrome.scripting.registerContentScripts([{
      id: REMOVE_SCRIPT_ID, js: ["remove-apply.js"], matches, runAt: "document_start", allFrames: false, persistAcrossSessions: true,
    }]);
  }
}

let removeScriptSync = Promise.resolve();
const queueRemoveScript = (removed) => (removeScriptSync = removeScriptSync.then(() => syncRemoveScript(removed)).catch(() => {}));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.removed || changes.removedShow)) return;
  if (changes.removed) queueRemoveScript(changes.removed.newValue || {});
  refreshDocuments();
});

chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove("removedShow"));
chrome.runtime.onInstalled.addListener(async () => queueRemoveScript((await chrome.storage.local.get("removed")).removed || {}));
