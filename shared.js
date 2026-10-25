// Settings shared by the background worker, popup and settings window.
// Blur settings live separately under "pii" (see pii-rules.js).
(() => {
  const DEFAULTS = {
    theme: "dark", // "dark" | "light" | "auto" (follow the system)
    openIn: "panel", // what the toolbar icon opens: "popup" | "panel" (Chrome's side panel)
    // tab / full: after the shot, "preview" (card on the page) | "local" (save) | "cloud"
    // (upload to the host from upload.menu, see TT.uploadChoices).
    // history: keep the last 10 screenshots (shot-store.js), on unless switched off.
    shot: { format: "png", quality: 92, folder: "", tab: "preview", full: "preview", history: true },
    refresh: {
      mode: "fixed", // "fixed" | "random"
      fixed: 30,
      min: 20,
      max: 45,
      // { text, enabled }; any enabled one on the page counts. Older versions kept a
      // single "keyword" string, which the popup turns into the first of these.
      keywords: [],
      continueAfterMatch: false,
      notify: true,
      sound: "chime", // "chime" (built in) | "" (none) | a link to a sound file
    },
    // QR codes (bg-qr.js, qr.html): the right-click menu (off until switched on); the icon in
    // the middle: "avocado" | "none" | the id of one of yours (local "qrIcons", each with its
    // own zoom). Static or dynamic is picked each time (static to start).
    qr: { menu: false, icon: "avocado", dynamic: "spoo", fit: true, clean: false }, // fit: the icon trimmed to fill its space; clean: its background removed
    // URL shorten (bg-shortener.js): x.gd (Extra Guac's own key unless you add yours; short
    // link analytics off, or on with your key when analytics.xgd is ticked: public to anyone), spoo.me (works without a key; with one, links are yours and only you see their analytics) or
    // dub.sh (your key). qr.dynamic: which of spoo.me and dub.sh makes dynamic QR codes.
    shortener: {
      service: "xgd",
      keys: { xgd: "", spoo: "", dub: "" },
      paid: { dub: false }, // dub.sh on a paid plan: its count only in settings
      analytics: { xgd: false }, // x.gd with your key: record visits (anyone can see them, adding "+" to the link)
    },
    awake: { lastAmount: 45, lastUnit: "min" },
    // Tab volume: the four levels on its buttons (beside 100% and mute), each changed by double-clicking it.
    volume: { presets: [1, 5, 25, 50] },
    picker: { selectorFormat: "css" }, // "css" | "xpath"
    // Rules: { domain, find, replace, auto, on }. Auto rules redirect on navigation;
    // manual ones run from the page's right-click menu.
    redirect: { enabled: false, rules: [] },
    // Dark mode: enabled = on/off everywhere; "sites" = only the sites listed, "all" =
    // everywhere except exclude; force = dark pages darkened (inverted) anyway.
    dark: { enabled: false, mode: "sites", sites: [], exclude: [], force: [] },
    // Image hosts. ImgLink works without a key (anonymous) or with a verified one (your
    // account); x02 needs a verified key. Uploads to both are unlisted (see bg-upload.js).
    // menu: with both on, "both" lets you pick the host each time (right-click menu and
    // screenshot ☁), or a host name always uses that host.
    upload: { imglink: false, x02: false, imglinkKey: "", imglinkVerified: false, x02Key: "", x02Verified: false, menu: "both" },
    // Clipboard history: limit = unpinned entries kept; maxAgeDays 0 = no age limit;
    // menu = pinned entries in the right-click menu; exclude = sites never recorded.
    clip: { enabled: false, limit: 200, maxAgeDays: 0, menu: false, exclude: [] },
    // Zoom & rotate images: modifier + scroll over an image ("alt" = Option on a Mac).
    imgZoom: { enabled: false, modifier: "alt" },
    // Save images on click: modifier + click; format "original" | "png" | "jpg" | "webp";
    // folder = sub-folder of Downloads ("" = Downloads itself).
    imgDl: { enabled: false, modifier: "alt", format: "original", folder: "" },
    // Copy & right-click unlock: the sites remembered for every visit (no switch for
    // everywhere). Sites unlocked only until Chrome closes are in storage.session.
    unlock: { sites: [] },
    // Open other sites' links in a new tab: the sites it's on for (no switch for everywhere);
    // also: [{ site, hosts }] = other domains that count as that site (links to them stay in
    // place); split: domains where each subdomain is a site of its own (like github.io).
    newTab: { sites: [], also: [], split: [] },
    // Refresh on focus: entries of { id, pattern, on, hard, enabledAt, expire: { n, unit:
    // "d" | "mo" } (n 0 = never), threshold: { n, unit: "s" | "m" } }, the time away before it refreshes. See bg-focus.js.
    focus: { entries: [] },
    // Text from image (OCR.space, your free key): engine "2" (default, fast) or "3"
    // (slower, better on handwriting, tables and many languages; its own smaller quota).
    // plan: "free" (api.ocr.space, 1 MB per image) or "pro" (PRO / PRO PDF / Enterprise:
    // apipro1/apipro2.ocr.space, or endpoint if the welcome email names another; 5 MB per
    // image). Checking the key in settings finds its plan (ocrKeyPlan in bg-ocr.js).
    ocr: { key: "", engine: "2", plan: "free", endpoint: "" },
    // Rewrite text (bg-rewrite.js, rewrite-card.js): "Rewrite" in the right-click menu on
    // selected text and in text fields while menu is on; key = your free Groq key; mode
    // "fix" | "rephrase" and tone, the card's last choice.
    rewrite: { menu: false, key: "", mode: "fix", tone: "clearer" },
    // Userscripts (bg-userscripts.js): on for all, how often to look for updates (hours, 0 =
    // never), and whether an update that asks for more access waits for an OK.
    us: { enabled: false, interval: 24, ask: true },
    // Which of the first three popup tabs each section is in, top to bottom (settings →
    // general → tools layout). The fourth tab (backup) is fixed.
    layout: {
      tools: ["screenshot", "ocr", "blur", "scratch", "dark", "refresh", "autoRefresh", "shortener", "qr", "volume", "proxy", "awake", "highlight", "clipboard"],
      page: ["imgzoom", "imgdl", "upload", "color", "font", "element", "remove", "newTab", "redirect", "focus", "unlock", "rewrite"],
      extra: ["sessions", "userscripts", "wordsearch"],
    },
  };

  // Popup tabs that hold sections, and the sections' names.
  const PANELS = { tools: "tab 1", page: "tab 2", extra: "tab 3" };
  const SECTIONS = {
    screenshot: "screenshot", blur: "privacy blur", scratch: "scratch pads", dark: "dark mode", refresh: "refresh", autoRefresh: "auto-refresh",
    shortener: "URL shorten", qr: "QR code", volume: "tab volume", proxy: "proxy", awake: "awake", color: "what color?", element: "what element?",
    font: "what font?", remove: "remove elements", highlight: "highlight words", imgzoom: "zoom & rotate images", imgdl: "save images on click", clipboard: "clipboard history", redirect: "URL auto redirect", upload: "upload images", unlock: "enable copy & right-click", ocr: "text from image", rewrite: "rewrite text", newTab: "open other site urls in new tab", focus: "refresh on focus",
    sessions: "session switch", userscripts: "userscripts", wordsearch: "word search",
  };

  // A saved layout with unknown sections dropped and any missing ones (new in an update)
  // added to their usual tab, right after the section they follow by default (or at the
  // end when that one is elsewhere).
  function layoutOf(saved) {
    const out = {}, seen = new Set();
    for (const p of Object.keys(PANELS)) {
      out[p] = (Array.isArray(saved?.[p]) ? saved[p] : []).filter((id) => SECTIONS[id] && !seen.has(id) && seen.add(id));
    }
    for (const [p, ids] of Object.entries(DEFAULTS.layout)) {
      ids.forEach((id, i) => {
        if (seen.has(id)) return;
        seen.add(id);
        const after = out[p].indexOf(ids[i - 1]);
        if (i > 0 && after !== -1) out[p].splice(after + 1, 0, id);
        else out[p].push(id);
      });
    }
    return out;
  }

  const MAX_KEYWORDS = 20;

  // Highlight words (storage.local "hl"). Limits keep pages fast and the settings usable.
  const HL_LIMITS = { global: 1000, site: 300, sites: 200, length: 100 };
  // Neon, so marks catch the eye even while scrolling fast: yellow, green, cyan, orange, magenta, purple.
  const HL_COLORS = ["#fff01f", "#39ff14", "#00f0ff", "#ff5f1f", "#ff2fd6", "#b026ff"];
  // How marks are drawn (no text-shadow "fake bold": at 0.35px it smears letters on
  // high-density screens). clean (default): solid color + black/white text;
  // underline: thick underline only, page's own text color.
  const HL_LOOKS = ["clean", "underline"];
  // The ::highlight declarations for a look. bg = [r, g, b] of the color as drawn, fg = the
  // text color that reads on it. Kept in step with the copy in hl.js (injected on its own).
  function hlLookRule(look, bg, fg) {
    const c = `rgb(${bg.join(" ")})`;
    if (look === "underline") return `text-decoration: underline 3px ${c}; text-decoration-skip-ink: none;`;
    return `background-color: ${c}; color: rgb(${fg.join(" ")});`;
  }
  function hlOf(hl) {
    const h = hl && typeof hl === "object" ? hl : {};
    const list = (l, color) => ({ on: l?.on !== false, color: /^#[0-9a-f]{6}$/i.test(l?.color || "") ? l.color : color, partial: !!l?.partial, words: Array.isArray(l?.words) ? l.words : [] });
    const sites = {};
    for (const [site, l] of Object.entries(h.sites || {})) sites[site] = list(l, HL_COLORS[2]);
    // also: other sites linked to a list, using its words too (each site in one place only).
    const taken = new Set(Object.keys(sites));
    for (const [site, l] of Object.entries(sites)) {
      const also = Array.isArray(h.sites[site]?.also) ? h.sites[site].also : [];
      l.also = also.filter((s) => typeof s === "string" && s && !taken.has(s) && taken.add(s));
    }
    return { enabled: !!h.enabled, look: HL_LOOKS.includes(h.look) ? h.look : "clean", global: list(h.global, HL_COLORS[0]), exclude: Array.isArray(h.exclude) ? h.exclude : [], sites };
  }

  // The list a site uses: the most specific of the list sites and the sites linked to them.
  // covers(s): whether site s covers the page's host.
  function hlSiteKey(hl, covers) {
    let best = "", key;
    for (const [k, l] of Object.entries(hl?.sites || {})) {
      for (const s of [k, ...(l.also || [])]) if (s.length > best.length && covers(s)) { best = s; key = k; }
    }
    return key;
  }

  // Site proxy (storage.local "proxy"), through the user's own Webshare account. mode "sites":
  // only the listed sites use a proxy; "full" (paid plans): every site but the skipped ones.
  // Each site: { site, on, country } (country "": the one for every site, "*": any). Countries are ISO codes;
  // "*" in backups means any other country the account has.
  const PROXY_LIMITS = { free: 20, paid: 200 };
  function proxyOf(p) {
    const h = p && typeof p === "object" ? p : {};
    const cc = (v) => (typeof v === "string" && /^([A-Z]{2}|\*)$/.test(v) ? v : "");
    const list = (l) => (Array.isArray(l) ? l : [])
      .filter((x) => x && typeof x.site === "string" && x.site)
      .map((x) => ({ site: x.site, on: x.on !== false, country: cc(x.country) }));
    return {
      key: typeof h.key === "string" ? h.key.trim() : "",
      on: h.on !== false,
      webrtc: h.webrtc !== false, // WebRTC off on proxied sites (see bg-proxy.js)
      // Proxied sites see the proxy's place, time zone and language (see bg-proxy.js)
      location: h.location !== false,
      time: h.time !== false,
      language: h.language !== false,
      mode: h.mode === "full" ? "full" : "sites",
      sites: list(h.sites),
      skip: list(h.skip),
      countryMode: h.countryMode === "each" ? "each" : "same",
      country: cc(h.country) === "*" ? "" : cc(h.country),
      backups: Array.isArray(h.backups) ? [...new Set(h.backups.map(cc).filter(Boolean))] : ["*"],
      whenOut: h.whenOut === "direct" ? "direct" : "stop",
    };
  }
  // A typed site or address as the hostname a list keeps: lowercase, no "www.", no path.
  function proxySite(raw) {
    let v = String(raw || "").trim().toLowerCase();
    try { if (/^[a-z]+:\/\//.test(v)) v = new URL(v).hostname; } catch {}
    v = v.replace(/^www\./, "").replace(/[/?#:].*$/, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : "";
  }
  // A site on any ending is kept as "name.*" (TT.proxyName): the name followed by any real domain
  // ending (endings.js), at any depth, and their subdomains: "xmovy.*" covers xmovy.fi,
  // www.xmovy.co.id and xmovy.solar, not xmovy.github.io or xmovy.someone.com.
  function proxyName(raw) {
    let v = String(raw || "").trim().toLowerCase();
    try { if (/^[a-z]+:\/\//.test(v)) v = new URL(v).hostname; } catch {}
    v = v.replace(/[/?#:].*$/, "").replace(/\.\*$/, "").replace(/^www\./, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(v)) return "";
    // A whole address (xmovy.co.id, app.xmovy.fi): the name just before its ending.
    const labels = v.split(".");
    if (labels.length > 1) {
      const at = labels.findIndex((_, i) => i && isEnding(labels.slice(i).join(".")));
      v = at > 0 ? labels[at - 1] : "";
    }
    return v ? `${v}.*` : "";
  }
  let endingTest = null;
  const isEnding = (s) => !!globalThis.ENDINGS && (endingTest ||= globalThis.ENDINGS.make(globalThis.ENDINGS.data))(s);
  const proxyAnyEnding = (site) => site.endsWith(".*");
  // "xmovy.*" as it's shown: just the name, or with what it means.
  const proxyLabel = (site, long = false) => (proxyAnyEnding(site) ? (long ? `${site.slice(0, -2)} on any ending` : site.slice(0, -2)) : site);
  // How closely an entry covers a host, as the routing script walks it (bg-proxy.js): the host's
  // part it matches (the longer, the closer; exact before any ending at the same part), 0 if not.
  function proxyMatch(host, site) {
    if (!proxyAnyEnding(site)) return host === site || host.endsWith(`.${site}`) ? site.length * 2 + 1 : 0;
    const name = site.slice(0, -2);
    for (let h = host, i; (i = h.indexOf(".")) > 0; h = h.slice(i + 1)) {
      if (h.slice(0, i) === name && isEnding(h.slice(i + 1))) return h.length * 2;
    }
    return 0;
  }
  const proxyCovers = (host, site) => proxyMatch(host, site) > 0;
  // The entry of a list that a host goes by: the closest one.
  const proxyBest = (host, list) => list.reduce((best, e) => (proxyMatch(host, e.site) > (best ? proxyMatch(host, best.site) : 0) ? e : best), null);
  // The part of a host that "name.*" matches (xmovy.co.id for www.xmovy.co.id), "" if none.
  function proxyDomain(host, site) {
    const n = proxyAnyEnding(site) ? proxyMatch(host, site) / 2 : 0;
    return n ? host.slice(host.length - n) : "";
  }
  // The country a listed site uses now: its own (or the main one), or, when the account has no
  // proxy there, the first backup it has ("*": any). ok: whether it's the one asked for.
  function proxyCountry(cfg, proxies, entry) {
    // A site's own "*": any country, even when one was chosen for every site.
    let want = cfg.countryMode === "each" && entry?.country ? entry.country : cfg.country;
    if (want === "*") want = "";
    const have = [...new Set((proxies || []).map((p) => p.c))];
    if (!want || have.includes(want)) return { want, use: want, ok: true };
    const b = cfg.backups.find((x) => x === "*" || have.includes(x));
    return { want, use: b === "*" ? have.find((c) => c !== want) || "" : b || "", ok: false };
  }
  // The plan's proxy sites in use: one per site and country, over the list here and the proxies of
  // Session Switch profiles (ssSites, see bg-sessions.js). A site in the list and on a profile
  // through the same country takes one; through different countries, one each (a profile's always
  // wins for its site while it's in use). On a paid plan sending every site through, the list is of
  // skipped sites and profiles take none.
  //   used, max   sites in use and the plan's limit
  //   own         how many of the list's entries can be used (the rest wait, past the limit)
  //   has(site, country)   whether that site and country already have their place
  function proxySlots(cfg, st, ssSites = []) {
    const free = st?.plan?.free !== false;
    const max = PROXY_LIMITS[free ? "free" : "paid"];
    if (!free && cfg.mode === "full") return { used: cfg.skip.length, max, own: max, has: () => true };
    const key = (site, country) => `${site}|${country || ""}`;
    const own = new Set(cfg.sites.map((s) => key(s.site, proxyCountry(cfg, [], s).want)));
    const profiles = new Set((ssSites || []).flatMap((e) => e.profiles.map((p) => key(e.site, p.country))));
    const all = new Set([...own, ...profiles]);
    const profilesOnly = [...profiles].filter((k) => !own.has(k)).length;
    return { used: all.size, max, own: Math.max(0, max - profilesOnly), has: (site, country) => all.has(key(site, country)) };
  }
  let regionNames = null;
  function countryName(code) {
    if (code === "*") return "any other";
    try { regionNames ||= new Intl.DisplayNames(["en"], { type: "region" }); return regionNames.of(code) || code; } catch { return code; }
  }

  // freeLimit: new links a month on the free plan (null: no monthly limit); keyOptional:
  // works without your own key. Older versions also had cutt.ly and TinyURL (old labels kept
  // for the history).
  const SHORTENERS = {
    xgd: { label: "x.gd", freeLimit: null, keyOptional: true, keyHelp: "https://x.gd/en/developer" },
    spoo: { label: "spoo.me", freeLimit: null, keyOptional: true, keyHelp: "https://spoo.me/dashboard/developer" },
    dub: { label: "dub.sh", freeLimit: 25, keyHelp: "https://app.dub.co/settings/tokens" },
  };
  const SHORTENER_LABEL = (id) => SHORTENERS[id]?.label || { cuttly: "cutt.ly", tinyurl: "TinyURL" }[id] || id;

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  function merge(base, over) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
    return out;
  }

  async function getSettings() {
    const { tt } = await chrome.storage.local.get("tt");
    return merge(DEFAULTS, tt);
  }

  // One writer: the background worker applies every change, one at a time, each onto the
  // settings as they are by then. Pages (popup, settings, viewer) send their patch there, so
  // two changes made at once from different places can't write over each other.
  const IN_WORKER = typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope;
  let settingsQueue = Promise.resolve();
  // (In the worker) runs fn in turn with the settings changes, e.g. a restore that replaces them.
  function settingsTask(fn) {
    const run = settingsQueue.then(fn);
    settingsQueue = run.catch(() => {});
    return run;
  }
  async function updateSettings(patch) {
    if (!IN_WORKER) {
      const res = await chrome.runtime.sendMessage({ type: "updateSettings", patch });
      if (!res?.ok) throw new Error(res?.error || "Couldn't save the settings");
      return res.settings;
    }
    return settingsTask(async () => {
      const next = merge(await getSettings(), patch);
      await chrome.storage.local.set({ tt: next });
      return next;
    });
  }

  const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  // How much of a shortener's quota is used, for the popup, settings and the QR page.
  // dub.sh's own numbers when its key can read them ("shortUsage", kept by bg-shortener.js for
  // the key in use: links used, their limit and when they reset). Otherwise the links made from
  // this browser this calendar month ("shortCounts"); limit is null where there's no monthly
  // limit (spoo.me, x.gd).
  const keyTag = (key) => String(key || "").trim().slice(-6);
  function shortQuota(service, s, shortCounts = {}, shortUsage = {}) {
    const free = SHORTENERS[service]?.freeLimit ?? null;
    const u0 = shortUsage[service];
    const live0 = u0 && !u0.error && u0.keyTag === keyTag(s.shortener.keys[service]) && Date.now() - u0.at < 864e5 ? u0 : null;
    // dub.sh on a paid plan (ticked in settings, or its limit is above the free 25): no limit
    // to watch, so the popup and the QR page leave its count out.
    const paid = service === "dub" && (!!s.shortener.paid?.dub || (live0?.limit ?? 0) > free);
    const u = shortUsage[service];
    const live = u && !u.error && u.keyTag === keyTag(s.shortener.keys[service]) && Date.now() - u.at < 864e5 ? u : null;
    const local = shortCounts.month === monthKey() ? shortCounts[service] || 0 : 0;
    const used = live ? live.used : local;
    const limit = live?.limit ?? (paid ? null : free);
    return {
      used, limit, left: limit == null ? null : Math.max(0, limit - used),
      live: !!live, resets: live?.resets ?? null,
      denied: !!(u && u.error === "denied" && u.keyTag === keyTag(s.shortener.keys[service])),
      paid, // dub.sh only
      // shown outside settings: only dub.sh's, on its free plan (x.gd and spoo.me have no limit)
      showCount: service === "dub" && !paid,
    };
  }
  const shortDay = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // A sub-folder of Downloads: no "..", no absolute paths, only safe characters.
  function cleanFolder(folder = "") {
    return folder
      .split(/[\\/]+/)
      .map((p) => p.trim().replace(/[<>:"|?*\x00-\x1f]/g, "").replace(/^\.+$/, ""))
      .filter(Boolean)
      .join("/");
  }

  // Applies the theme setting to a page: sets data-theme on <html>. Pages are dark
  // until this runs; "auto" follows the system. The popup reads the copy kept in
  // localStorage before it paints (popup-boot.js).
  async function applyTheme() {
    const apply = (t) => {
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem("theme", t); } catch {}
    };
    apply((await getSettings()).theme);
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.tt) apply(merge(DEFAULTS, c.tt.newValue).theme);
    });
  }

  // Image hosts that can take an upload right now, in menu order.
  const uploadHosts = (u) => [u.imglink && "imglink", u.x02 && u.x02Verified && u.x02Key?.trim() && "x02"].filter(Boolean);
  // The hosts to offer for an upload: the one picked in settings, or every host that's on.
  // ---- Refresh on focus: patterns, expiry and state (bg-focus.js, popup, settings) ----
  // An entry is one exact address ("github.com/notifications"), or a pattern where * stands
  // for anything ("github.com/*/pulls", "*.google.com/*"). Not counted: the scheme, a leading
  // "www.", the #part and a trailing "/"; the ?query is. Any port, unless the entry names one.
  const focusNew = (pattern) => ({ id: crypto.randomUUID(), pattern, on: true, hard: false, enabledAt: Date.now(),
    expire: { n: 0, unit: "d" }, threshold: { n: 1, unit: "m" } });
  const focusNorm = (s) => s.replace(/\/(?=\?|$)/, ""); // "a.com/x/" = "a.com/x", "a.com/" = "a.com"
  function focusPattern(pattern) {
    const p = focusNorm(String(pattern || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").replace(/#.*$/, ""));
    if (!p || p === "*") return null;
    const esc = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return { re: new RegExp(`^${esc}$`, "i"), port: /^[^/]*:\d/.test(p), wild: p.includes("*") };
  }
  function focusMatches(pattern, url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    const m = /^https?:$/.test(u.protocol) && focusPattern(pattern);
    return !!m && m.re.test(focusNorm((m.port ? u.host : u.hostname).replace(/^www\./i, "") + u.pathname + u.search));
  }
  // This page's address as an entry: no scheme, "www." or #part.
  const focusAddress = (url) => { const u = new URL(url); return focusNorm(u.host.replace(/^www\./i, "") + u.pathname + u.search); };
  // When an entry stops (0 = never): its days or calendar months after it was switched on.
  function focusExpiresAt(e) {
    const n = Math.floor(Number(e?.expire?.n) || 0);
    if (n <= 0 || !e.enabledAt) return 0;
    const d = new Date(e.enabledAt);
    if (e.expire.unit === "mo") { // the same day n months on, or that month's last day
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + n);
      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    } else d.setDate(d.getDate() + n);
    return d.getTime();
  }
  const focusState = (e, now = Date.now()) => (!e?.on ? "off" : focusExpiresAt(e) && now >= focusExpiresAt(e) ? "expired" : "on");
  const focusThresholdMs = (e) => Math.max(0, Number(e?.threshold?.n) || 0) * (e?.threshold?.unit === "s" ? 1000 : 60000);

  // Dates and times as shown everywhere: "8 Oct 2026 2:03PM" (or "8 Oct 2026" without the time).
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function when(t, time = true) {
    const d = new Date(t);
    if (isNaN(d)) return "";
    const day = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (!time) return day;
    const h = d.getHours();
    return `${day} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "AM" : "PM"}`;
  }

  // How a host is written where it's shown (ids stay lowercase).
  const hostName = (h) => (h === "x02" ? "X02" : h);
  const uploadChoices = (u) => { const on = uploadHosts(u); return on.includes(u.menu) ? [u.menu] : on; };

  // The clouds backups go to (bg-backup.js, bg-dropbox.js), with the storage key of each one's state.
  const BACKUP_CLOUDS = [
    { id: "drive", name: "Google Drive", short: "Drive", key: "backupState", account: "Google" },
    { id: "dropbox", name: "Dropbox", short: "Dropbox", key: "dropboxState", account: "Dropbox" },
  ];
  const cloudShort = (id) => BACKUP_CLOUDS.find((c) => c.id === id)?.short || "";

  globalThis.TT = { when, BACKUP_CLOUDS, cloudShort, settingsTask, uploadHosts, uploadChoices, hostName, focusNew, focusPattern, focusMatches, focusAddress, focusExpiresAt, focusState, focusThresholdMs, DEFAULTS, MAX_KEYWORDS, HL_LIMITS, HL_COLORS, HL_LOOKS, hlLookRule, hlOf, hlSiteKey, PROXY_LIMITS, proxyOf, proxySite, proxyName, proxyAnyEnding, proxyLabel, proxyCovers, proxyBest, proxyDomain, proxyCountry, proxySlots, countryName, SHORTENERS, SHORTENER_LABEL, shortQuota, shortDay, keyTag, PANELS, SECTIONS, layoutOf, merge, getSettings, updateSettings, monthKey, cleanFolder, applyTheme };
})();
