// Dropbox, the second cloud backups can go to (bg-backup.js has what both clouds share).
//
// Signing in uses Extra Guac's own Dropbox app (DROPBOX_APP_KEY) with PKCE, so there's no
// secret to keep. The one sign-in gives a refresh token, kept in this browser ("dropboxAuth",
// never in a backup), and every access token after that (they last about 4 hours) comes from
// it without showing anything. Settings ask to sign in again only when Dropbox turns it down
// (access removed in Dropbox, say). The app only has its own app folder (Apps → the app's
// name), the only place in the Dropbox it can see.
//
// Snapshots sit at the top of the app folder, the pad images and screenshots in folders of
// their own inside it, like in Drive. Dropbox keeps nothing beside a file the way Drive's
// appProperties do, so what a snapshot's list entry needs is in its name, after its time:
//   extra-guac-2026-10-22T10-00-00 at=1792663200000 d=<browser> h=<content hash> s=2 p=1.json.gz
// (at the exact time, d the browser that made it, h what's in it, s userscripts, p session
// switch profiles, k kept until). Protecting a snapshot from clean-up renames it.

const DROPBOX_APP_KEY = "h7lvrelz204ntgq"; // the "Extra Guac Backup" app; public, like Drive's client ID
const DROPBOX_API = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT = "https://content.dropboxapi.com/2";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DBX_TAGS = { at: "at", device: "d", hash: "h", scripts: "s", profiles: "p", keepUntil: "k" };
const DBX_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml" };

const setDropboxState = (patch) => setCloudState(CLOUDS.dropbox, patch);
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---- Sign-in ---------------------------------------------------------------------------

async function keepDropboxToken(got) {
  await chrome.storage.session.set({ dropboxToken: { token: got.access_token, exp: Date.now() + (Number(got.expires_in) || 14400) * 1000 } });
  await chrome.storage.local.remove("dropboxNoticeHidden"); // a notice hidden with × shows again next time
  return got.access_token;
}

// The window: Dropbox's sign-in (skipped when already signed in) and its Allow screen.
async function dropboxSignIn() {
  if (!DROPBOX_APP_KEY) throw new Error("Dropbox isn't set up in this copy of Extra Guac");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = crypto.randomUUID();
  const redirect = chrome.identity.getRedirectURL();
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: DROPBOX_APP_KEY,
    response_type: "code",
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    token_access_type: "offline", // a refresh token too, so this is the only time
    state,
  });
  let back;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch (err) {
    throw new Error(`Sign-in didn't finish: ${err.message}`);
  }
  const got = new URL(back).searchParams;
  if (got.get("error")) throw new Error(got.get("error") === "access_denied" ? "Dropbox access wasn't allowed" : got.get("error_description") || got.get("error"));
  if (got.get("state") !== state || !got.get("code")) throw new Error("Sign-in didn't finish");
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({ code: got.get("code"), grant_type: "authorization_code", client_id: DROPBOX_APP_KEY, redirect_uri: redirect, code_verifier: verifier }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new Error(tok.error_description || `Dropbox sign-in failed (${res.status})`);
  if (tok.refresh_token) await chrome.storage.local.set({ dropboxAuth: { refresh: tok.refresh_token } });
  return keepDropboxToken(tok);
}

// An access token, from this session's cache or the refresh token. Never shows a window.
let dropboxRefreshing = null;
async function dropboxToken() {
  const { dropboxToken: cached } = await chrome.storage.session.get("dropboxToken");
  if (cached?.token && cached.exp > Date.now() + 60e3) return cached.token;
  return (dropboxRefreshing ??= dropboxRefresh().finally(() => (dropboxRefreshing = null)));
}
async function dropboxRefresh() {
  const { dropboxAuth } = await chrome.storage.local.get("dropboxAuth");
  const signInAgain = async () => {
    await setDropboxState({ needsSignIn: true });
    return new Error("Sign in to Dropbox again");
  };
  if (!dropboxAuth?.refresh) throw await signInAgain();
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: dropboxAuth.refresh, client_id: DROPBOX_APP_KEY }),
  });
  // 400 invalid_grant: the access was removed in Dropbox (or the app's key changed).
  if (res.status === 400 || res.status === 401) throw await signInAgain();
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new Error(`Dropbox error ${res.status}`);
  return keepDropboxToken(tok);
}

// ---- API -------------------------------------------------------------------------------

// Dropbox-API-Arg is a header, so only ASCII goes in it.
const asciiJson = (v) => JSON.stringify(v).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);

// One call. RPC endpoints take and give JSON; content endpoints (content: true) take their
// arguments in a header, upload the body and give the Response back for downloads. A new
// token once on 401, and a short wait (up to 3 times) when Dropbox says too many requests.
async function dbx(path, args, { content = false, body } = {}, { renewed = false, waits = 0 } = {}) {
  const token = await dropboxToken();
  const headers = { authorization: `Bearer ${token}` };
  let send;
  if (content) {
    headers["dropbox-api-arg"] = asciiJson(args);
    if (body) { headers["content-type"] = "application/octet-stream"; send = body; }
  } else if (args !== undefined) {
    headers["content-type"] = "application/json";
    send = JSON.stringify(args);
  }
  const res = await fetch((content ? DROPBOX_CONTENT : DROPBOX_API) + path, { method: "POST", headers, body: send });
  if (res.status === 401 && !renewed) {
    await chrome.storage.session.remove("dropboxToken");
    return dbx(path, args, { content, body }, { renewed: true, waits });
  }
  if (res.status === 429 && waits < 3) {
    await new Promise((r) => setTimeout(r, Math.min(30, Number(res.headers.get("retry-after")) || 2 ** waits) * 1000));
    return dbx(path, args, { content, body }, { renewed, waits: waits + 1 });
  }
  if (!res.ok) {
    let summary = "";
    try { const j = await res.json(); summary = j.error_summary || j.error?.[".tag"] || ""; } catch {}
    if (res.status === 401) await setDropboxState({ needsSignIn: true });
    const err = new Error(res.status === 401 ? "Sign in to Dropbox again" : summary ? `Dropbox: ${summary.replace(/\/\.*$/, "")}` : `Dropbox error ${res.status}`);
    err.status = res.status;
    err.summary = summary;
    throw err;
  }
  if (content && !body) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Every file in a folder ("" = the app folder itself); a folder that isn't there is empty.
async function dbxFiles(path) {
  let res;
  try {
    res = await dbx("/files/list_folder", { path, limit: 2000 });
  } catch (err) {
    if (err.status === 409 && /not_found/.test(err.summary)) return [];
    throw err;
  }
  const out = [...res.entries];
  while (res.has_more) {
    res = await dbx("/files/list_folder/continue", { cursor: res.cursor });
    out.push(...res.entries);
  }
  return out.filter((e) => e[".tag"] === "file");
}

const dbxUpload = (path, blob) => dbx("/files/upload", { path, mode: "add", autorename: false, mute: true }, { content: true, body: blob });
const dbxDownload = async (path) => (await dbx("/files/download", { path }, { content: true })).blob();

// ---- Snapshot names --------------------------------------------------------------------

function dropboxName(props) {
  const tags = Object.entries(DBX_TAGS).filter(([k]) => props[k] !== undefined && props[k] !== "").map(([k, t]) => ` ${t}=${props[k]}`);
  return `${snapshotBaseName(props)}${tags.join("")}.json.gz`;
}

// A file's list entry, or null when it isn't a snapshot.
function dropboxEntry(e) {
  const m = /^extra-guac(-before-restore)?-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)((?: [a-z]+=[^ ]*)*)\.json\.gz$/.exec(e.name);
  if (!m) return null;
  const tags = Object.fromEntries(m[3].trim().split(" ").filter(Boolean).map((t) => t.split("=")));
  const props = Object.fromEntries(Object.entries(DBX_TAGS).filter(([, t]) => tags[t]).map(([k, t]) => [k, tags[t]]));
  if (m[1]) props.kind = "pre-restore";
  const [day, time] = m[2].split("T");
  const at = Date.parse(`${day}T${time.replace(/-/g, ":")}Z`) || Date.parse(e.server_modified);
  return snapshotEntry({ id: e.id, name: e.name, size: e.size || 0, at }, props);
}

// ---- The cloud -------------------------------------------------------------------------

CLOUDS.dropbox = {
  id: "dropbox", name: "Dropbox", short: "Dropbox", stateKey: "dropboxState",
  reset: {},
  signIn: () => dropboxSignIn(),
  account: async () => (await dbx("/users/get_current_account"))?.email || "",
  // Revoking any access token of the sign-in ends the refresh token too.
  async signOut() {
    const token = await dropboxToken().catch(() => "");
    if (token) await fetch(`${DROPBOX_API}/auth/token/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
    await chrome.storage.session.remove("dropboxToken");
    await chrome.storage.local.remove("dropboxAuth");
  },
  list: async () => (await dbxFiles("")).map(dropboxEntry).filter(Boolean).sort((a, b) => b.at - a.at),
  read: (id) => dbxDownload(id),
  upload: (props, gz) => dbxUpload(`/${dropboxName(props)}`, gz),
  // The name says how long it's kept: a new one, the rest as it was.
  async protect(snap, until) {
    const next = / k=\d+(?=[ .])/.test(snap.name) ? snap.name.replace(/ k=\d+(?=[ .])/, ` k=${until}`) : snap.name.replace(/\.json\.gz$/, ` k=${until}.json.gz`);
    await dbx("/files/move_v2", { from_path: snap.id, to_path: `/${next}`, autorename: false });
  },
  remove: (id) => dbx("/files/delete_v2", { path: id }),
  async attFolder(kind, create) {
    const path = `/${kind.folder}`;
    if (create) {
      await dbx("/files/create_folder_v2", { path, autorename: false }).catch((err) => {
        if (!(err.status === 409 && /conflict/.test(err.summary))) throw err; // already there
      });
    }
    return path;
  },
  attList: async (folder) => attachmentEntries((await dbxFiles(folder)).map((e) => ({
    fileId: e.id, name: e.name, mimeType: DBX_TYPES[e.name.split(".").pop().toLowerCase()] || "", created: Date.parse(e.server_modified) || 0,
  }))),
  // Already there (another browser just put it up): nothing to do.
  attUpload: (folder, { name, blob }) => dbxUpload(`${folder}/${name}`, blob).catch((err) => {
    if (!(err.status === 409 && /conflict/.test(err.summary))) throw err;
  }),
  attGet: async (f) => {
    const blob = await dbxDownload(f.fileId);
    return f.mimeType ? new Blob([blob], { type: f.mimeType }) : blob;
  },
};
