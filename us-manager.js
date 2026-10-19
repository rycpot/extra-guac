// The userscripts page (userscripts.html): tabs for the installed scripts (a table where a row
// opens its details), settings (on/off, updates, export / import / restore from Drive), and an
// editor tab per open script (us-edit.js). The address says which tab is shown: #settings,
// #edit=<script id>, #new or #new=<site>; nothing for the list.
// The scripts themselves are kept and run by bg-userscripts.js.
(() => {
  const $ = (id) => document.getElementById(id);
  const send = async (type, payload = {}) => {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res?.ok) throw new Error(res?.error || "Something went wrong");
    return res;
  };
  TT.applyTheme();
  const say = (id, text, bad = false) => { $(id).textContent = text; $(id).classList.toggle("bad", bad); };
  const age = (t) => {
    if (!t) return "";
    const m = (Date.now() - t) / 60e3;
    return m < 60 ? "just now" : m < 1440 ? `${Math.round(m / 60)} h ago` : m < 2880 ? "yesterday" : m < 60 * 24 * 45 ? `${Math.round(m / 1440)} days ago`
      : m < 60 * 24 * 600 ? `${Math.round(m / 43800)} months ago` : `${Math.round(m / 525600)} years ago`;
  };
  const SVG = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    storage: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/>',
    requests: '<path d="M4 12h16M14 6l6 6-6 6"/>',
    styles: '<path d="M14 4l6 6-8 8H6v-6z"/>',
    menu: '<path d="M5 7h14M5 12h14M5 17h14"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  };
  const SHOWN = ["storage", "requests", "styles", "menu"];
  const RUN_AT = { document_start: "before the page loads", document_end: "once the page is there, before its images", document_idle: "after the page has loaded" };

  let scripts = [];
  const open = new Set(); // rows showing their details

  // ---- Tabs ----
  // The list and settings are always there; each open script has an editor tab before them.
  const editors = []; // { el, api, tab, wrap }
  let tabCount = 0;
  let active = "list"; // "list", "settings" or an editor entry

  function show(which, { push = true } = {}) {
    active = which;
    $("pList").hidden = which !== "list";
    $("pSettings").hidden = which !== "settings";
    $("tabList").setAttribute("aria-selected", String(which === "list"));
    $("tabSettings").setAttribute("aria-selected", String(which === "settings"));
    for (const e of editors) {
      e.el.hidden = e !== which;
      e.tab.setAttribute("aria-selected", String(e === which));
      e.wrap.classList.toggle("on", e === which);
      e.tab.tabIndex = e === which ? 0 : -1;
    }
    if (which === "settings") onSettings();
    if (which === "list") setup();
    if (typeof which === "object") which.api.focus();
    const hash = which === "list" ? "" : which === "settings" ? "#settings" : which.api.id() ? `#edit=${encodeURIComponent(which.api.id())}` : "#new";
    if (push && location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
    title();
  }
  function title() {
    const what = active === "list" ? "installed scripts" : active === "settings" ? "settings" : active.api.name() || "new script";
    document.title = `${what} · Userscripts · Extra Guac`;
  }
  $("tabList").onclick = () => show("list");
  $("tabSettings").onclick = () => show("settings");
  $("tabNew").onclick = () => openEditor({});

  function openEditor({ id = "", site = "" }) {
    const have = id && editors.find((e) => e.api.id() === id);
    if (have) return show(have);
    const el = $("edTpl").content.firstElementChild.cloneNode(true);
    // A tab, with its close button beside it (not inside it). Delete or Ctrl/⌘+W on a
    // focused tab closes it; arrow keys move between tabs.
    const n = ++tabCount;
    const wrap = document.createElement("span");
    wrap.className = "tab edit";
    wrap.innerHTML = `<button type="button" class="pick" role="tab" id="edTab${n}" aria-controls="edPanel${n}"><span class="lab"></span><span class="dot" hidden title="unsaved changes"></span></button><button type="button" class="x" title="Close" aria-label="Close">×</button>`;
    const tab = wrap.querySelector(".pick");
    el.id = `edPanel${n}`;
    el.setAttribute("aria-labelledby", tab.id);
    const entry = { el, tab, wrap, api: null };
    const update = () => {
      if (!entry.api) return;
      const name = entry.api.name() || "new script";
      tab.querySelector(".lab").textContent = `edit · ${name}`;
      tab.title = name;
      wrap.querySelector(".x").setAttribute("aria-label", `Close ${name}`);
      tab.querySelector(".dot").hidden = !entry.api.dirty();
      if (active === entry) { title(); const h = entry.api.id() ? `#edit=${encodeURIComponent(entry.api.id())}` : "#new"; if (location.hash !== h) history.replaceState(null, "", h); }
    };
    entry.api = usEditor(el, { id, site, onChange: update });
    tab.querySelector(".lab").textContent = "edit · …";
    tab.onclick = () => show(entry);
    wrap.querySelector(".x").onclick = () => close(entry);
    wrap.onauxclick = (e) => { if (e.button === 1) close(entry); };
    tab.onkeydown = (e) => {
      if (e.key === "Delete" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w")) { e.preventDefault(); close(entry); }
    };
    $("editTabs").append(wrap);
    document.body.append(el);
    editors.push(entry);
    show(entry);
    update();
  }
  function close(entry) {
    if (entry.api.dirty() && !confirm(`Close “${entry.api.name() || "new script"}” without saving the changes?`)) return;
    const i = editors.indexOf(entry);
    editors.splice(i, 1);
    entry.api.dispose();
    entry.el.remove();
    entry.wrap.remove();
    if (active === entry) show(editors[Math.min(i, editors.length - 1)] || "list");
  }
  // Ctrl/⌘+G: go to row in the open editor; Ctrl/⌘+S saves it even when focus is elsewhere.
  document.addEventListener("keydown", (e) => {
    if (typeof active !== "object" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "g" && !e.shiftKey) { e.preventDefault(); active.api.jump(); }
    else if (k === "s" && !e.shiftKey) { e.preventDefault(); active.api.save(); }
  });
  // Left / right arrows move between all the tabs, as in any tab bar.
  $("tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const all = [...document.querySelectorAll('#tabs [role="tab"]')];
    const i = all.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    const next = all[(i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length];
    next.focus();
    next.click();
  });
  addEventListener("beforeunload", (e) => { if (editors.some((x) => x.api.dirty())) e.preventDefault(); });

  function route() {
    let h = location.hash.slice(1);
    try { h = decodeURIComponent(h); } catch {}
    const edit = /^edit=(.+)$/.exec(h), fresh = /^new(?:=(.*))?$/.exec(h);
    if (edit) openEditor({ id: edit[1] });
    else if (fresh) openEditor({ site: fresh[1] || "" });
    else show(h === "settings" ? "settings" : "list", { push: false });
  }
  addEventListener("hashchange", route);

  // ---- Getting started ----

  let polling = 0;
  async function setup() {
    let st;
    try { st = await send("usState"); } catch { return; }
    $("usNeedPermission").hidden = st.permitted || st.oldChrome;
    $("usNeedSwitch").hidden = !st.permitted || st.available || st.oldChrome;
    $("usOldChrome").hidden = !st.oldChrome;
    $("usSetup").hidden = st.available;
    clearInterval(polling);
    // Chrome says nothing when its switch is turned on: looked at while this is open.
    if (st.permitted && !st.available) polling = setInterval(async () => {
      const now = await send("usState").catch(() => null);
      if (now?.available) { clearInterval(polling); await send("usSync").catch(() => {}); setup(); }
    }, 2000);
  }
  $("usGrant").onclick = async () => {
    try { await chrome.permissions.request({ permissions: ["userScripts"] }); } catch (err) { alert(err.message); }
    await send("usSync").catch(() => {});
    setup();
  };
  $("usDetails").onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });

  // ---- The table ----

  async function load() {
    try {
      const res = await send("usList");
      scripts = res.scripts;
      say("usChecked", res.lastCheck ? `last checked ${age(res.lastCheck)}` : "");
    } catch (err) { scripts = []; say("usChecked", err.message, true); }
    render();
  }

  function render() {
    const q = $("usFilter").value.trim().toLowerCase();
    const shown = scripts.filter((s) => !q || [s.meta.name, s.meta.description, ...USM.sitesOf(s.meta)].join(" ").toLowerCase().includes(q));
    $("usTable").hidden = !scripts.length;
    $("usLegend").hidden = !scripts.length;
    $("usEmpty").hidden = !!scripts.length;
    $("usFilter").placeholder = `filter ${scripts.length || ""} script${scripts.length === 1 ? "" : "s"}`.replace("  ", " ");
    const body = $("usRows");
    body.replaceChildren();
    for (const s of shown) {
      body.append(row(s));
      if (open.has(s.id)) body.append(details(s));
    }
  }

  function row(s) {
    const m = s.meta;
    const tr = document.createElement("tr");
    tr.className = "us-row";
    tr.classList.toggle("off", s.enabled === false);
    tr.classList.toggle("open", open.has(s.id));
    const kinds = USM.kindsOf(m);
    const sites = USM.sitesOf(m);
    tr.innerHTML = `<td><label class="toggle"><input type="checkbox"></label></td>
      <td class="nm"><span class="n"></span></td><td class="mut v"></td><td class="mut st"></td>
      <td><span class="us-icons">${SHOWN.map((k) => `<span class="us-ic${kinds.includes(k) ? " on" : ""}" title="${k}">${SVG(ICONS[k])}</span>`).join("")}</span></td>
      <td class="mut up"></td><td><button type="button" class="ib" title="Edit code">${SVG(ICONS.edit)}</button></td>`;
    const n = tr.querySelector(".n");
    n.textContent = m.name;
    tr.querySelector(".nm").title = m.description || m.name;
    if (s.pending) n.insertAdjacentHTML("afterend", ' <span class="us-pill warn">update waiting</span>');
    else if (s.limits?.length) {
      const warn = document.createElement("span");
      warn.className = "us-pill warn";
      warn.textContent = "has limits";
      warn.title = s.limits.join("\n");
      n.after(" ", warn);
    }
    tr.querySelector(".v").textContent = m.version || "–";
    tr.querySelector(".st").textContent = sites.length > 2 ? `${sites.slice(0, 2).join(", ")} +${sites.length - 2}` : sites.join(", ");
    tr.querySelector(".st").title = sites.join(", ");
    tr.querySelector(".up").textContent = age(s.updatedAt);
    tr.querySelector(".up").title = s.updatedAt ? TT.when(s.updatedAt) : "";
    const box = tr.querySelector("input");
    box.setAttribute("aria-label", `${m.name}, on or off`);
    tr.tabIndex = 0;
    tr.setAttribute("aria-expanded", String(open.has(s.id)));
    tr.dataset.id = s.id;
    tr.onkeydown = (e) => {
      if ((e.key !== "Enter" && e.key !== " ") || e.target !== tr) return;
      e.preventDefault();
      tr.click();
      document.querySelector(`tr.us-row[data-id="${CSS.escape(s.id)}"]`)?.focus();
    };
    box.checked = s.enabled !== false;
    box.onchange = () => send("usToggle", { id: s.id, enabled: box.checked }).catch((err) => alert(err.message));
    tr.querySelector(".ib").onclick = () => edit(s.id);
    tr.onclick = (e) => {
      if (e.target.closest("button, label, input, a")) return;
      open.has(s.id) ? open.delete(s.id) : open.add(s.id);
      render();
    };
    return tr;
  }

  function details(s) {
    const m = s.meta;
    const tr = document.createElement("tr");
    tr.className = "us-detail";
    tr.innerHTML = `<td colspan="7"><dl class="us-dl"></dl><div class="us-acts"></div></td>`;
    const dl = tr.querySelector("dl");
    const item = (label, ...nodes) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label;
      dd.append(...nodes);
      dl.append(dt, dd);
    };
    const pill = (text, cls = "mono") => { const p = document.createElement("span"); p.className = `us-pill ${cls}`; p.textContent = text; return p; };
    const text = (t, cls = "mut") => { const p = document.createElement("span"); p.className = cls; p.textContent = t; return p; };
    if (m.description) item("about", text(m.description, ""));
    const ins = [...m.matches, ...m.includes];
    item("runs on", ...(ins.length ? ins : ["every site"]).map((p) => pill(p)), text(RUN_AT[m.runAt] || ""), ...(m.noframes ? [text("· top frame only")] : []));
    const ex = [...m.excludes, ...m.excludeMatches];
    if (ex.length) item("not on", ...ex.map((p) => pill(p)));
    const kinds = USM.kindsOf(m);
    item("can", ...(kinds.length ? kinds.map((k) => pill(USM.KIND_TEXT[k], "grant")) : [text(USM.inPage(m) ? "nothing extra: runs as part of the page" : "nothing extra")]));
    if (kinds.includes("requests")) item("send requests to", ...(m.connects.length ? m.connects.map((c) => pill(c)) : [text("any site")]));
    if (s.limits?.length) item("limits", ...s.limits.map((l) => { const p = text(l, "bad"); p.style.display = "block"; return p; }));
    const from = m.updateURL || m.downloadURL || s.source;
    let host = "";
    try { host = from ? new URL(from).host : ""; } catch {}
    item("updates", host ? text(`from ${host}${s.autoUpdate === false ? " · automatic updates off for this script" : ""}${s.checkedAt ? ` · checked ${age(s.checkedAt)}` : ""}`) : text("no update address (written or changed here)"));
    if (s.checkError) item("last check", text(s.checkError, "bad"));
    if (s.pending) {
      const pm = s.pending.meta;
      item("update waiting", text(`${pm?.version ? `version ${pm.version}` : "A newer version"} asks for more access, so it waits for your OK.`, ""));
    }
    item("installed", text(TT.when(s.installedAt)));
    const acts = tr.querySelector(".us-acts");
    const btn = (label, fn, cls = "btn") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.onclick = async () => { b.disabled = true; try { await fn(); } catch (err) { alert(err.message); } b.disabled = false; };
      acts.append(b);
      return b;
    };
    if (s.pending) {
      btn("review the update", () => window.open(`us-install.html#pending=${encodeURIComponent(s.id)}`, "_blank"), "btn blue");
      btn("skip it", () => send("usPending", { id: s.id, install: false }));
    }
    btn("edit code", () => edit(s.id));
    if (host) {
      btn("check for update", async () => {
        const r = await send("usCheckUpdates", { ids: [s.id] });
        alert(r.updated.length ? `Updated to ${r.updated[0]}.` : r.waiting.length ? "A newer version asks for more access: review it here." : r.failed.length ? r.failed[0] : "It's up to date.");
      });
      btn(s.autoUpdate === false ? "turn automatic updates on" : "turn automatic updates off", () => send("usAutoUpdate", { id: s.id, on: s.autoUpdate === false }), "btn ghost");
    }
    btn("delete", async () => {
      if (!confirm(`Delete “${m.name}” and what it saved?`)) return;
      open.delete(s.id);
      await send("usRemove", { id: s.id });
    }, "btn ghost");
    return tr;
  }

  const edit = (id) => openEditor({ id });
  $("usNew").onclick = () => openEditor({});
  $("usFromUrl").onclick = () => {
    const url = prompt("Address of the .user.js file to install");
    if (!url) return;
    try { new URL(url); } catch { return alert("That isn't a web address."); }
    window.open(`us-install.html#${url.trim()}`, "_blank");
  };
  $("usFilter").oninput = render;

  $("usLegend").innerHTML = SHOWN.map((k) => `<span><span class="us-ic on">${SVG(ICONS[k])}</span>${k}</span>`).join("")
    + "<span>Click a row for details; the pencil opens the script in a tab of its own.</span>";

  // ---- Updates ----

  for (const r of [$("usAskYes"), $("usAskNo")]) r.onchange = () => r.checked && TT.updateSettings({ us: { ask: r.value === "true" } }).catch((err) => alert(err.message));
  $("usCheckNow").onclick = async () => {
    $("usCheckNow").disabled = true;
    say("usCheckStatus", "checking…");
    try {
      const r = await send("usCheckUpdates");
      const parts = [];
      if (!r.checked) parts.push("No script has an address to update from.");
      else parts.push(r.updated.length ? `Updated: ${r.updated.join(", ")}.` : "Everything is up to date.");
      if (r.waiting.length) parts.push(`Waiting for your OK (they ask for more access): ${r.waiting.join(", ")}.`);
      if (r.failed.length) parts.push(`Couldn't check: ${r.failed.join("; ")}.`);
      say("usCheckStatus", parts.join(" "), r.failed.length > 0);
    } catch (err) { say("usCheckStatus", err.message, true); }
    $("usCheckNow").disabled = false;
  };

  // ---- Export / import ----

  const safeName = (n) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "script";
  $("usExport").onclick = async () => {
    try {
      const { scripts: list } = await send("usExport");
      if (!list.length) return say("usBackupStatus", "There are no scripts to export.");
      const used = new Set(), files = [];
      for (const s of list) {
        let base = safeName(s.name), i = 2;
        while (used.has(base.toLowerCase())) base = `${safeName(s.name)} (${i++})`;
        used.add(base.toLowerCase());
        files.push({ name: `${base}.user.js`, text: s.code });
        files.push({ name: `${base}.options.json`, text: JSON.stringify({ enabled: s.enabled, position: s.position, source: s.source }, null, 1) });
        if (Object.keys(s.values).length) files.push({ name: `${base}.storage.json`, text: JSON.stringify({ data: s.values }, null, 1) });
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(USZIP.zip(files));
      const d = new Date();
      a.download = `extra-guac-userscripts-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
      say("usBackupStatus", `Exported ${list.length} script${list.length === 1 ? "" : "s"}.`);
    } catch (err) { say("usBackupStatus", err.message, true); }
  };

  // A backup text file: JSON with a "scripts" list, each with its code ("source", sometimes in
  // base64) and what it saved ("storage.data", each value marked by its first letter: s text,
  // n number, b true/false, o JSON).
  const unmark = (v) => {
    if (typeof v !== "string" || !v) return v;
    const rest = v.slice(1);
    switch (v[0]) {
      case "s": return rest;
      case "n": return Number(rest);
      case "b": return rest === "true";
      case "o": try { return JSON.parse(rest); } catch { return rest; }
      default: return v;
    }
  };
  const fromB64 = (s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return ""; } };
  function fromBackupText(json) {
    if (!Array.isArray(json?.scripts)) throw new Error("That file has no scripts in it");
    return json.scripts.map((sc) => {
      let code = String(sc.source ?? sc.code ?? "");
      if (!/==UserScript==/.test(code)) code = fromB64(code) || code;
      const data = sc.storage?.data && typeof sc.storage.data === "object" ? sc.storage.data : null;
      const values = data ? Object.fromEntries(Object.entries(data).filter(([, v]) => v !== "u").map(([k, v]) => [k, unmark(v)])) : undefined;
      return { name: sc.name, code, enabled: sc.enabled !== false, position: sc.position, source: sc.file_url || sc.source_url || "", values };
    });
  }
  // A .zip: each "<name>.user.js", with "<name>.options.json" (on/off, order, where it came
  // from) and "<name>.storage.json" (what it saved) beside it when there.
  async function fromZip(file) {
    const entries = await USZIP.unzip(file);
    const by = new Map(entries.map((e) => [e.name, e.text]));
    const json = (n) => { try { return by.has(n) ? JSON.parse(by.get(n)) : null; } catch { return null; } };
    const items = [];
    for (const e of entries) {
      if (!/\.user\.js$/i.test(e.name)) continue;
      const base = e.name.replace(/\.user\.js$/i, "");
      const o = json(`${base}.options.json`) || {};
      const st = json(`${base}.storage.json`);
      const enabled = o.enabled ?? o.settings?.enabled ?? o.config?.enabled;
      items.push({
        code: e.text, enabled: enabled === undefined ? true : !!enabled, position: o.position ?? o.settings?.position,
        source: o.source || o.file_url || o.meta?.file_url || "", values: st ? (st.data && typeof st.data === "object" ? st.data : st) : undefined,
      });
    }
    // A backup text file inside the .zip counts too.
    for (const e of entries) if (/\.(txt|json)$/i.test(e.name) && !/\.(options|storage)\.json$/i.test(e.name)) {
      try { items.push(...fromBackupText(JSON.parse(e.text))); } catch {}
    }
    return items;
  }

  $("usImport").onclick = () => $("usImportFile").click();
  $("usImportFile").onchange = async () => {
    const files = [...$("usImportFile").files];
    $("usImportFile").value = "";
    if (!files.length) return;
    say("usBackupStatus", "reading…");
    try {
      const items = [];
      for (const f of files) {
        const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
        if (head[0] === 0x50 && head[1] === 0x4b) items.push(...await fromZip(f));
        else {
          const text = await f.text();
          if (/==UserScript==/.test(text)) items.push({ code: text, source: "" });
          else items.push(...fromBackupText(JSON.parse(text)));
        }
      }
      if (!items.length) return say("usBackupStatus", "No userscripts found in that file.", true);
      const names = items.map((it) => it.name || USM.parseMeta(it.code)?.name || "?");
      const have = new Set(scripts.map((s) => USM.keyOf(s.meta)));
      const replacing = items.filter((it) => { const m = USM.parseMeta(it.code); return m && have.has(USM.keyOf(m)); }).length;
      if (!confirm(`Import ${items.length} script${items.length === 1 ? "" : "s"}${replacing ? ` (${replacing} replacing ones here)` : ""}?\n\n${names.slice(0, 30).join("\n")}${names.length > 30 ? "\n…" : ""}`)) return say("usBackupStatus", "");
      say("usBackupStatus", "importing…");
      const r = await send("usImport", { items });
      say("usBackupStatus", [r.added && `${r.added} added`, r.replaced && `${r.replaced} replaced`, r.failed.length && `not imported: ${r.failed.join("; ")}`].filter(Boolean).join(" · ") || "Nothing imported.", r.failed.length > 0);
    } catch (err) {
      say("usBackupStatus", err instanceof SyntaxError ? "That file couldn't be read as userscripts." : err.message, true);
    }
  };

  // ---- Restore from Drive ----

  async function fillSnaps() {
    const sel = $("usSnap");
    const { backupState: st = {}, backupDevice } = await chrome.storage.local.get(["backupState", "backupDevice"]);
    if (!st.connected || st.needsSignIn) {
      sel.innerHTML = `<option value="">connect Google Drive in backup first</option>`;
      $("usRestore").disabled = true;
      return;
    }
    try {
      const { snapshots } = await send("backupList");
      sel.replaceChildren();
      for (const snap of snapshots) {
        const o = document.createElement("option");
        o.value = snap.id;
        const where = snap.kind === "pre-restore" ? "before a restore" : backupDevice && snap.device === backupDevice ? "this browser" : snap.device ? "another browser" : "";
        o.textContent = [TT.when(snap.at), where, snap.scripts != null ? `${snap.scripts} script${snap.scripts === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
        sel.append(o);
      }
      if (!snapshots.length) sel.innerHTML = `<option value="">no snapshots yet</option>`;
      $("usRestore").disabled = !snapshots.length;
    } catch (err) {
      sel.innerHTML = `<option value=""></option>`;
      sel.firstChild.textContent = `couldn't list snapshots: ${err.message}`;
      $("usRestore").disabled = true;
    }
  }
  $("usRestore").onclick = async () => {
    const opt = $("usSnap").selectedOptions[0];
    if (!opt?.value) return;
    if (!confirm(`Replace the userscripts here (and what they saved) with the ones in the snapshot from ${opt.textContent}? Every other setting stays as it is.`)) return;
    $("usRestore").disabled = true;
    say("usBackupStatus", "restoring…");
    try {
      const r = await send("backupRestore", { id: opt.value, what: "userscripts" });
      say("usBackupStatus", `${r.scripts} script${r.scripts === 1 ? "" : "s"} restored. Undo last restore (in backup) puts back what was here before.`);
    } catch (err) { say("usBackupStatus", err.message, true); }
    $("usRestore").disabled = false;
  };

  // ---- On / off ----

  async function fillSettings() {
    const { us } = await TT.getSettings();
    $("usEnabled").checked = !!us.enabled;
    $("usOff").hidden = !!us.enabled;
    for (const r of document.querySelectorAll('input[name="usInterval"]')) r.checked = Number(r.value) === Number(us.interval);
    $("usAskYes").checked = us.ask !== false;
    $("usAskNo").checked = us.ask === false;
  }
  const setOn = (on) => TT.updateSettings({ us: { enabled: on } }).catch((err) => alert(err.message));
  $("usEnabled").onchange = () => setOn($("usEnabled").checked);
  $("usTurnOn").onclick = () => setOn(true);
  for (const r of document.querySelectorAll('input[name="usInterval"]')) {
    r.onchange = () => r.checked && TT.updateSettings({ us: { interval: Number(r.value) } }).catch((err) => alert(err.message));
  }

  // ---- Start, and keep up ----

  let snapsListed = false;
  function onSettings() {
    if (!snapsListed) { snapsListed = true; fillSnaps(); }
  }
  load();
  fillSettings();
  route();
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.usScripts || c.usLastCheck) load();
    if (c.tt) fillSettings();
    if (c.backupState) { snapsListed = false; if (active === "settings") onSettings(); }
  });
})();
