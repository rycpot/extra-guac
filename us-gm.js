// Userscripts: the GM_* / GM.* functions a script gets. bg-userscripts.js puts these functions'
// source in front of each script that asks for them and calls them with that script's details.
// Each is used on its own, so nothing outside a function is used inside it.
//
// usApi: the GM functions. In the script's own world beside the page they reach Extra Guac with
// chrome.runtime messages (handled by bg-userscripts.js). In the page itself ("bridge" scripts,
// us-meta.js) there's no chrome.runtime, so link carries the same messages through the relay.
// eslint-disable-next-line no-unused-vars
function usApi(ctx, link) {
  const { id, key, info, resources = {} } = ctx;
  link ||= {
    send: (msg) => chrome.runtime.sendMessage({ ...msg, us: id, key }),
    connect: () => chrome.runtime.connect({ name: `us:${id}:${key}` }),
  };
  let values = { ...ctx.values };
  const ask = async (op, data = {}) => {
    const r = await link.send({ ...data, op });
    if (r?.error) throw new Error(r.error);
    return r;
  };
  const warn = (what, err) => console.warn(`[${info.script.name}] ${what}:`, err?.message || err);

  // One connection per script and frame, opened when first needed: values changed elsewhere,
  // menu commands run from the popup, request progress, notification clicks, finished
  // downloads and closed tabs come back on it.
  let port = null, portUp = null, portIsUp = null;
  const onPort = new Map(); // kind -> handler
  function connect() {
    if (port) return port;
    // portUp settles once Extra Guac's side has the connection ("hello"), so nothing sent on it
    // before then is lost.
    portUp = new Promise((r) => { portIsUp = r; });
    port = link.connect();
    port.onMessage.addListener((m) => onPort.get(m?.t)?.(m));
    // Extra Guac's side sleeps when idle, which closes this; it's opened again while anything
    // still listens (menu commands are told again, so the popup's list keeps working).
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(() => {
        if (port || !(usesValues || menus.size || listeners.size || notifs.size || downloads.size || opened.size)) return;
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
  // A refresh leaves alone the keys that are newer than its answer can be: ones written here,
  // or heard about, after it was asked for, and ones whose write from here hadn't been saved
  // yet when it was asked for. One set per refresh waiting or on its way.
  const watching = new Set();
  const touched = (k) => { for (const fresh of watching) fresh.add(k); };
  const unsaved = new Map(); // key -> writes from here not saved yet
  function saving(keys, write) {
    for (const k of keys) unsaved.set(k, (unsaved.get(k) || 0) + 1);
    return write.finally(() => { for (const k of keys) { const n = unsaved.get(k) - 1; if (n) unsaved.set(k, n); else unsaved.delete(k); } });
  }
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
    const fresh = new Set(unsaved.keys());
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
  onPort.set("hello", () => { portIsUp?.(); if (ctx.storage) refresh(); });
  // A document-idle script starts with no values written into its code and waits for this
  // first refresh before it runs, for 5 seconds at most (bg-userscripts.js). Earlier ones start
  // with the copy written into their code, which can be a moment older than the last save.
  const ready = ctx.storage ? Promise.race([refresh(), new Promise((r) => setTimeout(r, 5000))]) : Promise.resolve();
  // Once the script reads or writes values, the connection stays open so the copy keeps up with
  // saves in other tabs, even without a change listener.
  let usesValues = false;
  const useValues = () => { if (!usesValues && ctx.storage) { usesValues = true; connect(); } };
  const getValue = (key, def) => { useValues(); return Object.hasOwn(values, key) ? clone(values[key]) : def; };
  const listValues = () => { useValues(); return Object.keys(values); };
  function setValues(obj) {
    useValues();
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
    return saving(Object.keys(set), ask("setValues", { values: set })).catch((err) => warn("saving failed", err));
  }
  function deleteValues(keys) {
    useValues();
    for (const k of keys) { touched(k); if (Object.hasOwn(values, k)) { const old = values[k]; delete values[k]; changed(k, old, undefined, false); } }
    return saving(keys, ask("deleteValues", { keys })).catch((err) => warn("deleting failed", err));
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
  const join = (list) => {
    const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of list) { out.set(b, at); at += b.length; }
    return out;
  };
  const decode = (bytes, charset) => { try { return new TextDecoder(charset || "utf-8").decode(bytes); } catch { return new TextDecoder().decode(bytes); } };
  function xmlhttpRequest(d = {}) {
    const rid = `${id}:${nextReq++}`;
    let done = false, aborted = false, head = null;
    const call = (name, arg) => { try { d[name]?.call(handle, arg); } catch (err) { console.error(err); } };
    const type = (d.responseType || "").toLowerCase();
    // responseType "stream": the answer is a ReadableStream that fills as the pieces come in.
    let feed = null;
    const stream = type === "stream" ? new ReadableStream({ start(c) { feed = c; } }) : null;
    const state = (readyState, more = {}) => ({
      readyState, status: head?.status || 0, statusText: head?.statusText || "", finalUrl: head?.finalUrl || d.url,
      responseHeaders: head?.headers || "", context: d.context, ...more,
    });
    const handle = {
      abort() {
        if (done || aborted) return;
        aborted = true;
        ask("xhrAbort", { rid }).catch(() => {});
        feed?.error(new Error("aborted"));
        const r = { readyState: 4, status: 0, statusText: "", response: null, responseText: "", finalUrl: d.url };
        call("onabort", r); call("onloadend", r);
      },
    };
    let resolve, reject;
    handle.promise = new Promise((a, b) => { resolve = a; reject = b; });
    handle.promise.catch(() => {});
    (async () => {
      const progress = ["onprogress", "onreadystatechange"].some((n) => typeof d[n] === "function") || !!stream;
      // The answer's headers, progress and any pieces come back over the connection.
      connect();
      await Promise.race([portUp, new Promise((r) => setTimeout(r, 3000))]);
      const pieces = [];
      requests.set(rid, (m) => {
        if (aborted || done) return;
        if (m.ev === "headers") { head = m; return call("onreadystatechange", state(2)); }
        if (m.ev === "chunk") { const b = fromB64(m.b64); return feed ? feed.enqueue(b) : pieces.push(b); }
        if (m.ev === "progress") {
          call("onreadystatechange", state(3));
          return call("onprogress", { ...state(3), lengthComputable: !!m.total, loaded: m.loaded, total: m.total || 0 });
        }
        if (m.ev === "streamed") return; // the answer itself comes over the connection
        done = true;
        requests.delete(rid);
        head = m;
        if (m.ev !== "load") {
          feed?.error(new Error(m.error || m.ev));
          const r = { ...state(4), error: m.error || "" };
          call(m.ev === "timeout" ? "ontimeout" : "onerror", r);
          call("onloadend", r);
          return reject(r);
        }
        const r = state(4);
        let response;
        if (stream) {
          feed.close();
          response = stream;
        } else {
          const bytes = m.b64 != null ? fromB64(m.b64) : m.streamed ? join(pieces) : null;
          // charset=x-user-defined: one character per byte, as the page's own XMLHttpRequest gives.
          const raw = !!d.overrideMimeType?.includes("charset=x-user-defined");
          const text = !bytes ? m.text ?? "" : raw ? Array.from(bytes, (b) => String.fromCharCode(b < 0x80 ? b : 0xf700 + b)).join("") : decode(bytes, m.charset);
          response = text;
          if (type === "json") { try { response = JSON.parse(text); } catch { response = undefined; } }
          else if (type === "arraybuffer") response = bytes ? bytes.buffer : new TextEncoder().encode(text).buffer;
          else if (type === "blob") response = new Blob([bytes || text], { type: m.mime || "" });
          else if (type === "document") { try { response = new DOMParser().parseFromString(text, /xml/.test(m.mime || "") ? "text/xml" : "text/html"); } catch { response = null; } }
          if (type === "" || type === "text" || type === "json" || type === "document") r.responseText = text;
          if (type === "document") r.responseXML = response;
        }
        r.response = response;
        call("onreadystatechange", r);
        call("onload", r);
        call("onloadend", r);
        resolve(r);
      });
      call("onreadystatechange", state(1));
      call("onloadstart", state(1, stream ? { response: stream } : {}));
      const req = {
        url: new URL(d.url, location.href).href, method: (d.method || "GET").toUpperCase(), headers: d.headers || {}, body: await body(d.data),
        timeout: Number(d.timeout) || 0, anonymous: !!d.anonymous, cookie: d.cookie ? String(d.cookie) : "",
        binary: ["arraybuffer", "blob"].includes(type) || !!d.overrideMimeType?.includes("charset=x-user-defined"),
        redirect: d.redirect, user: d.user, password: d.password, progress, stream: !!stream,
      };
      const m = await ask("xhr", { rid, req });
      requests.get(rid)?.(m);
    })().catch((err) => {
      requests.delete(rid);
      if (aborted || done) return;
      done = true;
      feed?.error(err);
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
  // A type of "html" (or { type: "html" } / { mimetype: "text/html" }) copies it as HTML.
  const setClipboard = (data, type) => {
    const t = typeof type === "string" ? type : type?.type || type?.mimetype || "";
    return ask("clipboard", { text: String(data ?? ""), html: /html/i.test(t) }).catch((err) => warn("copying failed", err));
  };

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
      // highlight with no text only brings this tab to the front: there's nothing to show.
      ask("notification", { nid, n: { text: d.text || "", title: d.title || "", image: String(d.image || ""), silent: !!d.silent, timeout: Number(d.timeout) || 0, highlight: !!d.highlight } })
        .then((r) => { if (r?.shown === false) notifs.get(nid)?.("done"); })
        .catch((err) => { warn("notification failed", err); notifs.delete(nid); resolve(); });
    });
  }
  // The tab handed back hears when it's closed (onclose), however that happens.
  let nextTab = 1;
  const opened = new Map(); // oid -> tab
  onPort.set("tabClosed", (m) => {
    const tab = opened.get(m.oid);
    if (!tab) return;
    opened.delete(m.oid);
    tab.closed = true;
    try { tab.onclose?.(); } catch (err) { console.error(err); }
  });
  function openInTab(url, opts) {
    const o = typeof opts === "boolean" ? { active: !opts } : { active: true, ...opts };
    if (o.loadInBackground !== undefined) o.active = !o.loadInBackground;
    const oid = `${id}:${nextTab++}`;
    connect();
    const tab = { closed: false, onclose: null, close() { tab.closed = true; tabId.then((t) => t && ask("closeTab", { tabId: t })).catch(() => {}); } };
    opened.set(oid, tab);
    const tabId = ask("openInTab", { oid, url: new URL(url, location.href).href, active: !!o.active, insert: o.insert !== false })
      .then((r) => r.tabId, (err) => { opened.delete(oid); tab.closed = true; warn("opening the tab failed", err); });
    return tab;
  }
  // onload once the file is saved; onerror when it can't start or stops partway.
  let nextDownload = 1;
  const downloads = new Map(); // did -> handler
  onPort.set("download", (m) => downloads.get(m.did)?.(m));
  async function download(details, name) {
    const d = typeof details === "string" ? { url: details, name } : { ...details };
    const did = `${id}:${nextDownload++}`;
    try {
      let url = d.url;
      if (url instanceof Blob) url = `data:${url.type || "application/octet-stream"};base64,${await b64(url)}`;
      else if (/^blob:/.test(url)) { const blob = await (await fetch(url)).blob(); url = `data:${blob.type || "application/octet-stream"};base64,${await b64(blob)}`; }
      else url = new URL(url, location.href).href;
      connect();
      const finished = new Promise((resolve, reject) => downloads.set(did, (m) => {
        downloads.delete(did);
        if (m.ev === "load") resolve(); else reject(new Error(m.error || "the download stopped"));
      }));
      await ask("download", { did, url, name: d.name || "", saveAs: !!d.saveAs, conflict: d.conflictAction || "uniquify" });
      await finished;
      try { d.onload?.({}); } catch (err) { console.error(err); }
    } catch (err) {
      downloads.delete(did);
      try { d.onerror?.({ error: "not_succeeded", details: err.message }); } catch (e) { console.error(e); }
      throw err;
    }
  }
  // @grant window.close / window.focus: the script's tab itself is closed or brought to the
  // front. In its own world, window there is the script's alone. In the page, window is the
  // page's, so the script gets a window of its own (api.window) that only differs in those two.
  const own = {};
  if (info.script.grant.includes("window.close")) own.close = () => { ask("closeSelf").catch((err) => warn("closing the tab failed", err)); };
  if (info.script.grant.includes("window.focus")) own.focus = () => { ask("focusSelf").catch((err) => warn("bringing the tab to the front failed", err)); };
  if (!ctx.page) Object.assign(window, own);
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
  // Each @resource comes once, as fetched; text or a data URL is made of it when asked.
  const resourceText = (name) => {
    const f = resources[name];
    return !f ? null : f.text ?? (f.b64 != null ? new TextDecoder().decode(fromB64(f.b64)) : "");
  };
  const resourceUrl = (name) => {
    const f = resources[name];
    return !f ? null : f.b64 != null ? `data:${f.mime || "application/octet-stream"};base64,${f.b64}` : f.url ?? null;
  };
  const missing = (name) => () => { throw new Error(`${name} isn't available in Extra Guac`); };

  const api = {
    GM_info: info,
    unsafeWindow: window,
    GM_log: (...a) => console.log(`[${info.script.name}]`, ...a),
    GM_getValue: getValue,
    GM_setValue: (k, v) => { setValues({ [k]: v }); },
    GM_deleteValue: (k) => { deleteValues([k]); },
    GM_listValues: listValues,
    GM_getValues: (keys) => {
      useValues();
      return Array.isArray(keys) ? Object.fromEntries(keys.filter((k) => Object.hasOwn(values, k)).map((k) => [k, clone(values[k])]))
        : Object.fromEntries(Object.entries(keys || {}).map(([k, def]) => [k, getValue(k, def)]));
    },
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
    GM_getResourceText: resourceText,
    GM_getResourceURL: resourceUrl,
    GM_cookie: { list: missing("GM_cookie"), set: missing("GM_cookie"), delete: missing("GM_cookie") },
  };
  api.GM = {
    info,
    log: api.GM_log,
    getValue: async (k, def) => getValue(k, def),
    setValue: async (k, v) => { await setValues({ [k]: v }); },
    deleteValue: async (k) => { await deleteValues([k]); },
    listValues: async () => listValues(),
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
  if (ctx.page && Object.keys(own).length) {
    // Methods come bound to the real window (they refuse to run on anything else); names
    // starting with a capital are constructors and come as they are.
    api.window = new Proxy(window, {
      get: (t, p) => (Object.hasOwn(own, p) ? own[p] : (v => (typeof v === "function" && typeof p === "string" && !/^[A-Z]/.test(p) ? v.bind(t) : v))(Reflect.get(t, p))),
      set: (t, p, v) => Reflect.set(t, p, v),
    });
  }
  // Not one of the script's names: what bg-userscripts.js waits on before a document-idle start.
  api.ready = ready;
  return api;
}

// usPageLink: what usApi uses in the page itself. Its messages go to the relay (usRelay) as
// events on document named with this script's token, as JSON text (which crosses between the
// page and the relay's world as it is), and the relay's answers come back the same way. The
// page shares this space, so a page set on interfering could too; the relay holds the script's
// key, which never comes into the page.
// eslint-disable-next-line no-unused-vars
function usPageLink(token) {
  // Taken now, before anything else in the page can swap them.
  const doc = document, Ev = CustomEvent, parse = JSON.parse, text = JSON.stringify;
  const dispatch = EventTarget.prototype.dispatchEvent, listen = EventTarget.prototype.addEventListener;
  const up = (msg) => dispatch.call(doc, new Ev(`${token}:up`, { detail: text(msg) }));
  let isReady;
  const ready = new Promise((r) => { isReady = r; });
  const waiting = new Map();
  let n = 0, port = null;
  listen.call(doc, `${token}:down`, (e) => {
    let m;
    try { m = parse(e.detail); } catch { return; }
    if (m.kind === "ready") isReady();
    else if (m.kind === "reply") {
      const w = waiting.get(m.n);
      waiting.delete(m.n);
      if (m.error != null) w?.reject(new Error(m.error)); else w?.resolve(m.result);
    } else if (m.kind === "port") port?.heard.forEach((f) => f(m.m));
    else if (m.kind === "disconnect") { const p = port; port = null; p?.closed.forEach((f) => f()); }
  });
  up({ kind: "hello" });
  return {
    send: async (msg) => {
      await ready;
      const k = ++n;
      return new Promise((resolve, reject) => { waiting.set(k, { resolve, reject }); up({ kind: "ask", n: k, msg }); });
    },
    connect: () => {
      const p = { heard: [], closed: [] };
      p.onMessage = { addListener: (f) => p.heard.push(f) };
      p.onDisconnect = { addListener: (f) => p.closed.push(f) };
      port = p;
      ready.then(() => up({ kind: "connect" }));
      return p;
    },
  };
}

// usRelay: runs beside a "bridge" script, in that script's own world, and passes what the page
// part sends (usPageLink) to Extra Guac with the script's key, and the answers back.
// eslint-disable-next-line no-unused-vars
function usRelay({ id, key, token }) {
  const down = (msg) => document.dispatchEvent(new CustomEvent(`${token}:down`, { detail: JSON.stringify(msg) }));
  let port = null;
  document.addEventListener(`${token}:up`, (e) => {
    let m;
    try { m = JSON.parse(e.detail); } catch { return; }
    if (m.kind === "hello") down({ kind: "ready" });
    else if (m.kind === "ask") {
      chrome.runtime.sendMessage({ ...m.msg, us: id, key })
        .then((result) => down({ kind: "reply", n: m.n, result }), (err) => down({ kind: "reply", n: m.n, error: err?.message || String(err) }));
    } else if (m.kind === "connect" && !port) {
      port = chrome.runtime.connect({ name: `us:${id}:${key}` });
      port.onMessage.addListener((msg) => down({ kind: "port", m: msg }));
      port.onDisconnect.addListener(() => { port = null; down({ kind: "disconnect" }); });
    }
  });
  down({ kind: "ready" });
}
