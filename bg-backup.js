// Backup: snapshots of the bookmarks and of Extra Guac's settings and data, to Google
// Drive (on a schedule or on demand) and to a local file (settings and data only).
//
// Drive: signing in uses Extra Guac's own OAuth client (DRIVE_CLIENT_ID; its redirect
// addresses are the Web Store copy's and the developer's unpacked copy's). It uses the
// drive.file scope, so
// Extra Guac only ever sees the files it made itself. Access tokens last an hour; later
// ones are fetched silently, and settings ask to sign in again when Google wants that.
//
// Each snapshot is one gzipped JSON file in an "Extra Guac backups" folder, uploaded only
// when something changed. Old snapshots thin out like a time machine. Kept are:
//   - the 3 newest;
//   - the newest from each browser (device) that backed up in the last 90 days, so one
//     browser's backups never push out another's latest;
//   - protected ones (keepUntil): the copy taken before every restore/import, and the
//     previous snapshot whenever a new one is less than half its size — for 30 days;
//   - the oldest one in each age window (under a week, 1–2 weeks, 2 weeks–1 month, 1–2
//     months, 2–6 months, 6–12 months, over a year).
// Connecting a browser whose Drive folder already has snapshots from elsewhere doesn't
// back up straight away (that would make a fresh, empty install the "newest"): it waits
// until the user restores one or presses sync now.
// Snapshots include API keys (shorteners, upload hosts), like the settings themselves.
// Scratch pads and the screenshot history are in them too. Their images go up once each,
// as files of their own in folders inside the backup folder ("pad images", "screenshots");
// snapshots only name the ones they use, and a file goes when no kept snapshot names it
// any more.

// "backup" is the Drive setup (auto-sync interval); the sign-in itself isn't saved.
const BACKUP_KEYS = ["tt", "pii", "removed", "shortHistory", "shortCounts", "uploadHistory", "colorHistory", "selectorHistory", "fontHistory", "hl", "proxy", ...PADS.PAD_KEYS, "shotHistory", "qrHistory", "qrIcons", "myColors", "backup"];
const BACKUP_FOLDER = "Extra Guac backups";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const BACKUP_ALARM = "tt-backup";
const BACKUP_INTERVALS = [0, 1, 2, 4, 6, 12, 24]; // hours; 0 = only when asked, 24 unless set
const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_CLIENT_ID = "486999495710-35v1150u6s7hevvigeo3s3j95mp30sno.apps.googleusercontent.com";
const DAY = 864e5;
const BACKUP_WINDOWS = [0, 7, 14, 30, 60, 180, 365, Infinity].map((d) => d * DAY);
const KEEP_RECENT = 3;
const DEVICE_KEEP = 90 * DAY; // a browser's newest snapshot is kept while it's younger than this
const PROTECT_FOR = 30 * DAY; // pre-restore copies and big-before-shrink snapshots
const SHRINK_RATIO = 0.5;

const backupHandlers = {
  backupConnect: async () => {
    const { backupState: before = {} } = await chrome.storage.local.get("backupState");
    await driveToken(true);
    const about = await drive("/about?fields=user(emailAddress)");
    await setBackupState({ connected: true, email: about.user?.emailAddress || "", needsSignIn: false, lastError: "", folderId: "" });
    // A browser that has never backed up here, connecting to a folder that already has
    // other snapshots, is most likely a reinstall or a new computer still waiting to be
    // restored. Backing it up now would make its fresh settings the newest snapshot.
    // Unless its settings were already brought in on purpose (a settings file imported or
    // a snapshot restored before connecting), or the folder already has snapshots from
    // this very browser (it was disconnected and is connecting again): then it carries on.
    if (!before.lastHash && !before.chosenAt) {
      const device = await deviceId();
      const snaps = await listSnapshots();
      const others = snaps.filter((s) => s.device !== device);
      if (others.length && !snaps.some((s) => s.device === device)) {
        await setBackupState({ awaitingChoice: true, lastCheck: Date.now() });
        return { uploaded: false, awaitingChoice: true };
      }
    }
    return runBackup({ manual: true });
  },
  backupDisconnect: async () => {
    const { driveToken: t } = await chrome.storage.session.get("driveToken");
    if (t?.token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.token)}`, { method: "POST" }).catch(() => {});
    await chrome.storage.session.remove("driveToken");
    await chrome.storage.local.remove("driveNoticeHidden");
    // Forget the connection, but not that this browser's settings were chosen on purpose.
    const { backupState: st = {} } = await chrome.storage.local.get("backupState");
    await chrome.storage.local.set({ backupState: st.chosenAt ? { chosenAt: st.chosenAt } : {} });
  },
  backupNow: () => runBackup({ manual: true }),
  backupList: async () => ({ snapshots: await listSnapshots() }),
  backupRestore: async ({ id, what }) => {
    const snap = await readSnapshot(id);
    if (what === "bookmarks") return { folder: await restoreBookmarks(snap) };
    assertHasData(snap.data);
    return locked(async () => {
      const saved = await savePreRestore();
      await keepPadsBefore(snap.data);
      const applied = await applyData(snap.data);
      await setBackupState({ awaitingChoice: false, chosenAt: Date.now() });
      await fetchAttachments(snap.data).catch(() => {});
      await tidyShots().catch(() => {});
      return { ...saved, profiles: applied?.profiles };
    });
  },
  backupBookmarksHtml: async ({ id }) => {
    const snap = await readSnapshot(id);
    await saveFile(`bookmarks-${stamp(new Date(snap.createdAt))}.html`, "text/html", bookmarksHtml(snap.bookmarks));
  },
  backupDownload: async ({ id }) => {
    const snap = await readSnapshot(id);
    await saveFile(`extra-guac-${stamp(new Date(snap.createdAt))}.json`, "application/json", JSON.stringify(snap, null, 1));
  },
  // Local file: settings and data, no bookmarks (Chrome exports those itself).
  backupExportLocal: async () => {
    const snap = await buildSnapshot(false);
    await saveFile(`extra-guac-settings-${stamp(new Date())}.json`, "application/json", JSON.stringify(snap, null, 1));
  },
  backupImportLocal: async ({ snapshot }) => {
    if (snapshot?.app !== "Extra Guac" || !snapshot.data || typeof snapshot.data !== "object") throw new Error("That isn't an Extra Guac backup");
    assertHasData(snapshot.data);
    return locked(async () => {
      const saved = await savePreRestore();
      await keepPadsBefore(snapshot.data);
      await applyData(snapshot.data);
      await tidyShots().catch(() => {});
      await setBackupState({ awaitingChoice: false, chosenAt: Date.now() }); // counts as a choice, see backupConnect
      return saved;
    });
  },
  // Puts back what was there before the last restore/import (and keeps what's there now
  // as the new "before", so pressing it twice flips back).
  backupUndoRestore: () => locked(async () => {
    const { preRestore } = await chrome.storage.local.get("preRestore");
    if (!preRestore?.data) throw new Error("Nothing to undo");
    const now = await buildSnapshot(false);
    await keepPadsBefore(preRestore.data);
    await applyData(preRestore.data);
    await tidyShots().catch(() => {});
    await chrome.storage.local.set({ preRestore: { at: Date.now(), data: now.data } });
    return { from: preRestore.at };
  }),
};

// ---- State -----------------------------------------------------------------------------

async function setBackupState(patch) {
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  const next = { ...backupState, ...patch };
  await chrome.storage.local.set({ backupState: next });
  return next;
}

const stamp = (d) => d.toISOString().slice(0, 19).replace(/:/g, "-"); // 2026-10-02T09-00-00

// A random id for this browser profile, stored with each snapshot it uploads. Not part of
// the backed-up data, so a restored browser keeps its own id. A reinstall gets a new one.
async function deviceId() {
  const { backupDevice } = await chrome.storage.local.get("backupDevice");
  if (backupDevice) return backupDevice;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ backupDevice: id });
  return id;
}

// Backups, restores and imports one at a time, so a scheduled backup can't read the
// settings halfway through a restore.
let backupLock = Promise.resolve();
function locked(fn) {
  const run = backupLock.then(fn);
  backupLock = run.catch(() => {});
  return run;
}

// ---- Google sign-in --------------------------------------------------------------------

// An access token, from this session's cache or a new sign-in. Without "interactive" it
// never shows a window: Google answers at once when the user is still signed in and
// has agreed before.
async function driveToken(interactive = false) {
  const { driveToken: cached } = await chrome.storage.session.get("driveToken");
  if (!interactive && cached?.token && cached.exp > Date.now() + 60e3) return cached.token;
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: DRIVE_CLIENT_ID,
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
  await chrome.storage.local.remove("driveNoticeHidden"); // a notice hidden with × shows again next time
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
  const q = `name='${BACKUP_FOLDER}' and mimeType='${FOLDER_TYPE}' and trashed=false`;
  const found = await drive(`/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
  const id = found.files?.[0]?.id || (await drive("/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: BACKUP_FOLDER, mimeType: FOLDER_TYPE }),
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

// With profiles, Session Switch's saved logins come along, sealed, when turned on (ssProfiles,
// see bg-sessions.js): only in the snapshots uploaded to Drive.
async function buildSnapshot(withBookmarks = true, { profiles = false } = {}) {
  const data = withoutWriters(await chrome.storage.local.get(BACKUP_KEYS));
  data.clips = await clipExport(); // clipboard history: one key per entry (bg-clip.js)
  if (profiles) {
    const sealed = await sessionDriveSeal().catch((err) => console.error("[backup] profiles", err));
    if (sealed) data.ssProfiles = sealed;
  }
  const snap = { app: "Extra Guac", format: 1, version: chrome.runtime.getManifest().version, createdAt: new Date().toISOString(), data };
  if (withBookmarks) snap.bookmarks = (await chrome.bookmarks.getTree())[0].children.map(trimBookmarks);
  return snap;
}

// A pad remembers which pad tab saved it last (so that tab can skip its own saves coming
// back); a snapshot is no tab's save, so that's left out going in and coming out.
function withoutWriters(data) {
  for (const k of PADS.PAD_KEYS) {
    if (data[k] && typeof data[k] === "object" && "writer" in data[k]) {
      const { writer, ...rec } = data[k];
      data[k] = rec;
    }
  }
  return data;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const gzip = (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
const gunzip = (blob) => new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();

async function listSnapshots() {
  const folder = await backupFolder();
  const q = `'${folder}' in parents and trashed=false and mimeType!='${FOLDER_TYPE}'`;
  const res = await drive(`/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime,appProperties)&pageSize=1000&spaces=drive`);
  return (res.files || [])
    .map((f) => ({
      id: f.id,
      name: f.name,
      size: Number(f.size) || 0,
      at: Number(f.appProperties?.at) || Date.parse(f.createdTime),
      device: f.appProperties?.device || "", // "" = made before devices were recorded
      kind: f.appProperties?.kind || "auto",
      keepUntil: Number(f.appProperties?.keepUntil) || 0,
      hash: f.appProperties?.hash || "", // what's in it (older snapshots don't say)
    }))
    .sort((a, b) => b.at - a.at);
}

// Which snapshots to keep — see the comment at the top of this file.
function snapshotsToKeep(snaps, now = Date.now()) {
  const newestFirst = [...snaps].sort((a, b) => b.at - a.at);
  const keep = new Set(newestFirst.slice(0, KEEP_RECENT).map((s) => s.id));
  const devices = new Set();
  for (const s of newestFirst) {
    if (devices.has(s.device)) continue;
    devices.add(s.device);
    if (now - s.at < DEVICE_KEEP) keep.add(s.id);
  }
  for (const s of snaps) if (s.keepUntil > now) keep.add(s.id);
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
// Scheduled runs share one in-flight backup; "sync now" (manual) always runs its own.
function runBackup({ manual = false } = {}) {
  if (manual) return locked(() => doBackup({ manual: true }));
  backupRun ??= locked(() => doBackup()).finally(() => (backupRun = null));
  return backupRun;
}

// Uploads one snapshot; returns its size in Drive.
async function uploadSnapshot(snap, props = {}) {
  await syncAttachments(snap.data);
  const folder = await backupFolder();
  const at = Date.parse(snap.createdAt) || Date.now();
  const prefix = props.kind === "pre-restore" ? "extra-guac-before-restore" : "extra-guac";
  const meta = {
    name: `${prefix}-${stamp(new Date(at))}.json.gz`,
    parents: [folder],
    mimeType: "application/gzip",
    appProperties: { at: String(at), tt: "1", device: await deviceId(), ...props },
  };
  const b = `tt${crypto.randomUUID()}`;
  const gz = await gzip(JSON.stringify(snap));
  const body = new Blob([
    `--${b}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\ncontent-type: application/gzip\r\n\r\n`,
    gz,
    `\r\n--${b}--`,
  ]);
  await drive("/files?uploadType=multipart&fields=id", { method: "POST", body, headers: { "content-type": `multipart/related; boundary=${b}` }, base: "https://www.googleapis.com/upload/drive/v3" });
  return { at, size: gz.size };
}

const protectSnapshot = (id, until) =>
  drive(`/files/${id}?fields=id`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appProperties: { keepUntil: String(until) } }),
  });

async function doBackup({ manual = false } = {}) {
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  if (!backupState.connected) throw new Error("Connect Google Drive first");
  // Waiting for the user to restore or confirm after connecting (see backupConnect):
  // scheduled runs leave Drive alone; "sync now" means "back this browser up".
  if (backupState.awaitingChoice && !manual) return { uploaded: false, awaitingChoice: true };
  try {
    const snap = await buildSnapshot(true, { profiles: true });
    const hash = await sha256(JSON.stringify([snap.data, snap.bookmarks]));
    let snaps = await listSnapshots();
    let uploaded = false;
    // Unchanged = the same as this browser's newest snapshot in Drive (so disconnecting and
    // connecting again, even to another account, saves nothing new unless something
    // changed). Snapshots from before the content was recorded fall back on the last
    // upload remembered here.
    const device = await deviceId();
    const mine = snaps.filter((s) => s.device === device && s.kind !== "pre-restore").sort((a, b) => b.at - a.at)[0];
    const lastHash = mine?.hash || (mine ? backupState.lastHash : "");
    if (hash !== lastHash) {
      // Compare with this browser's own previous snapshot (another browser's can be any size).
      const before = snaps.find((s) => s.device === device) || snaps.find((s) => !s.device);
      const { at, size } = await uploadSnapshot(snap, { hash });
      uploaded = true;
      // Much smaller than the snapshot before it: probably data went missing. Keep the
      // bigger one around for a month whatever the age windows say.
      if (before && before.size && size < before.size * SHRINK_RATIO) {
        await protectSnapshot(before.id, Date.now() + PROTECT_FOR).catch(() => {});
      }
      await setBackupState({ lastHash: hash, lastSnapshot: at, awaitingChoice: false });
      snaps = await listSnapshots();
    } else if (backupState.awaitingChoice) {
      await setBackupState({ awaitingChoice: false });
    }
    const keep = snapshotsToKeep(snaps);
    let deleted = 0;
    for (const s of snaps) if (!keep.has(s.id)) await drive(`/files/${s.id}`, { method: "DELETE" }).then(() => deleted++, () => {});
    if (deleted) await pruneAttachments(snaps.filter((s) => keep.has(s.id))).catch(() => {});
    await setBackupState({ lastCheck: Date.now(), lastError: "", needsSignIn: false });
    return { uploaded };
  } catch (err) {
    await setBackupState({ lastError: err.message, lastCheck: Date.now() });
    throw err;
  }
}

// ---- Restore ---------------------------------------------------------------------------

// A backup whose settings and data are all missing or empty (e.g. an export from a fresh
// install) would wipe everything; refuse it.
function assertHasData(data) {
  const filled = (v) =>
    v !== undefined && v !== null && v !== "" &&
    !(Array.isArray(v) && v.length === 0) &&
    !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  if (!data || typeof data !== "object" || !BACKUP_KEYS.some((k) => k !== "backup" && filled(data[k]))) {
    throw new Error("That backup has no settings or data in it, so nothing was changed");
  }
}

// Before a restore or import: keep what's there now, locally (for "undo") and, when Drive
// is connected, as a snapshot protected from clean-up for 30 days.
async function savePreRestore() {
  const snap = await buildSnapshot();
  await chrome.storage.local.set({ preRestore: { at: Date.now(), data: snap.data } });
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  if (!backupState.connected || backupState.needsSignIn) return { preRestore: "local" };
  try {
    await uploadSnapshot(snap, { kind: "pre-restore", keepUntil: String(Date.now() + PROTECT_FOR) });
    return { preRestore: "drive" };
  } catch {
    return { preRestore: "local" };
  }
}

// Settings and data are replaced by the snapshot's. The Drive setup is only taken when the
// file has one (older ones don't); a different client ID means signing in again.
// In turn with settings changes (TT.settingsTask), so one queued just before can't write
// its older settings over the restored ones.
// Then what older backups need brought up to date, once the restore is in (outside the
// settings queue, which these use themselves).
const applyData = (data) => TT.settingsTask(() => applyDataNow(data)).then(async (r) => {
  await qrIconsUpgrade().catch(() => {});
  await shortenerUpgrade().catch(() => {});
  await qrLinksUpgrade().catch(() => {});
  return r;
});
async function applyDataNow(data) {
  data = withoutWriters({ ...data });
  const set = {}, remove = [];
  const hasPads = PADS.PAD_KEYS.some((k) => data[k] !== undefined);
  for (const k of BACKUP_KEYS) {
    if (k === "backup") continue;
    if (!hasPads && PADS.PAD_KEYS.includes(k)) continue; // older backups have no pads: keep them
    // nor a screenshot history, QR codes, My colors or the proxy (backed up since later versions)
    if (["shotHistory", "qrHistory", "qrIcons", "myColors", "proxy"].includes(k) && data[k] === undefined) continue;
    if (data[k] !== undefined) set[k] = data[k];
    else remove.push(k);
  }
  const { backup = {} } = await chrome.storage.local.get("backup");
  const from = data.backup;
  if (from && typeof from === "object" && from.interval !== undefined) set.backup = { ...backup, interval: Number(from.interval) };
  // The snapshot's data first; only once it's all in are the keys it doesn't have removed,
  // so a write that fails leaves the current data as it was. In turn with history edits
  // (editLocal), so an upload finishing meanwhile can't write the old list back over it.
  await editLocal([], async () => {
    await chrome.storage.local.set(set);
    if (remove.length) await chrome.storage.local.remove(remove);
  });
  if (Array.isArray(data.clips)) await clipImport(data.clips); // older backups have none: keep what's there
  // Saved logins sealed in the snapshot: added next to the ones here, now if this browser has
  // their key, else once their passphrase is given in settings (bg-sessions.js).
  if (data.ssProfiles) return { profiles: await sessionDriveRestore(data.ssProfiles).catch((err) => console.error("[backup] profiles", err)) };
  // Backups from 191 have a single QR icon ("qrIcon"): it becomes the first of yours.
  if (typeof data.qrIcon === "string" && data.qrIcons === undefined) await chrome.storage.local.set({ qrIcon: data.qrIcon });
}

// Bookmarks come back next to the current ones, in a new folder under "Other bookmarks".
async function restoreBookmarks(snap) {
  if (!Array.isArray(snap.bookmarks)) throw new Error("This snapshot has no bookmarks");
  const roots = (await chrome.bookmarks.getTree())[0].children;
  const other = roots.find((n) => n.id === "2") || roots[1] || roots[0];
  const title = `Restored ${TT.when(snap.createdAt)}`;
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

// ---- Files kept beside the snapshots: scratch pad images and the screenshot history ----
// Each kind has a folder inside the backup folder. A file's name starts with the id the
// snapshot uses for it (32 hex characters), then "." or "-" (a screenshot can have parts).
const ATTACHMENTS = [
  {
    folder: "pad images",
    stateKey: "padImagesFolderId",
    ids: (data = {}) => new Set(PADS.PAD_KEYS.flatMap((k) => [...PADS.padRefs(data[k])])),
    async files(id) {
      const rec = await PADS.imgGet(id).catch(() => null);
      return rec?.blob ? [{ name: `${id}.${PADS.imgExt(rec.type)}`, blob: rec.blob, type: rec.type }] : null;
    },
    has: async (id) => !!(await PADS.imgGet(id).catch(() => null)),
    restore: (id, [f]) => PADS.imgPut({ id, blob: f.blob, type: f.type, size: f.blob.size, at: Date.now() }),
  },
  {
    folder: "screenshots",
    stateKey: "shotsFolderId",
    ids: (data = {}) => new Set((Array.isArray(data.shotHistory) ? data.shotHistory : []).map((s) => s.id).filter((id) => PADS.IMG_ID.test(id || ""))),
    async files(id) {
      const rec = await SHOTS.get(id).catch(() => null);
      return rec ? rec.items.map((it, i) => ({ name: `${id}-${i}.${SHOTS.ext(it.blob.type)}`, blob: it.blob, type: it.blob.type || "image/png" })) : null;
    },
    has: async (id) => !!(await SHOTS.get(id).catch(() => null)),
    async restore(id, files, data) {
      const meta = data.shotHistory.find((s) => s.id === id);
      files = [...new Map(files.map((f) => [f.index, f])).values()];
      if (files.length < (meta?.parts || 1)) throw new Error("parts missing on Drive"); // left out, not restored half
      const parts = files.sort((a, b) => a.index - b.index).map((f, i) => ({ name: meta?.names?.[i] || meta?.name || f.name, blob: f.blob }));
      const { thumb } = await SHOTS.thumbOf(parts[0].blob);
      await SHOTS.put({ id, items: parts, thumb });
    },
  },
];

async function attachmentFolder(kind, create) {
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  const known = backupState[kind.stateKey];
  if (known) {
    const f = await drive(`/files/${known}?fields=id,trashed`).catch(() => null);
    if (f && !f.trashed) return f.id;
  }
  const parent = await backupFolder();
  const q = `name='${kind.folder}' and '${parent}' in parents and mimeType='${FOLDER_TYPE}' and trashed=false`;
  let id = (await drive(`/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`)).files?.[0]?.id;
  if (!id && !create) return "";
  id ||= (await drive("/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: kind.folder, mimeType: FOLDER_TYPE, parents: [parent] }),
  })).id;
  await setBackupState({ [kind.stateKey]: id });
  return id;
}

// id -> [{ fileId, name, index, mimeType, created }]
async function listAttachments(folder) {
  const out = new Map();
  let page = "";
  do {
    const q = `'${folder}' in parents and trashed=false`;
    const res = await drive(`/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,createdTime)&pageSize=1000&spaces=drive${page ? `&pageToken=${page}` : ""}`);
    for (const f of res.files || []) {
      const m = /^([0-9a-f]{32})(?:-(\d+))?\./.exec(f.name);
      if (!m) continue;
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push({ fileId: f.id, name: f.name, index: Number(m[2] || 0), mimeType: f.mimeType, created: Date.parse(f.createdTime) || 0 });
    }
    page = res.nextPageToken || "";
  } while (page);
  return out;
}

async function uploadAttachment(folder, { name, blob, type }) {
  const meta = { name, parents: [folder], mimeType: type, appProperties: { attachment: "1" } };
  const b = `tt${crypto.randomUUID()}`;
  const body = new Blob([
    `--${b}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\ncontent-type: ${type}\r\n\r\n`,
    blob,
    `\r\n--${b}--`,
  ]);
  await drive("/files?uploadType=multipart&fields=id", { method: "POST", body, headers: { "content-type": `multipart/related; boundary=${b}` }, base: "https://www.googleapis.com/upload/drive/v3" });
}

// Before a snapshot goes up: only the files Drive doesn't have yet.
async function syncAttachments(data) {
  for (const kind of ATTACHMENTS) {
    const ids = kind.ids(data);
    if (!ids.size) continue;
    const folder = await attachmentFolder(kind, true);
    const have = await listAttachments(folder);
    for (const id of ids) {
      // Every file of it, so a shot whose parts stopped half-way up gets the rest next time.
      const files = await kind.files(id);
      if (!files) continue; // not on this computer (it came from another browser)
      const up = new Set((have.get(id) || []).map((f) => f.name));
      for (const f of files) if (!up.has(f.name)) await uploadAttachment(folder, f);
    }
  }
}

// After old snapshots were deleted: files none of the kept ones use go too (only ones over
// a day old, so another browser's upload in progress is safe). Any snapshot that can't be
// read stops the clean-up, so nothing still in use is deleted.
async function pruneAttachments(kept) {
  const datas = [];
  for (const s of kept) datas.push((await readSnapshot(s.id)).data || {});
  for (const kind of ATTACHMENTS) {
    const folder = await attachmentFolder(kind, false);
    if (!folder) continue;
    const have = await listAttachments(folder);
    if (!have.size) continue;
    const used = new Set(datas.flatMap((d) => [...kind.ids(d)]));
    for (const [id, files] of have) {
      if (used.has(id)) continue;
      for (const f of files) if (Date.now() - f.created > DAY) await drive(`/files/${f.fileId}`, { method: "DELETE" }).catch(() => {});
    }
  }
}

// After a restore: the files the restored data uses that aren't on this computer.
async function fetchAttachments(data) {
  for (const kind of ATTACHMENTS) {
    const missing = [];
    for (const id of kind.ids(data)) if (!(await kind.has(id))) missing.push(id);
    if (!missing.length) continue;
    const folder = await attachmentFolder(kind, false);
    if (!folder) continue;
    const have = await listAttachments(folder);
    for (const id of missing) {
      const found = have.get(id);
      if (!found) continue;
      const files = [];
      for (const f of found) {
        const blob = await (await drive(`/files/${f.fileId}?alt=media`, { raw: true })).blob();
        files.push({ ...f, blob, type: f.mimeType || blob.type });
      }
      await kind.restore(id, files, data).catch(() => {});
    }
  }
}

// A restore or import replaces the pads; each one it changes keeps what it held for the
// pad page's "Restore previous" (on this computer only).
async function keepPadsBefore(data) {
  if (!PADS.PAD_KEYS.some((k) => data[k] !== undefined)) return; // older backups leave pads alone
  const now = await chrome.storage.local.get(PADS.PAD_KEYS);
  const set = {};
  PADS.PAD_KEYS.forEach((k, i) => {
    const pad = now[k];
    if (PADS.padEmpty(pad) || PADS.sameContent(pad, data[k])) return;
    const { writer, ...rec } = pad;
    set[PADS.prevKey(i + 1)] = { ...rec, savedAt: Date.now() };
  });
  if (Object.keys(set).length) await chrome.storage.local.set(set);
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
// Older versions kept the user's own OAuth client ID here; sign-in no longer uses one.
chrome.runtime.onInstalled.addListener(async () => {
  const { backup } = await chrome.storage.local.get("backup");
  if (backup && "clientId" in backup) {
    const { clientId, ...rest } = backup;
    await chrome.storage.local.set({ backup: rest });
  }
});
chrome.runtime.onStartup.addListener(syncBackupAlarm);
