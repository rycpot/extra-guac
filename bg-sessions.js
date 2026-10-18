// Session Switch: several saved logins per site, each with its own proxy if you like.
//
// One profile per site is active: its login is the one in the browser. While it is active, every
// change the site makes to its cookies is copied into it within a second or so, and its page storage
// is copied whenever a page of the site is hidden or closed and right before a switch. So a profile
// always holds the latest login, including one made after being logged out, and its expiry date moves
// forward as the site extends it. Switching saves the outgoing profile, parks the site's tabs on a
// blank page so nothing runs mid-switch, swaps cookies and storage, then sends the tabs back.
//
// Kept in storage.local:
//   ssGroups        { [id]: Group }   one per site: its registrable domain plus any linked sites
//   ssProfile:<id>  Profile           a saved login: its cookies and a few details
//   ssData:<id>     { [origin]: { local, session, idb, savedAt } }   the profile's page storage
//   ssWebrtc        false to leave WebRTC on for sites that go through a profile's proxy
// Messages are "ss:<name>": the popup's and settings' from extension pages, the pages' own
// (ss-page.js) from tabs. A profile's proxy uses Extra Guac's Webshare account (bg-proxy.js).
// Everything here stays inside this function, apart from what bg-proxy.js calls (see Proxy).
(() => {
// ---- Helpers ----

let tail = Promise.resolve();

// Runs tasks one at a time, in the order they were queued. Everything that reads and then writes
// saved profiles, or touches the browser's cookies, goes through here so two changes never interleave.
// A queued task must not await another queued task, or the queue stops.
function serial(task) {
  const run = tail.then(task, task);
  tail = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls check() until it returns something truthy, or gives up after timeout ms and returns null.
async function waitFor(check, timeout, every = 50) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

// Resolves with the promise's value, or with fallback if it takes longer than ms.
function within(promise, ms, fallback) {
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

const unique = (list) => [...new Set(list)];

// Reading, clearing and writing a site's cookies in the browser.


const STORE = "0"; // Chrome's regular cookie store (the extension isn't allowed in incognito)
const PROBE = "__session_switch_probe";

const bare = (domain) => domain.replace(/^\./, "");

// Whether host (or a cookie domain without its leading dot) is one of the domains or below one.
const inScope = (host, domains) => domains.some((d) => host === d || host.endsWith("." + d));

const isIp = (host) => /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[");

// The widest domain a cookie can be set on for this host, its registrable domain: github.com for
// gist.github.com, foo.co.uk for x.foo.co.uk, and me.github.io for me.github.io. The browser already
// knows the public-suffix list, so it is asked directly: a short-lived test cookie is tried on each
// parent domain, shortest first, and the first one the browser accepts is the answer.
const siteCache = new Map();
async function siteOf(host) {
  host = host.toLowerCase().replace(/\.$/, "");
  if (isIp(host) || !host.includes(".")) return host;
  if (siteCache.has(host)) return siteCache.get(host);
  const labels = host.split(".");
  let site = host;
  for (let i = labels.length - 2; i > 0; i--) {
    const candidate = labels.slice(i).join(".");
    if (await accepts(host, candidate)) {
      site = candidate;
      break;
    }
  }
  siteCache.set(host, site);
  return site;
}

// The registrable domain of host, or null if the browser won't keep cookies for it: a public suffix
// such as com or co.uk, or a site whose cookies are blocked. A profile on a public suffix would take
// in the cookies of every site under it.
async function validSite(host) {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  if (isIp(host) || host === "localhost") return host;
  if (!host.includes(".")) return null;
  const site = await siteOf(host);
  // Asked from a made-up subdomain: the browser lets a host set a cookie on itself even when the
  // host is a public suffix, but never lets a subdomain set one on a public suffix.
  return (await accepts(`probe.${site}`, site)) ? site : null;
}

async function accepts(host, domain) {
  try {
    const cookie = await chrome.cookies.set({
      url: `https://${host}/`, name: PROBE, value: "1", domain: "." + domain, path: "/",
      secure: true, sameSite: "lax", storeId: STORE, expirationDate: Math.floor(Date.now() / 1000) + 60,
    });
    if (!cookie) return false;
    await chrome.cookies.remove({ url: `https://${domain}/`, name: PROBE, storeId: STORE }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// The fields kept for each cookie.
function slim(c) {
  const out = {
    name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, session: c.session,
  };
  if (!c.session) out.expirationDate = c.expirationDate;
  if (c.partitionKey) out.partitionKey = c.partitionKey;
  return out;
}

function cookieKey(c) {
  const pk = c.partitionKey ? `${c.partitionKey.topLevelSite}|${!!c.partitionKey.hasCrossSiteAncestor}` : "";
  return `${c.name}\t${c.domain}\t${c.path}\t${pk}`;
}

// Every cookie of these domains and their subdomains, including partitioned ones.
async function readCookies(domains) {
  const found = new Map();
  for (const domain of domains) {
    const list = await chrome.cookies.getAll({ domain, storeId: STORE, partitionKey: {} });
    for (const c of list) {
      if (c.name !== PROBE && inScope(bare(c.domain), domains)) found.set(cookieKey(c), slim(c));
    }
  }
  return [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);
}

// Whether two cookie lists hold the same cookies, values and expiry dates.
function sameCookies(a, b) {
  if (a.length !== b.length) return false;
  const sig = (c) => `${cookieKey(c)}\t${c.value}\t${Math.floor(c.expirationDate || 0)}\t${c.secure}${c.httpOnly}${c.sameSite}`;
  const left = a.map(sig).sort(), right = b.map(sig).sort();
  return left.every((s, i) => s === right[i]);
}

// A URL the cookie belongs to. Secure cookies need https; the others follow the page's scheme.
function urlOf(c, https) {
  return `${c.secure || https ? "https" : "http"}://${bare(c.domain)}${c.path || "/"}`;
}

// Removals this extension made itself, by cookie name (a removal by address and name can take a
// same-named cookie of another path or host): how many of their events are still to come, and until
// when they count. Each removal event of such a name uses one up, so it isn't taken for a removal
// made from outside. Removals that didn't happen are taken back, and leftovers expire.
const ownRemovals = new Map();

function isOwnRemoval(name) {
  const own = ownRemovals.get(name);
  if (!own || own.until <= Date.now()) return false;
  if (--own.count <= 0) ownRemovals.delete(name);
  return true;
}

function noteOwnRemoval(name, change = 1) {
  const now = Date.now();
  for (const [key, own] of ownRemovals) if (own.until <= now) ownRemovals.delete(key);
  const own = ownRemovals.get(name) || { count: 0 };
  own.count += change;
  own.until = now + 3000;
  if (own.count > 0) ownRemovals.set(name, own);
  else ownRemovals.delete(name);
}

// Removes every cookie of the domains. Returns the ones that couldn't be removed.
async function clearCookies(domains, https) {
  for (let pass = 0; pass < 3; pass++) {
    const left = await readCookies(domains);
    if (!left.length) return [];
    await Promise.all(left.map((c) => {
      noteOwnRemoval(c.name);
      const details = { url: urlOf(c, https), name: c.name, storeId: STORE };
      if (c.partitionKey) details.partitionKey = c.partitionKey;
      return chrome.cookies.remove(details).then((r) => r || noteOwnRemoval(c.name, -1), () => noteOwnRemoval(c.name, -1));
    }));
  }
  return readCookies(domains);
}

// Writes saved cookies back into the browser. Cookies past their expiry date are skipped: the
// browser would drop them anyway. Returns the names of the expired ones and of any that failed.
async function restoreCookies(cookies, https) {
  const now = Date.now() / 1000;
  const expired = [], failed = [];
  await Promise.all(cookies.map(async (c) => {
    if (!c.session && c.expirationDate <= now) return expired.push(c.name);
    const details = {
      url: urlOf(c, https), name: c.name, value: c.value, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, storeId: STORE,
    };
    if (!c.hostOnly) details.domain = c.domain;
    if (!c.session) details.expirationDate = c.expirationDate;
    if (c.sameSite && c.sameSite !== "unspecified") details.sameSite = c.sameSite;
    if (c.partitionKey) details.partitionKey = c.partitionKey;
    try {
      if (!await chrome.cookies.set(details)) failed.push(c.name);
    } catch {
      failed.push(c.name);
    }
  }));
  // Read them back, in case the browser quietly changed or refused any.
  const back = await readCookies(unique(cookies.map((c) => bare(c.domain))));
  const have = new Map(back.map((c) => [cookieKey(c), c.value]));
  for (const c of cookies) {
    if ((c.session || c.expirationDate > now) && have.get(cookieKey(c)) !== c.value && !failed.includes(c.name)) failed.push(c.name);
  }
  return { expired, failed };
}

// Which of a profile's cookies holds the login, and when it runs out.
//
// No site says which of its cookies is the login, so the choice is a guess from the cookie's name and
// flags. The user can pick a different cookie in a profile's details, and that choice wins.

const NAME = /sess|auth|token|jwt|login|logged|remember|ident|sso|refresh|access|credential|passport|account|user|member|(^|[^a-z])sid|sid($|[^a-z])/i;
const NOT = /^(_ga|_gid|_gat|_gcl|__utm|_fb|fr$|_hj|ajs_|amp_|amplitude|mp_|_uet|muid$|optimizely|_?_cf|cf_|_dd_s|intercom-|__hs|hubspot|_clck|_clsk|_pin|_tt|_scid|_rdt|__stripe|_lr_|_parsely|_pk_|_vwo|mbox|amcv|s_(cc|sq|fid)$)|consent|gdpr|ccpa|banner|optanon|usprivacy|tracking|analytic|timezone|^tz$|theme|color_?mode|^lang|locale|currency|device|visitor|csrf|xsrf/i;
const LASTING = /refresh|remember|persist|keep|stay/i;

// How much a cookie looks like a login cookie.
function score(c) {
  let s = 0;
  if (NAME.test(c.name)) s += 3;
  if (NOT.test(c.name)) s -= 6;
  if (c.httpOnly) s += 2;
  if (c.secure) s += 1;
  if (/^__(Host|Secure)-/.test(c.name)) s += 1;
  if (c.value.length >= 20) s += 1;
  if (c.session) s -= 1;
  return s;
}

// The login state of a list of cookies:
//   state    'in' (has an expiry date), 'expired', 'session' (no expiry date), 'gone' (the login
//            cookie this profile had is missing: logged out), or 'none' (no login cookie found)
//   expires  when the login cookie runs out, in ms
//   name     the cookie the date comes from
//   how      'picked' by the user, 'auto' (a confident guess) or 'guess'
// remembered is the login cookie seen in this profile before, so a logout shows as 'gone'.
function loginOf(cookies, group, remembered) {
  let picks, how;
  if (group.loginCookie) {
    picks = cookies.filter((c) => c.name === group.loginCookie);
    how = "picked";
  } else if (remembered) {
    picks = cookies.filter((c) => c.name === remembered);
    how = "auto";
  } else {
    picks = cookies.filter((c) => score(c) >= 6);
    how = "auto";
    if (!picks.length) {
      picks = cookies.filter((c) => c.httpOnly && !c.session && score(c) >= 4);
      how = "guess";
    }
    // A long-lived "remember me" or refresh cookie is what brings the login back, so it decides.
    const lasting = picks.filter((c) => LASTING.test(c.name));
    if (lasting.length) picks = lasting;
  }
  const name = group.loginCookie || remembered || null;
  if (!picks.length) return { state: name ? "gone" : "none", name, how };
  const dated = picks.filter((c) => !c.session);
  if (!dated.length) return { state: "session", name: picks[0].name, how };
  const first = dated.reduce((a, b) => (a.expirationDate <= b.expirationDate ? a : b));
  const expires = Math.round(first.expirationDate * 1000);
  return { state: expires <= Date.now() ? "expired" : "in", expires, name: first.name, how };
}

// Notes the profile's login cookie the first time it is found with confidence, so that a logout
// later shows as one instead of falling back to some other cookie.
function remember(profile, group) {
  if (group.loginCookie || profile.login) return;
  const found = loginOf(profile.cookies, group, null);
  if (found.how === "auto" && found.state === "in") profile.login = found.name;
}

// ---- Saved sites and profiles (see the keys at the top) ----
//
// Group: { id, domains, activeId, order, loginCookie, epoch, pending, origins }
//   activeId     the profile whose login is in the browser now; it is kept up to date
//   order        profile ids, in the order shown
//   loginCookie  the cookie the user picked for the expiry date, or null to pick automatically
//   epoch        goes up on every switch, so pages loaded before it can be told apart
//   pending      origins whose storage still has to be written the next time one of their pages opens
//   origins      every origin of the site a page has been seen on
// Profile: { id, groupId, name, hue, createdAt, lastUsed, syncedAt, cookies, login }


let groups = null;
let loading = null;

function getGroups() {
  loading ??= chrome.storage.local.get("ssGroups").then((r) => (groups = r.ssGroups || {}));
  return loading;
}

const saveGroups = () => chrome.storage.local.set({ ssGroups: groups });

// The group a host or cookie domain belongs to. Groups must already be loaded.
const groupFor = (host) => Object.values(groups).find((g) => inScope(host, g.domains)) || null;

const allGroups = () => Object.values(groups);

const groupById = (id) => groups[id] || null;

function makeGroup(site) {
  const group = {
    id: crypto.randomUUID(), domains: [site], activeId: null, order: [], loginCookie: null,
    epoch: 1, pending: [], origins: [],
  };
  groups[group.id] = group;
  return group;
}

function dropGroup(id) {
  delete groups[id];
}

const P = (id) => "ssProfile:" + id;
const D = (id) => "ssData:" + id;

async function getProfile(id) {
  if (!id) return null;
  return (await chrome.storage.local.get(P(id)))[P(id)] || null;
}

async function getProfiles(ids) {
  if (!ids.length) return [];
  const found = await chrome.storage.local.get(ids.map(P));
  return ids.map((id) => found[P(id)]).filter(Boolean);
}

const putProfile = (profile) => chrome.storage.local.set({ [P(profile.id)]: profile });

async function getData(id) {
  return (await chrome.storage.local.get(D(id)))[D(id)] || {};
}

const putData = (id, data) => chrome.storage.local.set({ [D(id)]: data });

const removeProfile = (id) => chrome.storage.local.remove([P(id), D(id)]);

// Hues spread around the color wheel, so neighboring profiles look different.
const HUES = [210, 25, 140, 280, 350, 180, 55, 245];

function makeProfile(group, name) {
  const now = Date.now();
  const profile = {
    id: crypto.randomUUID(), groupId: group.id, name, hue: HUES[group.order.length % HUES.length],
    createdAt: now, lastUsed: now, syncedAt: now, cookies: [], login: null,
  };
  group.order.push(profile.id);
  return profile;
}

// The site's open tabs: reading their storage, and parking them while a switch happens.


// Every tab showing a page of the site.
async function siteTabs(domains) {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => {
    const host = hostOf(t.pendingUrl || t.url || "");
    return host && inScope(host, domains);
  });
}

// Runs in each frame of a tab. Returns the frame's storage when the frame belongs to the site and
// so does every frame around it (a frame embedded in another site has storage of its own).
function dumpFrame(domains) {
  const within = (origin) => {
    try {
      const host = new URL(origin).hostname;
      return /^https?:/.test(origin) && domains.some((d) => host === d || host.endsWith("." + d));
    } catch {
      return false;
    }
  };
  if (!within(self.origin) || ![...(location.ancestorOrigins || [])].every(within)) return null;
  const read = (store) => {
    const out = {};
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      out[key] = store.getItem(key);
    }
    return out;
  };
  try {
    return { origin: self.origin, local: read(localStorage), session: read(sessionStorage) };
  } catch {
    return null;
  }
}

// Runs func in the tab (and its frames, with allFrames). Resolves with the results, or null if the
// tab can't be reached or doesn't answer in time.
function exec(tabId, func, args = [], allFrames = false) {
  return within(chrome.scripting.executeScript({ target: { tabId, allFrames }, func, args }), 8000, null).catch(() => null);
}

// Runs an IndexedDB operation ('dump' or 'load') in the tab's top frame.
async function idbCall(tabId, op, arg) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["ss-idb.js"] });
  // Sent as JSON: script arguments lose properties whose value is null, and stored records have plenty.
  const [result] = await within(chrome.scripting.executeScript({
    target: { tabId },
    func: (op, json) => self.__sessionSwitchIdb[op](JSON.parse(json)),
    args: [op, JSON.stringify(arg)],
  }), 60000, [{ result: { problems: ["its app data took too long"] } }]);
  return result?.result || { problems: ["its app data could not be reached"] };
}

// The storage of every first-party frame in these tabs, by origin. The main tab is read first, so
// its sessionStorage is the one kept when several tabs share an origin. With idb, each origin's
// IndexedDB is read too, from a tab where the origin is the top page; incomplete lists the origins
// where some database couldn't be read.
async function readStorage(tabs, domains, mainTabId, idb) {
  const found = {}, problems = [], idbTabs = new Map(), incomplete = new Set();
  const ordered = [...tabs].sort((a, b) => (b.id === mainTabId) - (a.id === mainTabId));
  for (const tab of ordered) {
    if (tab.discarded) continue;
    const frames = await exec(tab.id, dumpFrame, [domains], true) || await exec(tab.id, dumpFrame, [domains]);
    for (const { result, frameId } of frames || []) {
      if (!result) continue;
      if (!found[result.origin]) found[result.origin] = { local: result.local, session: result.session, savedAt: Date.now() };
      if (idb && frameId === 0 && !idbTabs.has(result.origin)) idbTabs.set(result.origin, tab.id);
    }
  }
  for (const [origin, tabId] of idbTabs) {
    try {
      const { dbs, problems: skipped } = await idbCall(tabId, "dump", 25e6);
      if (dbs) found[origin].idb = dbs;
      if (!dbs || skipped?.length) incomplete.add(origin);
      problems.push(...(skipped || []).map((p) => `${origin}: ${p}`));
    } catch (e) {
      incomplete.add(origin);
      problems.push(`${origin}: its app data could not be read (${e.message})`);
    }
  }
  return { found, problems, incomplete };
}

// Folds freshly read storage into a profile's saved storage.
function mergeStorage(saved, found) {
  for (const [origin, data] of Object.entries(found)) saved[origin] = { ...saved[origin], ...data };
  return saved;
}

// A parked tab is on about:blank#<MARK><address to go back to>. The blank page keeps the origin of
// the page that opened it, and the address travels with the tab instead of only in memory.
const MARK = "session-switch-return=";

// A picture of what the tab shows, if it is the one in front of its window: shown on its blank page
// while it is parked, so the switch looks like the page reloading rather than going blank.
async function snapshot(tab) {
  if (!tab.active) return null;
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }).catch(() => null);
}

// The origin of the tab's blank page, once the tab is on one; 'gone' if the tab was closed. With a
// picture, the blank page shows it.
async function blankOrigin(tabId, picture) {
  const [frame] = await exec(tabId, (src) => {
    if (!location.href.startsWith("about:blank")) return "";
    if (src && !document.getElementById("session-switch-cover")) {
      const img = document.createElement("img");
      img.id = "session-switch-cover";
      img.src = src;
      img.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;object-position:top left";
      document.documentElement.style.background = "#000";
      (document.body || document.documentElement).append(img);
    }
    return self.origin;
  }, [picture || null]) || [];
  if (frame) return frame.result || null;
  return chrome.tabs.get(tabId).then(() => null, () => "gone");
}

// Moves each tab to a blank page of its own origin. The site's scripts stop running (so nothing can
// send requests or write storage halfway through a switch), but the blank page can still reach the
// origin's storage. location.replace leaves the tab's history as it was.
//   parked  tabs now on a blank page, with the page's origin and the address to go back to
//   reload  tabs that couldn't be parked (an error page, say); they are reloaded afterwards
//   stuck   tabs that didn't leave, usually because the page asked to confirm leaving
async function park(tabs, pictures = new Map()) {
  const parked = [], reload = [], stuck = [];
  await Promise.all(tabs.map(async (tab) => {
    if (tab.discarded) return;
    const url = tab.pendingUrl || tab.url;
    if (!await exec(tab.id, (to) => location.replace(to), [`about:blank#${MARK}${encodeURIComponent(url)}`])) return reload.push(tab);
    const origin = await waitFor(() => blankOrigin(tab.id, pictures.get(tab.id)), 10000, 15);
    if (origin === "gone") return;
    if (origin) parked.push({ tab, url, origin });
    else stuck.push(tab);
  }));
  return { parked, reload, stuck };
}

// The tabs among these ids that are still parked, read from the tabs themselves. Used after the
// extension stopped in the middle of a switch; tabs that aren't parked are left alone.
async function findParked(tabIds) {
  const parked = [];
  for (const id of tabIds) {
    const [frame] = await exec(id, (mark) => (location.href.startsWith(`about:blank#${mark}`)
      ? { origin: self.origin, url: decodeURIComponent(location.hash.slice(1 + mark.length)) } : null), [MARK]) || [];
    if (frame?.result) parked.push({ tab: { id }, ...frame.result });
  }
  return parked;
}

// Runs in a parked tab: replaces the origin's localStorage (unless local is null) and the tab's
// sessionStorage (unless session is null).
function fillStorage(local, session) {
  const fill = (store, data) => {
    store.clear();
    for (const [key, value] of Object.entries(data)) store.setItem(key, value);
  };
  try {
    if (local) fill(localStorage, local);
    if (session) fill(sessionStorage, session);
    return "";
  } catch (e) {
    return `${self.origin}: ${e.message}`;
  }
}

// Writes a profile's storage into a parked tab. idb is the list of databases to put in place of
// the origin's current ones, or null to leave IndexedDB alone. Returns any problems.
async function writeParked(tabId, local, session, idb) {
  const problems = [];
  const [frame] = await exec(tabId, fillStorage, [local, session]) || [];
  if (!frame) problems.push("Storage could not be written");
  else if (frame.result) problems.push(frame.result);
  if (idb) {
    try {
      problems.push(...((await idbCall(tabId, "load", idb)).problems || []));
    } catch (e) {
      problems.push(`App data could not be written (${e.message})`);
    }
  }
  return problems;
}

// The address a parked tab goes back to, or '' for a tab that isn't parked.
const parkedReturn = (url = "") => (url.startsWith(`about:blank#${MARK}`) ? decodeURIComponent(url.slice(`about:blank#${MARK}`.length)) : "");

// Sends parked tabs back to where they were.
async function unpark(parked) {
  await Promise.all(parked.map(async ({ tab, url }) => {
    if (!await exec(tab.id, (address) => location.replace(address), [url])) {
      await chrome.tabs.update(tab.id, { url }).catch(() => {});
    }
  }));
}

// Keeps a registered page script on these domains and their subdomains; none unregisters it.
async function registerScript(script, domains) {
  const matches = domains.flatMap((d) => (/^[\d.]+$/.test(d) || d.includes(":") ? [`*://${d}/*`] : [`*://${d}/*`, `*://*.${d}/*`]));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
    return;
  }
  const full = { ...script, matches, runAt: "document_start", allFrames: true, persistAcrossSessions: true };
  if (existing.length) await chrome.scripting.updateContentScripts([full]);
  else await chrome.scripting.registerContentScripts([full]);
}

// Keeps the page script registered on every site that has profiles.
const registerPageScript = (domains) => registerScript({ id: "ss-pages", js: ["ss-page.js"] }, domains);

// ---- Keeping the active profile current ----

const timers = new Map();

// Cookies of a group removed from outside Session Switch since its last sync: through the browser's
// cookie API or its settings. A site's own pages and responses expire or replace their cookies
// instead, except for a response that clears the site's data, which is watched for below.
const outsideRemovals = new Map();
const siteCleared = new Map(); // group id -> until when removals come from the site clearing its own data

chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  if (cookie.storeId !== STORE || cookie.name === PROBE) return;
  const outside = removed && cause === "explicit" && !isOwnRemoval(cookie.name);
  getGroups().then(() => {
    const group = groupFor(bare(cookie.domain));
    if (group && !group.activeId && !group.paused && !group.switching) {
      if (!removed && score(cookie) >= 4) recognizeSoon(group.id);
      return;
    }
    if (!group?.activeId) return;
    if (outside && !((siteCleared.get(group.id) || 0) > Date.now())) outsideRemovals.set(group.id, (outsideRemovals.get(group.id) || 0) + 1);
    clearTimeout(timers.get(group.id));
    timers.set(group.id, setTimeout(() => {
      timers.delete(group.id);
      serial(() => syncCookies(group.id));
    }, 1000));
  });
});

// A site clearing its own data (often how it logs out) removes cookies the way the browser's cookie
// API does; those removals are the site's.
chrome.webRequest.onHeadersReceived.addListener((details) => {
  const header = details.responseHeaders?.find((h) => h.name.toLowerCase() === "clear-site-data");
  if (!header || !/cookies|\*/.test(header.value || "")) return;
  getGroups().then(() => {
    const group = groupFor(hostOf(details.url));
    if (group) siteCleared.set(group.id, Date.now() + 2000);
  });
}, { urls: ["<all_urls>"] }, ["responseHeaders", "extraHeaders"]);

// Whether the login in the browser was swapped or cleared without Session Switch since the profile
// was saved: most of its cookies removed from outside, and its login cookie gone or replaced. Reads
// and resets the count of outside removals.
function changedOutside(group, profile, cookies) {
  const outside = outsideRemovals.get(group.id) || 0;
  outsideRemovals.delete(group.id);
  const before = loginOf(profile.cookies, group, profile.login);
  if (!["in", "session", "expired"].includes(before.state) || outside < 2 || outside * 2 < profile.cookies.length) return false;
  const value = (list) => list.filter((c) => c.name === before.name).map((c) => c.value).sort().join("\n");
  return value(profile.cookies) !== value(cookies);
}

// The profile that was active keeps its last login, and the popup asks what to do with the one in
// the browser: save it as a new profile, update the profile with it, or put the profile's back. The
// site keeps going through the profile's proxy meanwhile.
// With card, the question also shows once on a page of the site (see The card in the page); not
// when it comes up right before a switch, where the popup asks it.
async function pause(group, profile, card = true) {
  group.paused = profile.id;
  group.activeId = null;
  group.cardShown = !card;
  await saveGroups();
  await groupsChanged();
  if (card) await showCard(group);
}

// A login in the browser that a saved profile already holds (the same value of that profile's
// login cookie: after restoring a backup, say, or logging in again with the same session) makes
// that profile the active one, with the browser's copy of the login, which is the newer one.
async function recognize(groupId) {
  const group = groupById(groupId);
  if (!group || group.activeId || group.paused || group.switching) return false;
  const cookies = await readCookies(group.domains);
  // Only a login cookie found with confidence (or picked), with a value long enough to be a
  // session of its own (not "yes" or "1"), and only when exactly one profile has it.
  const matches = (await getProfiles(group.order)).filter((profile) => {
    const { name, how } = loginOf(profile.cookies, group, profile.login);
    if (!name || how === "guess") return false;
    const saved = profile.cookies.filter((c) => c.name === name && c.value.length >= 16).map((c) => c.value);
    return saved.length && cookies.some((c) => c.name === name && saved.includes(c.value));
  });
  for (const profile of matches.length === 1 ? matches : []) {
    group.activeId = profile.id;
    group.pending = [];
    profile.cookies = cookies;
    profile.syncedAt = Date.now();
    remember(profile, group);
    await putProfile(profile);
    await saveGroups();
    await applyProxy();
    await groupsChanged();
    return true;
  }
  return false;
}
const recognizeSoon = (groupId) => {
  clearTimeout(timers.get(groupId));
  timers.set(groupId, setTimeout(() => {
    timers.delete(groupId);
    serial(() => recognize(groupId));
  }, 1000));
};

async function syncCookies(groupId, adopting = false) {
  const group = groupById(groupId);
  const profile = group?.switching ? null : await getProfile(group?.activeId);
  if (!profile) return;
  const cookies = await readCookies(group.domains);
  if (!adopting && changedOutside(group, profile, cookies)) return pause(group, profile);
  if (sameCookies(profile.cookies, cookies)) return;
  profile.cookies = cookies;
  profile.syncedAt = Date.now();
  remember(profile, group);
  await putProfile(profile);
  notify();
}

// ---- Messages ----

const POPUP = {
  state: (m) => describe(m.tabId),
  save: (m) => saveCurrent(m.tabId, m.name),
  add: (m) => addProfile(m.tabId, m.name, m.discard, m.proxy),
  switch: (m) => switchTab(m.tabId, m.profileId, m.discard),
  rename: (m) => rename(m.profileId, m.name),
  remove: (m) => removeOne(m.profileId),
  reorder: (m) => reorder(m.groupId, m.ids),
  hue: (m) => setHue(m.profileId, m.hue),
  details: (m) => details(m.profileId),
  "login-cookie": (m) => setGroup(m.groupId, (group) => (group.loginCookie = m.name || null)),
  sites: () => sitesInfo(),
  open: (m) => openSite(m.site),
  "drive-info": () => driveInfo(),
  link: (m) => link(m.groupId, m.domain),
  unlink: (m) => unlink(m.groupId, m.domain),
  "proxy-profile": (m) => setProfileProxy(m.profileId, m.proxy),
  adopt: (m) => adopt(m.tabId),
};

// Settings-page requests that don't wait in the queue with switches and saves.
const UNQUEUED = {
  "proxy-info": () => proxyInfo(),
  // Deriving the key takes a moment; it doesn't hold up switches.
  "drive-on": (m) => driveOn(m.passphrase),
  "drive-off": () => chrome.storage.local.remove(["ssDriveKey", "ssDriveCache"]).then(notify).then(driveInfo),
  "drive-open": (m) => driveOpen(null, m.passphrase, false),
  // The encrypted backup file (settings): made and opened here, with the same sealing.
  "file-seal": (m) => sealFile(m.passphrase),
  "file-open": (m) => openFile(m.text, m.passphrase),
  webrtc: (m) => chrome.storage.local.set({ ssWebrtc: !!m.on }).then(applyProxy).then(proxyInfo),
};

const PAGE = {
  "page-hello": pageHello,
  "page-storage": (m, sender) => serial(() => pageStorage(m, sender)),
  "card-choice": (m, sender) => serial(() => getGroups().then(() => cardChoice(m.choice, sender.tab.id))),
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== "string" || !message.type.startsWith("ss:")) return;
  const type = message.type.slice(3);
  const fromExtension = sender.url?.startsWith(chrome.runtime.getURL(""));
  const own = (table) => (Object.hasOwn(table, type) ? table[type] : null);
  const unqueued = fromExtension ? own(UNQUEUED) : null;
  const handler = unqueued || (fromExtension ? own(POPUP) : sender.tab ? own(PAGE) : null);
  if (!handler) return;
  const run = fromExtension && !unqueued ? serial(() => getGroups().then(() => handler(message, sender))) : handler(message, sender);
  run.then(reply, (e) => reply({ error: e?.message || String(e) }));
  return true;
});

// Tells an open popup to redraw.
function notify() {
  chrome.runtime.sendMessage({ type: "ss:changed" }).catch(() => {});
}

// ---- Popup operations ----

// The site of a tab, and its group if it has profiles. With parked, a tab a switch parked counts as
// its site's page, and so does a tab on its way back; the popup keeps showing the site's profiles
// while the switch finishes.
async function locate(tabId, parked = false) {
  const tab = await chrome.tabs.get(tabId);
  const host = hostOf(tab.url || "") || (parked && (hostOf(tab.pendingUrl || "") || hostOf(parkedReturn(tab.url)))) || "";
  if (!host && parked) {
    const group = allGroups().find((g) => g.switching?.tabs.includes(tabId));
    if (group) return { tab, host: group.domains[0], group, domains: group.domains };
  }
  if (!host) throw new Error("Profiles work on http and https pages only.");
  const group = groupFor(host);
  if (group) return { tab, host, group, domains: group.domains };
  const site = await validSite(host);
  if (!site) throw new Error("This site can't keep cookies, so it can't have profiles.");
  return { tab, host, group, domains: [site] };
}

// Whether cookies look like they hold a login (analytics and preference cookies don't).
const holdsLogin = (cookies) => cookies.some((c) => score(c) >= 2);

async function describe(tabId) {
  let place;
  try {
    place = await locate(tabId, true);
  } catch (e) {
    return { supported: false, reason: e.message };
  }
  const { host, group, domains } = place;
  if (group) await recognize(group.id);
  const jar = await readCookies(domains);
  const profiles = group ? await getProfiles(group.order) : [];
  const proxies = await proxyStatuses(profiles);
  return {
    supported: true, host, domains, proxy: await proxyInfo(), drive: (await driveInfo()).on,
    group: group && { id: group.id, loginCookie: group.loginCookie, activeId: group.activeId },
    paused: ((paused) => paused && { id: paused.id, name: paused.name })(group?.paused && profiles.find((p) => p.id === group.paused)),
    unsaved: !group?.activeId && holdsLogin(jar),
    profiles: profiles.map((p, i) => {
      const active = p.id === group.activeId;
      return {
        id: p.id, name: p.name, hue: p.hue, active, lastUsed: p.lastUsed, syncedAt: p.syncedAt,
        login: loginOf(active ? jar : p.cookies, group, p.login), proxy: proxies[i],
      };
    }),
  };
}

function cleanName(name, group) {
  const text = String(name || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return text || `Profile ${group.order.length + 1}`;
}

// Saves the login that is in the browser now as a new profile, which becomes the active one.
async function saveCurrent(tabId, name) {
  const { tab, group: found, domains } = await locate(tabId);
  if (found?.activeId) throw new Error("This site already has an active profile, and it is saved automatically.");
  const group = found || makeGroup(domains[0]);
  const profile = makeProfile(group, cleanName(name, group));
  profile.cookies = await readCookies(group.domains);
  remember(profile, group);
  const { found: storage, problems } = await readStorage(await siteTabs(group.domains), group.domains, tab.id, true);
  group.activeId = profile.id;
  group.pending = [];
  delete group.paused;
  await putProfile(profile);
  await putData(profile.id, mergeStorage({}, storage));
  await saveGroups();
  await groupsChanged();
  return { ok: true, problems, name: profile.name };
}

// A login changed from outside that a switch is about to replace: the active profile is paused
// first, so the question about saving the current login comes up as for any unsaved login.
async function pauseIfChangedOutside(group) {
  const profile = group && !group.switching && await getProfile(group.activeId);
  if (profile && changedOutside(group, profile, await readCookies(group.domains))) await pause(group, profile, false);
}

// Whether the browser holds a login for the site that no profile has, which a switch would lose.
async function unsaved(group, domains) {
  return !group?.activeId && holdsLogin(await readCookies(domains));
}

// Starts a new, empty profile: the site is logged out, and whatever login comes next is saved in it.
// With proxy ({ country }), the new profile uses it from its very first request.
async function addProfile(tabId, name, discard, proxy) {
  const { tab, group: found, domains } = await locate(tabId);
  await pauseIfChangedOutside(found);
  if (!discard && await unsaved(found, domains)) return { confirm: true };
  if (proxy) await assertProxyRoom(domains[0], proxy.country);
  const group = found || makeGroup(domains[0]);
  const profile = makeProfile(group, cleanName(name, group));
  if (proxy) profile.proxy = { country: /^[A-Z]{2}$/.test(proxy.country) ? proxy.country : "" };
  await putProfile(profile);
  try {
    return { ...await swap(group, profile, tab), fresh: true, name: profile.name };
  } catch (e) {
    group.order = group.order.filter((id) => id !== profile.id);
    await removeProfile(profile.id);
    if (!group.order.length) dropGroup(group.id);
    await saveGroups();
    throw e;
  } finally {
    await groupsChanged();
  }
}

async function switchTab(tabId, profileId, discard) {
  const { tab, group } = await locate(tabId);
  const profile = await getProfile(profileId);
  if (!group || !profile || profile.groupId !== group.id) throw new Error("That profile belongs to a different site.");
  await pauseIfChangedOutside(group);
  if (group.activeId === profile.id) return { ok: true, problems: [] };
  if (!discard && await unsaved(group, group.domains)) return { confirm: true };
  const result = await swap(group, profile, tab);
  await groupsChanged();
  return result;
}

const list = (cookies) => unique(cookies.map((c) => c.name ?? c)).join(", ");

// Moves the site from its active profile to incoming. mainTab is the tab the switch started from.
async function swap(group, incoming, mainTab) {
  const domains = group.domains;
  const https = (mainTab.url || "").startsWith("https:");
  const problems = [];
  const tabs = await siteTabs(domains);
  const outgoing = await getProfile(group.activeId);

  // 1. The site's frames inside its own pages can only be read while those pages run.
  const frames = outgoing ? await readStorage(tabs, domains, mainTab.id, false) : null;

  // 2. Stop the site's pages. The switch is noted first, so that if the extension stops halfway,
  // its next start can put things back.
  group.switching = { phase: "parking", from: outgoing?.id || null, https, mainTabId: mainTab.id, tabs: tabs.map((t) => t.id) };
  await saveGroups();
  const picture = await snapshot(mainTab);
  const { parked, reload, stuck } = await park(tabs, new Map(picture ? [[mainTab.id, picture]] : []));
  if (stuck.length) {
    await unpark(parked);
    delete group.switching;
    await saveGroups();
    throw new Error("A tab of this site didn't leave its page (it may be asking whether to leave). Nothing was switched.");
  }
  await sleep(100); // responses already on their way may still set cookies

  try {
    // 3. Save the outgoing profile as it is now that nothing of the site runs: its pages have also
    // run their unload code, and the parked pages still reach each origin's storage.
    let outData = {}, keepIdb = new Set();
    const live = outgoing && await readCookies(domains);
    // A login put in from outside just before the switch isn't saved over the outgoing profile.
    if (outgoing && changedOutside(group, outgoing, live)) {
      problems.push(`The login on ${domains[0]} had been changed outside Session Switch, so ${outgoing.name} kept its own login and that one was discarded.`);
      outData = await getData(outgoing.id);
    } else if (outgoing) {
      const settled = await readStorage(parked.map((p) => p.tab), domains, mainTab.id, true);
      problems.push(...frames.problems, ...settled.problems);
      keepIdb = settled.incomplete;
      outgoing.cookies = live;
      outgoing.syncedAt = outgoing.lastUsed = Date.now();
      remember(outgoing, group);
      outData = mergeStorage(mergeStorage(await getData(outgoing.id), frames.found), settled.found);
      await putProfile(outgoing);
      await putData(outgoing.id, outData);
    }
    group.switching.phase = "swapping";
    await saveGroups();

    // 4. Cookies.
    const left = await clearCookies(domains, https);
    if (left.length) problems.push(`These cookies couldn't be removed: ${list(left)}.`);
    const { expired, failed } = await restoreCookies(incoming.cookies.filter((c) => inScope(bare(c.domain), domains)), https);
    if (failed.length) problems.push(`These cookies couldn't be restored: ${list(failed)}.`);

    // 5. Storage.
    problems.push(...await placeStorage(group, await getData(incoming.id), parked, mainTab.id, keepIdb, Object.keys(outData)));

    group.activeId = incoming.id;
    group.epoch += 1;
    delete group.switching;
    delete group.paused;
    incoming.lastUsed = Date.now();
    await putProfile(incoming);
    await saveGroups();
    // The site's proxy follows the profile, before its pages load again.
    await applyProxy();
    const [proxy] = await proxyStatuses([incoming]);
    if (proxy && !proxy.ok) problems.push(`This profile's proxy can't be used, so the site won't open: ${proxy.reason}`);
    return { ok: true, problems, expired: expired.length, login: loginOf(incoming.cookies, group, incoming.login) };
  } catch (e) {
    // Put the outgoing profile back, so the browser is never left halfway between two profiles.
    if (group.switching?.phase === "swapping") await putBack(group, outgoing, https, parked, mainTab.id);
    else {
      delete group.switching;
      await saveGroups();
    }
    throw e;
  } finally {
    // What happened to the cookies until now is this switch's doing.
    outsideRemovals.delete(group.id);
    await unpark(parked);
    for (const tab of reload) chrome.tabs.reload(tab.id).catch(() => {});
  }
}

// Writes a profile's storage into the parked tabs: each origin's localStorage and app data once,
// and sessionStorage into the main tab only (the other tabs start without). Origins with no open
// page have their localStorage cleared now and filled the next time one of their pages opens (their
// app data stays). keepIdb lists origins whose app data is left alone; also lists origins the
// outgoing profile used.
async function placeStorage(group, data, parked, mainTabId, keepIdb = new Set(), also = []) {
  const problems = [], written = new Set();
  for (const { tab, origin } of parked) {
    if (!/^https?:/.test(origin)) continue;
    const saved = data[origin] || {};
    const first = !written.has(origin);
    written.add(origin);
    // App data (IndexedDB) is always part of a profile: the outgoing profile's was just saved, so the
    // incoming one's replaces it (none yet: the site starts without). Left as it is only when the
    // outgoing copy couldn't be saved in full.
    let idb = null;
    if (first) {
      if (keepIdb.has(origin)) problems.push(`The app data on ${origin} was left as it was, because the outgoing profile's copy couldn't be saved in full (it may be too large).`);
      else idb = saved.idb || [];
    }
    const session = tab.id === mainTabId ? saved.session || {} : {};
    problems.push(...await writeParked(tab.id, first ? saved.local || {} : null, session, idb));
  }
  const elsewhere = unique([...also, ...Object.keys(data), ...group.origins, ...group.pending])
    .filter((origin) => !written.has(origin) && inScope(hostOf(origin), group.domains));
  if (elsewhere.length) {
    // App data stays: it's only ever copied from open pages, so what these origins have now was
    // never saved, and clearing it could lose it.
    await chrome.browsingData.remove({ origins: elsewhere }, { localStorage: true });
  }
  group.pending = elsewhere.filter((origin) => Object.keys(data[origin]?.local || {}).length);
  return problems;
}

// Returns the site to the profile a switch started from: its cookies, its storage in the parked
// tabs and, for other origins, on their next visit. Then forgets the switch.
async function putBack(group, profile, https, parked, mainTabId) {
  if (profile) {
    await clearCookies(group.domains, https);
    await restoreCookies(profile.cookies.filter((c) => inScope(bare(c.domain), group.domains)), https);
    await placeStorage(group, await getData(profile.id), parked, mainTabId);
  }
  group.epoch += 1;
  delete group.switching;
  await saveGroups();
}

async function rename(profileId, name) {
  const profile = await getProfile(profileId);
  if (!profile) return { ok: false };
  profile.name = cleanName(name, groupById(profile.groupId));
  await putProfile(profile);
  await saveProxySites();
  notify();
  return { ok: true };
}

async function setHue(profileId, hue) {
  const profile = await getProfile(profileId);
  if (!profile) return { ok: false };
  if (!Number.isFinite(Number(hue))) return { ok: false };
  profile.hue = Math.round(Number(hue)) % 360;
  await putProfile(profile);
  notify();
  return { ok: true };
}

// After the login was changed from outside: the profile that was active takes the login that is in
// the browser now (cookies and the open pages' storage), and is active again.
async function adopt(tabId) {
  const { tab, group } = await locate(tabId);
  const profile = await getProfile(group?.paused);
  if (!profile) throw new Error("There is no profile waiting to be updated.");
  group.activeId = profile.id;
  delete group.paused;
  await saveGroups();
  await syncCookies(group.id, true);
  const { found } = await readStorage(await siteTabs(group.domains), group.domains, tab.id, true);
  await putData(profile.id, mergeStorage({}, found));
  group.pending = [];
  await saveGroups();
  await applyProxy();
  await groupsChanged();
  return { ok: true, name: profile.name };
}

// Puts a site's profiles in the order given (the same profiles, rearranged).
async function reorder(groupId, ids) {
  const group = groupById(groupId);
  if (!group || !Array.isArray(ids) || ids.length !== group.order.length || !group.order.every((id) => ids.includes(id))) return { ok: false };
  group.order = [...ids];
  await saveGroups();
  notify();
  return { ok: true };
}

// Deletes a profile. Deleting the active one leaves its login in the browser, no longer tracked.
async function removeOne(profileId) {
  const profile = await getProfile(profileId);
  const group = groupById(profile?.groupId);
  if (!group) return { ok: false };
  group.order = group.order.filter((id) => id !== profileId);
  if (group.paused === profileId) delete group.paused;
  if (group.activeId === profileId) {
    group.activeId = null;
    group.pending = [];
  }
  await removeProfile(profileId);
  if (!group.order.length) dropGroup(group.id);
  await saveGroups();
  await applyProxy();
  await groupsChanged();
  return { ok: true };
}

async function details(profileId) {
  const profile = await getProfile(profileId);
  const group = groupById(profile?.groupId);
  if (!group) throw new Error("That profile no longer exists.");
  const active = group.activeId === profile.id;
  const cookies = active ? await readCookies(group.domains) : profile.cookies;
  const data = await getData(profile.id);
  return {
    profile: { id: profile.id, name: profile.name, hue: profile.hue, active, createdAt: profile.createdAt, lastUsed: profile.lastUsed, syncedAt: profile.syncedAt },
    group: { id: group.id, domains: group.domains, loginCookie: group.loginCookie },
    login: loginOf(cookies, group, profile.login),
    cookies: cookies
      .map((c) => ({
        name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure,
        partitioned: !!c.partitionKey, expires: c.session ? null : Math.round(c.expirationDate * 1000), score: score(c),
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
    storage: Object.entries(data).map(([origin, d]) => ({
      origin, local: Object.keys(d.local || {}).length, session: Object.keys(d.session || {}).length,
      databases: (d.idb || []).length, savedAt: d.savedAt,
    })),
  };
}

// Every site with profiles, for Settings → session switch: its domains (the first is the site,
// the rest are linked), and its profiles' names.
async function sitesInfo() {
  const sites = [];
  for (const group of allGroups()) {
    const profiles = await getProfiles(group.order);
    sites.push({ id: group.id, domains: group.domains, profiles: profiles.map((p) => p.name) });
  }
  return { sites: sites.sort((a, b) => a.domains[0].localeCompare(b.domains[0])) };
}

// From the proxy settings: brings up a tab of the site (a new one if none is open) and, where
// Chrome allows it without a click on the toolbar, the popup or side panel on it.
async function openSite(site) {
  const group = groupFor(String(site || ""));
  if (!group) throw new Error("That site has no profiles any more.");
  const tab = (await siteTabs(group.domains))[0] || await chrome.tabs.create({ url: `https://${group.domains[0]}/` });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
  } catch {
    await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
  return { ok: true };
}

async function setGroup(groupId, change) {
  const group = groupById(groupId);
  if (!group) return { ok: false };
  change(group);
  await saveGroups();
  notify();
  return { ok: true };
}

// Adds another site to this one's profiles, for sites that keep part of their login on a second
// domain. The active profile takes in that site's cookies from now on; the others start without them.
async function link(groupId, input) {
  const group = groupById(groupId);
  if (!group) return { ok: false };
  const text = String(input || "").trim();
  const host = hostOf(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (!host) throw new Error("Enter a site, like example.com.");
  const site = await validSite(host);
  if (!site) throw new Error(`${host} can't keep cookies, so it can't be linked.`);
  if (inScope(site, group.domains)) throw new Error(`${site} is already part of this site's profiles.`);
  if (allGroups().some((g) => g !== group && (inScope(site, g.domains) || g.domains.some((d) => inScope(d, [site]))))) {
    throw new Error(`${site} has profiles of its own. Delete them before linking it here.`);
  }
  group.domains.push(site);
  await saveGroups();
  await applyProxy();
  await groupsChanged();
  return { ok: true, site };
}

// Takes a linked site out again. Its cookies and storage leave every profile; the browser keeps
// whatever login it has there now.
async function unlink(groupId, domain) {
  const group = groupById(groupId);
  if (!group || group.domains[0] === domain) return { ok: false };
  group.domains = group.domains.filter((d) => d !== domain);
  const keep = (origin) => inScope(hostOf(origin), group.domains);
  group.origins = group.origins.filter(keep);
  group.pending = group.pending.filter(keep);
  for (const profile of await getProfiles(group.order)) {
    profile.cookies = profile.cookies.filter((c) => inScope(bare(c.domain), group.domains));
    const data = await getData(profile.id);
    for (const origin of Object.keys(data)) if (!keep(origin)) delete data[origin];
    await putProfile(profile);
    await putData(profile.id, data);
  }
  await saveGroups();
  await applyProxy();
  await groupsChanged();
  return { ok: true };
}

// Adds the profiles of an opened backup. Each joins the site it belongs to here (or a new one),
// inactive; a profile that is already here is left alone.
async function importBackup(payload) {
  let added = 0, skipped = 0, noRoom = 0;
  const proxied = new Set(); // "site|country" given a proxy by this import, not yet in ssProxySites
  const text = (value, fallback) => (typeof value === "string" ? value : fallback);
  for (const saved of Object.values(payload?.groups || {})) {
    // Only domains the browser accepts as a site: never a public suffix like com.
    const domains = [];
    for (const d of Array.isArray(saved.domains) ? saved.domains : []) {
      const site = typeof d === "string" ? await validSite(d) : null;
      if (site && !domains.includes(site)) domains.push(site);
    }
    if (!domains.length) continue;
    let group = allGroups().find((g) => g.domains.some((d) => inScope(d, domains) || domains.some((e) => inScope(e, [d]))));
    if (!group) {
      group = makeGroup(domains[0]);
      group.domains = domains;
      group.loginCookie = text(saved.loginCookie, null);
    }
    for (const id of Array.isArray(saved.order) ? saved.order : []) {
      const source = payload.profiles?.[id];
      if (typeof id !== "string" || !source || await getProfile(id)) {
        skipped++;
        continue;
      }
      const cookies = (Array.isArray(source.cookies) ? source.cookies : [])
        .filter((c) => typeof c?.name === "string" && typeof c.domain === "string" && typeof c.value === "string" && inScope(bare(c.domain), group.domains));
      const data = {};
      for (const [origin, d] of Object.entries(payload.data?.[id] || {})) {
        if (inScope(hostOf(origin), group.domains) && d && typeof d === "object") data[origin] = d;
      }
      let proxy = source.proxy && typeof source.proxy === "object" ? { country: /^[A-Z]{2}$/.test(source.proxy.country) ? source.proxy.country : "" } : null;
      // A proxy takes one of the plan's sites (one per site and country): kept only while there's room.
      const slot = proxy && `${group.domains[0]}|${proxy.country}`;
      if (proxy && !proxied.has(slot)) {
        if (await proxyRoom(group.domains[0], proxy.country, proxied.size)) proxied.add(slot);
        else {
          proxy = null;
          noRoom++;
        }
      }
      group.order.push(id);
      await putProfile({
        id, groupId: group.id, name: text(source.name, "Profile").slice(0, 40), hue: Number(source.hue) % 360 || 210,
        createdAt: Number(source.createdAt) || Date.now(), lastUsed: Number(source.lastUsed) || Date.now(),
        syncedAt: Number(source.syncedAt) || Date.now(), cookies, login: text(source.login, null), proxy,
      });
      await putData(id, data);
      added++;
    }
    if (!group.order.length) dropGroup(group.id);
  }
  await saveGroups();
  for (const group of allGroups()) await recognize(group.id);
  await groupsChanged();
  return { ok: true, added, skipped, noRoom };
}

// ---- Drive backups ----
// Off unless turned on in Settings → session switch, with a passphrase. Then every profile, without
// its app data (IndexedDB) copies, goes into Extra Guac's Drive snapshots (bg-backup.js), sealed with a key
// derived from the passphrase (PBKDF2, AES-GCM): Drive only gets ciphertext. The key stays in this
// browser (ssDriveKey: { salt, iterations, key }) so scheduled backups can seal without asking; the
// passphrase itself isn't kept. The same sealed copy is used again while the profiles haven't
// changed (ssDriveCache), so an unchanged snapshot stays unchanged. Restoring a snapshot adds its
// profiles next to the ones here: right away when this browser has the key, else it waits in
// ssDrivePending until the passphrase is given in settings.

const DRIVE_ITERATIONS = 600000;
const b64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const unb64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function driveInfo() {
  const { ssDriveKey, ssDrivePending } = await chrome.storage.local.get(["ssDriveKey", "ssDrivePending"]);
  return { on: !!ssDriveKey, pending: ssDrivePending ? { profiles: ssDrivePending.profiles || 0, at: ssDrivePending.at || 0 } : null };
}

async function driveOn(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 10) throw new Error("Use a passphrase of at least 10 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, DRIVE_ITERATIONS);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  await chrome.storage.local.set({ ssDriveKey: { salt: b64(salt), iterations: DRIVE_ITERATIONS, key: b64(raw) } });
  await chrome.storage.local.remove("ssDriveCache");
  notify();
  return driveInfo();
}

// The profiles, sealed for a snapshot, or null when it's off.
async function driveSeal() {
  const { ssDriveKey, ssDriveCache } = await chrome.storage.local.get(["ssDriveKey", "ssDriveCache"]);
  if (!ssDriveKey) return null;
  await getGroups();
  const payload = { groups: {}, profiles: {}, data: {} };
  for (const group of allGroups()) {
    payload.groups[group.id] = { domains: group.domains, order: group.order, loginCookie: group.loginCookie };
    for (const profile of await getProfiles(group.order)) {
      payload.profiles[profile.id] = profile;
      const data = {};
      for (const [origin, d] of Object.entries(await getData(profile.id))) data[origin] = { local: d.local, session: d.session, savedAt: d.savedAt };
      payload.data[profile.id] = data;
    }
  }
  const text = JSON.stringify(payload);
  // When profiles were last saved or used doesn't make a snapshot new (they change all the time).
  const lasting = JSON.stringify(payload, (k, v) => (["syncedAt", "lastUsed", "savedAt"].includes(k) ? undefined : v));
  const hash = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ssDriveKey.salt + lasting))));
  if (ssDriveCache?.hash === hash) return ssDriveCache.sealed;
  const key = await crypto.subtle.importKey("raw", unb64(ssDriveKey.key), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const sealed = {
    format: "session-switch-drive", version: 1, profiles: Object.keys(payload.profiles).length, at: Date.now(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ssDriveKey.iterations, salt: ssDriveKey.salt },
    cipher: { name: "AES-GCM", iv: b64(iv) }, data: b64(data),
  };
  await chrome.storage.local.set({ ssDriveCache: { hash, sealed } });
  // As stored (storage orders its keys its own way), so the next unchanged snapshot reads the same.
  return (await chrome.storage.local.get("ssDriveCache")).ssDriveCache.sealed;
}

// Opens sealed profiles (from a restored snapshot, or the one waiting) and adds them. With no
// passphrase, only this browser's own key is tried, and the profiles wait if it doesn't fit.
// queued: called from the message queue already (adding them mustn't queue behind itself).
async function driveOpen(sealed, passphrase, queued = true) {
  const { ssDrivePending } = await chrome.storage.local.get("ssDrivePending");
  const fromPending = !sealed;
  sealed ||= ssDrivePending;
  if (sealed?.format !== "session-switch-drive" || sealed.version !== 1) throw new Error("There are no profiles waiting to be restored.");
  const iterations = Number(sealed.kdf?.iterations);
  if (!(iterations >= 100000 && iterations <= 5000000)) throw new Error("This backup uses settings that are not supported.");
  let key = null;
  if (passphrase) key = await deriveKey(passphrase, unb64(sealed.kdf.salt), iterations);
  else {
    const { ssDriveKey } = await chrome.storage.local.get("ssDriveKey");
    if (ssDriveKey?.salt === sealed.kdf.salt) key = await crypto.subtle.importKey("raw", unb64(ssDriveKey.key), "AES-GCM", false, ["decrypt"]);
  }
  let payload = null;
  if (key) {
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.cipher.iv) }, key, unb64(sealed.data));
      payload = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      if (passphrase) throw new Error("The passphrase is wrong, or the backup is damaged.");
    }
  }
  if (!payload) {
    await chrome.storage.local.set({ ssDrivePending: sealed });
    notify();
    return { ok: true, pending: true };
  }
  const result = queued ? await importBackup(payload) : await serial(() => getGroups().then(() => importBackup(payload)));
  if (fromPending || ssDrivePending?.data === sealed.data) await chrome.storage.local.remove("ssDrivePending");
  return result;
}

// ---- The encrypted backup file (Settings → session switch) ----
// { format: "session-switch-backup", version 1, kdf, cipher, data }: every profile, app data copies
// included, sealed with the passphrase given (not kept). Opening one adds its missing profiles.

async function sealFile(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 10) throw new Error("Use a passphrase of at least 10 characters.");
  await getGroups();
  const payload = { groups: {}, profiles: {}, data: {} };
  for (const group of allGroups()) {
    payload.groups[group.id] = group;
    for (const profile of await getProfiles(group.order)) {
      payload.profiles[profile.id] = profile;
      payload.data[profile.id] = await getData(profile.id);
    }
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, DRIVE_ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  return {
    file: {
      format: "session-switch-backup", version: 1, created: new Date().toISOString(),
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: DRIVE_ITERATIONS, salt: b64(salt) },
      cipher: { name: "AES-GCM", iv: b64(iv) }, data: b64(data),
    },
    count: Object.keys(payload.profiles).length,
  };
}

async function openFile(text, passphrase) {
  let box;
  try {
    box = JSON.parse(text);
  } catch {
    box = null;
  }
  if (box?.format !== "session-switch-backup" || box.version !== 1) throw new Error("This file isn't a Session Switch backup.");
  const iterations = Number(box.kdf?.iterations);
  if (!(iterations >= 100000 && iterations <= 5000000)) throw new Error("This backup uses settings that are not supported.");
  const key = await deriveKey(String(passphrase || ""), unb64(box.kdf.salt), iterations);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.cipher.iv) }, key, unb64(box.data))));
  } catch {
    throw new Error("The passphrase is wrong, or the file is damaged.");
  }
  return serial(() => getGroups().then(() => importBackup(payload)));
}

globalThis.sessionDriveSeal = driveSeal;
globalThis.sessionDriveRestore = (sealed) => driveOpen(sealed, null, false);

// ---- Proxy ----
// A profile's proxy uses Extra Guac's Webshare account (getProxy in bg-proxy.js): its key, its
// proxies and their logins. bg-proxy.js puts the profiles' routes (sessionProxyRoutes) into its
// routing script. While that script is being replaced, or Chrome's proxy setting is held elsewhere,
// it blocks the profiles' sites (sessionBlock), so they never open over the own connection, and
// WebRTC is off on them (sessionGuard) unless turned on in the settings.

const CLOSED = "PROXY 127.0.0.1:9";
const BLOCK_RULE = 9001;
const controlledElsewhere = (level) => level === "not_controllable" || level === "controlled_by_other_extensions";
const webrtcOff = async () => (await chrome.storage.local.get("ssWebrtc")).ssWebrtc !== false;

// Each domain that goes through a profile's proxy now, with the routing answer for it: the
// proxies of the profile's country (any country for ''), or a closed port when there are none.
async function proxyRoutes(cfg, st) {
  await getGroups();
  const groups = allGroups();
  const routes = {};
  // A paused profile's site keeps its route: the login in the browser is still that site's.
  for (const profile of await getProfiles(groups.map((g) => g.activeId || g.paused).filter(Boolean))) {
    if (!profile.proxy) continue;
    const group = groups.find((g) => g.id === profile.groupId);
    const answer = cfg.key && !st.badKey ? proxyChain(st, profile.proxy.country || "", []) : CLOSED;
    for (const domain of group?.domains || []) routes[domain] = answer;
  }
  return routes;
}

// Blocks every request to these domains (none: lifts the block). Kept across browser restarts.
function block(domains) {
  const addRules = domains.length ? [{
    id: BLOCK_RULE, priority: 1, action: { type: "block" },
    condition: {
      requestDomains: domains,
      resourceTypes: ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"],
    },
  }] : [];
  return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [BLOCK_RULE], addRules });
}

globalThis.sessionProxyRoutes = proxyRoutes;
globalThis.sessionBlock = block;
globalThis.sessionGuard = async (domains) => registerScript(
  { id: "ss-webrtc-guard", js: ["ss-webrtc-guard.js"], world: "MAIN", matchOriginAsFallback: true }, await webrtcOff() ? domains : []);

// The sites whose profiles use a proxy, kept in storage.local "ssProxySites" for the proxy
// settings and the popup's proxy section, where they're listed and count toward the plan's sites:
// [{ site, domains, profiles: [{ name, hue, country, inUse }] }], one per site with profiles; inUse
// marks the profile whose login (and route) the site has now.
async function saveProxySites() {
  await getGroups();
  const list = [];
  for (const group of allGroups()) {
    const inUse = group.activeId || group.paused;
    const profiles = (await getProfiles(group.order)).filter((p) => p.proxy).map((p) => ({ name: p.name, hue: p.hue, country: p.proxy.country || "", inUse: p.id === inUse }));
    if (profiles.length) list.push({ site: group.domains[0], domains: group.domains, profiles });
  }
  const { ssProxySites = [] } = await chrome.storage.local.get("ssProxySites");
  if (JSON.stringify(list) !== JSON.stringify(ssProxySites)) await chrome.storage.local.set({ ssProxySites: list });
}

// A profile's proxy takes one of the plan's sites (the free plan has 20), shared with the proxy's
// own list, one per site and country (TT.proxySlots): a site already going through that country,
// in the list or on another profile, takes no more. extra: places about to be added that
// ssProxySites doesn't have yet.
async function proxyRoom(site, country, extra = 0) {
  country = /^[A-Z]{2}$/.test(country || "") ? country : "";
  const [{ cfg, st }, { ssProxySites = [] }] = await Promise.all([getProxy(), chrome.storage.local.get("ssProxySites")]);
  const slots = TT.proxySlots(cfg, st, ssProxySites);
  return slots.has(site, country || "") || slots.used + extra < slots.max;
}
async function assertProxyRoom(site, country) {
  if (await proxyRoom(site, country)) return;
  const { st } = await getProxy();
  const free = st.plan?.free !== false;
  throw new Error(`All ${TT.PROXY_LIMITS[free ? "free" : "paid"]} proxy sites of the ${free ? "free plan" : "plan"} are in use. Remove one in the proxy settings to give this site a proxy.`);
}

// How each profile's proxy stands: null for none, else { ok, country, reason }.
async function proxyStatuses(profiles) {
  const { cfg, st } = await getProxy();
  const elsewhere = controlledElsewhere((await chrome.proxy.settings.get({})).levelOfControl);
  return profiles.map((profile) => {
    if (!profile?.proxy) return null;
    const country = profile.proxy.country || "";
    const some = (st.proxies || []).some((p) => !country || p.c === country);
    const reason = !cfg.key ? "Add your Webshare API key in Extra Guac's proxy settings."
      : st.badKey ? st.error
      : elsewhere ? "Chrome's proxy setting is controlled elsewhere, so this site is blocked."
      : sessionProxyFailure ? `The proxy couldn't be set (${sessionProxyFailure}), so this site is blocked.`
      : !some ? (country ? `Your Webshare account has no proxies in ${TT.countryName(country)}.` : "Your Webshare account has no proxies.")
      : "";
    return { ok: !reason, country, reason };
  });
}

// What the settings and the popup show about the Webshare account.
async function proxyInfo() {
  const { cfg, st } = await getProxy();
  const counts = {};
  for (const p of st.proxies || []) counts[p.c] = (counts[p.c] || 0) + 1;
  return {
    hasKey: !!cfg.key, free: !!st.plan?.free, problem: st.error || "", checkedAt: st.listAt || 0, webrtc: await webrtcOff(),
    countries: Object.entries(counts).map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code)),
    elsewhere: controlledElsewhere((await chrome.proxy.settings.get({})).levelOfControl),
  };
}

// Another program or extension taking Chrome's proxy setting (or giving it back) changes what the
// profiles' sites need: blocked, or routed again.
chrome.proxy.settings.onChange.addListener((details) => {
  if (details.levelOfControl !== "controlled_by_this_extension") applyProxy();
});

// A profile's proxy: null for none, or { country } with a two-letter country code ('' for any).
async function setProfileProxy(profileId, proxy) {
  const profile = await getProfile(profileId);
  if (!profile) return { ok: false };
  if (proxy) await assertProxyRoom(groupById(profile.groupId)?.domains[0], proxy.country);
  profile.proxy = proxy ? { country: /^[A-Z]{2}$/.test(proxy.country) ? proxy.country : "" } : null;
  await putProfile(profile);
  await saveProxySites();
  await applyProxy();
  // The site's open pages load again, so the new route applies to all of their connections.
  const group = groupById(profile.groupId);
  if (group?.activeId === profile.id) for (const tab of await siteTabs(group.domains)) chrome.tabs.reload(tab.id).catch(() => {});
  notify();
  return { ok: true, proxy: (await proxyStatuses([profile]))[0] };
}

// ---- Page messages ----

// A page of a site with profiles has loaded. Its storage is tracked if it is a first-party page.
// If its origin still waits for the active profile's storage, that is written now.
async function pageHello(m, sender) {
  await getGroups();
  const origin = sender.origin;
  const group = groupFor(hostOf(origin));
  if (!group || !m.ancestors.every((a) => inScope(hostOf(a), group.domains))) return { track: false };
  if (!group.origins.includes(origin)) {
    group.origins.push(origin);
    saveGroups();
  }
  const held = group.pending.includes(origin);
  if (held && m.top) serial(() => applyPending(group.id, sender.tab.id, origin, sender.url));
  return { track: true, epoch: group.epoch, held };
}

async function applyPending(groupId, tabId, origin, url) {
  const group = groupById(groupId);
  if (!group?.activeId || !group.pending.includes(origin)) return;
  const saved = (await getData(group.activeId))[origin];
  const { parked } = await park([{ id: tabId, url }]);
  try {
    if (parked[0]?.origin !== origin) return;
    const problems = await writeParked(tabId, saved?.local || {}, null, null);
    if (problems.length) console.warn("Session Switch:", ...problems);
    // Once only, even when something couldn't be written: the page reloads afterwards, and trying
    // again on every load would keep reloading it.
    group.pending = group.pending.filter((o) => o !== origin);
    await saveGroups();
  } finally {
    await unpark(parked);
  }
}

async function pageStorage(m, sender) {
  await getGroups();
  const origin = sender.origin;
  const group = groupFor(hostOf(origin));
  if (!group?.activeId || m.epoch !== group.epoch || group.pending.includes(origin)) return;
  if (!m.ancestors.every((a) => inScope(hostOf(a), group.domains))) return;
  const data = await getData(group.activeId);
  data[origin] = { ...data[origin], local: m.local, savedAt: Date.now() };
  await putData(group.activeId, data);
}

// ---- The card in the page ----
// When a login is found changed from outside, the question the popup asks (save it as a new
// profile, update the profile with it, or put the profile's back) also shows once on the site, as a
// card at the bottom right of its tab in front (ss-card.js): now, or the next time one of its tabs
// is in front. It stays until a choice is made there or it is closed; a choice made anywhere closes
// it. group.cardShown notes that it was shown for this question, so it doesn't come back.

async function showCard(group) {
  if (!group.paused || group.cardShown) return;
  const profile = await getProfile(group.paused);
  const tab = profile && (await siteTabs(group.domains)).find((t) => t.active && t.status === "complete" && hostOf(t.url || ""));
  if (!tab) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["ss-card.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "ss:card", site: group.domains[0], name: profile.name });
  } catch {
    return; // a page the extension can't reach: next time
  }
  group.cardShown = true;
  group.cardTabs = [...new Set([...(group.cardTabs || []), tab.id])];
  await saveGroups();
}

// A question settled (in the card, the popup, or by a switch): its cards go.
async function closeSettledCards() {
  for (const group of allGroups()) {
    if (group.paused || !group.cardTabs) continue;
    for (const tabId of group.cardTabs) chrome.tabs.sendMessage(tabId, { type: "ss:card-close" }).catch(() => {});
    delete group.cardTabs;
    delete group.cardShown;
    await saveGroups();
  }
}

// A tab of a site with a waiting question comes to the front, or finishes loading in front.
const cardCheck = (tabId) => serial(async () => {
  await getGroups();
  if (!allGroups().some((g) => g.paused && !g.cardShown)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const group = tab?.active ? groupFor(hostOf(tab.url || "")) : null;
  if (group) await showCard(group);
});
chrome.tabs.onActivated.addListener(({ tabId }) => cardCheck(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => change.status === "complete" && cardCheck(tabId));

// A choice made in the card.
async function cardChoice(choice, tabId) {
  const { group } = await locate(tabId);
  const profile = await getProfile(group?.paused);
  if (!profile) throw new Error("This was already settled.");
  if (choice === "save") return saveCurrent(tabId);
  if (choice === "update") return adopt(tabId);
  if (choice === "back") return switchTab(tabId, profile.id, true);
  throw new Error("Unknown choice.");
}

// After groups or profiles change: the page script follows the sites, cards and popup redraw.
async function groupsChanged() {
  await registerPageScript(allGroups().flatMap((g) => g.domains)).catch((e) => console.warn("Page script:", e));
  await saveProxySites();
  await closeSettledCards();
  notify();
}

// ---- Start-up ----

// A switch still marked when the background starts was cut off when it last stopped (none can be
// running in a fresh start). This is queued before anything else, so no other change sees the site
// half switched: tabs still parked go home, and if cookies were being swapped, the profile the
// switch started from is put back.
serial(async () => {
  await getGroups();
  for (const group of allGroups()) {
    const marker = group.switching;
    if (!marker) continue;
    const parked = await findParked(marker.tabs || []);
    if (marker.phase === "swapping") await putBack(group, await getProfile(marker.from), marker.https, parked, marker.mainTabId);
    else {
      delete group.switching;
      await saveGroups();
    }
    await unpark(parked);
  }
});

async function start() {
  await getGroups();
  await saveProxySites();
  applyProxy();
  await registerPageScript(allGroups().flatMap((g) => g.domains)).catch((e) => console.warn("Page script:", e));
  // Catch up on cookie changes made while the extension wasn't running.
  for (const group of allGroups()) if (group.activeId) serial(() => syncCookies(group.id));
}

// Every time the background starts: the routes (and what bg-proxy.js keeps in memory about them)
// may be out of date after it was stopped.
applyProxy();

chrome.runtime.onInstalled.addListener(() => start());
chrome.runtime.onStartup.addListener(() => start());
})();
