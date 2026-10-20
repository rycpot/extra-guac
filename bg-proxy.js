// Site proxy through the user's own Webshare account (settings in storage.local "proxy", see
// TT.proxyOf). With the API key, Webshare tells the plan (free or paid, its monthly data and
// renewal date), the account's proxies (address, port, login, country) and the data used so
// far; storage.local "proxyState" keeps that:
//   { plan: { id, free, limit (bytes, 0: unlimited), count, residential }, start, end (this
//     month of the plan), proxies: [{ h, p, u, w, c, t (city) }], used, usedAt, listAt, error, blocked,
//     warned: { start, at: [0.8, 1] } }
// Chrome's proxy setting is a routing script written here from the lists (never fetched): a
// listed site goes to the proxies of its country, then the backup countries in order (Chrome
// moves to the next when one doesn't answer), never straight out; everything else goes
// direct. On a paid plan, mode "full" turns it around. The script carries no logins: they're
// given when a proxy asks (onAuthRequired). Free plans: up to 20 sites, "only these sites".
// A site on any ending ("xmovy.*", TT.proxyName) is its name followed by any real domain ending
// (endings.js): the script carries the endings for it. Page scripts (WebRTC, the proxy's place)
// can only be given whole addresses, so each such site's addresses are learned as they're opened
// (proxySeen), and a page opened on one for the first time gets them as it opens.
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
          if (p.valid && p.proxy_address) proxies.push({ h: p.proxy_address, p: p.port, u: p.username, w: p.password, c: p.country_code || "", t: p.city_name || "" });
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

// What each site uses ({ rules: { site: answer }, fallback: the answer for every other site}).
// own: whether the proxy's own sites are routed (else only the profiles' sites); profiles: the
// Session Switch routes, which win over the rest.
function proxyRules(cfg, st, own = true, profiles = {}) {
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
  return { rules, fallback };
}

function proxyScript({ rules, fallback }) {
  // Walks up the host's labels (a.b.example.com, b.example.com, example.com) to the first
  // listed one, or the first whose name is listed on any ending and is followed by a real
  // ending (xmovy.co.id for "xmovy.*"). This computer and its network always go direct.
  const exact = {}, names = {};
  for (const [site, answer] of Object.entries(rules)) {
    if (TT.proxyAnyEnding(site)) names[site.slice(0, -2)] = answer;
    else exact[site] = answer;
  }
  const any = Object.keys(names).length > 0;
  return `var R = ${JSON.stringify(exact)};${any ? `
var N = ${JSON.stringify(names)};
var ending = (${ENDINGS.make})(${JSON.stringify(ENDINGS.data)});` : ""}
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === "localhost" || /^(127\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.)/.test(host) || host.indexOf(":") >= 0) return "DIRECT";
  for (var h = host; ; ) {
    if (Object.prototype.hasOwnProperty.call(R, h)) return R[h];
    var i = h.indexOf(".");
    if (i < 0) break;${any ? `
    if (Object.prototype.hasOwnProperty.call(N, h.slice(0, i)) && ending(h.slice(i + 1))) return N[h.slice(0, i)];` : ""}
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
  await readEndings(cfg, st, true);
  const profiles = await sessionProxyRoutes(cfg, st);
  const domains = Object.keys(profiles);
  sessionRouted = domains;
  sessionProxyFailure = "";
  let usable = false, routed = null;
  const own = !blocked && !!(proxyActive(cfg, st) && (proxyMode(cfg, st) === "full" || proxySites(cfg, st).length));
  if (!blocked) {
    if (own || domains.length) {
      routed = proxyRules(cfg, st, own, profiles);
      const data = proxyScript(routed);
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
  await proxyGuard(cfg, st, own, domains);
  await proxyWarp(cfg, st, usable ? routed : null);
  proxyCreds = null;
  await proxyTabIcons();
}

// ---- WebRTC on proxied sites -------------------------------------------------------------
// WebRTC could show a site the user's own address past the proxy, so it's turned off on the pages
// of every site going through one (webrtc-guard.js, in the page before its own scripts), unless
// switched off in settings (proxy.webrtc): the listed sites (with every site going through, all
// but the skipped ones) and Session Switch profiles' sites, only while their proxy is in use.
// Everywhere else it works as usual.
const GUARD_ID = "webrtc-guard";
const guardPatterns = (sites) => expandSites(sites).flatMap((d) => (/^[\d.]+$/.test(d) || d.includes(":") ? [`*://${d}/*`] : [`*://${d}/*`, `*://*.${d}/*`]));
async function proxyGuard(cfg, st, own, profileDomains) {
  let matches = [], excludeMatches = [];
  if (cfg.webrtc) {
    if (own && proxyMode(cfg, st) === "full") {
      matches = ["<all_urls>"];
      // Skipped sites go direct, unless a profile's proxy takes them.
      const skipped = [...cfg.skip.filter((s) => s.on).map((s) => s.site), "webshare.io"];
      excludeMatches = guardPatterns(expandSites(skipped).filter((s) => !profileDomains.some((d) => TT.proxyCovers(s, d))));
    } else {
      matches = guardPatterns([...new Set([...(own ? proxySites(cfg, st).map((s) => s.site) : []), ...profileDomains])]);
    }
  }
  // Before 257 it was Session Switch's own, for profiles' sites only.
  await pageScripts((id) => id === GUARD_ID || id === "ss-webrtc-guard",
    matches.length ? [{ id: GUARD_ID, js: ["webrtc-guard.js"], matches, excludeMatches }] : []);
}

// Puts the scripts run in proxied pages ahead of their own in place: scripts ({ id, js, matches,
// excludeMatches }), and none of the others whose ids mine(id) says are these. Only what changed is
// registered again.
async function pageScripts(mine, scripts) {
  const have = (await chrome.scripting.getRegisteredContentScripts()).filter((s) => mine(s.id));
  const shape = (s) => JSON.stringify([s.js, s.matches, s.excludeMatches || []]);
  const keep = scripts.filter((s) => have.some((h) => h.id === s.id && shape(h) === shape(s)));
  const gone = have.filter((h) => !keep.some((s) => s.id === h.id)).map((h) => h.id);
  if (gone.length) await chrome.scripting.unregisterContentScripts({ ids: gone });
  const add = scripts.filter((s) => !keep.includes(s)).map((s) => ({
    ...s, excludeMatches: s.excludeMatches?.length ? s.excludeMatches : undefined,
    runAt: "document_start", allFrames: true, world: "MAIN", matchOriginAsFallback: true, persistAcrossSessions: true,
  }));
  if (add.length) await chrome.scripting.registerContentScripts(add);
}

// ---- The proxy's place on proxied sites ----------------------------------------------------
// Sites going through a proxy see its place, unless switched off in settings (proxy.location, time
// and language): a spot on the map in its country and time zone, that time zone, and the country's
// language, in the page (warp.js and the scripts before it, ahead of the page's own) and in the
// requests' language header. The place is that of the first proxy a site's route tries: its
// country, and its city's time zone where the country has several (warp/places.js). One set of
// scripts and one header rule per place, on its sites; none while the proxy isn't in use.
const WARP_ID = "warp:";
const WARP_RULES = 9100; // to 9199
const WARP_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"];

// The place file (warp/<key>.js) for a proxy, "" for a country with none.
function warpPlace(proxy) {
  const zones = WARP_PLACES.zones[proxy.c];
  if (!zones) return "";
  const city = (proxy.t || "").trim().toLowerCase();
  const zone = zones.find((z) => z === WARP_PLACES.cities[city])
    || zones.find((z) => z.split("/").pop().replace(/_/g, " ").toLowerCase() === city)
    || zones[0];
  return `${proxy.c}_${zone.replace(/\//g, "-")}`;
}

// The language header for a country's language, with English after it (as warp-language.js has it).
function warpLanguages(cc) {
  const lang = WARP_PLACES.languages[cc] || "en-US";
  const list = [...new Set([lang, lang.split("-")[0], "en-US", "en"])];
  return list.map((l, i) => (i ? `${l};q=${(10 - i) / 10}` : l)).join(",");
}

// routed: the routing in use (proxyRules), null when nothing goes through a proxy.
async function proxyWarp(cfg, st, routed) {
  const features = [cfg.time && "warp-time.js", cfg.location && "warp-location.js", cfg.language && "warp-language.js"].filter(Boolean);
  const places = new Map();
  if (routed && features.length) {
    const placeOf = (answer) => {
      const [, host, port] = /^PROXY (\S+):(\d+)/.exec(answer) || [];
      const proxy = host && (st.proxies || []).find((p) => p.h === host && String(p.p) === port);
      return proxy ? warpPlace(proxy) : "";
    };
    const place = (key) => places.get(key) || places.set(key, { key, sites: [], all: false }).get(key);
    for (const [site, answer] of Object.entries(routed.rules)) {
      const key = placeOf(answer);
      if (key) place(key).sites.push(site);
    }
    const key = placeOf(routed.fallback);
    if (key) place(key).all = true;
  }
  const scripts = [], rules = [];
  const listed = Object.keys(routed?.rules || {});
  for (const p of places.values()) {
    // The sites inside its own that go another way (for the place every other site has, all of them).
    const others = listed.filter((s) => !p.sites.includes(s));
    const away = p.all ? others : others.filter((s) => p.sites.some((d) => s !== d && TT.proxyCovers(s, d)));
    const matches = p.all ? ["<all_urls>"] : guardPatterns(p.sites);
    if (!matches.length) continue; // only sites on any ending, none of their addresses opened yet
    scripts.push({ id: WARP_ID + p.key, js: [`warp/${p.key}.js`, ...features, "warp.js"], matches, excludeMatches: guardPatterns(away) });
    if (!cfg.language || rules.length === 100) continue; // the rule ids it has
    const condition = { resourceTypes: WARP_TYPES };
    if (!p.all) condition.requestDomains = expandSites(p.sites);
    const skip = expandSites(p.all ? [...away, "localhost"] : away);
    if (skip.length) condition.excludedRequestDomains = skip;
    rules.push({
      id: WARP_RULES + rules.length, priority: p.all ? 1 : 2, condition,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "accept-language", operation: "set", value: warpLanguages(p.key.slice(0, 2)) }] },
    });
  }
  await pageScripts((id) => id.startsWith(WARP_ID), scripts);
  const have = (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.id >= WARP_RULES && r.id < WARP_RULES + 100);
  if (JSON.stringify(have.map(({ id, priority, action, condition }) => ({ id, priority, condition, action }))) !== JSON.stringify(rules)) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: have.map((r) => r.id), addRules: rules });
  }
}

// ---- Sites on any ending ------------------------------------------------------------------
// Their addresses as they're opened, for the page scripts (Chrome takes only whole addresses
// there): storage.local "proxySeen", { "xmovy.*": ["xmovy.fi", "xmovy.co.id"] }, the latest 50
// of each, forgotten when the site's taken off the lists. The routing script needs none of it.

let anyEndings = []; // the sites on any ending in use (listed for the mode, switched on), as last routed
let seenDomains = {};
// tidy: the addresses of sites no longer on either list are forgotten.
async function readEndings(cfg, st, tidy = false) {
  const { proxySeen } = await chrome.storage.local.get("proxySeen");
  const listed = new Set([...cfg.sites, ...cfg.skip].map((s) => s.site).filter(TT.proxyAnyEnding));
  anyEndings = cfg.key ? (proxyMode(cfg, st) === "full" ? cfg.skip : proxySites(cfg, st)).filter((s) => s.on && TT.proxyAnyEnding(s.site)).map((s) => s.site) : [];
  seenDomains = proxySeen && typeof proxySeen === "object" ? proxySeen : {};
  if (tidy && Object.keys(seenDomains).some((s) => !listed.has(s))) {
    await editLocal(["proxySeen"], ({ proxySeen }) => {
      seenDomains = Object.fromEntries(Object.entries(proxySeen || {}).filter(([s]) => listed.has(s)));
      return { proxySeen: seenDomains };
    });
  }
}
// After the service worker starts again, before the first routing.
const endingsRead = getProxy().then(({ cfg, st }) => readEndings(cfg, st)).catch(() => {});
const expandSites = (sites) => [...new Set(sites.flatMap((s) => (TT.proxyAnyEnding(s) ? seenDomains[s] || [] : [s])))];
// Addresses learned since a page began opening on them, with the routing then put in place:
// that page gets the scripts as it opens, in case it opened before they were registered.
const freshDomains = new Map();
// One navigation after another, so a page's commit (below) waits for what its start learned.
let learning = Promise.resolve();

chrome.webNavigation.onBeforeNavigate.addListener(({ url }) => {
  learning = learning.then(() => learnFrom(url)).catch(() => {});
});
async function learnFrom(url) {
  await endingsRead;
  if (!anyEndings.length) return;
  let host = "";
  try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) host = u.hostname.toLowerCase(); } catch {}
  if (!host || proxyLocalHost(host)) return;
  const learn = anyEndings.map((site) => [site, TT.proxyDomain(host, site)]).filter(([site, d]) => d && !seenDomains[site]?.includes(d));
  if (!learn.length) return;
  const applied = editLocal(["proxySeen"], ({ proxySeen }) => {
    const seen = proxySeen && typeof proxySeen === "object" ? { ...proxySeen } : {};
    for (const [site, d] of learn) seen[site] = [...(seen[site] || []).filter((x) => x !== d), d].slice(-50);
    seenDomains = seen;
    return { proxySeen: seen };
  }).then(() => applyProxy());
  for (const [, d] of learn) freshDomains.set(d, { at: Date.now(), applied });
}

chrome.webNavigation.onCommitted.addListener(async ({ url, tabId, frameId }) => {
  await learning;
  if (!freshDomains.size) return;
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  for (const [d, f] of freshDomains) {
    if (Date.now() - f.at > 60e3) { freshDomains.delete(d); continue; }
    if (host !== d && !host.endsWith(`.${d}`)) continue;
    await f.applied.catch(() => {});
    const covers = (pattern) => {
      const [, sub, h] = /^\*:\/\/(\*\.)?([^/]+)\/\*$/.exec(pattern) || [];
      return pattern === "<all_urls>" || (h ? host === h || (!!sub && host.endsWith(`.${h}`)) : false);
    };
    const scripts = (await chrome.scripting.getRegisteredContentScripts())
      .filter((s) => (s.id === GUARD_ID || s.id.startsWith(WARP_ID)) && s.matches.includes(`*://${d}/*`) && !(s.excludeMatches || []).some(covers));
    // Each runs once on a page, so one that was in place in time isn't run twice.
    for (const s of scripts) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: s.js, world: "MAIN", injectImmediately: true }).catch(() => {});
    }
    return;
  }
});

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
chrome.runtime.onInstalled.addListener(({ reason }) => {
  applyProxy();
  syncProxyAlarm();
  // Proxies kept before 258 have no city (for their time zone): the list is asked for again.
  if (reason === "update") getProxy().then(({ cfg }) => cfg.key && proxyRefresh({ list: true }));
});
