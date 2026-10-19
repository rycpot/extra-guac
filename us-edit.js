// Userscript editor (us-edit.html?id=<script> or ?new=1&site=<host>): the code with the scratch
// pads' highlighting, and beside it what the script's metadata says, kept up to date while typing.
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let id = params.get("id") || "";
  let saved = "";
  const ta = $("src");
  const send = async (type, payload = {}) => {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res?.ok) throw new Error(res?.error || "Something went wrong");
    return res;
  };
  TT.applyTheme();

  const template = (site) => `// ==UserScript==
// @name         New script${site ? ` for ${site}` : ""}
// @namespace    extra-guac
// @version      1.0
// @description  
// @match        ${site ? `https://${site}/*` : "https://example.com/*"}
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

})();
`;

  // ---- Highlighting (speed-highlight, as in the scratch pads) ----
  let shj = null, hlTimer = 0, hlSeq = 0;
  const esc = (s) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  async function paint() {
    const seq = ++hlSeq, v = ta.value;
    if (v.length > 400000) { $("hl").textContent = `${v}\n`; return; }
    shj ??= import("./vendor/speed-highlight/index.js");
    let out = "";
    try {
      await (await shj).tokenize(v, "js", (str, type) => { out += type ? `<span class="t-${type}">${esc(str)}</span>` : esc(str); });
    } catch { out = esc(v); }
    if (seq === hlSeq) { $("hl").innerHTML = `${out}\n`; sync(); }
  }
  function sync() {
    $("hl").scrollTop = ta.scrollTop;
    $("hl").scrollLeft = ta.scrollLeft;
    $("gutter").scrollTop = ta.scrollTop;
  }
  let lines = 0;
  function onText() {
    $("hl").textContent = `${ta.value}\n`; // right away, so what's shown always matches what's typed
    sync();
    clearTimeout(hlTimer);
    hlTimer = setTimeout(paint, ta.value.length > 60000 ? 250 : 40);
    const n = ta.value.split("\n").length;
    if (n !== lines) { lines = n; $("gutter").textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n") + "\n\n"; }
    const dirty = ta.value !== saved;
    $("revert").disabled = !dirty || !id;
    $("status").textContent = dirty ? "unsaved changes" : "";
    clearTimeout(sideTimer);
    sideTimer = setTimeout(side, 200);
  }
  ta.addEventListener("input", onText);
  ta.addEventListener("scroll", sync);
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = ta;
      if (a === b && !e.shiftKey) return void document.execCommand("insertText", false, "  ");
      // Several lines: indented, or with Shift taken back.
      const start = value.lastIndexOf("\n", a - 1) + 1;
      const block = value.slice(start, b);
      const next = e.shiftKey ? block.replace(/^( {1,2}|\t)/gm, "") : block.replace(/^/gm, "  ");
      ta.setSelectionRange(start, b);
      document.execCommand("insertText", false, next);
      ta.setSelectionRange(start, start + next.length);
    }
  });

  // ---- What the metadata says ----
  let sideTimer = 0;
  const RUN_AT = { document_start: "before the page loads", document_end: "once the page is there, before its images", document_idle: "after the page has loaded" };
  function side() {
    const box = $("side");
    box.replaceChildren();
    const meta = USM.parseMeta(ta.value);
    $("title").textContent = meta?.name || (id ? "" : "new script");
    $("ver").textContent = meta?.version ? `v${meta.version}` : "";
    document.title = `${meta?.name || "Userscript"} · Extra Guac`;
    const h = (t) => { const e = document.createElement("h2"); e.textContent = t; box.append(e); };
    const p = (t, cls = "") => { const e = document.createElement("div"); e.className = cls; e.textContent = t; box.append(e); return e; };
    const pills = (list, cls = "mono") => { const w = document.createElement("div"); w.className = "pills"; for (const t of list) { const s = document.createElement("span"); s.className = `pill ${cls}`; s.textContent = t; w.append(s); } box.append(w); };
    if (!meta) { h("metadata"); p("No “// ==UserScript==” block yet: a script needs one, with at least a @name.", "bad"); return; }
    h("runs on");
    const ins = [...meta.matches, ...meta.includes];
    pills(ins.length ? ins : ["every site"]);
    const ex = [...meta.excludes, ...meta.excludeMatches];
    if (ex.length) { p("not on", "mut"); pills(ex); }
    h("when");
    p(`${RUN_AT[meta.runAt]}${meta.noframes ? ", top frame only" : ", in frames too"}`);
    h("access it asks for");
    const kinds = USM.kindsOf(meta);
    if (!kinds.length) p(USM.inPage(meta) ? "Nothing extra: it runs as part of the page." : "Nothing extra.", "mut");
    const acc = document.createElement("div");
    acc.className = "acc";
    for (const k of kinds) {
      const row = document.createElement("div");
      row.innerHTML = `<span class="dot"></span><span></span>`;
      row.lastChild.textContent = USM.KIND_TEXT[k] + (k === "requests" ? (meta.connects.length ? `: ${meta.connects.join(", ")}` : ": any site") : "");
      acc.append(row);
    }
    box.append(acc);
    const lim = USM.limits(meta, ta.value);
    if (lim.length) { h("limits"); for (const l of lim) p(l, "bad"); }
    if (meta.requires.length || meta.resources.length) {
      h("files it brings along");
      pills([...meta.requires.map((u) => u.replace(/^https?:\/\//, "")), ...meta.resources.map((r) => `${r.name}: ${r.url.replace(/^https?:\/\//, "")}`)]);
    }
    h("details");
    const dl = document.createElement("dl");
    dl.className = "kv";
    for (const [k, v] of [["name", meta.name], ["namespace", meta.namespace], ["author", meta.author], ["updates", meta.updateURL || meta.downloadURL]]) {
      if (!v) continue;
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k; dd.textContent = v;
      dl.append(dt, dd);
    }
    box.append(dl);
  }

  // ---- Load and save ----
  // The stored code, to notice when an update (or another window) changes the script while
  // it's open here, so a save doesn't quietly put the old code back.
  let stored = "", changedElsewhere = false, loadError = "";
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local" || !c.usScripts || !id) return;
    const now = (c.usScripts.newValue || []).find((x) => x.id === id);
    if (now && now.code !== stored) {
      stored = now.code;
      changedElsewhere = true;
      $("status").textContent = "This script changed since you opened it (an update, or another window).";
    }
  });
  async function load() {
    if (id) {
      try {
        const { script } = await send("usGet", { id });
        saved = stored = script.code;
        $("enabledWrap").hidden = false;
        $("enabled").checked = script.enabled !== false;
      } catch (err) {
        loadError = err.message;
        id = "";
      }
    }
    if (!id) saved = template(params.get("site") || "");
    ta.value = saved;
    onText();
    if (loadError) $("status").textContent = loadError;
    paint();
    ta.focus();
    ta.setSelectionRange(0, 0);
  }
  async function save() {
    if ($("save").disabled) return;
    if (changedElsewhere && !confirm("This script changed since you opened it (an update, or another window). Save your version over it?")) return;
    $("save").disabled = true;
    $("status").textContent = "saving…";
    try {
      const code = ta.value;
      const r = await send("usInstall", { code, id: id || undefined, fresh: !id });
      if (!id) {
        id = r.id;
        history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
        $("enabledWrap").hidden = false;
        $("enabled").checked = true;
      }
      saved = stored = code;
      changedElsewhere = false;
      onText();
      $("status").textContent = "saved";
    } catch (err) {
      $("status").textContent = err.message;
    }
    $("save").disabled = false;
  }
  $("save").onclick = save;
  $("revert").onclick = () => { if (confirm("Throw away the changes since the last save?")) { ta.value = saved; onText(); paint(); } };
  $("enabled").onchange = () => send("usToggle", { id, enabled: $("enabled").checked }).catch((err) => ($("status").textContent = err.message));
  addEventListener("beforeunload", (e) => { if (ta.value !== saved) e.preventDefault(); });
  load();
})();
