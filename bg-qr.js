// QR codes (Extra Guac's own look, qr-render.js).
// - Static: the content itself (a link, text, phone number or email) is in the code.
// - Dynamic: the code holds a short link whose destination can be changed later, at spoo.me
//   (the default; your key with shorten:create, urls:read and urls:manage, or admin:all) or
//   dub.sh (your key), from settings → URL shortener; qr.dynamic says which, when both are
//   linked. Made and changed through bg-shortener.js (dynCreate, dynUpdate); each code keeps
//   its link as { service, id, short, url } ("link"), so changes go to the right service.
//   dub.sh's are among its 25 new links a month: what's left is dub.sh's own figure when the
//   key can read it ("shortUsage"), else counted here.
// - Made from the popup (this page), the right-click menu (this page, a link, selected text)
//   or the QR page (qr.html). Popup and menu codes are drawn in the offscreen page and shown
//   in the page's card (shot-card.js) with save PNG / SVG, copy, upload, and "customize",
//   which opens the QR page; where the card can't be shown, the QR page opens instead.
// - History ("qrHistory"): { static: [...], dynamic: [...] }, the newest 50 of each; codes
//   are drawn again from what's in them, so only that is kept.
// - Your icons ("qrIcons"): up to 5, [{ id, url (a PNG data URL) }]; settings say which is
//   used (qr.icon) and whether icons are fitted to their space (qr.fit: transparent edges
//   trimmed so the icon fills it, whole).
// - Codes hold up to 500 bytes (EGQR.MAX): longer content opens the QR page to shorten it.
// - The right-click menu always makes static codes; dynamic ones come from the popup or the
//   QR page, where static is picked again each time they open.
// Loaded by background.js; qrHandlers join its message handlers.

const QR_KEEP = 50;

const qrHandlers = {
  qrNow: ({ mode, tabId }) => qrForTab(tabId, mode === "dynamic" ? "dynamic" : "static"),
  qrRecord: ({ entry }) => qrRecord(entry),
  qrDynCreate: ({ url, service }) => qrDynCreate(url, service),
  qrDynUpdate: ({ entryId, url }) => qrDynUpdate(entryId, url),
  qrDelete: ({ id }) => qrDrop((e) => e.id === id),
  qrClear: ({ mode }) => qrDrop((e) => e.mode === mode),
  qrOpenPage: ({ open }) => openQrPage(open),
};

const qrId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
// What a code holds, in a line: for the history and the card.
const qrTitle = (p) => {
  const t = p.replace(/^(tel|mailto):/i, "").replace(/^https?:\/\//i, "");
  return (/^mailto:/i.test(p) ? t.replace(/\?.*$/s, "") : t).slice(0, 200);
};

async function qrRecord(entry) {
  const e = { id: entry.id || qrId(), at: Date.now(), ...entry };
  await editLocal(["qrHistory"], ({ qrHistory }) => {
    const h = { static: [], dynamic: [], ...(qrHistory || {}) };
    const list = h[e.mode] || [];
    // The same content again moves to the top rather than repeating.
    const rest = list.filter((x) => x.id !== e.id && !(e.mode === "static" && x.payload === e.payload));
    return { qrHistory: { ...h, [e.mode]: [e, ...rest].slice(0, QR_KEEP) } };
  });
  return { entry: e };
}

async function qrDrop(match) {
  await editLocal(["qrHistory"], ({ qrHistory }) => {
    const h = { static: [], dynamic: [], ...(qrHistory || {}) };
    return { qrHistory: { static: h.static.filter((e) => !match(e)), dynamic: h.dynamic.filter((e) => !match(e)) } };
  });
}

// ---- Dynamic links: spoo.me or dub.sh -------------------------------------------

// Which service makes a dynamic code: the one asked for (or picked in settings) when its key
// is there, else the other one that has a key; null when neither is linked.
function qrDynService(s, want = s.qr.dynamic) {
  const has = (id) => !!s.shortener.keys[id]?.trim();
  const order = want === "dub" ? ["dub", "spoo"] : ["spoo", "dub"];
  return order.find(has) || null;
}
async function qrDynCreate(url, want) {
  if (!/^https?:\/\/\S+$/i.test(url || "")) throw new Error("A dynamic code needs a web address (http or https)");
  const s = await TT.getSettings();
  const service = qrDynService(s, want);
  if (!service) throw new Error("Link spoo.me (or dub.sh) first: an API key in settings → URL shortener");
  let link;
  try { link = await dynCreate(service, s.shortener.keys[service].trim(), url); } catch (err) {
    if (service === "dub") shortUsageRefresh(["dub"], true).catch(() => {}); // a limit reached shows in dub.sh's numbers
    throw err;
  }
  const month = TT.monthKey();
  await editLocal(["shortCounts"], ({ shortCounts = {} }) => {
    const counts = shortCounts.month === month ? { ...shortCounts } : { month };
    counts[service] = (counts[service] || 0) + 1;
    return { shortCounts: counts };
  });
  if (service === "dub") shortUsageRefresh(["dub"], true).catch(() => {});
  return { link };
}
// A dynamic code's destination, changed at its service; the printed code stays the same.
async function qrDynUpdate(entryId, url) {
  if (!/^https?:\/\/\S+$/i.test(url || "")) throw new Error("The destination needs to be a web address (http or https)");
  const { qrHistory } = await chrome.storage.local.get("qrHistory");
  const entry = qrHistory?.dynamic?.find((e) => e.id === entryId);
  if (!entry?.link) throw new Error("That code isn't in the history any more");
  const key = (await TT.getSettings()).shortener.keys[entry.link.service]?.trim();
  if (!key) throw new Error(`Link ${TT.SHORTENER_LABEL(entry.link.service)} again (its API key) to change where this code goes`);
  const link = await dynUpdate(entry.link, key, url);
  await editLocal(["qrHistory"], ({ qrHistory: h }) => {
    if (!h?.dynamic) return null;
    const dynamic = h.dynamic.map((e) => (e.id === entryId ? { ...e, link, content: { ...e.content, url: link.url }, edited: Date.now() } : e));
    return { qrHistory: { ...h, dynamic } };
  });
  return { link };
}
// Dynamic codes from before spoo.me kept their dub.sh link as "dub": it becomes "link". Once
// after an update, and after restoring an older backup.
async function qrLinksUpgrade() {
  await editLocal(["qrHistory"], ({ qrHistory }) => {
    if (!qrHistory?.dynamic?.some((e) => e.dub && !e.link)) return null;
    const dynamic = qrHistory.dynamic.map(({ dub, ...e }) => (dub && !e.link ? { ...e, link: { service: "dub", ...dub } } : dub ? { ...e } : e));
    return { qrHistory: { ...qrHistory, dynamic } };
  });
}

// ---- Popup and right-click menu ------------------------------------------------

// The icon in the middle: "avocado" (the extension's), one of yours (saved from the QR page,
// "qrIcons") or "none"; whether it's fitted to its space, and (yours) its background removed.
async function qrIconFor(s) {
  const fit = s.qr.fit !== false;
  if (s.qr.icon === "none") return { mode: "none", own: null, fit, clean: false };
  if (s.qr.icon !== "avocado") {
    const { qrIcons } = await chrome.storage.local.get("qrIcons");
    const own = Array.isArray(qrIcons) && qrIcons.find((i) => i.id === s.qr.icon);
    if (own) return { mode: "own", own: own.url, id: own.id, fit, clean: s.qr.clean === true };
  }
  return { mode: "avocado", own: null, fit, clean: false };
}

// 191 kept a single icon of your own ("qrIcon", picked as qr.icon "own"): it becomes the
// first of "qrIcons". After an update, and after restoring a backup from 191.
async function qrIconsUpgrade() {
  const { qrIcon, qrIcons } = await chrome.storage.local.get(["qrIcon", "qrIcons"]);
  if (typeof qrIcon !== "string") return;
  const icon = { id: "i191", url: qrIcon };
  const list = Array.isArray(qrIcons) ? qrIcons : [];
  if (!list.some((i) => i.url === qrIcon)) await chrome.storage.local.set({ qrIcons: [icon, ...list].slice(0, 5) });
  await chrome.storage.local.remove("qrIcon");
  const { tt } = await chrome.storage.local.get("tt");
  if (tt?.qr?.icon === "own") await TT.updateSettings({ qr: { icon: (list.find((i) => i.url === qrIcon) || icon).id } });
}

// The popup's "generate": this tab's address, static or dynamic.
async function qrForTab(tabId, mode) {
  const tab = await chrome.tabs.get(tabId);
  return qrShow(tab, { kind: "url", content: { url: tab.url }, payload: tab.url }, mode);
}

// Makes the code (dynamic: the spoo.me or dub.sh link first), keeps it in the history and
// shows it in the page's card. Dynamic without a key for either, and pages the card can't go
// on: the QR page instead, filled in.
async function qrShow(tab, { kind, content, payload }, mode = "static") {
  const s = await TT.getSettings();
  if (mode === "dynamic" && kind !== "url") mode = "static"; // only links can be dynamic
  if (mode === "dynamic" && !qrDynService(s)) return openQrPage({ kind, content, mode, note: "link" });
  const canCard = /^(https?|file):/i.test(tab?.url || "");
  // Over 500: the QR page, with its count, to shorten it there.
  if (!canCard || new TextEncoder().encode(payload).length > 500) return openQrPage({ kind, content, mode });
  let entry = { mode, kind, content, payload };
  if (mode === "dynamic") {
    const { link } = await qrDynCreate(payload);
    entry = { ...entry, payload: link.short, link };
  }
  const icon = await qrIconFor(s);
  const made = await toOffscreen({ type: "qr", text: entry.payload, icon: icon.mode, own: icon.own, fit: icon.fit, clean: icon.clean }).then((r) => r.result);
  // A code that didn't read back in any style or icon size isn't offered as a working one:
  // the QR page shows it with its warning, to change it there (a dynamic code's link is
  // kept, it's already made).
  if (!made?.ok) {
    if (mode !== "dynamic") return openQrPage({ kind, content, mode });
    ({ entry } = await qrRecord({ ...entry, icon: icon.id || icon.mode, fit: icon.fit, clean: icon.clean }));
    await openQrPage({ id: entry.id });
    return { card: false, id: entry.id };
  }
  ({ entry } = await qrRecord({ ...entry, icon: icon.id || icon.mode, fit: icon.fit, clean: icon.clean }));
  const folder = TT.cleanFolder(s.shot.folder);
  const slug = (qrTitle(kind === "url" ? entry.content.url : entry.payload).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "code");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const base = `${folder ? `${folder}/` : ""}qr-${slug}-${stamp}`;
  const hosts = uploadHostsOn(s.upload), choices = TT.uploadChoices(s.upload);
  const msg = {
    type: "egShotCard", kind: "qr", qrId: entry.id,
    items: [{ name: `${base}.png`, dataUrl: made.png }],
    svg: { name: `${base}.svg`, dataUrl: `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(made.svg)))}` },
    label: mode === "dynamic" ? "Dynamic QR code" : "QR code",
    sub: mode === "dynamic" ? `${entry.link.short.replace(/^https?:\/\//, "")} → ${qrTitle(entry.link.url)}` : qrTitle(entry.payload),
    hosts, choices, host: choices.length === 1 ? choices[0] : null,
  };
  const shown = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shot-card.js"] })
    .then(() => chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }))
    .then((got) => got === true, () => false);
  if (!shown) await openQrPage({ id: entry.id });
  return { card: shown, id: entry.id };
}

// The QR page, brought to the front if it's open; open: what to show in it (handed over in
// storage.session, which the page watches).
async function openQrPage(open = null) {
  if (open) await chrome.storage.session.set({ qrOpen: { ...open, at: Date.now() } });
  const base = chrome.runtime.getURL("qr.html");
  const tab = (await chrome.tabs.query({})).find((t) => (t.url || t.pendingUrl || "").startsWith(base));
  if (!tab) {
    const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return void (await chrome.tabs.create({ url: base, ...(cur ? { index: cur.index + 1, windowId: cur.windowId } : {}) }));
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// Right-click: "QR code for this page", "… for this link", "… for the selected text"; once
// switched on (in the popup or on the QR page). Always static.
function qrMenuItems(s) {
  if (s.qr.menu !== true) return;
  chrome.contextMenus.create({ id: "qr:page", title: "QR code for this page", contexts: ["page"] });
  chrome.contextMenus.create({ id: "qr:link", title: "QR code for this link", contexts: ["link"] });
  chrome.contextMenus.create({ id: "qr:selection", title: "QR code for “%s”", contexts: ["selection"] });
}
async function onQrMenu(info, tab) {
  const what = String(info.menuItemId).slice(3);
  const run = (x) => qrShow(tab, x, "static").catch((err) => qrMenuFailed(tab, err));
  if (what === "selection") {
    const text = String(info.selectionText || "").trim();
    // A selected web address is a link; anything else, text.
    if (/^https?:\/\/\S+$/i.test(text)) return run({ kind: "url", content: { url: text }, payload: text });
    return run({ kind: "text", content: { text }, payload: text });
  }
  const url = what === "link" ? info.linkUrl : info.pageUrl || tab.url;
  return run({ kind: "url", content: { url }, payload: url });
}
function qrMenuFailed(tab, err) {
  chrome.notifications.create(`qr-fail-${Date.now()}`, {
    type: "basic", iconUrl: "icons/icon128.png", title: "Couldn't make the QR code", message: err.message || String(err),
  });
}

// This update moves "remove elements" from tab 1 to tab 2, below "what element?", in popup
// layouts saved before it (once; moving it back by hand stays). New layouts start that way.
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason !== "update") return;
  moveRemoveToPage().catch(() => {});
  qrIconsUpgrade().catch(() => {});
  qrLinksUpgrade().catch(() => {});
  // In 191 the right-click menu was on to start with; now it's off until switched on.
  if (previousVersion === "191") TT.updateSettings({ qr: { menu: false } }).catch(() => {});
});
async function moveRemoveToPage() {
  const { tt } = await chrome.storage.local.get("tt");
  if (!tt?.layout || tt.moved?.removeToPage) return;
  const layout = TT.layoutOf(tt.layout);
  if (layout.tools.includes("remove")) {
    layout.tools = layout.tools.filter((id) => id !== "remove");
    layout.page = layout.page.filter((id) => id !== "remove");
    const at = layout.page.indexOf("element");
    layout.page.splice(at === -1 ? layout.page.length : at + 1, 0, "remove");
  }
  await TT.updateSettings({ layout, moved: { ...(tt.moved || {}), removeToPage: true } });
}
