// Userscripts: the GM_* / GM.* functions a script gets. bg-userscripts.js puts this function's
// source in front of each script that asks for them and calls it with that script's details;
// it runs in the script's own world beside the page, so it only reaches Extra Guac through
// chrome.runtime messages (handled by bg-userscripts.js). Nothing outside this function is used.
// eslint-disable-next-line no-unused-vars
function usApi(ctx) {
  const { id, key, info, resources = {} } = ctx;
  let values = { ...ctx.values };
  const ask = async (op, data = {}) => {
    const r = await chrome.runtime.sendMessage({ ...data, us: id, key, op });
    if (r?.error) throw new Error(r.error);
    return r;
  };
  const warn = (what, err) => console.warn(`[${info.script.name}] ${what}:`, err?.message || err);

  // One connection per script and frame, opened when first needed: values changed elsewhere,
  // menu commands run from the popup, request progress and notification clicks come back on it.
  let port = null;
  const onPort = new Map(); // kind -> handler
  function connect() {
    if (port) return port;
    port = chrome.runtime.connect({ name: `us:${id}:${key}` });
    port.onMessage.addListener((m) => onPort.get(m?.t)?.(m));
    // Extra Guac's side sleeps when idle, which closes this; it's opened again while anything
    // still listens (menu commands are told again, so the popup's list keeps working).
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(() => {
        if (port || !(menus.size || listeners.size || notifs.size)) return;
        connect();
        for (const [cid, m] of menus) ask("menu", { cid, name: m.name, title: m.title }).catch(() => {});
      }, 500);
    });
    return port;
  }

  // ---- Values ----
  // Read from a copy here, so GM_getValue answers at once; writes go to Extra Guac and the
  // other tabs running this script hear about them over the connection. The copy is refreshed
  // at start, and again each time the connection is opened: changes made while it was closed
  // (Extra Guac's side asleep, or not connected yet) were sent to nobody.
  const listeners = new Map();
  let nextListener = 1;
  function changed(key, oldValue, newValue, remote) {
    for (const l of listeners.values()) {
      if (l.key !== key) continue;
      try { l.fn(key, oldValue, newValue, remote); } catch (err) { console.error(err); }
    }
  }
  // Keys written here, or heard about, after a refresh was asked for are newer than its answer,
  // so it leaves them as they are. One set per refresh waiting or on its way.
  const watching = new Set();
  const touched = (k) => { for (const fresh of watching) fresh.add(k); };
  onPort.set("value", (m) => {
    touched(m.key);
    const old = values[m.key];
    if (m.deleted) delete values[m.key];
    else values[m.key] = m.value;
    changed(m.key, old, m.deleted ? undefined : m.value, true);
  });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  // What differs from Extra Guac's saved values comes in as changes made elsewhere. One at a time.
  let refreshing = Promise.resolve();
  function refresh() {
    const fresh = new Set();
    watching.add(fresh);
    refreshing = refreshing.then(() => ask("values").then((r) => {
      const got = r.values || {};
      for (const [k, v] of Object.entries(got)) {
        if (!fresh.has(k) && JSON.stringify(values[k]) !== JSON.stringify(v)) { const old = values[k]; values[k] = v; changed(k, old, v, true); }
      }
      for (const k of Object.keys(values)) if (!fresh.has(k) && !(k in got)) { const old = values[k]; delete values[k]; changed(k, old, undefined, true); }
    }, () => {}).finally(() => { watching.delete(fresh); }));
    return refreshing;
  }
  // Sent once the connection hears about changes, so nothing from before then is missed.
  onPort.set("hello", () => { if (ctx.storage) refresh(); });
  // The copy this page started with can be older than a value saved just before it loaded (the
  // registered code is brought up to date a moment after each save). A document-idle script
  // waits for this first refresh, for 2 seconds at most, before it runs (bg-userscripts.js).
  const ready = ctx.storage ? Promise.race([refresh(), new Promise((r) => setTimeout(r, 2000))]) : Promise.resolve();
  const getValue = (key, def) => (Object.hasOwn(values, key) ? clone(values[key]) : def);
  function setValues(obj) {
    const set = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const json = JSON.stringify(v);
      if (json === undefined) continue;
      const old = values[k];
      touched(k);
      values[k] = JSON.parse(json);
      set[k] = values[k];
      changed(k, old, values[k], false);
    }
    return ask("setValues", { values: set }).catch((err) => warn("saving failed", err));
  }
  function deleteValues(keys) {
    for (const k of keys) { touched(k); if (Object.hasOwn(values, k)) { const old = values[k]; delete values[k]; changed(k, old, undefined, false); } }
    return ask("deleteValues", { keys }).catch((err) => warn("deleting failed", err));
  }
  function addValueChangeListener(key, fn) {
    connect();
    const lid = nextListener++;
    listeners.set(lid, { key: String(key), fn });
    return lid;
  }

  // ---- Requests (made by Extra Guac, so other sites' answers can be read) ----
  let nextReq = 1;
  const requests = new Map();
  onPort.set("xhr", (m) => requests.get(m.rid)?.(m));
  async function body(data) {
    if (data == null) return null;
    if (typeof data === "string") return { text: data };
    if (data instanceof URLSearchParams) return { text: data.toString(), type: "application/x-www-form-urlencoded;charset=UTF-8" };
    if (data instanceof FormData) {
      const parts = [];
      for (const [k, v] of data) parts.push(typeof v === "string" ? { k, v } : { k, name: v.name, type: v.type, b64: await b64(v) });
      return { form: parts };
    }
    if (data instanceof Blob) return { b64: await b64(data), type: data.type };
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return { b64: await b64(new Blob([data])) };
    if (typeof data === "object") return { text: JSON.stringify(data) };
    return { text: String(data) };
  }
  async function b64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  function xmlhttpRequest(d = {}) {
    const rid = `${id}:${nextReq++}`;
    let done = false, aborted = false;
    const call = (name, arg) => { try { d[name]?.call(handle, arg); } catch (err) { console.error(err); } };
    const handle = {
      abort() {
        if (done || aborted) return;
        aborted = true;
        ask("xhrAbort", { rid }).catch(() => {});
        const r = { readyState: 4, status: 0, statusText: "", response: null, responseText: "", finalUrl: d.url };
        call("onabort", r); call("onloadend", r);
      },
    };
    let resolve, reject;
    handle.promise = new Promise((a, b) => { resolve = a; reject = b; });
    handle.promise.catch(() => {});
    (async () => {
      if (typeof d.onprogress === "function") connect();
      const type = (d.responseType || "").toLowerCase();
      requests.set(rid, (m) => {
        if (aborted) return;
        if (m.ev === "progress") return call("onprogress", { lengthComputable: !!m.total, loaded: m.loaded, total: m.total || 0 });
        done = true;
        requests.delete(rid);
        const r = { readyState: 4, status: m.status || 0, statusText: m.statusText || "", finalUrl: m.finalUrl || d.url, responseHeaders: m.headers || "", context: d.context };
        if (m.ev !== "load") {
          r.error = m.error || "";
          call(m.ev === "timeout" ? "ontimeout" : "onerror", r);
          call("onloadend", r);
          return reject(r);
        }
        const bytes = m.b64 != null ? fromB64(m.b64) : null;
        // charset=x-user-defined: one character per byte, as the page's own XMLHttpRequest gives.
        const raw = !!d.overrideMimeType?.includes("charset=x-user-defined");
        const text = !bytes ? m.text ?? "" : raw ? Array.from(bytes, (b) => String.fromCharCode(b < 0x80 ? b : 0xf700 + b)).join("") : new TextDecoder().decode(bytes);
        let response = text;
        if (type === "json") { try { response = JSON.parse(text); } catch { response = undefined; } }
        else if (type === "arraybuffer") response = bytes ? bytes.buffer : new TextEncoder().encode(text).buffer;
        else if (type === "blob") response = new Blob([bytes || text], { type: m.mime || "" });
        else if (type === "document") { try { response = new DOMParser().parseFromString(text, /xml/.test(m.mime || "") ? "text/xml" : "text/html"); } catch { response = null; } }
        Object.assign(r, { response });
        if (type === "" || type === "text" || type === "json" || type === "document") r.responseText = text;
        if (type === "document") r.responseXML = response;
        call("onreadystatechange", r);
        call("onload", r);
        call("onloadend", r);
        resolve(r);
      });
      call("onloadstart", { readyState: 1, finalUrl: d.url });
      const req = {
        url: new URL(d.url, location.href).href, method: (d.method || "GET").toUpperCase(), headers: d.headers || {}, body: await body(d.data),
        timeout: Number(d.timeout) || 0, anonymous: !!d.anonymous, binary: ["arraybuffer", "blob"].includes(type) || !!d.overrideMimeType?.includes("charset=x-user-defined"),
        redirect: d.redirect, user: d.user, password: d.password, progress: typeof d.onprogress === "function",
      };
      // The answer is the reply; the connection only carries progress.
      const m = await ask("xhr", { rid, req });
      requests.get(rid)?.(m);
    })().catch((err) => {
      requests.delete(rid);
      if (aborted) return;
      done = true;
      const r = { readyState: 4, status: 0, statusText: "", error: err.message, finalUrl: d.url };
      call("onerror", r); call("onloadend", r);
      reject(r);
    });
    return handle;
  }

  // ---- The page ----
  function addElement(parent, tag, attrs) {
    if (typeof parent === "string") { attrs = tag; tag = parent; parent = null; }
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "textContent") el.textContent = v;
      else if (k === "innerHTML") { try { el.innerHTML = v; } catch { el.textContent = v; } } // pages with Trusted Types refuse it
      else el.setAttribute(k, v);
    }
    (parent || (["script", "style", "link", "meta"].includes(tag) ? document.head || document.documentElement : document.body || document.documentElement)).append(el);
    return el;
  }
  const addStyle = (css) => addElement("style", { textContent: css });
  // Copied by Extra Guac (in its own hidden page), so it works without a click on the page.
  const setClipboard = (data) => ask("clipboard", { text: String(data ?? "") }).catch((err) => warn("copying failed", err));

  // ---- Extra Guac does it ----
  let nextNotif = 1;
  const notifs = new Map();
  onPort.set("notif", (m) => notifs.get(m.nid)?.(m.ev));
  function notification(details, title, image, onclick) {
    const d = typeof details === "string" ? { text: details, title, image, onclick } : { ...details };
    const nid = `${id}:${nextNotif++}`;
    connect();
    return new Promise((resolve) => {
      notifs.set(nid, (ev) => {
        if (ev === "click") { try { d.onclick?.(); } catch (err) { console.error(err); } }
        else { notifs.delete(nid); try { d.ondone?.(); } catch (err) { console.error(err); } resolve(); }
      });
      ask("notification", { nid, n: { text: d.text || "", title: d.title || "", image: d.image || "", silent: !!d.silent, timeout: Number(d.timeout) || 0, highlight: !!d.highlight } })
        .catch((err) => { warn("notification failed", err); notifs.delete(nid); resolve(); });
    });
  }
  function openInTab(url, opts) {
    const o = typeof opts === "boolean" ? { active: !opts } : { active: true, ...opts };
    if (o.loadInBackground !== undefined) o.active = !o.loadInBackground;
    const tab = { closed: false, onclose: null, close() { tab.closed = true; tabId.then((t) => t && ask("closeTab", { tabId: t })).catch(() => {}); } };
    const tabId = ask("openInTab", { url: new URL(url, location.href).href, active: !!o.active, insert: o.insert !== false }).then((r) => r.tabId, (err) => warn("opening the tab failed", err));
    return tab;
  }
  async function download(details, name) {
    const d = typeof details === "string" ? { url: details, name } : { ...details };
    try {
      let url = d.url;
      if (url instanceof Blob) url = `data:${url.type || "application/octet-stream"};base64,${await b64(url)}`;
      else if (/^blob:/.test(url)) { const blob = await (await fetch(url)).blob(); url = `data:${blob.type || "application/octet-stream"};base64,${await b64(blob)}`; }
      else url = new URL(url, location.href).href;
      await ask("download", { url, name: d.name || "", saveAs: !!d.saveAs, conflict: d.conflictAction || "uniquify" });
      try { d.onload?.({}); } catch (err) { console.error(err); }
    } catch (err) {
      try { d.onerror?.({ error: "not_succeeded", details: err.message }); } catch (e) { console.error(e); }
      throw err;
    }
  }
  const menus = new Map();
  onPort.set("menu", (m) => { try { menus.get(m.cid)?.run(); } catch (err) { console.error(err); } });
  let nextMenu = 1;
  function registerMenuCommand(name, fn, opts) {
    connect();
    const o = typeof opts === "string" ? { accessKey: opts } : opts || {};
    const cid = o.id != null ? String(o.id) : String(nextMenu++);
    const m = { run: () => fn({ type: "menu" }), name: String(name), title: String(o.title || "") };
    menus.set(cid, m);
    ask("menu", { cid, name: m.name, title: m.title }).catch(() => {});
    return o.id ?? cid;
  }
  function unregisterMenuCommand(cid) {
    menus.delete(String(cid));
    ask("unmenu", { cid: String(cid) }).catch(() => {});
  }
  const res = (name) => resources[name];
  const missing = (name) => () => { throw new Error(`${name} isn't available in Extra Guac`); };

  const api = {
    GM_info: info,
    unsafeWindow: window,
    GM_log: (...a) => console.log(`[${info.script.name}]`, ...a),
    GM_getValue: getValue,
    GM_setValue: (k, v) => { setValues({ [k]: v }); },
    GM_deleteValue: (k) => { deleteValues([k]); },
    GM_listValues: () => Object.keys(values),
    GM_getValues: (keys) => (Array.isArray(keys) ? Object.fromEntries(keys.filter((k) => Object.hasOwn(values, k)).map((k) => [k, clone(values[k])]))
      : Object.fromEntries(Object.entries(keys || {}).map(([k, def]) => [k, getValue(k, def)]))),
    GM_setValues: (obj) => { setValues(obj || {}); },
    GM_deleteValues: (keys) => { deleteValues(keys || []); },
    GM_addValueChangeListener: addValueChangeListener,
    GM_removeValueChangeListener: (lid) => { listeners.delete(lid); },
    GM_xmlhttpRequest: xmlhttpRequest,
    GM_addStyle: addStyle,
    GM_addElement: addElement,
    GM_setClipboard: (d, t) => { setClipboard(d, t); },
    GM_notification: (...a) => { notification(...a); },
    GM_openInTab: openInTab,
    GM_download: (...a) => { download(...a).catch(() => {}); },
    GM_registerMenuCommand: registerMenuCommand,
    GM_unregisterMenuCommand: unregisterMenuCommand,
    GM_getResourceText: (n) => res(n)?.text ?? null,
    GM_getResourceURL: (n) => res(n)?.url ?? null,
    GM_cookie: { list: missing("GM_cookie"), set: missing("GM_cookie"), delete: missing("GM_cookie") },
  };
  api.GM = {
    info,
    log: api.GM_log,
    getValue: async (k, def) => getValue(k, def),
    setValue: async (k, v) => { await setValues({ [k]: v }); },
    deleteValue: async (k) => { await deleteValues([k]); },
    listValues: async () => Object.keys(values),
    getValues: async (keys) => api.GM_getValues(keys),
    setValues: async (obj) => { await setValues(obj || {}); },
    deleteValues: async (keys) => { await deleteValues(keys || []); },
    addValueChangeListener: async (k, fn) => addValueChangeListener(k, fn),
    removeValueChangeListener: async (lid) => { listeners.delete(lid); },
    xmlHttpRequest: (d) => { const h = xmlhttpRequest(d); const p = h.promise; p.abort = h.abort; return p; },
    addStyle: async (css) => addStyle(css),
    addElement: async (...a) => addElement(...a),
    setClipboard: (d, t) => setClipboard(d, t),
    notification: (...a) => notification(...a),
    openInTab: async (u, o) => openInTab(u, o),
    download: (...a) => download(...a),
    registerMenuCommand: async (...a) => registerMenuCommand(...a),
    unregisterMenuCommand: async (c) => unregisterMenuCommand(c),
    getResourceText: async (n) => api.GM_getResourceText(n),
    getResourceUrl: async (n) => api.GM_getResourceURL(n),
  };
  api.GM.xmlhttpRequest = api.GM.xmlHttpRequest;
  api.GM.getResourceURL = api.GM.getResourceUrl;
  // Not one of the script's names: what bg-userscripts.js waits on before a document-idle start.
  api.ready = ready;
  return api;
}
