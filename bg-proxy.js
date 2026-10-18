// Site proxy through the user's own Webshare account (settings in storage.local "proxy", see
// TT.proxyOf). With the API key, Webshare tells the plan (free or paid, its monthly data and
// renewal date), the account's proxies (address, port, login, country) and the data used so
// far; storage.local "proxyState" keeps that:
//   { plan: { id, free, limit (bytes, 0: unlimited), count, residential }, start, end (this
//     month of the plan), proxies: [{ h, p, u, w, c }], used, usedAt, listAt, error, blocked,
//     warned: { start, at: [0.8, 1] } }
// Chrome's proxy setting is a routing script written here from the lists (never fetched): a
// listed site goes to the proxies of its country, then the backup countries in order (Chrome
// moves to the next when one doesn't answer), never straight out; everything else goes
// direct. On a paid plan, mode "full" turns it around. The script carries no logins: they're
// given when a proxy asks (onAuthRequired). Free plans: up to 20 sites, "only these sites".
// Session Switch profiles with a proxy (bg-sessions.js) add their sites to the same script, ahead
// of everything here: whenever a key is set, even with the proxy switched off, and never straight
// out. While the script is being replaced, or the setting is held elsewhere, those sites are blocked.

const WS_API = "https://proxy.webshare.io/api/v2";
const GB = 1024 ** 3; // Webshare counts a GB as 1024³ bytes

async function getProxy() {
  const { proxy, proxyState = {} } = await chrome.storage.local.get(["proxy", "proxyState"]);
  return { cfg: TT.proxyOf(proxy), st: proxyState };
}

async function wsGet(key, path) {
  let res;
  try {
    res = await fetch(`${WS_API}${path}`, { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error("Couldn't reach Webshare; check your connection");
  }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Webshare didn't accept this API key. Copy it again from API → Keys in your Webshare dashboard"), { badKey: true });
  if (!res.ok) throw new Error(`Webshare: HTTP ${res.status}`);
  return res.json();
}

// The plan's current month: from the subscription's start, a month at a time (a short month
// ends on its last day), up to now.
function planMonth(startIso, now = Date.now()) {
  const s = new Date(startIso);
  if (Number.isNaN(+s)) return null;
  const at = (n) => {
    const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + n, 1, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds()));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(s.getUTCDate(), last));
    return +d;
  };
  let n = 0;
  while (at(n + 1) <= now && n < 1200) n++;
  return { start: at(n), end: at(n + 1) };
}

// Asks Webshare for the plan, the data used this month and (when asked, or once a day) the
// proxies. Errors are kept in proxyState.error for the settings and the panel to show; what
// was known before stays, so sites keep working through a short Webshare outage.
// One check at a time; a call while one runs shares it, unless it asks for the proxy list and
// the running one doesn't (then it runs next).
let proxyRefreshing = null, refreshingList = false;
function proxyRefresh({ list = false } = {}) {
  if (proxyRefreshing && (refreshingList || !list)) return proxyRefreshing;
  const run = (proxyRefreshing || Promise.resolve()).catch(() => {}).then(() => refreshProxyNow({ list }));
  proxyRefreshing = run;
  refreshingList = list;
  run.finally(() => { if (proxyRefreshing === run) { proxyRefreshing = null; refreshingList = false; } }).catch(() => {});
  return run;
}
async function refreshProxyNow({ list = false } = {}) {
  const { cfg, st } = await getProxy();
  if (!cfg.key) {
    await forgetProxyState();
    return {};
  }
  const next = { ...st, error: "" };
  try {
    const plans = (await wsGet(cfg.key, "/subscription/plan/")).results?.filter((p) => p.status === "active") || [];
    const plan = plans.find((p) => p.proxy_type !== "free") || plans[0];
    if (!plan) throw new Error("This Webshare account has no active plan");
    next.plan = {
      id: plan.id,
      free: plan.proxy_type === "free",
      limit: (plan.bandwidth_limit || 0) * GB,
      count: plan.proxy_count || 0,
      residential: plan.proxy_subtype === "residential",
    };
    const sub = await wsGet(cfg.key, "/subscription/").catch(() => null);
    // This month of the plan: up to the renewal date Webshare gives (a plan month is 30 days),
    // else counted a month at a time from its start.
    const end = Date.parse(sub?.end_date || "");
    const month = end > Date.now()
      ? { start: Math.max(Date.parse(sub.start_date) || 0, end - 30 * 86400e3), end }
      : planMonth(sub?.start_date || plan.created_at);
    if (month) Object.assign(next, month);
    if (next.plan.residential) throw new Error("Residential plans aren't supported yet; use a proxy server plan");
    if (list || st.plan?.id !== plan.id || !st.proxies?.length || Date.now() - (st.listAt || 0) > 12 * 3600e3) {
      next.listAt = 0; // until the new list is in: if fetching it fails, the next check tries again
      const proxies = [];
      for (let page = 1; page <= 3; page++) {
        const d = await wsGet(cfg.key, `/proxy/list/?mode=direct&page=${page}&page_size=100&plan_id=${plan.id}`);
        for (const p of d.results || []) {
          if (p.valid && p.proxy_address) proxies.push({ h: p.proxy_address, p: p.port, u: p.username, w: p.password, c: p.country_code || "" });
        }
        if (!d.next) break;
      }
      next.proxies = proxies;
      next.listAt = Date.now();
    }
    if (next.start) {
      const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
      const s = await wsGet(cfg.key, `/stats/aggregate/?timestamp__gte=${iso(next.start)}&timestamp__lte=${iso(Date.now())}&plan_id=${plan.id}`);
      next.used = s.bandwidth_total || 0;
      next.usedAt = Date.now();
    }
  } catch (err) {
    next.error = err.message;
    if (err.badKey) next.badKey = true;
  }
  if (!next.error) delete next.badKey;
  // Saved only if the key is still the one asked with (a key removed or changed meanwhile
  // must not get the old account's proxies and logins back), keeping the blocked note,
  // which applyProxy keeps.
  const saved = await editLocal(["proxy", "proxyState"], ({ proxy, proxyState }) => {
    if (TT.proxyOf(proxy).key !== cfg.key) return null;
    return { proxyState: { ...next, blocked: !!proxyState?.blocked } };
  });
  if (!saved) return {};
  if (await usageNotice(cfg, next)) await editLocal(["proxy", "proxyState"], ({ proxy, proxyState }) =>
    TT.proxyOf(proxy).key === cfg.key && proxyState ? { proxyState: { ...proxyState, warned: next.warned } } : null);
  return next;
}

// The account's details (proxies and their logins included) go when the key does; in turn
// with the other writes, so one finishing later can't bring them back.
const forgetProxyState = () => editLocal(["proxy"], async ({ proxy }) => {
  if (!TT.proxyOf(proxy).key) await chrome.storage.local.remove("proxyState");
  return null;
});

const proxyOut = (st) => !!(st.plan?.limit && st.used >= st.plan.limit);
const sizeLabel = (b) => (b >= GB ? `${+(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB` : `${Math.max(0, Math.round(b / 1024 ** 2))} MB`);

// A notification at 80% of the month's data and when it runs out, once each per month;
// true when one was shown (st.warned then needs saving).
async function usageNotice(cfg, st) {
  if (!cfg.on || !st.plan?.limit || !st.start) return;
  const warned = st.warned?.start === st.start ? st.warned : { start: st.start, at: [] };
  const share = (st.used || 0) / st.plan.limit;
  const step = share >= 1 ? 1 : share >= 0.8 ? 0.8 : 0;
  if (!step || warned.at.includes(step)) return;
  st.warned = { start: st.start, at: [...warned.at, step] };
  const reset = new Date(st.end).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const message = step === 1
    ? (cfg.whenOut === "direct"
      ? `This month's ${sizeLabel(st.plan.limit)} is used up. Until ${reset}, your proxy sites open with your own connection.`
      : `This month's ${sizeLabel(st.plan.limit)} is used up. Your proxy sites won't open until ${reset}.`)
    : `${sizeLabel(st.used)} of ${sizeLabel(st.plan.limit)} used this month; it resets ${reset}.`;
  chrome.notifications.create("proxy-usage", { type: "basic", iconUrl: "icons/icon128.png", title: step === 1 ? "Proxy: out of data" : "Proxy: data running low", message, priority: 1 }, () => void chrome.runtime.lastError);
  return true;
}
chrome.notifications.onClicked.addListener((id) => {
  if (id !== "proxy-usage") return;
  chrome.notifications.clear(id);
  openSettings("proxy");
});

// ---- The routing --------------------------------------------------------------------

// What a site uses: "PROXY a:1; PROXY b:2" for its country's proxies, then the backups'.
function proxyChain(st, country, backups) {
  const all = st.proxies || [];
  const picked = [];
  const add = (list) => { for (const p of list) if (!picked.includes(p)) picked.push(p); };
  if (country) add(all.filter((p) => p.c === country));
  else add(all);
  for (const b of backups) add(b === "*" ? all : all.filter((p) => p.c === b));
  // A couple per country is enough to get past one that's down; the rest only slow a
  // failing site down.
  const seen = {};
  const chain = picked.filter((p) => (seen[p.c] = (seen[p.c] || 0) + 1) <= 2).slice(0, 8);
  // Nothing to use: point at a closed port so the site fails rather than go out directly.
  return chain.length ? chain.map((p) => `PROXY ${p.h}:${p.p}`).join("; ") : "PROXY 127.0.0.1:9";
}

const proxyFree = (st) => st.plan?.free !== false;
const proxyActive = (cfg, st) => !!(cfg.key && cfg.on && st.plan && (st.proxies?.length || proxyOut(st)) && !st.badKey
  && !(proxyOut(st) && cfg.whenOut === "direct"));
const proxyMode = (cfg, st) => (proxyFree(st) ? "sites" : cfg.mode);
// Session Switch profiles with a proxy take some of the plan's sites (TT.proxySlots): how many of
// the list's entries are left for it, as last worked out (null: not yet, the plan's limit).
let sessionOwnLimit = null;
const proxySites = (cfg, st) => cfg.sites.slice(0, sessionOwnLimit ?? TT.PROXY_LIMITS[proxyFree(st) ? "free" : "paid"]).filter((s) => s.on);

// Whether a page's host goes through a proxy now (for the toolbar icon and the panel).
// This computer and its network: always direct (as in the routing script).
const proxyLocalHost = (host) => !host.includes(".") || host === "localhost" || host.includes(":") || host.startsWith("[")
  || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
// The domains of Session Switch profiles going through a proxy now, as last routed.
let sessionRouted = [];
let sessionProxyFailure = ""; // why the setting couldn't be set for them, if it couldn't
function proxyCoversHost(cfg, st, host) {
  if (!host || proxyLocalHost(host)) return false;
  if (sessionRouted.some((d) => TT.proxyCovers(host, d))) return true;
  if (!proxyActive(cfg, st)) return false;
  if (proxyMode(cfg, st) === "full") {
    return !/(^|\.)webshare\.io$/.test(host) && !cfg.skip.some((s) => s.on && TT.proxyCovers(host, s.site));
  }
  return proxySites(cfg, st).some((s) => TT.proxyCovers(host, s.site));
}

// own: whether the proxy's own sites are routed (else only the profiles' sites); profiles: the
// Session Switch routes, which win over the rest.
function proxyScript(cfg, st, own = true, profiles = {}) {
  const rules = {};
  let fallback = "DIRECT";
  if (!own) {
    // Only the profiles' sites.
  } else if (proxyMode(cfg, st) === "full") {
    fallback = proxyChain(st, cfg.country, cfg.backups);
    for (const s of cfg.skip) if (s.on) rules[s.site] = "DIRECT";
    rules["webshare.io"] = "DIRECT"; // the account and the API stay reachable, even when out of data
  } else {
    for (const s of proxySites(cfg, st)) {
      const c = TT.proxyCountry(cfg, st.proxies, s);
      // Its country gone and no backup there: it waits rather than go out from somewhere else.
      rules[s.site] = !c.ok && !c.use ? "PROXY 127.0.0.1:9" : proxyChain(st, c.use, c.ok ? cfg.backups : cfg.backups.filter((b) => b !== c.use));
    }
  }
  // A profile's site is all its own: rules here for it or its subdomains (a skipped or
  // differently routed subdomain) give way, so none of it goes out another way.
  for (const site of Object.keys(rules)) {
    if (Object.keys(profiles).some((d) => TT.proxyCovers(site, d))) delete rules[site];
  }
  Object.assign(rules, profiles);
  // Walks up the host's labels (a.b.example.com, b.example.com, example.com) to the first
  // listed one. This computer and its network always go direct.
  return `var R = ${JSON.stringify(rules)};
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === "localhost" || /^(127\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.)/.test(host) || host.indexOf(":") >= 0) return "DIRECT";
  for (var h = host; ; ) {
    if (Object.prototype.hasOwnProperty.call(R, h)) return R[h];
    var i = h.indexOf(".");
    if (i < 0) break;
    h = h.slice(i + 1);
  }
  return ${JSON.stringify(fallback)};
}`;
}

// Puts Chrome's proxy setting in line with the lists: the script while there's something to
// route, cleared otherwise (only when it's ours: a setting from elsewhere is left alone, and
// noted as blocking).
let proxyApplying = Promise.resolve();
function applyProxy() {
  proxyApplying = proxyApplying.then(applyProxyNow).catch((err) => console.error("[proxy]", err));
  return proxyApplying;
}
async function applyProxyNow() {
  const { cfg, st } = await getProxy();
  const { levelOfControl, value } = await chrome.proxy.settings.get({});
  const blocked = levelOfControl === "not_controllable" || levelOfControl === "controlled_by_other_extensions";
  if (!!st.blocked !== blocked && cfg.key) {
    await editLocal(["proxyState"], ({ proxyState }) => (proxyState ? { proxyState: { ...proxyState, blocked } } : null));
  }
  sessionOwnLimit = TT.proxySlots(cfg, st, (await chrome.storage.local.get("ssProxySites")).ssProxySites).own;
  const profiles = await sessionProxyRoutes(cfg, st);
  const domains = Object.keys(profiles);
  sessionRouted = domains;
  sessionProxyFailure = "";
  let usable = false;
  if (!blocked) {
    const own = !!(proxyActive(cfg, st) && (proxyMode(cfg, st) === "full" || proxySites(cfg, st).length));
    if (own || domains.length) {
      const data = proxyScript(cfg, st, own, profiles);
      if (levelOfControl === "controlled_by_this_extension" && value?.pacScript?.data === data) {
        usable = true;
      } else {
        // The profiles' sites wait until the new script is in use (the network side takes it a
        // moment after it's saved).
        if (domains.length) await sessionBlock(domains);
        try {
          await chrome.proxy.settings.set({ value: { mode: "pac_script", pacScript: { data, mandatory: true } }, scope: "regular" });
          usable = true;
          if (domains.length) await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          sessionProxyFailure = err.message || String(err);
          if (!domains.length) throw err;
        }
      }
    } else if (levelOfControl === "controlled_by_this_extension") {
      await chrome.proxy.settings.clear({ scope: "regular" });
    }
  }
  await sessionBlock(domains.length && !usable ? domains : []);
  await sessionGuard(domains);
  proxyCreds = null;
  await proxyTabIcons();
}

// ---- Proxy logins ---------------------------------------------------------------------
// Chrome asks when a proxy wants its login. Two tries per request at most: a proxy that keeps
// refusing (an account that's out of data or switched off) gets the request canceled, and a
// check of the account, instead of a loop.

let proxyCreds = null;
const proxyTries = new Map();
async function credsFor(host, port) {
  if (!proxyCreds) {
    const { st } = await getProxy();
    proxyCreds = new Map((st.proxies || []).map((p) => [`${p.h}:${p.p}`, p]));
  }
  return proxyCreds.get(`${host}:${port}`);
}
chrome.webRequest.onAuthRequired.addListener((d, reply) => {
  if (!d.isProxy) return void reply({});
  const n = (proxyTries.get(d.requestId) || 0) + 1;
  if (proxyTries.size > 500) proxyTries.clear();
  proxyTries.set(d.requestId, n);
  if (n > 2) {
    proxyTrouble();
    return void reply({ cancel: true });
  }
  credsFor(d.challenger?.host, d.challenger?.port)
    .then((p) => reply(p ? { authCredentials: { username: p.u, password: p.w } } : {}))
    .catch(() => reply({}));
}, { urls: ["<all_urls>"] }, ["asyncBlocking"]);

// A proxy that doesn't answer, refuses or fails: look at the account again (the data may
// have run out, a proxy may have been replaced), at most once a minute.
let proxyTroubleAt = 0;
function proxyTrouble() {
  if (Date.now() - proxyTroubleAt < 60e3) return;
  proxyTroubleAt = Date.now();
  getProxy().then(({ cfg }) => cfg.key && proxyRefresh({ list: true }));
}
chrome.proxy.onProxyError.addListener(() => proxyTrouble());
chrome.webRequest.onErrorOccurred.addListener((d) => {
  if (/PROXY|TUNNEL/.test(d.error || "")) proxyTrouble();
}, { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] });

// ---- Toolbar icon -----------------------------------------------------------------------
// Tabs whose site goes through a proxy show the purple proxy pill on the avocado (with the
// awake dot too while that's on). Only touched once a key has been added; after it's removed,
// the tabs are put back once.

async function proxyTabIcons(onlyTab) {
  const { cfg, st } = await getProxy();
  const { proxyIcons, awake } = await chrome.storage.session.get(["proxyIcons", "awake"]);
  if (!cfg.key && !proxyIcons) return;
  if (cfg.key && !proxyIcons) await chrome.storage.session.set({ proxyIcons: true });
  const tabs = onlyTab ? [onlyTab] : await chrome.tabs.query({});
  for (const t of tabs) {
    let host = "";
    try { const u = new URL(t.url || t.pendingUrl || ""); if (/^https?:$/.test(u.protocol)) host = u.hostname.toLowerCase(); } catch {}
    const on = proxyCoversHost(cfg, st, host);
    chrome.action.setIcon({ tabId: t.id, imageData: await actionIcon({ awake: !!awake, proxy: on }) }).catch(() => {});
  }
  if (!cfg.key && !onlyTab) await chrome.storage.session.remove("proxyIcons"); // every tab put back
}
chrome.tabs.onUpdated.addListener((tabId, info, t) => {
  if (info.url || info.status === "loading") proxyTabIcons(t);
});

// ---- Messages, storage, timers ------------------------------------------------------------

const proxyHandlers = {
  // Settings → connect: checks the key with Webshare before keeping it.
  proxyConnect: async ({ key }) => {
    key = String(key || "").trim();
    if (!key) throw new Error("Paste your Webshare API key first");
    await wsGet(key, "/subscription/plan/");
    const { proxy } = await chrome.storage.local.get("proxy");
    await chrome.storage.local.set({ proxy: { ...TT.proxyOf(proxy), key } });
    return { state: await proxyRefresh({ list: true }) };
  },
  proxyRefresh: async ({ list }) => ({ state: await proxyRefresh({ list: !!list }) }),
};

chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local" || !(c.proxy || c.proxyState || c.ssProxySites)) return;
  if (c.proxy && TT.proxyOf(c.proxy.oldValue).key !== TT.proxyOf(c.proxy.newValue).key) {
    if (TT.proxyOf(c.proxy.newValue).key) proxyRefresh({ list: true });
    else forgetProxyState();
  }
  applyProxy();
  syncProxyAlarm();
});

// Once an hour while a key is set: the data used (for the 80% and out-of-data notices) and,
// twice a day, the list of proxies.
async function syncProxyAlarm() {
  const { cfg } = await getProxy();
  const have = await chrome.alarms.get("proxy-refresh");
  if (!cfg.key) return void (have && chrome.alarms.clear("proxy-refresh"));
  if (!have) chrome.alarms.create("proxy-refresh", { periodInMinutes: 60, delayInMinutes: 60 });
}
chrome.alarms.onAlarm.addListener((a) => a.name === "proxy-refresh" && proxyRefresh());

chrome.runtime.onStartup.addListener(() => { applyProxy(); syncProxyAlarm(); });
chrome.runtime.onInstalled.addListener(() => { applyProxy(); syncProxyAlarm(); });
