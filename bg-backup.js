// Backup: snapshots of the bookmarks and of Extra Guac's settings and data, to Google
// Drive and Dropbox (on a schedule or on demand) and to a local file (settings and data only).
// Both clouds can be connected at once: each sync goes to every connected one, and each keeps
// its own snapshots by the same rules. What's the same for both is here; CLOUDS.drive is
// below, CLOUDS.dropbox is in bg-dropbox.js.
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
// (Dropbox keeps them in its app folder the same way, see bg-dropbox.js.)
// Connecting a browser whose Drive folder (or Dropbox app folder) already has snapshots from elsewhere doesn't
// back up straight away (that would make a fresh, empty install the "newest"): it waits
// until the user restores one or presses sync now.
// Snapshots include API keys (shorteners, upload hosts), like the settings themselves, and
// session switch profiles (saved logins).
// Scratch pads and the screenshot history are in them too. Their images go up once each,
// as files of their own in folders inside the backup folder ("pad images", "screenshots");
// snapshots only name the ones they use, and a file goes when no kept snapshot names it
// any more.

// "backup" is the auto-sync interval, for both clouds; the sign-ins themselves aren't saved.
const BACKUP_KEYS = ["tt", "pii", "removed", "shortHistory", "shortCounts", "uploadHistory", "colorHistory", "selectorHistory", "fontHistory", "hl", "proxy", ...PADS.PAD_KEYS, "shotHistory", "qrHistory", "qrIcons", "myColors", "usScripts", "usValues", "backup"];
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

const cloudOf = (cloud) => CLOUDS[cloud || "drive"] || CLOUDS.drive;

const backupHandlers = {
  backupConnect: async ({ cloud } = {}) => {
    const c = cloudOf(cloud);
    const before = await cloudState(c);
    const { backupState: { chosenAt } = {} } = await chrome.storage.local.get("backupState");
    await c.signIn();
    const email = await c.account();
    await setCloudState(c, { connected: true, email, needsSignIn: false, lastError: "", ...c.reset });
    // A browser that has never backed up here, connecting to a folder that already has
    // other snapshots, is most likely a reinstall or a new computer still waiting to be
    // restored. Backing it up now would make its fresh settings the newest snapshot.
    // Unless its settings were already brought in on purpose (a settings file imported or
    // a snapshot restored before connecting), or the folder already has snapshots from
    // this very browser (it was disconnected and is connecting again): then it carries on.
    if (!before.lastHash && !chosenAt) {
      const device = await deviceId();
      const snaps = await c.list();
      const others = snaps.filter((s) => s.device !== device);
      if (others.length && !snaps.some((s) => s.device === device)) {
        await setCloudState(c, { awaitingChoice: true, lastCheck: Date.now() });
        return { uploaded: false, awaitingChoice: true };
      }
    }
    return runBackup({ manual: true, clouds: [c] });
  },
  backupDisconnect: async ({ cloud } = {}) => {
    const c = cloudOf(cloud);
    await c.signOut();
    await chrome.storage.local.remove(`${c.id}NoticeHidden`);
    // Forget the connection, but not that this browser's settings were chosen on purpose
    // (kept with Drive's state, where it has always been).
    const st = await cloudState(c);
    await chrome.storage.local.set({ [c.stateKey]: st.chosenAt ? { chosenAt: st.chosenAt } : {} });
  },
  // Every connected cloud, or the one asked for.
  backupNow: async ({ cloud } = {}) => runBackup({ manual: true, clouds: cloud ? [cloudOf(cloud)] : await connectedClouds() }),
  // Every connected cloud's snapshots, newest first. One sync puts the same snapshot in each
  // cloud: those are one entry, with a copy per cloud ("copies", "clouds"). A cloud that
  // can't be listed is left out (and named in "failed") unless none could be.
  backupList: async ({ cloud } = {}) => {
    const clouds = cloud ? [cloudOf(cloud)] : await connectedClouds(true);
    // Connected, but every one needs signing in again: say so rather than list nothing.
    if (!clouds.length) for (const c of await connectedClouds()) throw new Error(`Sign in to ${c.name} again`);
    const snapshots = [], failed = [];
    for (const c of clouds) {
      try {
        snapshots.push(...(await c.list()).map((s) => ({ ...s, cloud: c.id })));
      } catch (err) {
        if (clouds.length === 1) throw err;
        failed.push({ cloud: c.id, name: c.name, error: err.message });
      }
    }
    if (clouds.length && failed.length === clouds.length) throw new Error(failed.map((f) => `${f.name}: ${f.error}`).join(" · "));
    return { snapshots: mergeCopies(snapshots).sort((a, b) => b.at - a.at), failed };
  },
  backupRestore: async ({ what, ...ref }) => {
    const { c, snap } = await readAnyCopy(ref);
    if (what === "bookmarks") return { folder: await restoreBookmarks(snap) };
    if (what === "userscripts") return restoreUserscripts(snap);
    if (what === "profiles") return restoreProfiles(snap);
    assertHasData(snap.data);
    return locked(async () => {
      const saved = await savePreRestore();
      await keepPadsBefore(snap.data);
      const applied = await applyData(snap.data);
      await markChosen();
      await fetchAttachments(c, snap.data).catch(() => {});
      await tidyShots().catch(() => {});
      return { ...saved, profiles: applied?.profiles };
    });
  },
  backupBookmarksHtml: async (ref) => {
    const { snap } = await readAnyCopy(ref);
    await saveFile(`bookmarks-${stamp(new Date(snap.createdAt))}.html`, "text/html", bookmarksHtml(snap.bookmarks));
  },
  backupDownload: async (ref) => {
    const { snap } = await readAnyCopy(ref);
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
      await markChosen(); // counts as a choice, see backupConnect
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

// Each cloud's connection and last sync, under its own key (Drive's is "backupState").
async function cloudState(c) {
  return (await chrome.storage.local.get(c.stateKey))[c.stateKey] || {};
}
async function setCloudState(c, patch) {
  const next = { ...(await cloudState(c)), ...patch };
  await chrome.storage.local.set({ [c.stateKey]: next });
  return next;
}
const setBackupState = (patch) => setCloudState(CLOUDS.drive, patch);

// The connected clouds; with signedIn, only those that don't need signing in again.
async function connectedClouds(signedIn = false) {
  const out = [];
  for (const c of Object.values(CLOUDS)) {
    const st = await cloudState(c);
    if (st.connected && !(signedIn && st.needsSignIn)) out.push(c);
  }
  return out;
}

// This browser's settings were brought in on purpose (a restore or an import): no cloud
// waits for a choice any more, and one connected later backs up straight away.
async function markChosen() {
  await setBackupState({ chosenAt: Date.now(), awaitingChoice: false });
  for (const c of await connectedClouds()) if (c !== CLOUDS.drive) await setCloudState(c, { awaitingChoice: false });
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

// Drive as one of the clouds (see CLOUDS.dropbox in bg-dropbox.js for the other).
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
async function driveMultipart(meta, blob) {
  const b = `tt${crypto.randomUUID()}`;
  const body = new Blob([
    `--${b}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\ncontent-type: ${meta.mimeType}\r\n\r\n`,
    blob,
    `\r\n--${b}--`,
  ]);
  await drive("/files?uploadType=multipart&fields=id", { method: "POST", body, headers: { "content-type": `multipart/related; boundary=${b}` }, base: DRIVE_UPLOAD });
}

const CLOUDS = {
  drive: {
    id: "drive", name: "Google Drive", short: "Drive", stateKey: "backupState",
    reset: { folderId: "" }, // looked up again on connecting (it may be another account)
    signIn: () => driveToken(true),
    account: async () => (await drive("/about?fields=user(emailAddress)")).user?.emailAddress || "",
    async signOut() {
      const { driveToken: t } = await chrome.storage.session.get("driveToken");
      if (t?.token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.token)}`, { method: "POST" }).catch(() => {});
      await chrome.storage.session.remove("driveToken");
    },
    list: () => driveList(),
    read: async (id) => (await drive(`/files/${id}?alt=media`, { raw: true })).blob(),
    async upload(props, gz) {
      await driveMultipart({
        name: `${snapshotBaseName(props)}.json.gz`,
        parents: [await backupFolder()],
        mimeType: "application/gzip",
        appProperties: { tt: "1", ...props },
      }, gz);
    },
    protect: (snap, until) =>
      drive(`/files/${snap.id}?fields=id`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appProperties: { keepUntil: String(until) } }),
      }),
    remove: (id) => drive(`/files/${id}`, { method: "DELETE" }),
    async attFolder(kind, create) {
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
    },
    async attList(folder) {
      const files = [];
      let page = "";
      do {
        const q = `'${folder}' in parents and trashed=false`;
        const res = await drive(`/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,createdTime)&pageSize=1000&spaces=drive${page ? `&pageToken=${page}` : ""}`);
        for (const f of res.files || []) files.push({ fileId: f.id, name: f.name, mimeType: f.mimeType, created: Date.parse(f.createdTime) || 0 });
        page = res.nextPageToken || "";
      } while (page);
      return attachmentEntries(files);
    },
    attUpload: (folder, { name, blob, type }) => driveMultipart({ name, parents: [folder], mimeType: type, appProperties: { attachment: "1" } }, blob),
    attGet: async (f) => (await drive(`/files/${f.fileId}?alt=media`, { raw: true })).blob(),
  },
};

// ---- Snapshots -------------------------------------------------------------------------

function trimBookmarks(node) {
  const out = { title: node.title };
  if (node.url) out.url = node.url;
  if (node.dateAdded) out.dateAdded = node.dateAdded;
  if (node.children) out.children = node.children.map(trimBookmarks);
  return out;
}

// With profiles, Session Switch's saved logins come along (ssProfiles, see bg-sessions.js): only in
// the snapshots uploaded to Drive and Dropbox.
async function buildSnapshot(withBookmarks = true, { profiles = false } = {}) {
  const data = withoutWriters(await chrome.storage.local.get(BACKUP_KEYS));
  data.clips = await clipExport(); // clipboard history: one key per entry (bg-clip.js)
  if (profiles) {
    const copy = await sessionDriveCopy().catch((err) => console.error("[backup] profiles", err));
    if (copy) data.ssProfiles = copy;
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

async function driveList() {
  const folder = await backupFolder();
  const q = `'${folder}' in parents and trashed=false and mimeType!='${FOLDER_TYPE}'`;
  const res = await drive(`/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime,appProperties)&pageSize=1000&spaces=drive`);
  return (res.files || [])
    .map((f) => snapshotEntry({ id: f.id, name: f.name, size: Number(f.size) || 0, at: Date.parse(f.createdTime) }, f.appProperties || {}))
    .sort((a, b) => b.at - a.at);
}

// "extra-guac-2026-10-02T09-00-00", or "extra-guac-before-restore-…" for the copy before a restore.
const snapshotBaseName = (props) => `${props.kind === "pre-restore" ? "extra-guac-before-restore" : "extra-guac"}-${stamp(new Date(Number(props.at)))}`;

// A list entry from what a cloud keeps beside the file (Drive's appProperties, the tags in a
// Dropbox file's name): all strings, and older snapshots don't have all of them.
function snapshotEntry(file, p) {
  return {
    ...file,
    at: Number(p.at) || file.at,
    device: p.device || "", // "" = made before devices were recorded
    kind: p.kind || "auto",
    keepUntil: Number(p.keepUntil) || 0,
    hash: p.hash || "", // what's in it (older snapshots don't say)
    scripts: p.scripts ? Number(p.scripts) : null, // userscripts in it (older ones don't say)
    profiles: p.profiles ? Number(p.profiles) : null, // session switch profiles in it (older ones don't say)
  };
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

// The same snapshot in several clouds: same time, browser, kind, size and content.
function mergeCopies(snaps) {
  const byKey = new Map();
  for (const s of snaps) {
    const key = [s.at, s.device, s.kind, s.size, s.hash].join("|");
    const copy = { cloud: s.cloud, id: s.id };
    const have = byKey.get(key);
    if (have && !have.clouds.includes(s.cloud)) {
      have.copies.push(copy);
      have.clouds.push(s.cloud);
    } else if (!have) byKey.set(key, { ...s, copies: [copy], clouds: [s.cloud] });
    else byKey.set(`${key}|${s.id}`, { ...s, copies: [copy], clouds: [s.cloud] }); // two in one cloud: both stay
  }
  return [...byKey.values()];
}

// A list entry's snapshot, from the first of its copies that can be read ({ copies }, or
// { cloud, id } for one copy), with the cloud it came from.
async function readAnyCopy({ copies, cloud, id }) {
  copies = Array.isArray(copies) && copies.length ? copies : [{ cloud, id }];
  let error;
  for (const copy of copies) {
    const c = cloudOf(copy.cloud);
    try {
      return { c, snap: await readSnapshot(c, copy.id) };
    } catch (err) {
      error ??= err;
    }
  }
  throw error;
}

async function readSnapshot(c, id) {
  const blob = await c.read(id);
  // Drive may hand the file back already unpacked.
  const text = new Uint8Array(await blob.slice(0, 2).arrayBuffer())[0] === 0x1f ? await gunzip(blob) : await blob.text();
  return JSON.parse(text);
}

// Scheduled runs share one in-flight backup per cloud; "sync now" (manual) always runs its
// own. One snapshot is built for all the clouds a run goes to. A cloud that fails doesn't stop
// the others; the run fails only when every one did.
const backupRuns = new Map();
async function runBackup({ manual = false, clouds } = {}) {
  clouds ??= await connectedClouds();
  if (!clouds.length) throw new Error("Connect Google Drive or Dropbox first");
  let built = null;
  const build = () => (built ??= buildSnapshot(true, { profiles: true }));
  const runs = clouds.map((c) => {
    if (manual) return locked(() => doBackup(c, { manual: true, build }));
    if (!backupRuns.has(c.id)) backupRuns.set(c.id, locked(() => doBackup(c, { build })).finally(() => backupRuns.delete(c.id)));
    return backupRuns.get(c.id);
  });
  const results = await Promise.allSettled(runs);
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [{ cloud: clouds[i].id, name: clouds[i].name, error: r.reason?.message || String(r.reason) }] : []));
  if (failed.length === clouds.length) throw results.find((r) => r.status === "rejected").reason;
  const ok = results.flatMap((r, i) => (r.status === "fulfilled" ? [{ cloud: clouds[i], ...r.value }] : []));
  return {
    uploaded: ok.some((r) => r.uploaded),
    savedTo: ok.filter((r) => r.uploaded).map((r) => r.cloud.short), // "Drive", "Dropbox"
    awaitingChoice: ok.some((r) => r.awaitingChoice),
    failed,
  };
}

// Uploads one snapshot; returns its size in the cloud.
async function uploadSnapshot(c, snap, props = {}) {
  await syncAttachments(c, snap.data);
  const at = Date.parse(snap.createdAt) || Date.now();
  const gz = await gzip(JSON.stringify(snap));
  await c.upload({
    at: String(at), device: await deviceId(),
    ...(Array.isArray(snap.data.usScripts) ? { scripts: String(snap.data.usScripts.length) } : {}),
    ...(snap.data.ssProfiles?.profiles ? { profiles: String(snap.data.ssProfiles.profiles) } : {}),
    ...props,
  }, gz);
  return { at, size: gz.size };
}

async function doBackup(c, { manual = false, build = () => buildSnapshot(true, { profiles: true }) } = {}) {
  const st = await cloudState(c);
  if (!st.connected) throw new Error(`Connect ${c.name} first`);
  // Waiting for the user to restore or confirm after connecting (see backupConnect):
  // scheduled runs leave the cloud alone; "sync now" means "back this browser up".
  if (st.awaitingChoice && !manual) return { uploaded: false, awaitingChoice: true };
  try {
    const snap = await build();
    // Profiles by their own hash, which leaves out when they were last saved or used.
    const hash = await sha256(JSON.stringify([{ ...snap.data, ssProfiles: snap.data.ssProfiles?.hash }, snap.bookmarks]));
    let snaps = await c.list();
    let uploaded = false;
    // Unchanged = the same as this browser's newest snapshot there (so disconnecting and
    // connecting again, even to another account, saves nothing new unless something
    // changed). Snapshots from before the content was recorded fall back on the last
    // upload remembered here.
    const device = await deviceId();
    const mine = snaps.filter((s) => s.device === device && s.kind !== "pre-restore").sort((a, b) => b.at - a.at)[0];
    const lastHash = mine?.hash || (mine ? st.lastHash : "");
    if (hash !== lastHash) {
      // Compare with this browser's own previous snapshot (another browser's can be any size).
      const before = snaps.find((s) => s.device === device) || snaps.find((s) => !s.device);
      const { at, size } = await uploadSnapshot(c, snap, { hash });
      uploaded = true;
      // Much smaller than the snapshot before it: probably data went missing. Keep the
      // bigger one around for a month whatever the age windows say.
      if (before && before.size && size < before.size * SHRINK_RATIO) {
        await c.protect(before, Date.now() + PROTECT_FOR).catch(() => {});
      }
      await setCloudState(c, { lastHash: hash, lastSnapshot: at, awaitingChoice: false });
      snaps = await c.list();
    } else if (st.awaitingChoice) {
      await setCloudState(c, { awaitingChoice: false });
    }
    const keep = snapshotsToKeep(snaps);
    let deleted = 0;
    for (const s of snaps) if (!keep.has(s.id)) await c.remove(s.id).then(() => deleted++, () => {});
    if (deleted) await pruneAttachments(c, snaps.filter((s) => keep.has(s.id))).catch(() => {});
    await setCloudState(c, { lastCheck: Date.now(), lastError: "", needsSignIn: false });
    return { uploaded };
  } catch (err) {
    await setCloudState(c, { lastError: err.message, lastCheck: Date.now() });
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

// Before a restore or import: keep what's there now, locally (for "undo") and, in each
// connected cloud, as a snapshot protected from clean-up for 30 days. savedTo names the
// clouds it went to ("Drive", "Dropbox").
async function savePreRestore() {
  const snap = await buildSnapshot();
  await chrome.storage.local.set({ preRestore: { at: Date.now(), data: snap.data } });
  const savedTo = [];
  for (const c of await connectedClouds(true)) {
    try {
      await uploadSnapshot(c, snap, { kind: "pre-restore", keepUntil: String(Date.now() + PROTECT_FOR) });
      savedTo.push(c.short);
    } catch {}
  }
  return { preRestore: savedTo.length ? "cloud" : "local", savedTo };
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
    // nor a screenshot history, QR codes, My colors, the proxy or userscripts (backed up since later versions)
    if (["shotHistory", "qrHistory", "qrIcons", "myColors", "proxy", "usScripts", "usValues"].includes(k) && data[k] === undefined) continue;
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
  // Saved logins in the snapshot: added next to the ones here (bg-sessions.js).
  if (data.ssProfiles) return { profiles: await sessionDriveRestore(data.ssProfiles).catch((err) => console.error("[backup] profiles", err)) };
  // Backups from 191 have a single QR icon ("qrIcon"): it becomes the first of yours.
  if (typeof data.qrIcon === "string" && data.qrIcons === undefined) await chrome.storage.local.set({ qrIcon: data.qrIcon });
}

// Userscripts only: the snapshot's scripts and what they saved take the place of the ones here;
// every other setting stays. The copy taken first (savePreRestore) undoes it, like a full restore.
function restoreUserscripts(snap) {
  if (!Array.isArray(snap.data?.usScripts)) throw new Error("This snapshot has no userscripts");
  return locked(async () => {
    const saved = await savePreRestore();
    const usValues = snap.data.usValues && typeof snap.data.usValues === "object" ? snap.data.usValues : {};
    await editLocal([], () => ({ usScripts: snap.data.usScripts, usValues }));
    return { ...saved, scripts: snap.data.usScripts.length };
  });
}

// Session switch profiles only: added next to the ones here, every setting stays (so there's
// nothing to undo).
async function restoreProfiles(snap) {
  if (!snap.data?.ssProfiles) throw new Error("This snapshot has no session switch profiles");
  return (await sessionDriveRestore(snap.data.ssProfiles)) || {};
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
      if (files.length < (meta?.parts || 1)) throw new Error("parts missing in the backup"); // left out, not restored half
      const parts = files.sort((a, b) => a.index - b.index).map((f, i) => ({ name: meta?.names?.[i] || meta?.name || f.name, blob: f.blob }));
      const { thumb } = await SHOTS.thumbOf(parts[0].blob);
      await SHOTS.put({ id, items: parts, thumb });
    },
  },
];

// Each cloud gives a folder for a kind (attFolder; "" when there's none and create isn't
// set), what's in it (attList: id -> [{ fileId, name, index, mimeType, created }]), and
// uploads (attUpload), downloads (attGet) and deletes (remove) single files.
function attachmentEntries(files) {
  const out = new Map();
  for (const f of files) {
    const m = /^([0-9a-f]{32})(?:-(\d+))?\./.exec(f.name);
    if (!m) continue;
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1]).push({ ...f, index: Number(m[2] || 0) });
  }
  return out;
}

// Before a snapshot goes up: only the files the cloud doesn't have yet.
async function syncAttachments(c, data) {
  for (const kind of ATTACHMENTS) {
    const ids = kind.ids(data);
    if (!ids.size) continue;
    const folder = await c.attFolder(kind, true);
    const have = await c.attList(folder);
    for (const id of ids) {
      // Every file of it, so a shot whose parts stopped half-way up gets the rest next time.
      const files = await kind.files(id);
      if (!files) continue; // not on this computer (it came from another browser)
      const up = new Set((have.get(id) || []).map((f) => f.name));
      for (const f of files) if (!up.has(f.name)) await c.attUpload(folder, f);
    }
  }
}

// After old snapshots were deleted: files none of the kept ones use go too (only ones over
// a day old, so another browser's upload in progress is safe). Any snapshot that can't be
// read stops the clean-up, so nothing still in use is deleted.
async function pruneAttachments(c, kept) {
  const datas = [];
  for (const s of kept) datas.push((await readSnapshot(c, s.id)).data || {});
  for (const kind of ATTACHMENTS) {
    const folder = await c.attFolder(kind, false);
    if (!folder) continue;
    const have = await c.attList(folder);
    if (!have.size) continue;
    const used = new Set(datas.flatMap((d) => [...kind.ids(d)]));
    for (const [id, files] of have) {
      if (used.has(id)) continue;
      for (const f of files) if (Date.now() - f.created > DAY) await c.remove(f.fileId).catch(() => {});
    }
  }
}

// After a restore: the files the restored data uses that aren't on this computer.
async function fetchAttachments(c, data) {
  for (const kind of ATTACHMENTS) {
    const missing = [];
    for (const id of kind.ids(data)) if (!(await kind.has(id))) missing.push(id);
    if (!missing.length) continue;
    const folder = await c.attFolder(kind, false);
    if (!folder) continue;
    const have = await c.attList(folder);
    for (const id of missing) {
      const found = have.get(id);
      if (!found) continue;
      const files = [];
      for (const f of found) {
        const blob = await c.attGet(f);
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

// One alarm for every connected cloud, due from the one checked longest ago.
async function syncBackupAlarm() {
  const { backup = {} } = await chrome.storage.local.get("backup");
  const hours = BACKUP_INTERVALS.includes(Number(backup.interval ?? 24)) ? Number(backup.interval ?? 24) : 24;
  const have = await chrome.alarms.get(BACKUP_ALARM);
  const states = await Promise.all((await connectedClouds()).map(cloudState));
  if (!hours || !states.length) return void (have && chrome.alarms.clear(BACKUP_ALARM));
  if (have?.periodInMinutes === hours * 60) return;
  const due = Math.min(...states.map((st) => st.lastCheck || Date.now())) + hours * 3600e3;
  chrome.alarms.create(BACKUP_ALARM, { when: Math.max(Date.now() + 60e3, due), periodInMinutes: hours * 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => alarm.name === BACKUP_ALARM && runBackup().catch(() => {}));
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  const connected = (v) => !!v?.connected;
  const flipped = Object.values(CLOUDS).some(({ stateKey: k }) => c[k] && connected(c[k].oldValue) !== connected(c[k].newValue));
  if (c.backup || flipped) syncBackupAlarm();
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
// From 297 session switch profiles go into Drive snapshots without a passphrase: updating from an
// older version backs up once right away, so Drive has a copy any browser can restore them from.
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  if (reason !== "update" || Number(previousVersion) >= 297) return;
  const { backupState = {} } = await chrome.storage.local.get("backupState");
  if (backupState.connected && !backupState.needsSignIn) runBackup({ clouds: [CLOUDS.drive] }).catch(() => {});
});
