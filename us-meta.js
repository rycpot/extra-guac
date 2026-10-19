// Userscripts: reading a script's metadata block, which pages it runs on, and what it asks
// for. Shared by the background worker (bg-userscripts.js), the userscripts page and its editor,
// the install page and the popup.
(() => {
  // The keys that can appear more than once; the rest keep their first value.
  const LISTS = new Set(["match", "include", "exclude", "exclude-match", "grant", "connect", "require", "resource"]);

  // "// @key value" lines between "// ==UserScript==" and "// ==/UserScript==". Localized keys
  // (@name:fr) are kept as they are; the plain one is what's shown. Null when there's no block.
  function parseMeta(code) {
    const block = /\/\/[ \t]*==UserScript==[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\/\/[ \t]*==\/UserScript==/.exec(code || "");
    if (!block) return null;
    const raw = {};
    for (const line of block[1].split(/\r?\n/)) {
      const m = /^[ \t]*\/\/[ \t]*@([\w:.-]+)(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
      if (!m) continue;
      const key = m[1], value = m[2] ?? "";
      if (LISTS.has(key)) (raw[key] ||= []).push(value);
      else if (!(key in raw)) raw[key] = value;
    }
    const list = (k) => (raw[k] || []).filter(Boolean);
    const resources = list("resource").map((r) => /^(\S+)\s+(\S+)/.exec(r)).filter(Boolean).map(([, name, url]) => ({ name, url }));
    const runAt = { "document-start": "document_start", "document-body": "document_end", "document-end": "document_end", "document-idle": "document_idle" }[(raw["run-at"] || "").toLowerCase()] || "document_idle";
    return {
      name: raw.name || "", namespace: raw.namespace || "", version: raw.version || "", description: raw.description || "",
      author: raw.author || "", icon: raw.icon || raw.iconURL || raw.icon64 || raw.icon64URL || "",
      homepage: raw.homepage || raw.homepageURL || raw.website || raw.source || "", supportURL: raw.supportURL || "",
      updateURL: raw.updateURL || "", downloadURL: raw.downloadURL || raw.installURL || "",
      matches: list("match"), includes: list("include"), excludes: list("exclude"), excludeMatches: list("exclude-match"),
      grants: list("grant"), connects: list("connect"), requires: list("require"), resources,
      runAt, runAtRaw: raw["run-at"] || "", noframes: "noframes" in raw, injectInto: (raw["inject-into"] || "").toLowerCase(),
      sandbox: (raw.sandbox || "").toLowerCase(), unwrap: "unwrap" in raw,
    };
  }

  // ---- Which pages ----
  // A match pattern (scheme://host/path, "<all_urls>") as a regular expression. "*" as the scheme
  // is http and https; "*." before a host also covers the host itself. Null when it isn't one.
  function matchRegex(p) {
    if (p === "<all_urls>") return /^(https?|file|ftp):\/\//i;
    const m = /^(\*|https?|file|ftp|wss?):\/\/(\*|(?:\*\.)?[^/*]*)?(\/.*)$/i.exec(p);
    if (!m) return null;
    const [, scheme, host = "", path] = m;
    const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const s = scheme === "*" ? "https?" : esc(scheme);
    const h = host === "*" ? "[^/]*" : host.startsWith("*.") ? `(?:[^/]*\\.)?${esc(host.slice(2))}` : esc(host);
    return new RegExp(`^${s}://${h}(?::\\d+)?${path.split("*").map(esc).join(".*")}$`, "i");
  }
  // Chrome only takes "proper" match patterns (no "*" inside a host, a known scheme).
  const nativeMatch = (p) => p === "<all_urls>" || /^(\*|https?|file|ftp):\/\/(\*|(?:\*\.)?[^/*:]+)?\/.*$/i.test(p);

  // @include / @exclude: /regex/flags, or a glob where "*" is anything and ".tld" any top-level
  // domain; one without "://" is matched against the whole address as is.
  function globRegex(p) {
    const re = /^\/(.*)\/([a-z]*)$/i.exec(p);
    if (re) { try { return new RegExp(re[1], re[2].replace(/[gy]/g, "") || "i"); } catch { return null; } }
    if (p === "*") return /^/;
    const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const body = p.split("*").map((part) => esc(part).replace(/\\\.tld(?=\/|$)/gi, "\\.[a-z.]{2,}")).join(".*");
    return new RegExp(`^${body}$`, "i");
  }
  const toRegex = (p) => matchRegex(p) || globRegex(p);

  // Runs on url: one of @match or @include, and none of @exclude / @exclude-match. With neither
  // @match nor @include it runs everywhere.
  function urlAllowed(meta, url) {
    const bare = String(url).split("#")[0]; // match patterns don't see the #part
    const any = (list) => list.some((p) => { const mr = matchRegex(p); return mr ? mr.test(bare) : globRegex(p)?.test(url); });
    const ins = [...meta.matches, ...meta.includes];
    if (ins.length && !any(ins)) return false;
    return !any([...meta.excludes, ...meta.excludeMatches]);
  }

  // What Chrome is asked to inject on: its own patterns where they say all of it, else every
  // page with the script itself checking the address first (filter: true).
  function registration(meta) {
    const native = meta.includes.length === 0 && meta.matches.length > 0 && meta.matches.every(nativeMatch);
    const exNative = meta.excludes.length === 0 && meta.excludeMatches.every(nativeMatch);
    return {
      matches: native ? meta.matches : ["*://*/*", "file:///*"],
      excludeMatches: exNative ? meta.excludeMatches : [],
      filter: !native || !exNative,
    };
  }

  // The sites a script names, short: hosts from its patterns ("all sites" for a catch-all).
  function sitesOf(meta) {
    const out = new Set();
    for (const p of [...meta.matches, ...meta.includes]) {
      if (p === "<all_urls>" || p === "*" || /^(\*|https?):\/\/\*\//.test(p)) return ["all sites"];
      const m = /^[^:]*:\/\/(?:\*\.)?([^/:]+)/.exec(p);
      if (m) out.add(m[1].replace(/^www\./, ""));
      else if (/^\/.*\/[a-z]*$/i.test(p)) out.add("pattern");
    }
    return out.size ? [...out] : ["all sites"];
  }

  // ---- What it asks for ----
  // The grants Extra Guac has, grouped the way the settings show them.
  const GRANTS = {
    storage: ["GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "GM_getValues", "GM_setValues", "GM_deleteValues",
      "GM_addValueChangeListener", "GM_removeValueChangeListener", "GM.getValue", "GM.setValue", "GM.deleteValue", "GM.listValues",
      "GM.getValues", "GM.setValues", "GM.deleteValues", "GM.addValueChangeListener", "GM.removeValueChangeListener"],
    requests: ["GM_xmlhttpRequest", "GM.xmlHttpRequest", "GM.xmlhttpRequest"],
    styles: ["GM_addStyle", "GM_addElement", "GM.addStyle", "GM.addElement"],
    menu: ["GM_registerMenuCommand", "GM_unregisterMenuCommand", "GM.registerMenuCommand", "GM.unregisterMenuCommand"],
    downloads: ["GM_download", "GM.download"],
    notifications: ["GM_notification", "GM.notification"],
    tabs: ["GM_openInTab", "GM.openInTab"],
    clipboard: ["GM_setClipboard", "GM.setClipboard"],
    resources: ["GM_getResourceText", "GM_getResourceURL", "GM.getResourceText", "GM.getResourceUrl", "GM.getResourceURL"],
    other: ["GM_info", "GM.info", "GM_log", "GM.log", "unsafeWindow", "none", "window.close", "window.focus"],
  };
  const KIND = Object.fromEntries(Object.entries(GRANTS).flatMap(([k, list]) => list.map((g) => [g, k])));
  // In plain words, for the install page and the editor.
  const KIND_TEXT = {
    storage: "Save its own settings", requests: "Send requests to other sites, with your cookies", styles: "Add styles and elements to the page",
    menu: "Add commands to the Extra Guac menu", downloads: "Download files", notifications: "Show notifications", tabs: "Open new tabs",
    clipboard: "Copy to your clipboard", resources: "Use files it brings along",
  };
  const kindsOf = (meta) => [...new Set(meta.grants.map((g) => KIND[g]).filter((k) => k && k !== "other"))];
  const unsupported = (meta) => meta.grants.filter((g) => !KIND[g]);
  // Runs in the page itself, with no extra access (and so as the page's own scripts see it).
  // @grant none (or only ones that need nothing from Extra Guac) runs there; so does
  // @inject-into page / @sandbox raw. Anything else runs in a world of its own beside the page.
  const needsApi = (meta) => meta.grants.some((g) => !(KIND[g] === "other"));
  const inPage = (meta) => meta.injectInto !== "content" && meta.sandbox !== "dom" && meta.sandbox !== "javascript"
    && (meta.injectInto === "page" || meta.sandbox === "raw" || !needsApi(meta));

  // "1.2.10" after "1.2.9"; text parts compare as text ("1.0beta" before "1.0").
  function compareVersions(a = "", b = "") {
    const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? "0", y = pb[i] ?? "0";
      const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
      if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx < ny ? -1 : 1; continue; }
      const mx = /^(\d*)(.*)$/.exec(x), my = /^(\d*)(.*)$/.exec(y);
      if (Number(mx[1] || 0) !== Number(my[1] || 0)) return Number(mx[1] || 0) < Number(my[1] || 0) ? -1 : 1;
      if (mx[2] !== my[2]) return !mx[2] ? 1 : !my[2] ? -1 : mx[2] < my[2] ? -1 : 1;
    }
    return 0;
  }

  // Two scripts are the same script when both name and namespace are.
  const keyOf = (meta) => `${meta.namespace}\n${meta.name}`;

  // A newer copy asks for more than the one installed: grants, hosts it can send requests to,
  // or pages it runs on.
  function asksMore(oldMeta, newMeta) {
    // An empty @connect or @match/@include list means anywhere; fewer @exclude lines means more pages.
    const all = (list) => (list.length ? list : ["*"]);
    const more = (a, b) => b.some((x) => !a.includes(x)) || (b.includes("*") && !a.includes("*"));
    return more(oldMeta.grants, newMeta.grants) || more(all(oldMeta.connects), all(newMeta.connects))
      || more(all([...oldMeta.matches, ...oldMeta.includes]), all([...newMeta.matches, ...newMeta.includes]))
      || more([...newMeta.excludes, ...newMeta.excludeMatches], [...oldMeta.excludes, ...oldMeta.excludeMatches]);
  }

  // What may not work as the script expects, in plain words, so the list, the editor and the
  // install page can say so. requires: the files fetched for an installed script, by address.
  function limits(meta, code = "", requires = null) {
    const out = [];
    const bad = unsupported(meta);
    if (bad.length) out.push(`${bad.join(", ")} ${bad.length > 1 ? "aren't" : "isn't"} available here, so the parts that use ${bad.length > 1 ? "them" : "it"} stay off.`);
    if (!inPage(meta) && /\bunsafeWindow\b/.test(code)) {
      out.push("It uses unsafeWindow, which here is the script's own window: what the page's own scripts set on window isn't there.");
    }
    if (kindsOf(meta).includes("requests")) {
      const set = new Set();
      for (const m of code.matchAll(/headers\s*:\s*\{([^}]*)\}/g)) {
        for (const h of m[1].matchAll(/["']?\b(cookie|referer|user-agent|origin|host)\b["']?\s*:/gi)) set.add(h[1].toLowerCase());
      }
      if (set.size) out.push(`Its requests set ${[...set].join(", ")}, which Chrome doesn't let extensions change; ${set.size > 1 ? "those are" : "that's"} left out.`);
    }
    if (requires) {
      const missing = meta.requires.filter((u) => requires[u] == null);
      if (missing.length) out.push(`${missing.length > 1 ? "Files" : "A file"} it loads with @require couldn't be fetched: ${missing.join(", ")}.`);
    }
    return out;
  }

  globalThis.USM = { parseMeta, matchRegex, globRegex, urlAllowed, registration, sitesOf, GRANTS, KIND, KIND_TEXT, kindsOf, unsupported, limits, inPage, compareVersions, keyOf, asksMore };
})();
