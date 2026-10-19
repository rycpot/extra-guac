// URL shorten: x.gd, spoo.me or dub.sh.
// - x.gd (the default): Extra Guac's own key, or yours (x.gd/en/developer). Analytics off,
//   unless you've added your key and ticked them on: x.gd shows a link's analytics to anyone
//   who adds "+" to it (private ones need its Free Plus plan).
// - spoo.me: works without a key (anonymous: 20 a minute, 200 a day, and the
//   link's stats are public at spoo.me/stats/<alias>); with your key (from
//   spoo.me/dashboard/developer) links are yours, 5,000 a day, and only you can see their analytics.
// - dub.sh: your key; 25 new links a month on the free plan.
// Links made here are counted per service per calendar month ("shortCounts") and kept in
// "shortHistory". dub.sh's own numbers are kept in "shortUsage" and shown instead
// (TT.shortQuota): the workspace's new links used, their limit and when they reset
// (GET /workspaces/{id}, which needs the key's workspaces.read permission, there with "all
// permissions"; the workspace id comes with any of its links).
// spoo.me and dub.sh also make dynamic QR codes (bg-qr.js), through dynCreate / dynUpdate.
// Loaded by background.js; shortenerHandlers join its message handlers.

const shortenerHandlers = {
  shorten: ({ service, url }) => shorten(service, url),
  shortUsage: ({ services, force }) => shortUsageRefresh(services, force),
  checkShortKey: ({ service, key }) => checkShortKey(service, key),
  clearShortHistory: () => editLocal("shortHistory", () => ({ shortHistory: [] })),
};

const HISTORY_LIMIT = 100;

// Extra Guac's own x.gd key. Anyone can read it from the extension, so it can't be kept
// secret; it's only scrambled so it isn't plain text in the code. Your own key, when added,
// is used instead.
const unscrambleKey = (v) => Array.from(atob(v), (c, i) => String.fromCharCode(c.charCodeAt(0) ^ 0x5a ^ (i * 7 & 0x3f))).join("");
const XGD_KEY = unscrambleKey("P21nfHAYQAhbBD9mL3JJRwhUVz5ge3QYSkVdUW9lcSI=");

async function shorten(service, url) {
  const info = TT.SHORTENERS[service];
  if (!info) throw new Error("Unknown shortener");
  if (!/^https?:\/\//i.test(url || "")) throw new Error("Only http(s) pages can be shortened");
  const { shortener } = await TT.getSettings();
  const key = shortener.keys[service]?.trim() || "";
  if (!key && !info.keyOptional) throw new Error(`Add your ${info.label} API key in settings → URL shortener`);

  let short;
  try { short = (await SHORTEN[service](key, url, shortener)).short; } catch (err) {
    if (service === "dub") shortUsageRefresh(["dub"], true).catch(() => {});
    throw err;
  }
  const month = TT.monthKey();
  const { shortCounts: counts } = await editLocal(["shortCounts", "shortHistory"], ({ shortCounts = {}, shortHistory = [] }) => {
    const counts = shortCounts.month === month ? { ...shortCounts } : { month };
    counts[service] = (counts[service] || 0) + 1;
    return { shortCounts: counts, shortHistory: [{ service, short, url, at: Date.now() }, ...shortHistory].slice(0, HISTORY_LIMIT) };
  });
  if (service === "dub") shortUsageRefresh(["dub"], true).catch(() => {});
  return { short, count: counts[service] };
}

// Each returns { short } and, for spoo.me and dub.sh, what's needed to change it later.
const SHORTEN = {
  async spoo(key, url) {
    const res = await fetch("https://spoo.me/api/v1/shorten", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      // Stats private wherever spoo.me allows it: only for links made with a key.
      body: JSON.stringify(key ? { long_url: url, private_stats: true } : { long_url: url }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.short_url) return { short: data.short_url, alias: data.alias };
    throw new Error(spooError(res, data, "make links (shorten:create)"));
  },
  async xgd(key, url, shortener) {
    const analytics = !!key && !!shortener?.analytics?.xgd; // never with Extra Guac's own key
    const q = new URLSearchParams({ url, key: key || XGD_KEY, analytics: String(analytics) });
    const res = await fetch(`https://xgd.io/V1/shorten?${q}`, { headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => null);
    // x.gd answers HTTP 200 with the real status in the body.
    if (Number(data?.status) === 200 && /^https?:\/\//i.test(data.shorturl || "")) {
      if (key) xgdKeySeen(key, true).catch(() => {});
      return { short: data.shorturl };
    }
    const status = Number(data?.status) || res.status;
    if (status === 401 || status === 403) {
      if (key) xgdKeySeen(key, false).catch(() => {});
      throw new Error(key ? "x.gd didn't accept your API key" : "x.gd turned down Extra Guac's key: add your own in settings → URL shortener");
    }
    if (status === 429) throw new Error("x.gd's limit is reached for now: try again later, or use spoo.me");
    throw new Error(data?.message ? `x.gd: ${data.message}` : `x.gd error (${status})`);
  },
  async dub(key, url) {
    const res = await fetch("https://api.dub.co/links", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.shortLink) {
      dubWorkspaceSeen(key, data.workspaceId).catch(() => {});
      return { short: data.shortLink, id: data.id };
    }
    throw new Error(data?.error?.message || (res.status === 401 ? "Invalid dub.sh API key" : `dub.sh error (${res.status})`));
  },
};

function spooError(res, data, needs) {
  if (res.status === 401) return "spoo.me didn't accept the API key";
  if (res.status === 403) return `This spoo.me key can't ${needs}: give it that scope (or admin:all) in the spoo.me dashboard`;
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After"));
    return `spoo.me's limit is reached for now${wait ? `: try again in ${wait < 120 ? `${wait} s` : `${Math.ceil(wait / 60)} min`}` : ""}`;
  }
  return data?.error ? `spoo.me: ${data.error}` : `spoo.me error (${res.status})`;
}

// ---- Is a key accepted? (settings, as a key is pasted) -------------------------
// spoo.me makes links with a key it doesn't take too, anonymously, so a wrong key would go
// unnoticed: it's checked by reading one of your links (401: not accepted; 403: accepted, but
// only allowed to make links). dub.sh the same way. x.gd has nothing to check a key with short
// of making a link, so its answer is how the last link made with that key went ("shortKeyState").
// { state: "none" | "ok" | "limited" | "bad" | "unchecked" | "unknown", error? }
async function checkShortKey(service, key) {
  key = (key || "").trim();
  if (!key) return { state: "none" };
  // Keys are one run of printable ASCII: spaces or other characters mean something else was pasted.
  if (/[^\x21-\x7e]/.test(key)) return { state: "bad" };
  if (service === "xgd") {
    const { shortKeyState = {} } = await chrome.storage.local.get("shortKeyState");
    const seen = shortKeyState.xgd;
    return { state: seen?.keyTag === TT.keyTag(key) ? (seen.ok ? "ok" : "bad") : "unchecked" };
  }
  const url = { spoo: "https://spoo.me/api/v1/urls?pageSize=1", dub: "https://api.dub.co/links?pageSize=1" }[service];
  if (!url) return { state: "unknown" };
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  } catch (err) {
    return { state: "unknown", error: err.message };
  }
  if (res.ok) return { state: "ok" };
  if (res.status === 401) return { state: "bad" };
  if (res.status === 403) return { state: "limited" };
  return { state: "unknown", error: res.status === 429 ? "rate limited, try again later" : `HTTP ${res.status}` };
}
async function xgdKeySeen(key, ok) {
  await editLocal(["shortKeyState"], ({ shortKeyState: cur = {} }) => {
    const had = cur.xgd;
    return had?.keyTag === TT.keyTag(key) && had.ok === ok ? null : { shortKeyState: { ...cur, xgd: { keyTag: TT.keyTag(key), ok } } };
  });
}

// ---- Dynamic links (for dynamic QR codes, bg-qr.js) -----------------------------
// { service, id, short, url }: a short link whose destination can be changed later.

async function dynCreate(service, key, url) {
  if (service === "spoo") {
    const made = await SHORTEN.spoo(key, url);
    return { service, id: await spooIdOf(key, made.alias).catch(() => null), alias: made.alias, short: made.short, url };
  }
  const made = await SHORTEN.dub(key, url);
  return { service, id: made.id, short: made.short, url };
}
// spoo.me's answer to a new link doesn't carry the id that changing it needs: it's looked up
// among your links by the alias (needs urls:read).
async function spooIdOf(key, alias) {
  const q = new URLSearchParams({ pageSize: "20", filter: JSON.stringify({ search: alias }) });
  const res = await fetch(`https://spoo.me/api/v1/urls?${q}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(spooError(res, data, "read your links (urls:read)"));
  const hit = (data?.items || []).find((u) => u.alias === alias);
  if (!hit?.id) throw new Error("spoo.me didn't find the link");
  return hit.id;
}
async function dynUpdate(link, key, url) {
  if (link.service === "spoo") {
    const id = link.id || await spooIdOf(key, link.alias || link.short.split("/").pop());
    const res = await fetch(`https://spoo.me/api/v1/urls/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ long_url: url }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(spooError(res, data, "change links (urls:manage)"));
    return { ...link, id, url: data?.long_url || url };
  }
  const res = await fetch(`https://api.dub.co/links/${encodeURIComponent(link.id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || (res.status === 401 ? "dub.sh didn't accept the API key" : `dub.sh error (${res.status})`));
  return { ...link, url: data?.url || url };
}

// cutt.ly and TinyURL were replaced by x.gd and spoo.me: their keys go, and settings set to
// either now use x.gd, as do those 197 moved to spoo.me without a spoo.me key (x.gd became the
// default after). Once after an update, and after restoring an older backup. Their links in
// the history keep working.
async function shortenerUpgrade(previousVersion) {
  if (previousVersion === "197") {
    const s = await TT.getSettings();
    if (s.shortener.service === "spoo" && !s.shortener.keys.spoo?.trim()) await TT.updateSettings({ shortener: { service: "xgd" } });
  }
  await TT.settingsTask(async () => {
    const { tt } = await chrome.storage.local.get("tt");
    const sh = tt?.shortener;
    const oldPaid = sh?.paid && ("cuttly" in sh.paid || "tinyurl" in sh.paid);
    if (!sh || !(sh.keys?.cuttly !== undefined || sh.keys?.tinyurl !== undefined || oldPaid || ["cuttly", "tinyurl"].includes(sh.service))) return;
    const keys = { ...(sh.keys || {}) };
    delete keys.cuttly;
    delete keys.tinyurl;
    const next = { ...sh, keys, service: ["cuttly", "tinyurl"].includes(sh.service) ? "xgd" : sh.service };
    next.paid = { dub: !!sh.paid?.dub };
    await chrome.storage.local.set({ tt: { ...tt, shortener: next } });
  });
  await editLocal(["shortUsage"], ({ shortUsage }) => (shortUsage?.tinyurl ? { shortUsage: { dub: shortUsage.dub } } : null));
}
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => { if (reason === "update") shortenerUpgrade(previousVersion).catch(() => {}); });

// ---- The services' own numbers ("shortUsage") ----------------------------------

const USAGE_FRESH = 60_000; // asked at most once a minute per service (the APIs rate-limit)
const usageRuns = {};
async function shortUsageRefresh(services = ["dub"], force = false) {
  const s = await TT.getSettings();
  const { shortUsage = {} } = await chrome.storage.local.get("shortUsage");
  await Promise.all(services.filter((id) => USAGE[id]).map(async (id) => {
    const key = s.shortener.keys[id]?.trim();
    if (!key) return;
    const had = shortUsage[id];
    const same = had?.keyTag === TT.keyTag(key);
    if (!force && same && Date.now() - had.at < USAGE_FRESH) return;
    if (usageRuns[id]) return usageRuns[id];
    usageRuns[id] = (async () => {
      let next;
      try { next = await USAGE[id](key, same ? had : null, s); } catch (err) {
        next = { error: err.denied ? "denied" : "failed", ws: same ? had?.ws : undefined };
      }
      if (!next) return;
      await editLocal(["shortUsage"], ({ shortUsage: cur = {} }) => ({ shortUsage: { ...cur, [id]: { ...next, at: Date.now(), keyTag: TT.keyTag(key) } } }));
    })().finally(() => { usageRuns[id] = null; });
    return usageRuns[id];
  }));
  return { ok: true };
}
// A dub.sh link just made (here or for a QR code) says which workspace the key is for.
async function dubWorkspaceSeen(key, ws) {
  if (!ws) return;
  await editLocal(["shortUsage"], ({ shortUsage: cur = {} }) => {
    const had = cur.dub?.keyTag === TT.keyTag(key) ? cur.dub : { at: 0 };
    return had.ws === ws ? null : { shortUsage: { ...cur, dub: { ...had, ws, keyTag: TT.keyTag(key) } } };
  });
}

const USAGE = {
  async dub(key, had) {
    const call = async (path) => {
      const res = await fetch(`https://api.dub.co${path}`, { headers: { Authorization: `Bearer ${key}` } });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error("denied"), { denied: true });
      if (!res.ok) throw new Error(`dub.sh error (${res.status})`);
      return res.json();
    };
    let ws = had?.ws;
    if (!ws) ws = (await call("/links?pageSize=1"))?.[0]?.workspaceId;
    if (!ws) return { error: "nolinks" }; // no links yet: nothing to read the workspace from
    const w = await call(`/workspaces/${encodeURIComponent(ws)}`);
    if (typeof w?.linksUsage !== "number") throw new Error("dub.sh didn't say");
    return {
      ws, plan: w.plan, used: w.linksUsage, limit: w.linksLimit,
      resets: dubResets(w),
    };
  },
};
// When dub.sh's counts start again: the end of this billing cycle, or the next billing day.
function dubResets(w) {
  const end = Date.parse(w.billingCycleEndsAt || "");
  if (end > Date.now()) return end;
  const day = Number(w.billingCycleStart);
  if (!day) return null;
  const now = new Date();
  const at = (y, m) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate())).getTime();
  const thisMonth = at(now.getFullYear(), now.getMonth());
  return thisMonth > now.getTime() ? thisMonth : at(now.getFullYear(), now.getMonth() + 1);
}

