// Backup: snapshots of the bookmarks and of Tab Toolkit's settings and data, to Google
// Drive (on a schedule or on demand) and to a local file (settings and data only).
//
// Drive: the user creates an OAuth client in Google Cloud and pastes its client ID in
// settings ("backup": { clientId, interval }). Signing in uses the drive.file scope, so
// Tab Toolkit only ever sees the files it made itself. Access tokens last an hour; later
// ones are fetched silently, and settings ask to sign in again when Google wants that.
//
// Each snapshot is one gzipped JSON file in a "Tab Toolkit backups" folder, uploaded only
// when something changed. Old snapshots thin out like a time machine: the newest is kept,
// plus the oldest one in each age window (under a week, 1–2 weeks, 2 weeks–1 month, 1–2
// months, 2–6 months, 6–12 months, over a year), so there are never more than 8.
// Snapshots include API keys (shorteners, upload hosts), like the settings themselves.

// "backup" is the Drive setup (OAuth client ID, auto-sync interval); the sign-in itself isn't saved.
const BACKUP_KEYS = ["tt", "pii", "removed", "shortHistory", "shortCounts", "uploadHistory", "colorHistory", "selectorHistory", "fontHistory", "hl", "backup"];
const ADDED_LATER = new Set(["hl"]);
const BACKUP_FOLDER = "Tab Toolkit backups";
const BACKUP_ALARM = "tt-backup";
const BACKUP_INTERVALS = [0, 1, 2, 4, 6, 12, 24]; // hours; 0 = only when asked, 24 unless set
const DRIVE = "https://www.googleapis.com/drive/v3";
const DAY = 864e5;
const BACKUP_WINDOWS = [0, 7, 14, 30, 60, 180, 365, Infinity].map((d) => d * DAY);

const backupHandlers = {
  backupConnect: async () => {
    const { backup = {} } = await chrome.storage.local.get("backup");
    if (!backup.clientId?.trim()) throw new Error("Paste your OAuth client ID first");
    await driveToken(true);
    const about = await drive("/about?fields=user(emailAddress)");
    await setBackupState({ connected: true, email: about.user?.emailAddress || "", needsSignIn: false, lastError: "", folderId: "" });
    return runBackup();
  },
  backupDisconnect: async () => {
    const { driveToken: t } = await chrome.storage.session.get("driveToken");
    if (t?.token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.token)}`, { method: "POST" }).catch(() => {});
    await chrome.storage.session.remove("driveToken");
    await chrome.storage.local.set({ backupState: {} });
  },
  backupNow: () => runBackup(),
  backupList: async () => ({ snapshots: await listSnapshots() }),
  backupRestore: async ({ id, what }) => {
    const snap = await readSnapshot(id);
    if (what === "bookmarks") return { folder: await restoreBookmarks(snap) };
    await applyData(snap.data);
  },
  backupBookmarksHtml: async ({ id }) => {
    const snap = await readSnapshot(id);
    await saveFile(`bookmarks-${stamp(new Date(snap.createdAt))}.html`, "text/html", bookmarksHtml(snap.bookmarks));
  },
  backupDownload: async ({ id }) => {
    const snap = await readSnapshot(id);
    await saveFile(`tab-toolkit-${stamp(new Date(snap.createdAt))}.json`, "application/json", JSON.stringify(snap, null, 1));
  },
  // Local file: settings and data, no bookmarks (Chrome exports those itself).
  backupExportLocal: async () => {
    const snap = await buildSnapshot(false);
    await saveFile(`tab-toolkit-settings-${stamp(new Date())}.json`, "application/json", JSON.stringify(snap, null, 1));
  },
  backupImportLocal: async ({ snapshot }) => {
    if (snapshot?.app !== "Tab Toolkit" || !snapshot.data || typeof snapshot.data !== "object") throw new Error("That isn't a Tab Toolkit backup");
    await applyData(snapshot.data);
  },
};

// ---- State -----------------------------------------------------------------------------

async function setBackupState(patch) {
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  const next = { ...backupState, ...patch };
  await chrome.storage.local.set({ backupState: next });
  return next;
}

const stamp = (d) => d.toISOString().slice(0, 16).replace(/:/g, "-"); // 2026-10-02T09-00

// ---- Google sign-in --------------------------------------------------------------------

// An access token, from this session's cache or a new sign-in. Without "interactive" it
// never shows a window: Google answers at once when the user is still signed in and
// has agreed before.
async function driveToken(interactive = false) {
  const { driveToken: cached } = await chrome.storage.session.get("driveToken");
  if (!interactive && cached?.token && cached.exp > Date.now() + 60e3) return cached.token;
  const { backup = {}, backupState = {} } = await chrome.storage.local.get(["backup", "backupState"]);
  const clientId = backup.clientId?.trim();
  if (!clientId) throw new Error("No OAuth client ID set");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: "https://www.googleapis.com/auth/drive.file",
    prompt: interactive ? "consent select_account" : "none",
    ...(!interactive && backupState.email ? { login_hint: backupState.email } : {}),
  });
  let back;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch (err) {
    if (!interactive) await setBackupState({ needsSignIn: true });
    throw new Error(interactive ? `Sign-in didn't finish: ${err.message}` : "Sign in to Google Drive again");
  }
  const got = new URLSearchParams(new URL(back).hash.slice(1));
  const token = got.get("access_token");
  if (!token) {
    if (!interactive) await setBackupState({ needsSignIn: true });
    throw new Error(got.get("error") === "access_denied" ? "Drive access wasn't allowed" : "Sign in to Google Drive again");
  }
  await chrome.storage.session.set({ driveToken: { token, exp: Date.now() + (Number(got.get("expires_in")) || 3600) * 1000 } });
  return token;
}

// Drive API call; JSON back unless raw. One silent retry with a new token on 401.
async function drive(path, { method = "GET", body, headers = {}, raw = false, base = DRIVE } = {}, retried = false) {
  const token = await driveToken();
  const res = await fetch(base + path, { method, body, headers: { ...headers, authorization: `Bearer ${token}` } });
  if (res.status === 401 && !retried) {
    await chrome.storage.session.remove("driveToken");
    return drive(path, { method, body, headers, raw, base }, true);
  }
  if (!res.ok) {
    let msg = `Drive error ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

// One lookup at a time, so a listing and a sync starting together can't make two folders.
let folderLookup = null;
const backupFolder = () => (folderLookup ??= findBackupFolder().finally(() => (folderLookup = null)));

async function findBackupFolder() {
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  if (backupState.folderId) {
    const f = await drive(`/files/${backupState.folderId}?fields=id,trashed`).catch(() => null);
    if (f && !f.trashed) return f.id;
  }
  const q = `name='${BACKUP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await drive(`/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
  const id = found.files?.[0]?.id || (await drive("/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: BACKUP_FOLDER, mimeType: "application/vnd.google-apps.folder" }),
  })).id;
  await setBackupState({ folderId: id });
  return id;
}

// ---- Snapshots -------------------------------------------------------------------------

function trimBookmarks(node) {
  const out = { title: node.title };
  if (node.url) out.url = node.url;
  if (node.dateAdded) out.dateAdded = node.dateAdded;
  if (node.children) out.children = node.children.map(trimBookmarks);
  return out;
}

async function buildSnapshot(withBookmarks = true) {
  const data = await chrome.storage.local.get(BACKUP_KEYS);
  const snap = { app: "Tab Toolkit", format: 1, version: chrome.runtime.getManifest().version, createdAt: new Date().toISOString(), data };
  if (withBookmarks) snap.bookmarks = (await chrome.bookmarks.getTree())[0].children.map(trimBookmarks);
  return snap;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const gzip = (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
const gunzip = (blob) => new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();

async function listSnapshots() {
  const folder = await backupFolder();
  const q = `'${folder}' in parents and trashed=false`;
  const res = await drive(`/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime,appProperties)&pageSize=1000&spaces=drive`);
  return (res.files || [])
    .map((f) => ({ id: f.id, name: f.name, size: Number(f.size) || 0, at: Number(f.appProperties?.at) || Date.parse(f.createdTime) }))
    .sort((a, b) => b.at - a.at);
}

// Which snapshots to keep: the newest, and the oldest in each age window.
function snapshotsToKeep(snaps, now = Date.now()) {
  const keep = new Set(snaps.length ? [snaps.reduce((a, b) => (b.at > a.at ? b : a)).id] : []);
  for (let i = 0; i < BACKUP_WINDOWS.length - 1; i++) {
    const inWindow = snaps.filter((s) => now - s.at >= BACKUP_WINDOWS[i] && now - s.at < BACKUP_WINDOWS[i + 1]);
    if (inWindow.length) keep.add(inWindow.reduce((a, b) => (b.at < a.at ? b : a)).id);
  }
  return keep;
}

async function readSnapshot(id) {
  const res = await drive(`/files/${id}?alt=media`, { raw: true });
  const blob = await res.blob();
  // Drive may hand the file back already unpacked.
  const text = new Uint8Array(await blob.slice(0, 2).arrayBuffer())[0] === 0x1f ? await gunzip(blob) : await blob.text();
  return JSON.parse(text);
}

let backupRun = null;
function runBackup() {
  backupRun ??= doBackup().finally(() => (backupRun = null));
  return backupRun;
}

async function doBackup() {
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  if (!backupState.connected) throw new Error("Connect Google Drive first");
  try {
    const snap = await buildSnapshot();
    const hash = await sha256(JSON.stringify([snap.data, snap.bookmarks]));
    const folder = await backupFolder();
    let uploaded = false;
    if (hash !== backupState.lastHash || !(await listSnapshots()).length) {
      const at = Date.now();
      const meta = { name: `tab-toolkit-${stamp(new Date(at))}.json.gz`, parents: [folder], mimeType: "application/gzip", appProperties: { at: String(at), tt: "1" } };
      const b = `tt${crypto.randomUUID()}`;
      const body = new Blob([
        `--${b}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\ncontent-type: application/gzip\r\n\r\n`,
        await gzip(JSON.stringify(snap)),
        `\r\n--${b}--`,
      ]);
      await drive("/files?uploadType=multipart&fields=id", { method: "POST", body, headers: { "content-type": `multipart/related; boundary=${b}` }, base: "https://www.googleapis.com/upload/drive/v3" });
      uploaded = true;
      await setBackupState({ lastHash: hash, lastSnapshot: at });
    }
    const snaps = await listSnapshots();
    const keep = snapshotsToKeep(snaps);
    for (const s of snaps) if (!keep.has(s.id)) await drive(`/files/${s.id}`, { method: "DELETE" }).catch(() => {});
    await setBackupState({ lastCheck: Date.now(), lastError: "", needsSignIn: false });
    return { uploaded };
  } catch (err) {
    await setBackupState({ lastError: err.message, lastCheck: Date.now() });
    throw err;
  }
}

// ---- Restore ---------------------------------------------------------------------------

// Settings and data are replaced by the snapshot's. The Drive setup is only taken when the
// file has one (older ones don't); a different client ID means signing in again.
async function applyData(data) {
  const set = {}, remove = [];
  for (const k of BACKUP_KEYS) {
    if (k === "backup") continue;
    if (data[k] !== undefined) set[k] = data[k];
    else if (!ADDED_LATER.has(k)) remove.push(k); // older snapshots don't have these: keep what's there
  }
  const { backup = {}, backupState = {} } = await chrome.storage.local.get(["backup", "backupState"]);
  const from = data.backup;
  if (from && typeof from === "object") {
    set.backup = { ...backup, ...(typeof from.clientId === "string" ? { clientId: from.clientId.trim() } : {}), ...(from.interval !== undefined ? { interval: Number(from.interval) } : {}) };
    if (backupState.connected && (set.backup.clientId || "") !== (backup.clientId || "")) {
      await chrome.storage.session.remove("driveToken");
      set.backupState = { ...backupState, needsSignIn: true };
    }
  }
  if (remove.length) await chrome.storage.local.remove(remove);
  await chrome.storage.local.set(set);
}

// Bookmarks come back next to the current ones, in a new folder under "Other bookmarks".
async function restoreBookmarks(snap) {
  if (!Array.isArray(snap.bookmarks)) throw new Error("This snapshot has no bookmarks");
  const roots = (await chrome.bookmarks.getTree())[0].children;
  const other = roots.find((n) => n.id === "2") || roots[1] || roots[0];
  const title = `Restored ${new Date(snap.createdAt).toISOString().slice(0, 10)}`;
  const top = await chrome.bookmarks.create({ parentId: other.id, title });
  const add = async (node, parentId) => {
    try {
      if (node.url) return void (await chrome.bookmarks.create({ parentId, title: node.title, url: node.url }));
      const folder = await chrome.bookmarks.create({ parentId, title: node.title });
      for (const child of node.children || []) await add(child, folder.id);
    } catch {} // a URL Chrome won't take as a bookmark; skip it
  };
  for (const root of snap.bookmarks) if (root.children?.length) await add(root, top.id);
  return title;
}

// The bookmarks as the usual bookmarks.html, which every browser can import.
function bookmarksHtml(roots = []) {
  const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const date = (n) => (n.dateAdded ? ` ADD_DATE="${Math.floor(n.dateAdded / 1000)}"` : "");
  const lines = ["<!DOCTYPE NETSCAPE-Bookmark-file-1>", '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>"];
  const walk = (node, depth, bar = false) => {
    const pad = "    ".repeat(depth);
    if (node.url) return void lines.push(`${pad}<DT><A HREF="${esc(node.url)}"${date(node)}>${esc(node.title)}</A>`);
    lines.push(`${pad}<DT><H3${date(node)}${bar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ""}>${esc(node.title)}</H3>`, `${pad}<DL><p>`);
    for (const c of node.children || []) walk(c, depth + 1);
    lines.push(`${pad}</DL><p>`);
  };
  roots.forEach((r, i) => walk(r, 1, i === 0));
  lines.push("</DL><p>");
  return lines.join("\n");
}

async function saveFile(filename, type, text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await chrome.downloads.download({ url: `data:${type};base64,${btoa(bin)}`, filename, saveAs: true });
}

// ---- Schedule --------------------------------------------------------------------------

async function syncBackupAlarm() {
  const { backup = {}, backupState = {} } = await chrome.storage.local.get(["backup", "backupState"]);
  const hours = BACKUP_INTERVALS.includes(Number(backup.interval ?? 24)) ? Number(backup.interval ?? 24) : 24;
  const have = await chrome.alarms.get(BACKUP_ALARM);
  if (!hours || !backupState.connected) return void (have && chrome.alarms.clear(BACKUP_ALARM));
  if (have?.periodInMinutes === hours * 60) return;
  const due = (backupState.lastCheck || Date.now()) + hours * 3600e3;
  chrome.alarms.create(BACKUP_ALARM, { when: Math.max(Date.now() + 60e3, due), periodInMinutes: hours * 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => alarm.name === BACKUP_ALARM && runBackup().catch(() => {}));
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  const connected = (v) => !!v?.connected;
  if (c.backup || (c.backupState && connected(c.backupState.oldValue) !== connected(c.backupState.newValue))) syncBackupAlarm();
});
chrome.runtime.onInstalled.addListener(syncBackupAlarm);
chrome.runtime.onStartup.addListener(syncBackupAlarm);
