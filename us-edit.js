// Userscript editor, one per "edit" tab of the userscripts page (userscripts.html): the code
// with the scratch pads' highlighting, undo and redo, go to row, find and replace, and beside
// it what the script's metadata says, kept up to date while typing.
// usEditor(root, { id, site, onChange }) fills root (a copy of the page's editor template) and
// returns { id(), name(), dirty(), focus(), save(), jump(), find(), dispose() }. onChange() runs
// when the name, the saved state or the script's id changes, so the page can update the tab.
// The editor stays see-through (class "loading") until the code is in and colored, so it
// appears in one go.
(() => {
  const send = async (type, payload = {}) => {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res?.ok) throw new Error(res?.error || "Something went wrong");
    return res;
  };
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
  const RUN_AT = { document_start: "before the page loads", document_end: "once the page is there, before its images", document_idle: "after the page has loaded", context_menu: "when picked from the right-click menu" };
  const LINE = 20, PAD = 14; // .code-font line height and the code's top padding, in px
  const esc = (s) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  let shj = null;
  const highlighter = () => (shj ??= import("./vendor/speed-highlight/index.js"));
  // Shortcut names as this computer writes them.
  const MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || "");
  const key = (k, shift = false) => (MAC ? `⌘${shift ? "⇧" : ""}${k}` : `Ctrl+${shift ? "Shift+" : ""}${k}`);

  globalThis.usEditor = function usEditor(root, { id = "", site = "", onChange = () => {} } = {}) {
    const q = (sel) => root.querySelector(sel);
    const ta = q(".src"), hl = q(".hl"), gutter = q(".gutter"), status = q(".status");
    let saved = "", stored = "", changedElsewhere = false, name = "";

    // ---- Highlighting (speed-highlight, as in the scratch pads) ----
    // The colored copy is redone on each change and normally lands before the next frame, so
    // the code keeps its colors while typing. Only when that's too slow (very long scripts) is
    // the plain text shown in between, so the copy never lags behind what's typed.
    // One pass at a time: changes made during a pass get one more pass when it ends.
    let hlTimer = 0, hlSeq = 0, painted = "", painting = null, again = false;
    function paint() {
      if (painting) { again = true; return painting; }
      painting = paintOnce().finally(() => { painting = null; if (again) { again = false; if (ta.value !== painted) paint(); } });
      return painting;
    }
    async function paintOnce() {
      const seq = ++hlSeq, v = ta.value;
      if (v.length > 400000) { hl.textContent = `${v}\n`; painted = v; return; }
      let out = "";
      try {
        await (await highlighter()).tokenize(v, "js", (str, type) => { out += type ? `<span class="t-${type}">${esc(str)}</span>` : esc(str); });
      } catch { out = esc(v); }
      if (seq === hlSeq) { hl.innerHTML = `${out}\n`; painted = v; sync(); }
    }
    function sync() {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
      gutter.scrollTop = ta.scrollTop;
    }
    let lines = 0, sideTimer = 0;
    function onText() {
      clearTimeout(hlTimer);
      if (ta.value.length > 60000) {
        ++hlSeq;
        hl.textContent = `${ta.value}\n`;
        hlTimer = setTimeout(paint, 250);
      } else {
        paint();
        const v = ta.value;
        requestAnimationFrame(() => { if (painted !== v && ta.value === v) hl.textContent = `${v}\n`; sync(); });
      }
      sync();
      const n = ta.value.split("\n").length;
      if (n !== lines) { lines = n; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n") + "\n\n"; }
      const dirty = ta.value !== saved;
      q(".revert").disabled = !dirty || !id;
      if (!status.classList.contains("keep")) status.textContent = dirty ? "unsaved changes" : "";
      clearTimeout(sideTimer);
      sideTimer = setTimeout(side, 200);
      onChange();
    }
    const say = (text, keep = false) => { status.textContent = text; status.classList.toggle("keep", keep); };
    let replacing = false; // an edit from find and replace: a step of its own, never typing
    ta.addEventListener("input", (e) => { status.classList.remove("keep"); record(!replacing && e.inputType === "insertText" && e.data?.length === 1 && !/\s/.test(e.data)); onText(); });
    ta.addEventListener("scroll", sync);
    ta.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && !e.altKey && (k === "z" || k === "y")) { e.preventDefault(); return step(k === "y" || e.shiftKey ? 1 : -1); }
      // A new line starts as indented as the one it breaks, one step more after an opening bracket.
      if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey && !e.isComposing) {
        const { selectionStart: a, value } = ta;
        const lineStart = value.lastIndexOf("\n", a - 1) + 1;
        let indent = /^[ \t]*/.exec(value.slice(lineStart, a))[0];
        if (/[{[(]\s*$/.test(value.slice(lineStart, a))) indent += "  ";
        if (!indent) return;
        e.preventDefault();
        return void document.execCommand("insertText", false, `\n${indent}`);
      }
      if (e.key === "Tab" && !mod && !e.altKey) {
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

    // ---- Undo, redo and go to row ----
    // Each editor keeps its own history (the browser has one per page, which several editor
    // tabs would share). Every change is a step (typing, Tab, revert), so revert can be undone
    // too; a run of typed letters counts as one step.
    const hist = [];
    let at = -1, lastTyped = 0;
    function record(typing = false) {
      const snap = { v: ta.value, a: ta.selectionStart, b: ta.selectionEnd };
      if (at >= 0 && hist[at].v === snap.v) return;
      hist.length = at + 1;
      if (typing && lastTyped && Date.now() - lastTyped < 800 && at > 0) hist[at] = snap;
      else { hist.push(snap); if (hist.length > 200) hist.shift(); at = hist.length - 1; }
      lastTyped = typing ? Date.now() : 0;
      undoBtns();
    }
    function step(dir) {
      const to = at + dir;
      if (to < 0 || to >= hist.length) return;
      at = to;
      lastTyped = 0;
      const { v, a, b } = hist[at];
      ta.value = v;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(a, b);
      onText();
      finder.refresh();
      undoBtns();
    }
    function undoBtns() {
      q(".undo").disabled = at <= 0;
      q(".redo").disabled = at >= hist.length - 1;
    }
    ta.addEventListener("beforeinput", (e) => {
      if (e.inputType === "historyUndo" || e.inputType === "historyRedo") { e.preventDefault(); step(e.inputType === "historyUndo" ? -1 : 1); }
    });
    for (const b of root.querySelectorAll(".undo, .redo")) {
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => step(b.classList.contains("undo") ? -1 : 1);
    }
    const jumpInput = q(".jump input");
    function jumpToRow(n) {
      const v = ta.value, total = v.split("\n").length;
      const line = Math.min(n, total);
      let start = 0;
      for (let i = 1; i < line; i++) start = v.indexOf("\n", start) + 1;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(start, start);
      const top = PAD + (line - 1) * LINE;
      ta.scrollTop = Math.max(0, top + LINE / 2 - ta.clientHeight / 2);
      ta.scrollLeft = 0;
      sync();
      root.querySelectorAll(".jump-flash").forEach((x) => x.remove());
      const flash = Object.assign(document.createElement("div"), { className: "jump-flash" });
      flash.style.top = `${top - ta.scrollTop}px`;
      flash.style.height = `${LINE}px`;
      q(".stack").append(flash);
      setTimeout(() => flash.remove(), 1700);
      say(n > total ? `Only ${total.toLocaleString()} rows, so it went to the last one` : "", n > total);
    }
    // A click on a row number selects that row (Shift+click: from the caret's row to there).
    gutter.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const n = Math.floor((e.clientY - gutter.getBoundingClientRect().top + gutter.scrollTop - PAD) / LINE) + 1;
      const v = ta.value, rows = v.split("\n");
      if (n < 1 || n > rows.length) return;
      const startOf = (r) => rows.slice(0, r - 1).reduce((t, l) => t + l.length + 1, 0);
      let from = startOf(n), to = from + rows[n - 1].length + (n < rows.length ? 1 : 0);
      if (e.shiftKey) {
        const caretRow = v.slice(0, ta.selectionStart).split("\n").length;
        if (caretRow < n) from = startOf(caretRow);
        else to = startOf(caretRow) + rows[caretRow - 1].length + (caretRow < rows.length ? 1 : 0);
      }
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(from, to);
    });
    q(".jump").onsubmit = (e) => {
      e.preventDefault();
      const raw = jumpInput.value.trim().replace(/[,\s_]/g, "");
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        jumpInput.classList.remove("invalid");
        void jumpInput.offsetWidth; // restart the shake
        jumpInput.classList.add("invalid");
        return say(`Type a row number from 1 to ${ta.value.split("\n").length.toLocaleString()}`, true);
      }
      jumpInput.classList.remove("invalid");
      jumpInput.value = "";
      jumpToRow(Number(raw));
    };
    jumpInput.oninput = () => jumpInput.classList.remove("invalid");
    jumpInput.onkeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); jumpInput.value = ""; ta.focus({ preventScroll: true }); }
    };

    // Find and replace (find-bar.js), over the code.
    const finder = findBar({
      ta, mount: q(".code"), layer: q(".stack"), mirror: true,
      edit: (a, b, text) => {
        replacing = true;
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(a, b);
        document.execCommand("insertText", false, text);
        replacing = false;
      },
    });
    q(".find").onmousedown = (e) => e.preventDefault();
    q(".find").onclick = () => finder.open();

    // ---- What the metadata says ----
    function side() {
      const box = q(".side2");
      box.replaceChildren();
      const meta = USM.parseMeta(ta.value);
      const was = name;
      name = meta?.name || "";
      q(".title").textContent = name || "new script";
      q(".ver").textContent = meta?.version ? `v${meta.version}` : "";
      if (name !== was) onChange();
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
    const onStorage = (c, area) => {
      if (area !== "local" || !c.usScripts || !id) return;
      const now = (c.usScripts.newValue || []).find((x) => x.id === id);
      if (now && now.code !== stored) {
        stored = now.code;
        changedElsewhere = true;
        say("This script changed since you opened it (an update, or another window).", true);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    async function load() {
      let loadError = "";
      if (id) {
        try {
          const { script } = await send("usGet", { id });
          saved = stored = script.code;
        } catch (err) {
          loadError = err.message;
          id = "";
        }
      }
      try {
        if (!id) saved = template(site);
        ta.value = saved;
        ta.setSelectionRange(0, 0);
        record();
        onText();
        side();
        if (loadError) say(loadError, true);
        clearTimeout(hlTimer);
        await paint();
      } finally {
        root.classList.remove("loading");
      }
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(0, 0);
    }
    async function save() {
      if (q(".save").disabled) return;
      if (changedElsewhere && !confirm("This script changed since you opened it (an update, or another window). Save your version over it?")) return;
      q(".save").disabled = true;
      say("saving…", true);
      try {
        const code = ta.value;
        const r = await send("usInstall", { code, id: id || undefined, fresh: !id });
        // A new script, or one deleted meanwhile (saved again as new): from now on, this id.
        if (r.id !== id) id = r.id;
        saved = stored = code;
        changedElsewhere = false;
        status.classList.remove("keep");
        onText();
        say("saved");
      } catch (err) {
        say(err.message, true);
      }
      q(".save").disabled = false;
    }
    q(".save").onclick = save;
    q(".revert").onclick = () => {
      if (!confirm("Throw away the changes since the last save? Undo brings them back.")) return;
      lastTyped = 0;
      ta.value = saved;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(0, 0);
      ta.scrollTop = 0;
      record();
      onText();
      finder.refresh();
    };
    q(".undo").title = `Undo (${key("Z")})`;
    q(".redo").title = `Redo (${MAC ? key("Z", true) : key("Y")})`;
    jumpInput.title = `Type a row number and press Enter (${key("G")})`;
    q(".find").title = `Find and replace (${key("F")})`;
    q(".save").title = `Save (${key("S")})`;
    root.classList.add("loading");
    load();

    return {
      id: () => id,
      name: () => name,
      dirty: () => ta.value !== saved,
      focus: () => ta.focus({ preventScroll: true }),
      save,
      jump: () => { jumpInput.focus(); jumpInput.select(); },
      find: () => finder.open(),
      dispose: () => { chrome.storage.onChanged.removeListener(onStorage); clearTimeout(hlTimer); clearTimeout(sideTimer); },
    };
  };
})();
