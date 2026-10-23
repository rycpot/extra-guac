// Userscripts: scripts you add (installed from a .user.js link, written in the editor or
// imported) run on the pages they name, through Chrome's userScripts API. That needs the
// optional "userScripts" permission (asked for on the userscripts page) and Chrome's
// "Allow User Scripts" switch on Extra Guac's details page.
//
// Kept in storage.local: "usScripts" (each script's code, parsed metadata, the @require and
// @resource files fetched for it, on/off, where it came from and any update waiting for an OK)
// and "usValues" (what each script saved with GM_setValue, by script id). Both go into backups.
// Settings (on/off for all, how often to look for updates, asking before an update that wants
// more access) are tt.us.
//
// A script with @grant none runs in the page itself. One that asks for GM functions runs in
// a world beside the page (Chrome's USER_SCRIPT world) with us-gm.js in front of it; those
// functions reach back here with chrome.runtime messages.

const US_INSTALL_RULE = 9300; // the .user.js redirect to the install page
const US_UPDATE_ALARM = "us-updates";
const US_INTERVALS = [0, 1, 6, 24, 168]; // hours; 0 = never
const US_API = ["GM", "GM_info", "unsafeWindow", "GM_log", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "GM_getValues",
  "GM_setValues", "GM_deleteValues", "GM_addValueChangeListener", "GM_removeValueChangeListener", "GM_xmlhttpRequest", "GM_addStyle",
  "GM_addElement", "GM_setClipboard", "GM_notification", "GM_openInTab", "GM_download", "GM_registerMenuCommand",
  "GM_unregisterMenuCommand", "GM_getResourceText", "GM_getResourceURL", "GM_cookie"];

// ---- State ----

// Off when Chrome's switch is off (chrome.userScripts is then missing, or throws).
async function usAvailable() {
  // Scripts reach Extra Guac with messages, which Chrome has for user scripts from 131 on.
  if (!chrome.userScripts?.configureWorld || !chrome.runtime.onUserScriptMessage) return false;
  try { await chrome.userScripts.getScripts(); return true; } catch { return false; }
}
async function usState() {
  const permitted = await chrome.permissions.contains({ permissions: ["userScripts"] }).catch(() => false);
  const chromeVersion = Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] || 0);
  const oldChrome = chromeVersion > 0 && chromeVersion < 131;
  return { permitted, available: permitted && !oldChrome && await usAvailable(), oldChrome };
}

// The scripts and what they saved, read from storage once and kept until either changes: every
// GM function call looks its script up here. editLocal (background.js) drops the copy the moment
// it writes either; storage.onChanged below catches any other writer. Callers only read it.
let usCache = null;
function usForget() { usCache = null; }
function usLoad() {
  usCache ||= chrome.storage.local.get(["usScripts", "usValues"]).then(
    ({ usScripts = [], usValues = {} }) => ({ scripts: Array.isArray(usScripts) ? usScripts : [], values: usValues && typeof usValues === "object" ? usValues : {} }),
    (err) => { usCache = null; throw err; });
  return usCache;
}
// Read-change-write of the script list, in turn with every other (editLocal, background.js).
const usEditScripts = (fn) => editLocal(["usScripts"], async ({ usScripts = [] }) => {
  const list = Array.isArray(usScripts) ? usScripts : [];
  const out = await fn(list);
  return out ? { usScripts: out } : null;
});
const usByOrder = (list) => [...list].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.meta.name).localeCompare(b.meta.name));

// ---- Registration ----

// What Chrome injects for one script: its address check (when Chrome's patterns can't say it
// all), GM_info, the GM functions (only for one that asks for any), its @require files, then
// the script, all inside one function so they share names but keep them off the page.
function usInjected(s, values, key) {
  const m = s.meta;
  const reg = USM.registration(m);
  const page = USM.inPage(m);
  const info = {
    script: {
      name: m.name, namespace: m.namespace, version: m.version, description: m.description, author: m.author, icon: m.icon,
      homepage: m.homepage, matches: m.matches, includes: m.includes, excludes: m.excludes, "exclude-match": m.excludeMatches,
      grant: m.grants, connects: m.connects, resources: m.resources.map((r) => ({ name: r.name, url: r.url })),
      "run-at": m.runAtRaw || "document-idle", noframes: m.noframes, "inject-into": page ? "page" : "content", uuid: s.id,
      updateURL: m.updateURL, downloadURL: m.downloadURL, options: { check_for_updates: s.autoUpdate !== false },
    },
    scriptHandler: "Extra Guac", version: chrome.runtime.getManifest().version, injectInto: page ? "page" : "content",
    scriptMetaStr: /\/\/[ \t]*==UserScript==[\s\S]*?==\/UserScript==/.exec(s.code)?.[0] || "", scriptWillUpdate: s.autoUpdate !== false && !!(m.updateURL || m.downloadURL || s.source),
    isIncognito: false,
  };
  // Match patterns look at the address without its #part, as Chrome's own do; globs and
  // /regex/ at all of it.
  const rx = (list) => JSON.stringify(list.map((p) => {
    const mr = USM.matchRegex(p), r = mr || USM.globRegex(p);
    return r && [r.source, r.flags, mr ? 1 : 0];
  }).filter(Boolean));
  const check = reg.filter
    ? `{ const u = location.href, h = u.split("#")[0], t = (l) => l.some(([s, f, m]) => new RegExp(s, f).test(m ? h : u));
  const i = ${rx([...m.matches, ...m.includes])}, x = ${rx([...m.excludes, ...m.excludeMatches])};
  if ((i.length && !t(i)) || t(x)) return; }\n`
    : "";
  // Each file once, as fetched; GM_getResourceText / GM_getResourceURL make text or a data URL
  // of it when asked (us-gm.js).
  const resources = Object.fromEntries(m.resources.map((r) => {
    const f = s.resources?.[r.name];
    return [r.name, f ? { text: f.text, b64: f.b64, mime: f.mime, url: f.url } : null];
  }));
  // The GM names come in as the inner function's parameters, so a script may still declare
  // its own (a fallback "function GM_addStyle" or "var GM_info") without clashing.
  const names = page ? ["GM_info", "GM", "unsafeWindow", "GM_log"] : US_API;
  const storage = USM.kindsOf(m).includes("storage");
  // A document-idle script waits for its values before it runs (us-gm.js), so they aren't
  // written in here for it, and saving doesn't register it again (usValuesChanged). Scripts
  // that start earlier, or from the right-click menu, read the copy written here.
  const idle = m.runAt === "document_idle";
  const api = page
    ? `const __usInfo = ${JSON.stringify(info)}, __usApi = { GM_info: __usInfo, GM: { info: __usInfo }, unsafeWindow: window, GM_log: console.log.bind(console, ${JSON.stringify(`[${m.name}]`)}) };\n`
    : `const __usApi = (${usApi.toString()})(${JSON.stringify({ id: s.id, key, info, values: idle ? {} : values || {}, resources, storage })});\n`;
  const requires = m.requires.map((u) => `${s.requires?.[u] ?? `console.warn(${JSON.stringify(`[${m.name}] @require not loaded: ${u}`)});`}\n`).join(";\n");
  const name = m.name.replace(/[^\w .-]/g, "_");
  const run = `(function (${names.join(", ")}) {\n${requires}\n${s.code}\n}).apply(window, ${JSON.stringify(names)}.map((n) => __usApi[n]))`;
  const start = !page && storage && idle ? `__usApi.ready.then(() => ${run});` : `${run};`;
  return `(() => {\n${check}${api}${start}\n})();\n//# sourceURL=userscript:///${encodeURIComponent(name)}.user.js`;
}

// Chrome 133+ gives each script a world of its own, so one script can't use another's
// values or requests, and messages say which world (and so which script) sent them.
const usOwnWorlds = () => typeof chrome.userScripts?.getWorldConfigurations === "function";

function usRegistration(s, values, key) {
  const m = s.meta;
  const reg = USM.registration(m);
  const page = USM.inPage(m);
  return {
    id: `us-${s.id}`, js: [{ code: usInjected(s, values, key) }], matches: reg.matches,
    ...(reg.excludeMatches.length ? { excludeMatches: reg.excludeMatches } : {}),
    runAt: m.runAt, allFrames: !m.noframes, world: page ? "MAIN" : "USER_SCRIPT",
    ...(!page && usOwnWorlds() ? { worldId: s.id } : {}),
  };
}

// Each script's key, built into its registered code (which other scripts and pages can't
// read), so a message naming a script really comes from it. Kept on this computer only
// ("usKeys", not in backups).
let usKeyCache = null;
async function usKeys(ids) {
  if (!usKeyCache) ({ usKeys: usKeyCache = {} } = await chrome.storage.local.get("usKeys"));
  if (ids.some((id) => !usKeyCache[id])) {
    await editLocal(["usKeys"], ({ usKeys = {} }) => {
      for (const id of ids) usKeys[id] ||= crypto.randomUUID();
      usKeyCache = usKeys;
      return { usKeys };
    });
  }
  return usKeyCache;
}

// The message or connection really comes from this script: its key, its own world when
// Chrome says which world sent it, and a page the script runs on.
async function usFromScript(s, sender, key) {
  if (USM.inPage(s.meta) || !key || (await usKeys([s.id]))[s.id] !== key) return false;
  if (sender.userScriptWorldId !== undefined && usOwnWorlds() && sender.userScriptWorldId !== s.id) return false;
  return !!sender.url && USM.urlAllowed(s.meta, sender.url);
}

// Brings Chrome's registered scripts in line with the stored ones (only those that changed
// are touched), and the install redirect and update alarm with the settings.
async function usSyncNow() {
  const { us } = await TT.getSettings();
  const available = await usAvailable();
  usAttach();
  const { scripts, values } = await usLoad();
  const want = available && us.enabled ? scripts.filter((s) => s.enabled !== false && s.meta) : [];
  if (available) {
    await chrome.userScripts.configureWorld({ messaging: true }).catch((err) => console.error("[userscripts] world", err));
    const have = await chrome.userScripts.getScripts();
    const keys = await usKeys(want.map((s) => s.id));
    // @run-at context-menu scripts aren't registered: they run when picked from the right-click
    // menu (usContextRun), in the same world they'd have otherwise.
    const regs = want.filter((s) => s.meta.runAt !== "context_menu").map((s) => usRegistration(s, values[s.id], keys[s.id]));
    // A world of its own only messages Extra Guac when configured to, one by one.
    if (usOwnWorlds()) {
      const worlds = new Set(want.filter((s) => !USM.inPage(s.meta)).map((s) => s.id));
      const configs = await chrome.userScripts.getWorldConfigurations();
      for (const c of configs) if (c.worldId && !worlds.has(c.worldId)) await chrome.userScripts.resetWorldConfiguration(c.worldId).catch(() => {});
      for (const w of worlds) {
        if (!configs.some((c) => c.worldId === w && c.messaging)) {
          await chrome.userScripts.configureWorld({ worldId: w, messaging: true }).catch((err) => console.error(`[userscripts] world ${w}`, err));
        }
      }
    }
    const same = (a, b) => JSON.stringify([a.js, a.matches, a.excludeMatches || [], a.runAt, a.allFrames, a.world, a.worldId || ""]) === JSON.stringify([b.js, b.matches, b.excludeMatches || [], b.runAt, b.allFrames, b.world, b.worldId || ""]);
    const gone = have.filter((h) => !regs.some((r) => r.id === h.id)).map((h) => h.id);
    const changed = regs.filter((r) => have.some((h) => h.id === r.id && !same(h, r)));
    const added = regs.filter((r) => !have.some((h) => h.id === r.id));
    if (gone.length) await chrome.userScripts.unregister({ ids: gone });
    // A change of world can't be an update: those go and come back.
    for (const r of changed) {
      try { await chrome.userScripts.update([r]); }
      catch { await chrome.userScripts.unregister({ ids: [r.id] }); added.push(r); }
    }
    for (const r of added) {
      try { await chrome.userScripts.register([r]); }
      catch (err) { console.error(`[userscripts] ${r.id}`, err); }
    }
  }
  // Opening a .user.js link opens the install page instead (pages only, not Extra Guac's own
  // update checks).
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const has = rules.some((r) => r.id === US_INSTALL_RULE);
  if (available && us.enabled && !has) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: US_INSTALL_RULE, priority: 1,
        action: { type: "redirect", redirect: { regexSubstitution: `${chrome.runtime.getURL("us-install.html")}#\\0` } },
        condition: { regexFilter: "^https?://[^#?]*\\.user\\.js(\\?[^#]*)?$", resourceTypes: ["main_frame"] },
      }],
    });
  } else if ((!available || !us.enabled) && has) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [US_INSTALL_RULE] });
  }
  const hours = US_INTERVALS.includes(Number(us.interval)) ? Number(us.interval) : 24;
  const alarm = await chrome.alarms.get(US_UPDATE_ALARM);
  if (!hours || !scripts.length || !available) { if (alarm) await chrome.alarms.clear(US_UPDATE_ALARM); }
  else if (alarm?.periodInMinutes !== hours * 60) chrome.alarms.create(US_UPDATE_ALARM, { delayInMinutes: Math.min(hours * 60, 5), periodInMinutes: hours * 60 });
  // Right-click items for @run-at context-menu scripts (usContextItems) follow the same changes.
  syncMenus(await TT.getSettings());
}
let usSyncing = Promise.resolve(), usValuesTimer = 0;
const usSync = () => (usSyncing = usSyncing.then(usSyncNow).catch((err) => console.error("[userscripts] sync", err)));
// After saved values change: the copy those scripts start with is brought up to date at once
// (a burst of writes counts as one), so the next page load reads what was just saved. Only
// scripts that start before the page has loaded have such a copy (see usInjected).
const usValuesDue = new Set();
function usValuesChanged(ids) {
  for (const id of ids) usValuesDue.add(id);
  clearTimeout(usValuesTimer);
  usValuesTimer = setTimeout(() => {
    const due = [...usValuesDue];
    usValuesDue.clear();
    usSyncing = usSyncing.then(async () => {
      const { us } = await TT.getSettings();
      if (!us.enabled || !(await usAvailable())) return;
      const { scripts, values } = await usLoad();
      const have = new Set((await chrome.userScripts.getScripts({ ids: due.map((id) => `us-${id}`) })).map((h) => h.id));
      const keys = await usKeys(due);
      const regs = scripts.filter((s) => due.includes(s.id) && have.has(`us-${s.id}`) && s.meta.runAt !== "document_idle").map((s) => usRegistration(s, values[s.id], keys[s.id]));
      if (regs.length) await chrome.userScripts.update(regs);
    }).catch((err) => console.error("[userscripts] values", err));
  }, 50);
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  if (c.usScripts || c.usValues) usForget();
  if (c.usScripts) usSync();
  else if (c.usValues) {
    const was = c.usValues.oldValue || {}, now = c.usValues.newValue || {};
    usValuesChanged([...new Set([...Object.keys(was), ...Object.keys(now)])].filter((id) => JSON.stringify(was[id]) !== JSON.stringify(now[id])));
  }
  if (c.tt) {
    const pick = (tt) => JSON.stringify(TT.merge(TT.DEFAULTS, tt).us);
    if (pick(c.tt.oldValue) !== pick(c.tt.newValue)) usSync();
  }
});
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  // Version 265 had userscripts on at first and in tab 1. From 266 they're off until turned on
  // (kept on where scripts are already installed) and sit in tab 3, below session switch.
  if (reason === "update" && previousVersion === "265") {
    const { scripts } = await usLoad().catch(() => ({ scripts: [] }));
    await TT.settingsTask(async () => {
      const { tt = {} } = await chrome.storage.local.get("tt");
      const next = structuredClone(tt);
      if (!scripts.length) { if (next.us) next.us.enabled = false; }
      else if (next.us?.enabled === undefined) next.us = { ...next.us, enabled: true };
      const lay = next.layout;
      if (lay && Array.isArray(lay.tools) && lay.tools.includes("userscripts")) {
        lay.tools = lay.tools.filter((id) => id !== "userscripts");
        lay.extra = (Array.isArray(lay.extra) ? lay.extra : []).filter((id) => id !== "userscripts");
        const at = lay.extra.indexOf("sessions");
        lay.extra.splice(at === -1 ? lay.extra.length : at + 1, 0, "userscripts");
      }
      await chrome.storage.local.set({ tt: next });
    }).catch((err) => console.error("[userscripts] moving to 266", err));
  }
  usSync();
});
chrome.runtime.onStartup.addListener(() => usSync());
chrome.permissions.onAdded.addListener((p) => p.permissions?.includes("userScripts") && usSync());
chrome.permissions.onRemoved.addListener((p) => p.permissions?.includes("userScripts") && usSync());
chrome.alarms.onAlarm.addListener((a) => a.name === US_UPDATE_ALARM && usCheckUpdates().catch((err) => console.error("[userscripts] updates", err)));

// ---- Fetching a script and what it brings along ----

async function usFetchText(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.text();
}
// The text behind a link that points at a page about the file rather than the file itself.
const usRawUrl = (url) => url.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/, "https://raw.githubusercontent.com/$1/$2/$3")
  .replace(/^(https:\/\/gitlab\.com\/.+?)\/-\/blob\//, "$1/-/raw/");

// @require files (code) and @resource files (text, and the bytes for GM_getResourceURL);
// ones already fetched for the installed copy are kept when the address is the same.
async function usExtras(meta, old = {}) {
  const requires = {}, resources = {};
  for (const url of meta.requires) {
    requires[url] = old.requires?.[url] ?? await usFetchText(url).catch((err) => { throw new Error(`@require ${url}: ${err.message}`); });
  }
  for (const r of meta.resources) {
    const prev = old.resources?.[r.name];
    if (prev?.url === r.url) { resources[r.name] = prev; continue; }
    if (/^data:/.test(r.url)) { resources[r.name] = { url: r.url }; continue; }
    const res = await fetch(r.url, { cache: "no-store", credentials: "omit" }).catch(() => null);
    if (!res?.ok) throw new Error(`@resource ${r.name}: couldn't download ${r.url}`);
    const mime = (res.headers.get("content-type") || "").split(";")[0];
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    resources[r.name] = { url: r.url, mime, b64: btoa(bin) };
  }
  return { requires, resources };
}

// ---- Adding, changing, removing ----

function usCheckCode(code) {
  const meta = USM.parseMeta(code);
  if (!meta) throw new Error("No “// ==UserScript==” block found");
  if (!meta.name.trim()) throw new Error("The script needs a @name");
  return meta;
}

// Installs or replaces (same name and namespace) a script. values: what it had saved (an
// import), which replaces what's there. Returns { id, replaced }.
// fresh: a new script from the editor, which mustn't take the place of an installed one.
async function usInstall({ code, source = "", enabled, values, position, autoUpdate, id: wantId, fresh = false } = {}) {
  const meta = usCheckCode(code);
  const { scripts } = await usLoad();
  const old = scripts.find((s) => (wantId ? s.id === wantId : USM.keyOf(s.meta) === USM.keyOf(meta)));
  if ((wantId || fresh) && scripts.some((s) => s.id !== wantId && USM.keyOf(s.meta) === USM.keyOf(meta))) {
    throw new Error("Another script already has this name and namespace");
  }
  const extras = await usExtras(meta, old || {});
  const id = old?.id || crypto.randomUUID();
  const now = Date.now();
  await usEditScripts((list) => {
    const prev = list.find((s) => s.id === id);
    const rec = {
      ...(prev || {}), id, code, meta, ...extras, source: source || prev?.source || "",
      enabled: enabled ?? prev?.enabled ?? true, autoUpdate: autoUpdate ?? prev?.autoUpdate ?? true,
      position: position ?? prev?.position ?? (list.reduce((n, s) => Math.max(n, s.position ?? 0), 0) + 1),
      installedAt: prev?.installedAt || now, updatedAt: now,
    };
    delete rec.pending;
    return prev ? list.map((s) => (s.id === id ? rec : s)) : [...list, rec];
  });
  if (values && typeof values === "object") {
    await editLocal(["usValues"], ({ usValues = {} }) => ({ usValues: { ...usValues, [id]: values } }));
  }
  return { id, replaced: !!old };
}

async function usRemove(id) {
  await usEditScripts((list) => list.filter((s) => s.id !== id));
  await editLocal(["usValues"], ({ usValues = {} }) => {
    if (!(id in usValues)) return null;
    const { [id]: _, ...rest } = usValues;
    return { usValues: rest };
  });
}

const usPatch = (id, patch) => usEditScripts((list) => (list.some((s) => s.id === id) ? list.map((s) => (s.id === id ? { ...s, ...patch } : s)) : null));

// ---- Updates ----

// Each script with an address to update from (and updates not switched off for it): a newer
// @version is installed, unless it asks for more access and tt.us.ask is on; then it waits
// in "pending" for an OK in settings. ids: only these (check now on one script).
async function usCheckUpdates({ ids } = {}) {
  const { us } = await TT.getSettings();
  const { scripts } = await usLoad();
  const out = { checked: 0, updated: [], waiting: [], failed: [] };
  for (const s of scripts) {
    if (ids ? !ids.includes(s.id) : s.autoUpdate === false) continue;
    const url = s.meta.updateURL || s.meta.downloadURL || s.source;
    if (!/^https?:/i.test(url || "")) continue;
    out.checked++;
    try {
      const first = await usFetchText(url);
      const head = USM.parseMeta(first);
      if (!head) throw new Error("no metadata at the update address");
      if (USM.compareVersions(head.version, s.meta.version) <= 0) { await usPatch(s.id, { checkedAt: Date.now(), checkError: "" }); continue; }
      // A .meta.js address only has the header: the script itself is beside it as .user.js.
      const from = head.downloadURL || s.meta.downloadURL || s.source || url.replace(/\.meta\.js(\?|$)/i, ".user.js$1");
      const code = from !== url || /\.meta\.js(\?|$)/i.test(url) ? await usFetchText(from) : first;
      const meta = usCheckCode(code);
      if (!/==\/UserScript==[^\n]*\n[\s\S]*\S/.test(code)) throw new Error("the update address only has the script's header");
      if (us.ask && USM.asksMore(s.meta, meta)) {
        await usPatch(s.id, { pending: { code, source: from, at: Date.now() }, checkedAt: Date.now(), checkError: "" });
        out.waiting.push(s.meta.name);
        continue;
      }
      await usInstall({ code, source: from, id: s.id });
      await usPatch(s.id, { checkedAt: Date.now(), checkError: "" });
      out.updated.push(`${meta.name} ${meta.version}`);
    } catch (err) {
      await usPatch(s.id, { checkedAt: Date.now(), checkError: err.message });
      out.failed.push(`${s.meta.name}: ${err.message}`);
    }
  }
  await chrome.storage.local.set({ usLastCheck: Date.now() });
  return out;
}

// ---- What scripts ask of Extra Guac ----

const usPorts = new Map(); // `${tabId}:${frameId}:${scriptId}` -> port
const usPortKey = (sender, id) => `${sender.tab?.id ?? -1}:${sender.frameId ?? 0}:${id}`;
const usXhrs = new Map(); // request id -> AbortController

async function usScript(id) {
  const { scripts } = await usLoad();
  return scripts.find((s) => s.id === id && s.enabled !== false);
}
function usNeed(s, kind) {
  if (!USM.kindsOf(s.meta).includes(kind)) throw new Error(`Not granted: this needs a @grant for ${kind}`);
}

// Requests go where @connect allows: when a script names none, anywhere.
function usConnectAllowed(meta, url, pageUrl) {
  const host = new URL(url).hostname.toLowerCase();
  let pageHost = "";
  try { pageHost = new URL(pageUrl).hostname.toLowerCase(); } catch {}
  if (!meta.connects.length || host === pageHost) return true;
  return meta.connects.some((c) => {
    const d = c.toLowerCase().trim();
    if (d === "*") return true;
    if (d === "self") return host === pageHost;
    return host === d || host.endsWith(`.${d.replace(/^\*\./, "")}`);
  });
}

function usBody(b) {
  if (!b) return undefined;
  const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (b.text != null) return b.text;
  if (b.b64 != null) return new Blob([bytes(b.b64)], { type: b.type || "" });
  if (b.form) {
    const f = new FormData();
    for (const p of b.form) p.b64 != null ? f.append(p.k, new Blob([bytes(p.b64)], { type: p.type || "" }), p.name || "blob") : f.append(p.k, p.v);
    return f;
  }
}

// Headers a fetch can't set (Chrome drops them) are set by a request rule for just that request:
// a session rule on its exact address, for requests from here (no tab), gone once the answer's
// headers are in. While one is up, every request from here to that address waits its turn.
const US_RULED_HEADERS = ["cookie", "referer", "user-agent", "origin"];
const US_RULE_BASE = 9400000; // session rules 9400000-9499999
let usNextRule = 0;
const usUrlTurns = new Map(); // address -> settles when its rule is gone
// Rules left from before the worker last stopped (their requests stopped with it).
chrome.declarativeNetRequest.getSessionRules().then((rules) => {
  const ids = rules.map((r) => r.id).filter((id) => id >= US_RULE_BASE && id < US_RULE_BASE + 100000);
  if (ids.length) return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}).catch(() => {});

async function usWithHeaders(url, method, ruled, send) {
  while (usUrlTurns.has(url)) await usUrlTurns.get(url);
  if (!ruled.length) return send();
  let done;
  usUrlTurns.set(url, new Promise((r) => { done = r; }));
  const id = US_RULE_BASE + (usNextRule++ % 100000);
  const methods = ["connect", "delete", "get", "head", "options", "patch", "post", "put"];
  const condition = { tabIds: [chrome.tabs.TAB_ID_NONE], requestMethods: [methods.includes(method.toLowerCase()) ? method.toLowerCase() : "other"] };
  const rule = (match) => ({ id, priority: 1, action: { type: "modifyHeaders", requestHeaders: ruled }, condition: { ...condition, ...match } });
  try {
    // A regular expression of the exact address; an address too long for one, as a plain filter.
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule({ regexFilter: `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` })] })
      .catch(() => (/[*^|]/.test(url) ? null : chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule({ urlFilter: `|${url}|` })] })))
      .catch((err) => console.warn("[userscripts] request headers", err));
    return await send();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
    usUrlTurns.delete(url);
    done();
  }
}

// Answers bigger than this, and every "stream" answer, come over the script's connection in
// pieces (one message can't hold much more than 64 MB).
const US_CHUNK = 1024 * 1024;
const usB64 = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const usJoin = (list, size) => {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of list) { out.set(c, at); at += c.length; }
  return out;
};

async function usXhr(s, sender, { rid, req }) {
  usNeed(s, "requests");
  const url = new URL(req.url);
  if (!/^(https?|data):$/.test(url.protocol)) throw new Error(`Can't request ${url.protocol} addresses`);
  if (url.protocol !== "data:" && !usConnectAllowed(s.meta, url.href, sender.url || sender.tab?.url)) {
    throw new Error(`${url.hostname} isn't in this script's @connect list`);
  }
  const ctl = new AbortController();
  const key = `${usPortKey(sender, s.id)}|${rid}`;
  const port = () => usPorts.get(usPortKey(sender, s.id));
  usXhrs.set(key, ctl);
  let timedOut = false;
  const timer = req.timeout > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, req.timeout) : 0;
  const headers = new Headers(), ruled = [];
  for (const [k, v] of Object.entries(req.headers || {})) {
    const name = k.toLowerCase().trim();
    if (US_RULED_HEADERS.includes(name) && url.protocol !== "data:") ruled.push({ header: name, operation: "set", value: String(v) });
    else { try { headers.set(k, String(v)); } catch {} }
  }
  // cookie: added to the cookies the request carries anyway.
  if (req.cookie && url.protocol !== "data:") {
    const set = ruled.find((h) => h.header === "cookie");
    if (set) set.value = `${set.value}; ${req.cookie}`;
    else ruled.push({ header: "cookie", operation: "append", value: String(req.cookie) });
  }
  if (req.user && !headers.has("authorization")) headers.set("authorization", `Basic ${btoa(`${req.user}:${req.password || ""}`)}`);
  const body = usBody(req.body);
  if (req.body?.type && !headers.has("content-type")) headers.set("content-type", req.body.type);
  try {
    const address = url.href.split("#")[0];
    const res = await usWithHeaders(address, req.method, ruled, () => fetch(address, {
      method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, signal: ctl.signal,
      credentials: req.anonymous ? "omit" : "include", redirect: ["manual", "error"].includes(req.redirect) ? req.redirect : "follow", cache: "no-store",
    }));
    // A redirect may not lead outside the @connect list either.
    if (res.redirected && !usConnectAllowed(s.meta, res.url, sender.url || sender.tab?.url)) {
      ctl.abort();
      return { ev: "error", error: `${new URL(res.url).hostname} (redirected to) isn't in this script's @connect list`, finalUrl: url.href };
    }
    const head = {
      status: res.status, statusText: res.statusText, finalUrl: res.url || url.href, mime: res.headers.get("content-type") || "",
      headers: [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\r\n"),
    };
    const charset = /charset=([^;]+)/i.exec(head.mime)?.[1] || "";
    if (req.progress) port()?.postMessage({ t: "xhr", rid, ev: "headers", ...head });
    const total = Number(res.headers.get("content-length")) || 0;
    // Pieces go out as they're read for a stream; otherwise the answer is kept until it's done,
    // or until it's bigger than US_CHUNK, when it goes out 1 MB at a time from there on.
    let streamed = !!req.stream && !!port(), loaded = 0, last = 0;
    let held = [], heldSize = 0;
    const flush = () => {
      if (!heldSize) return;
      port()?.postMessage({ t: "xhr", rid, ev: "chunk", b64: usB64(usJoin(held, heldSize)) });
      held = []; heldSize = 0;
    };
    if (res.body && req.method !== "HEAD") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        held.push(value);
        heldSize += value.length;
        loaded += value.length;
        if (!streamed && heldSize > US_CHUNK && port()) streamed = true;
        if (streamed && (req.stream || heldSize >= US_CHUNK)) flush();
        if (req.progress && Date.now() - last > 100) { last = Date.now(); port()?.postMessage({ t: "xhr", rid, ev: "progress", loaded, total }); }
      }
    }
    if (streamed) {
      flush();
      port()?.postMessage({ t: "xhr", rid, ev: "load", streamed: true, charset, ...head });
      return { ev: "streamed" };
    }
    const bytes = usJoin(held, heldSize);
    const out = { ev: "load", ...head };
    if (req.binary) out.b64 = usB64(bytes);
    else {
      let dec;
      try { dec = new TextDecoder(charset || "utf-8"); } catch { dec = new TextDecoder(); }
      out.text = dec.decode(bytes);
    }
    return out;
  } catch (err) {
    return { ev: timedOut ? "timeout" : ctl.signal.aborted ? "abort" : "error", error: err.message, finalUrl: url.href };
  } finally {
    clearTimeout(timer);
    usXhrs.delete(key);
  }
}

// Menu commands, per tab (storage.session "usMenus"), for the popup to list.
function usMenus(tabId, fn) {
  return editSession(`usMenus:${tabId}`, (list = []) => fn(list));
}

const usOps = {
  values: async (s) => { usNeed(s, "storage"); const { values } = await usLoad(); return { values: values[s.id] || {} }; },
  setValues: async (s, sender, { values: set }) => { usNeed(s, "storage"); await usWriteValues(s, sender, set || {}, []); },
  deleteValues: async (s, sender, { keys }) => { usNeed(s, "storage"); await usWriteValues(s, sender, {}, keys || []); },
  xhr: (s, sender, msg) => usXhr(s, sender, msg),
  xhrAbort: async (s, sender, { rid }) => { usXhrs.get(`${usPortKey(sender, s.id)}|${rid}`)?.abort(); },
  clipboard: async (s, sender, { text, html }) => {
    usNeed(s, "clipboard");
    if (!(await copyToClipboard(String(text), { html: !!html }))) throw new Error("Couldn't copy");
  },
  notification: async (s, sender, { nid, n }) => {
    usNeed(s, "notifications");
    // highlight: the tab that sent it comes to the front; with no text, that's all it does.
    if (n.highlight && sender.tab) await usFocusTab(sender.tab);
    if (n.highlight && !n.text) return { shown: false };
    const id = `us:${usPortKey(sender, s.id)}:${nid}`;
    const opts = { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title: n.title || s.meta.name, message: n.text || " ", silent: !!n.silent };
    if (/^data:image\//.test(n.image || "")) opts.iconUrl = n.image;
    else if (/^https?:/i.test(n.image || "")) opts.iconUrl = (await usImageData(n.image)) || opts.iconUrl;
    await chrome.notifications.create(id, opts);
    await editSession("usNotifs", (map = {}) => ({ ...map, [id]: { key: usPortKey(sender, s.id), nid } }));
    if (n.timeout > 0) setTimeout(() => chrome.notifications.clear(id), n.timeout);
  },
  openInTab: async (s, sender, { oid, url, active, insert }) => {
    usNeed(s, "tabs");
    if (!/^(https?|ftp|file|data):/i.test(url)) throw new Error("Can't open that address");
    const from = sender.tab;
    const tab = await chrome.tabs.create({ url, active, ...(from && insert ? { index: from.index + 1, openerTabId: from.id, windowId: from.windowId } : {}) });
    // Remembered so the script hears when it closes, and only it can close it.
    await editSession("usTabs", (map = {}) => Object.fromEntries([...Object.entries(map).slice(-200), [tab.id, { key: usPortKey(sender, s.id), oid }]]));
    return { tabId: tab.id };
  },
  closeTab: async (s, sender, { tabId }) => {
    const { usTabs = {} } = await chrome.storage.session.get("usTabs");
    if (usTabs[tabId]?.key.endsWith(`:${s.id}`)) await chrome.tabs.remove(tabId).catch(() => {});
  },
  download: async (s, sender, { did, url, name, saveAs, conflict }) => {
    usNeed(s, "downloads");
    if (!/^(https?|data):/i.test(url)) throw new Error("Can't download that address");
    const filename = String(name || "").split(/[\\/]/).map((p) => p.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").trim()).filter(Boolean).join("/");
    const downloadId = await chrome.downloads.download({ url, filename: filename || undefined, saveAs, conflictAction: ["uniquify", "overwrite", "prompt"].includes(conflict) ? conflict : "uniquify" });
    // The script hears when it's saved or has stopped (usDownloadDone). A small file can be done
    // before this is written down, so its state is looked at once more after.
    await editSession("usDownloads", (map = {}) => ({ ...map, [downloadId]: { key: usPortKey(sender, s.id), did } }));
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item && item.state !== "in_progress") await usDownloadDone(downloadId, item.state, item.error);
    return { downloadId };
  },
  // @grant window.close: only the top frame closes its tab, as a page's own window.close would.
  closeSelf: async (s, sender) => {
    usNeed(s, "window");
    if (!s.meta.grants.includes("window.close")) throw new Error("Not granted: this needs @grant window.close");
    if (sender.frameId || sender.tab?.id == null) throw new Error("Only the top frame can close its tab");
    await chrome.tabs.remove(sender.tab.id);
  },
  focusSelf: async (s, sender) => {
    usNeed(s, "window");
    if (!s.meta.grants.includes("window.focus")) throw new Error("Not granted: this needs @grant window.focus");
    if (sender.tab) await usFocusTab(sender.tab);
  },
  menu: async (s, sender, { cid, name, title }) => {
    usNeed(s, "menu");
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    await usMenus(tabId, (list) => [...list.filter((m) => !(m.us === s.id && m.cid === cid && m.frameId === sender.frameId)),
      { us: s.id, cid, name: name.slice(0, 200), title: String(title || "").slice(0, 300), frameId: sender.frameId ?? 0 }]);
  },
  unmenu: async (s, sender, { cid }) => {
    const tabId = sender.tab?.id;
    if (tabId != null) await usMenus(tabId, (list) => list.filter((m) => !(m.us === s.id && m.cid === cid && m.frameId === sender.frameId)));
  },
};

// storage.session read-change-write, one at a time.
let sessionEdits = Promise.resolve();
function editSession(key, fn) {
  const run = sessionEdits.then(async () => {
    const { [key]: v } = await chrome.storage.session.get(key);
    await chrome.storage.session.set({ [key]: fn(v) });
  });
  sessionEdits = run.catch(() => {});
  return run;
}

// Saves values and tells this script's copies in other tabs and frames. Saving what's already
// there writes nothing.
async function usWriteValues(s, sender, set, keys) {
  let changed = false;
  await editLocal(["usValues"], ({ usValues = {} }) => {
    const was = usValues[s.id] || {};
    const mine = { ...was, ...set };
    for (const k of keys) delete mine[k];
    changed = JSON.stringify(mine) !== JSON.stringify(was);
    return changed ? { usValues: { ...usValues, [s.id]: mine } } : null;
  });
  if (!changed) return;
  const from = usPortKey(sender, s.id);
  for (const [key, port] of usPorts) {
    if (key === from || !key.endsWith(`:${s.id}`)) continue;
    for (const [k, value] of Object.entries(set)) port.postMessage({ t: "value", key: k, value });
    for (const k of keys) port.postMessage({ t: "value", key: k, deleted: true });
  }
}

function usOnMessage(msg, sender, reply) {
  const op = typeof msg?.op === "string" && Object.hasOwn(usOps, msg.op) && usOps[msg.op];
  if (!op || typeof msg.us !== "string") return;
  usScript(msg.us)
    .then((s) => {
      if (!s) throw new Error("This script is off or gone");
      return usFromScript(s, sender, msg.key).then((ok) => {
        if (!ok) throw new Error("Not this script's message");
        return op(s, sender, msg);
      });
    })
    .then((r) => reply(r && typeof r === "object" ? r : {}), (err) => reply({ error: err?.message || String(err) }));
  return true;
}

function usOnConnect(port) {
  const [, id, key] = /^us:([^:]+):(.+)$/.exec(port.name) || [];
  if (!id) return port.disconnect();
  usScript(id)
    .then(async (s) => (s && (await usFromScript(s, port.sender, key)) ? usOnScriptPort(port, id) : port.disconnect()))
    .catch(() => port.disconnect());
}

function usOnScriptPort(port, id) {
  const key = usPortKey(port.sender, id);
  usPorts.set(key, port);
  // From here on it hears about changed values; told so, it asks for any it missed before.
  port.postMessage({ t: "hello" });
  port.onDisconnect.addListener(() => {
    if (usPorts.get(key) === port) usPorts.delete(key);
    const tabId = port.sender.tab?.id;
    if (tabId != null) usMenus(tabId, (list) => list.filter((m) => !(m.us === id && m.frameId === (port.sender.frameId ?? 0)))).catch(() => {});
  });
}

// The events only exist once the permission is there; attached at start, or as soon as it is.
let usAttached = false;
function usAttach() {
  if (usAttached || !chrome.runtime.onUserScriptMessage) return;
  usAttached = true;
  chrome.runtime.onUserScriptMessage.addListener(usOnMessage);
  chrome.runtime.onUserScriptConnect.addListener(usOnConnect);
}
usAttach();

// Tells a script's copy something over its connection. The event that brings it here may have
// woken the worker, and the copy reconnects half a second after that, so it's tried a few times.
function usPost(key, msg, tries = 8) {
  const port = usPorts.get(key);
  if (port) { try { port.postMessage(msg); return; } catch {} }
  if (tries > 0) setTimeout(() => usPost(key, msg, tries - 1), 500);
}

async function usFocusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

// A notification's image from the web, as a data URL (Chrome only shows those or its own files).
async function usImageData(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    const blob = res.ok ? await res.blob() : null;
    if (!blob || !/^image\//.test(blob.type) || blob.size > 2 * 1024 * 1024) return "";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type};base64,${btoa(bin)}`;
  } catch { return ""; }
}

// Kept in storage.session, so a click still finds its script after the worker slept (the
// script's connection comes back on its own).
async function usNotif(id, ev) {
  if (!id.startsWith("us:")) return;
  const { usNotifs = {} } = await chrome.storage.session.get("usNotifs");
  const n = usNotifs[id];
  if (!n) return;
  usPost(n.key, { t: "notif", nid: n.nid, ev });
  if (ev === "done") await editSession("usNotifs", (map = {}) => { const { [id]: _, ...rest } = map; return rest; });
}
chrome.notifications.onClicked.addListener((id) => { usNotif(id, "click").catch(() => {}); });
chrome.notifications.onClosed.addListener((id) => { usNotif(id, "done").catch(() => {}); });

// A script's download has been saved or has stopped: told once, whichever notices first.
async function usDownloadDone(downloadId, state, error) {
  let entry = null;
  await editSession("usDownloads", (map = {}) => {
    entry = map[downloadId] || null;
    const { [downloadId]: _, ...rest } = map;
    return rest;
  });
  if (entry) usPost(entry.key, { t: "download", did: entry.did, ev: state === "complete" ? "load" : "error", error: error || "" });
}
chrome.downloads.onChanged.addListener((d) => {
  const state = d.state?.current;
  if (state === "complete" || state === "interrupted") usDownloadDone(d.id, state, d.error?.current).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  chrome.storage.session.remove(`usMenus:${tabId}`).catch(() => {});
  // A tab a script opened: it hears that it closed.
  const { usTabs = {} } = await chrome.storage.session.get("usTabs").catch(() => ({}));
  if (!usTabs[tabId]) return;
  let entry = null;
  await editSession("usTabs", (map = {}) => {
    entry = map[tabId] || null;
    if (!entry) return map;
    const { [tabId]: _, ...rest } = map;
    return rest;
  }).catch(() => {});
  if (entry) usPost(entry.key, { t: "tabClosed", oid: entry.oid });
});

// ---- Right-click menu: @run-at context-menu ----

// A script that runs from the right-click menu gets an item there on the pages it names (under
// "Userscripts" when there are several). Running it needs chrome.userScripts.execute (Chrome 135+).
const usCanRunNow = () => typeof chrome.userScripts?.execute === "function";
async function usContextItems() {
  const { us } = await TT.getSettings();
  if (!us.enabled || !usCanRunNow() || !(await usAvailable())) return;
  const { scripts } = await usLoad();
  const list = usByOrder(scripts).filter((s) => s.enabled !== false && s.meta?.runAt === "context_menu");
  if (!list.length) return;
  const patterns = (s) => USM.registration(s.meta).matches;
  const parentId = list.length > 1 ? "us" : undefined;
  if (parentId) chrome.contextMenus.create({ id: parentId, title: "Userscripts", contexts: ["all"], documentUrlPatterns: [...new Set(list.flatMap(patterns))] });
  for (const s of list) {
    chrome.contextMenus.create({ id: `us:${s.id}`, parentId, title: parentId ? s.meta.name : `Run ${s.meta.name}`, contexts: ["all"], documentUrlPatterns: patterns(s) });
  }
}

// Picked from the menu: runs once in the frame that was right-clicked (the top one for
// @noframes), as it would have run on load.
async function usContextRun(info, tab) {
  const id = String(info.menuItemId).slice(3);
  const { scripts, values } = await usLoad();
  const s = scripts.find((x) => x.id === id && x.enabled !== false);
  if (!s || !usCanRunNow()) return;
  const frameId = s.meta.noframes ? 0 : info.frameId || 0;
  if (!USM.urlAllowed(s.meta, (frameId ? info.frameUrl : info.pageUrl) || tab.url || "")) return;
  const key = (await usKeys([s.id]))[s.id];
  const page = USM.inPage(s.meta);
  await chrome.userScripts.execute({
    target: { tabId: tab.id, frameIds: [frameId] }, injectImmediately: true,
    js: [{ code: usInjected(s, values[s.id], key) }], world: page ? "MAIN" : "USER_SCRIPT",
    ...(!page && usOwnWorlds() ? { worldId: s.id } : {}),
  });
}

// ---- From the popup, settings, editor and install page ----

// The userscripts page, in one tab: brought to the front (on the tab the hash names) when it's
// open already. hash: "settings", "edit=<id>", "new=<site>" or nothing for the list.
async function usOpenPage(hash = "") {
  const base = chrome.runtime.getURL("userscripts.html");
  const url = hash ? `${base}#${hash}` : base;
  const [tab] = await chrome.tabs.query({ url: `${base}*` });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true, ...(hash ? { url } : {}) });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    await chrome.tabs.create({ url, ...(win ? { windowId: win.id } : {}) });
    if (win) await chrome.windows.update(win.id, { focused: true });
  }
}

const usHandlers = {
  usOpen: ({ hash }) => usOpenPage(typeof hash === "string" ? hash : ""),
  usState: () => usState(),
  usSync: async () => { await usSync(); return usState(); },
  usList: async () => {
    const { scripts } = await usLoad();
    const { usLastCheck = 0 } = await chrome.storage.local.get("usLastCheck");
    // Code isn't needed for the list; whether an update waits, and what it asks for, is.
    return {
      lastCheck: usLastCheck,
      scripts: usByOrder(scripts).map(({ code, requires, resources, pending, ...s }) => ({
        ...s, limits: USM.limits(s.meta, code, requires || {}), pending: pending ? { at: pending.at, meta: USM.parseMeta(pending.code) } : null,
      })),
    };
  },
  usGet: async ({ id }) => {
    const { scripts, values } = await usLoad();
    const s = scripts.find((x) => x.id === id);
    if (!s) throw new Error("That script is gone");
    return { script: s, values: values[id] || {} };
  },
  // From the install page or the editor.
  usInstall: (msg) => usInstall({ code: msg.code, source: msg.source, id: msg.id, fresh: !!msg.fresh }),
  usToggle: ({ id, enabled }) => usPatch(id, { enabled: !!enabled }),
  usAutoUpdate: ({ id, on }) => usPatch(id, { autoUpdate: !!on }),
  usRemove: ({ id }) => usRemove(id),
  usCheckUpdates: ({ ids }) => usCheckUpdates({ ids }),
  // The update that waited for an OK: installed (yes) or dropped.
  usPending: async ({ id, install, at }) => {
    const { scripts } = await usLoad();
    const s = scripts.find((x) => x.id === id);
    if (!s?.pending) throw new Error("That update was already installed or skipped.");
    // Only the update that was looked at: a newer one that came in since needs its own look.
    if (install && at != null && s.pending.at !== at) throw new Error("A newer update came in since this page opened. Reload it to see what changed.");
    if (!install) return usPatch(id, { pending: null });
    await usInstall({ code: s.pending.code, source: s.pending.source, id });
  },
  // Many at once (an import): { items: [{ code, enabled, values, source, position }] }.
  usImport: async ({ items }) => {
    const out = { added: 0, replaced: 0, failed: [] };
    for (const it of Array.isArray(items) ? items : []) {
      try {
        const r = await usInstall({ code: it.code, source: it.source, enabled: it.enabled, values: it.values, position: it.position });
        r.replaced ? out.replaced++ : out.added++;
      } catch (err) {
        out.failed.push(`${it.name || USM.parseMeta(it.code)?.name || "a script"}: ${err.message}`);
      }
    }
    return out;
  },
  usExport: async () => {
    const { scripts, values } = await usLoad();
    return { scripts: usByOrder(scripts).map((s) => ({ id: s.id, name: s.meta.name, code: s.code, enabled: s.enabled !== false, position: s.position, source: s.source || "", values: values[s.id] || {} })) };
  },
  usMenuRun: async ({ tabId, us, cid, frameId = 0 }) => {
    const port = usPorts.get(`${tabId}:${frameId}:${us}`);
    if (!port) throw new Error("The page was reloaded; open the menu again");
    port.postMessage({ t: "menu", cid });
  },
};
