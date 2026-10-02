// Settings window: left-nav sections and every setting except blur (settings-blur.js).
// Inputs with data-path="a.b" are bound to that path in the "tt" settings object.
(() => {
  const $ = (id) => document.getElementById(id);
  let settings;
  let saveTimer = 0;

  TT.applyTheme();
  init();

  async function init() {
    settings = await TT.getSettings();
    buildServices();
    bindPaths();
    initRedirect();
    initUpload();
    initRemoved();
    initDarkLists();
    initBackup();
    initLayout();
    initHighlight();
    showPane();
    addEventListener("hashchange", showPane);
    $("testSound").onclick = testSound;
    $("resetSound").onclick = () => setPath("refresh.sound", TT.DEFAULTS.refresh.sound, true);
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.tt && !saveTimer) {
        settings = TT.merge(TT.DEFAULTS, c.tt.newValue);
        fill();
      }
      if (area === "local" && c.shortCounts) fillCounts();
    });
  }

  function showPane() {
    const id = (location.hash || "#general").slice(1);
    const pane = $(id)?.classList.contains("pane") ? id : "general";
    document.querySelectorAll(".pane").forEach((p) => (p.hidden = p.id !== pane));
    document.querySelectorAll(".side a").forEach((a) => a.classList.toggle("active", a.hash === `#${pane}`));
  }

  // ---- data-path binding ----

  const getPath = (path) => path.split(".").reduce((o, k) => o?.[k], settings);

  function setPath(path, value, refill = false) {
    const keys = path.split(".");
    let o = settings;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys.at(-1)] = value;
    save();
    if (refill) fill();
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await chrome.storage.local.set({ tt: settings });
      saveTimer = 0;
    }, 250);
  }

  function bindPaths() {
    for (const el of document.querySelectorAll("[data-path]")) {
      el.addEventListener(["text", "url", "password"].includes(el.type) ? "input" : "change", () => {
        const value = el.type === "checkbox" ? el.checked
          : el.type === "range" || el.type === "number" ? +el.value
          : el.value;
        if (el.type === "radio" && !el.checked) return;
        setPath(el.dataset.path, value);
        update();
      });
      if (el.type === "range") el.addEventListener("input", update);
    }
    fill();
  }

  function fill() {
    for (const el of document.querySelectorAll("[data-path]")) {
      const v = getPath(el.dataset.path);
      if (el.type === "checkbox") el.checked = !!v;
      else if (el.type === "radio") el.checked = el.value === v;
      else if (document.activeElement !== el) el.value = v ?? "";
    }
    fillServices();
    renderRules();
    fillUpload();
    renderLayout();
    update();
  }

  function update() {
    for (const out of document.querySelectorAll("output[data-for]")) out.textContent = $(out.dataset.for).value;
    $("qualityRow").hidden = settings.shot.format !== "jpeg";
  }

  // ---- Alert sound ----

  async function testSound() {
    const err = $("soundError");
    err.textContent = "";
    const url = settings.refresh.sound;
    if (!url) return (err.textContent = "No sound set.");
    try {
      await new Audio(url).play();
    } catch (e) {
      err.textContent = `Couldn't play that sound: ${e.message}`;
    }
  }

  // ---- Auto redirect rules ----

  const rules = () => settings.redirect.rules;

  function initRedirect() {
    $("addRule").onclick = () => {
      rules().push({ domain: "", find: "", replace: "", auto: true, on: true });
      save();
      renderRules();
      $("ruleRows").querySelector(".rule:last-child input[data-k=domain]").focus();
    };
    $("tryUrl").addEventListener("input", tryUrl);
  }

  function renderRules() {
    const box = $("ruleRows");
    if (box.contains(document.activeElement)) return; // don't rebuild under the cursor
    box.replaceChildren(...rules().map((rule, i) => {
      const row = document.createElement("div");
      row.className = "rule";
      row.innerHTML = `<div class="rules-grid">
          <input type="checkbox" data-k="on" title="Rule on/off">
          <input class="text" data-k="domain" placeholder="any site" spellcheck="false">
          <input class="text" data-k="find" placeholder="find" spellcheck="false">
          <span class="arrow">→</span>
          <input class="text" data-k="replace" placeholder="replace with" spellcheck="false">
          <input type="checkbox" data-k="auto" title="Redirect automatically (off: right-click → Redirect with rules)">
          <button type="button" class="del" title="Delete rule">×</button>
        </div><div class="rules-grid"><span class="rule-error"></span></div>`;
      for (const input of row.querySelectorAll("[data-k]")) {
        const k = input.dataset.k;
        if (input.type === "checkbox") input.checked = k === "on" ? rule.on !== false : !!rule.auto;
        else input.value = rule[k] || "";
        input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
          rule[k] = input.type === "checkbox" ? input.checked : input.value.trim();
          row.classList.toggle("off", rule.on === false);
          showRuleError(row, rule);
          save();
          tryUrl();
        });
      }
      row.classList.toggle("off", rule.on === false);
      row.querySelector(".del").onclick = () => {
        rules().splice(i, 1);
        save();
        renderRules();
        tryUrl();
      };
      showRuleError(row, rule);
      return row;
    }));
  }

  function showRuleError(row, rule) {
    row.querySelector(".rule-error").textContent = Redirects.check(rule);
  }

  function tryUrl() {
    const url = $("tryUrl").value.trim();
    const out = $("tryResult");
    if (!url) return (out.textContent = "");
    const { url: to, rules: used } = Redirects.apply(url, rules());
    if (!used.length) return (out.textContent = "No rule changes this URL.");
    out.innerHTML = "";
    const auto = used.every((r) => r.auto);
    out.append(`${auto ? "Redirects automatically" : "Right-click → Redirect with rules"} to `, Object.assign(document.createElement("b"), { textContent: to }));
    if (Redirects.apply(to, rules()).url !== to) out.append(" — note: the rules would change that URL again; the loop guard stops it there.");
  }

  // ---- Image upload ----

  function initUpload() {
    for (const btn of document.querySelectorAll("[data-reveal]")) {
      btn.onclick = () => {
        const input = btn.parentElement.querySelector("input");
        input.type = input.type === "password" ? "text" : "password";
        btn.textContent = input.type === "password" ? "show" : "hide";
      };
    }
    $("x02Key").addEventListener("input", () => {
      $("x02State").textContent = $("x02Key").value.trim() === settings.upload.x02Key ? x02StateText() : "not saved";
      $("x02State").className = "hint";
    });
    $("x02Save").onclick = async () => {
      const btn = $("x02Save");
      btn.disabled = true;
      $("x02State").textContent = "checking…";
      const res = await chrome.runtime.sendMessage({ type: "verifyX02", key: $("x02Key").value });
      btn.disabled = false;
      settings = await TT.getSettings();
      fill();
      if (res?.ok && !res.verified) {
        $("x02State").textContent = res.error;
        $("x02State").className = "hint x02-bad";
      }
    };
  }

  const x02StateText = () => (settings.upload.x02Verified ? "✓ key verified" : settings.upload.x02Key ? "key not verified" : "no key yet");

  function fillUpload() {
    if (document.activeElement !== $("x02Key")) $("x02Key").value = settings.upload.x02Key || "";
    $("x02State").textContent = x02StateText();
    $("x02State").className = `hint ${settings.upload.x02Verified ? "x02-ok" : ""}`;
    $("x02UseRow").querySelector("input").disabled = !settings.upload.x02Verified;
  }

  // ---- URL shortener services ----

  function buildServices() {
    const box = $("shortenerServices");
    const tpl = $("serviceTpl");
    for (const [id, info] of Object.entries(TT.SHORTENERS)) {
      const node = tpl.content.cloneNode(true);
      const section = node.querySelector(".service");
      section.dataset.service = id;
      section.querySelector(".name").textContent = info.label;
      const key = section.querySelector(".key");
      key.placeholder = `${info.label} API ${id === "tinyurl" ? "token" : "key"}`;
      key.addEventListener("input", () => setPath(`shortener.keys.${id}`, key.value.trim()));
      section.querySelector(".reveal").onclick = (e) => {
        key.type = key.type === "password" ? "text" : "password";
        e.target.textContent = key.type === "password" ? "show" : "hide";
      };
      const paid = section.querySelector(".paid");
      paid.addEventListener("change", () => { setPath(`shortener.paid.${id}`, paid.checked); fillCounts(); });
      const keyLink = section.querySelector(".keylink");
      keyLink.href = info.keyHelp;
      keyLink.textContent = new URL(info.keyHelp).host + new URL(info.keyHelp).pathname;
      section.querySelector(".docs").href = info.docs;
      box.append(node);
    }
  }

  function fillServices() {
    for (const section of document.querySelectorAll(".service")) {
      const id = section.dataset.service;
      const key = section.querySelector(".key");
      if (document.activeElement !== key) key.value = settings.shortener.keys[id] || "";
      section.querySelector(".paid").checked = !!settings.shortener.paid[id];
    }
    fillCounts();
  }

  async function fillCounts() {
    const { shortCounts = {} } = await chrome.storage.local.get("shortCounts");
    const thisMonth = shortCounts.month === TT.monthKey();
    for (const section of document.querySelectorAll(".service")) {
      const id = section.dataset.service;
      const n = thisMonth ? shortCounts[id] || 0 : 0;
      section.querySelector(".count").textContent = settings.shortener.paid[id]
        ? `${n} links this month`
        : `${n}/${TT.SHORTENERS[id].freeLimit} links this month`;
    }
  }

  // ---- Remove elements: one row per site, removed elements as pills ----

  function initRemoved() {
    const box = $("removeSites");
    async function render() {
      const { removed = {} } = await chrome.storage.local.get("removed");
      const sites = Object.keys(removed).sort();
      if (!sites.length) {
        box.innerHTML = `<p class="rm-empty">Nothing removed yet.</p>`;
        return;
      }
      box.replaceChildren(...sites.map((site) => {
        const row = document.createElement("div");
        row.className = "rm-site";
        row.innerHTML = `<div class="rm-head"><b></b><span class="hint"></span><button type="button" class="btn ghost">clear site</button></div><div class="rm-pills"></div>`;
        row.querySelector("b").textContent = site;
        const off = removed[site].filter((r) => r.enabled === false).length;
        row.querySelector(".hint").textContent = `${removed[site].length - off} removed${off ? ` · ${off} off` : ""}`;
        row.querySelector("button").onclick = () => edit(site, () => []);
        row.querySelector(".rm-pills").append(...removed[site].map((r) => {
          const on = r.enabled !== false;
          const chip = document.createElement("span");
          chip.className = `chip${on ? "" : " off"}`;
          chip.title = `${r.selector}\nremoved ${new Date(r.at).toLocaleString()}${on ? "" : "\n(off: shown on the page)"}`;
          const text = Object.assign(document.createElement("button"), { type: "button", className: "chip-text", textContent: r.label || r.selector });
          text.setAttribute("aria-label", `${on ? "Show" : "Remove"} ${r.label || r.selector} again`);
          text.onclick = () => edit(site, (list) => list.map((e) => (e.selector === r.selector ? { ...e, enabled: !on } : e)));
          const x = Object.assign(document.createElement("button"), { type: "button", className: "chip-x", textContent: "×" });
          x.setAttribute("aria-label", `Stop removing ${r.label || r.selector}`);
          x.onclick = () => edit(site, (list) => list.filter((e) => e.selector !== r.selector));
          chip.append(text, x);
          return chip;
        }));
        return row;
      }));
    }
    async function edit(site, fn) {
      const { removed = {} } = await chrome.storage.local.get("removed");
      const list = fn(removed[site] || []);
      if (list.length) removed[site] = list;
      else delete removed[site];
      await chrome.storage.local.set({ removed });
    }
    render();
    chrome.storage.onChanged.addListener((c, area) => area === "local" && c.removed && render());
  }

  // ---- Dark mode: the site lists ----

  function initDarkLists() {
    const clean = (v) => {
      let h = v.trim().toLowerCase();
      try { if (h.includes("://")) h = new URL(h).hostname; } catch {}
      return h.split("/")[0].split(":")[0].replace(/^(\*\.|www\.)/, "");
    };
    async function lists() {
      const { dark } = await TT.getSettings();
      return { dark, all: { sites: dark.sites, exclude: dark.exclude, force: dark.force } };
    }
    async function change(key, fn) {
      const { dark } = await TT.getSettings();
      await TT.updateSettings({ dark: { [key]: fn(dark[key]) } });
    }
    async function render() {
      const { dark, all } = await lists();
      for (const sec of document.querySelectorAll(".dark-list")) {
        const key = sec.dataset.list;
        sec.classList.toggle("inactive", (key === "sites" && dark.mode !== "sites") || (key === "exclude" && dark.mode !== "all"));
        const pills = sec.querySelector(".rm-pills");
        pills.replaceChildren(...all[key].map((site) => {
          const chip = document.createElement("span");
          chip.className = "chip";
          const text = Object.assign(document.createElement("span"), { className: "chip-text", textContent: site });
          const x = Object.assign(document.createElement("button"), { type: "button", className: "chip-x", textContent: "×" });
          x.setAttribute("aria-label", `Remove ${site}`);
          x.onclick = () => change(key, (l) => l.filter((s) => s !== site));
          chip.append(text, x);
          return chip;
        }));
        if (!all[key].length) pills.innerHTML = `<span class="rm-empty">None</span>`;
      }
    }
    for (const sec of document.querySelectorAll(".dark-list")) {
      const input = sec.querySelector("input"), btn = sec.querySelector(".add-row button");
      if (!input) continue;
      const add = () => {
        const site = clean(input.value);
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) return input.focus();
        input.value = "";
        change(sec.dataset.list, (l) => [...new Set([...l, site])].sort());
      };
      btn.onclick = add;
      input.addEventListener("keydown", (e) => e.key === "Enter" && add());
    }
    render();
    chrome.storage.onChanged.addListener((c, area) => area === "local" && c.tt && render());
  }
  // ---- Backup ----

  function initBackup() {
    const send = async (type, payload = {}) => {
      const res = await chrome.runtime.sendMessage({ type, ...payload });
      if (!res?.ok) throw new Error(res?.error || "Something went wrong");
      return res;
    };
    const say = (text, bad = false) => { $("driveState").textContent = text; $("driveState").classList.toggle("bad", bad); };
    const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const age = (t) => { const d = (Date.now() - t) / 864e5; return d < 1 ? "today" : d < 2 ? "yesterday" : d < 60 ? `${Math.round(d)} days ago` : d < 730 ? `${Math.round(d / 30.4)} months ago` : `${Math.round(d / 365)} years ago`; };
    const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
    $("driveRedirect").textContent = chrome.identity.getRedirectURL();
    $("copyRedirect").onclick = () => navigator.clipboard.writeText(chrome.identity.getRedirectURL()).then(() => ($("copyRedirect").textContent = "copied"));

    let listed = false;
    async function render() {
      const { backup = {}, backupState: st = {} } = await chrome.storage.local.get(["backup", "backupState"]);
      if (document.activeElement !== $("driveClientId")) $("driveClientId").value = backup.clientId || "";
      const interval = String(backup.interval ?? 24);
      document.querySelectorAll('[name="driveInterval"]').forEach((r) => (r.checked = r.value === interval));
      $("driveConnect").textContent = !st.connected ? "connect" : st.needsSignIn ? "sign in again" : "reconnect";
      $("driveConnect").hidden = st.connected && !st.needsSignIn;
      $("driveDisconnect").hidden = !st.connected;
      $("driveClientId").disabled = !!st.connected;
      $("driveNow").disabled = !st.connected;
      if (!st.connected) say("not connected");
      else if (st.needsSignIn) say("signed out of Google — sign in again", true);
      else if (st.lastError) say(`last sync failed: ${st.lastError}`, true);
      else say(`connected${st.email ? ` as ${st.email}` : ""}${st.lastSnapshot ? ` · last snapshot ${when(st.lastSnapshot)}` : ""}${st.lastCheck ? ` · checked ${when(st.lastCheck)}` : ""}`);
      if (st.connected && !st.needsSignIn && !listed) listSnaps();
    }

    async function listSnaps() {
      listed = true;
      const box = $("driveSnaps");
      try {
        const { snapshots } = await send("backupList");
        if (!snapshots.length) return void (box.innerHTML = `<p class="rm-empty">No snapshots yet.</p>`);
        const table = document.createElement("table");
        table.className = "snaps";
        for (const snap of snapshots) {
          const tr = table.insertRow();
          tr.innerHTML = `<td class="when"><b></b><span class="hint"></span></td><td><span class="hint"></span></td>
            <td><button type="button" class="btn" data-what="settings">restore settings</button></td>
            <td><button type="button" class="btn" data-what="bookmarks">restore bookmarks</button></td>
            <td><button type="button" class="btn ghost" data-html>.html</button></td>
            <td><button type="button" class="btn ghost" data-json>.json</button></td>`;
          tr.querySelector("b").textContent = when(snap.at);
          tr.querySelector(".when .hint").textContent = age(snap.at);
          tr.cells[1].querySelector(".hint").textContent = size(snap.size);
          tr.title = snap.name;
          tr.querySelectorAll("[data-what]").forEach((b) => (b.onclick = async () => {
            const settingsToo = b.dataset.what === "settings";
            if (!confirm(settingsToo
              ? `Replace Tab Toolkit's settings and data with the snapshot from ${when(snap.at)}?`
              : `Add the bookmarks from ${when(snap.at)} in a new folder under Other bookmarks?`)) return;
            b.disabled = true;
            try {
              const res = await send("backupRestore", { id: snap.id, what: b.dataset.what });
              alert(settingsToo ? "Settings restored." : `Bookmarks restored to “${res.folder}” in Other bookmarks.`);
              if (settingsToo) location.reload();
            } catch (err) { alert(err.message); }
            b.disabled = false;
          }));
          tr.querySelector("[data-html]").onclick = () => send("backupBookmarksHtml", { id: snap.id }).catch((err) => alert(err.message));
          tr.querySelector("[data-json]").onclick = () => send("backupDownload", { id: snap.id }).catch((err) => alert(err.message));
        }
        box.replaceChildren(table);
      } catch (err) {
        box.innerHTML = `<p class="rm-empty"></p>`;
        box.firstChild.textContent = `Couldn't list snapshots: ${err.message}`;
        listed = false;
      }
    }

    $("driveClientId").addEventListener("change", async () => {
      const { backup = {} } = await chrome.storage.local.get("backup");
      await chrome.storage.local.set({ backup: { ...backup, clientId: $("driveClientId").value.trim() } });
    });
    document.querySelectorAll('[name="driveInterval"]').forEach((r) => r.addEventListener("change", async () => {
      const { backup = {} } = await chrome.storage.local.get("backup");
      await chrome.storage.local.set({ backup: { ...backup, interval: Number(r.value) } });
    }));
    $("driveConnect").onclick = async () => {
      const { backup = {} } = await chrome.storage.local.get("backup");
      await chrome.storage.local.set({ backup: { ...backup, clientId: $("driveClientId").value.trim() } });
      $("driveConnect").disabled = true;
      say("waiting for Google…");
      try { await send("backupConnect"); listed = false; } catch (err) { say(err.message, true); }
      $("driveConnect").disabled = false;
      render();
    };
    $("driveDisconnect").onclick = async () => {
      if (!confirm("Disconnect Google Drive? Your snapshots stay in Drive.")) return;
      await send("backupDisconnect");
      $("driveSnaps").innerHTML = `<p class="rm-empty">Connect Google Drive to see your snapshots.</p>`;
      listed = false;
    };
    $("driveNow").onclick = async () => {
      $("driveNow").disabled = true;
      say("syncing…");
      try {
        const res = await send("backupNow");
        listed = false;
        await listSnaps();
        alert(res.uploaded ? "Snapshot saved to Drive." : "Nothing changed since the last snapshot, so none was saved.");
      } catch (err) { say(err.message, true); }
      $("driveNow").disabled = false;
    };

    $("exportLocal").onclick = () => send("backupExportLocal").catch((err) => alert(err.message));
    $("importLocal").onclick = () => $("importFile").click();
    $("importFile").onchange = async () => {
      const file = $("importFile").files[0];
      $("importFile").value = "";
      if (!file) return;
      try {
        const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
        const text = head[0] === 0x1f && head[1] === 0x8b
          ? await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text()
          : await file.text();
        const snapshot = JSON.parse(text);
        if (snapshot?.app !== "Tab Toolkit") throw new Error("That isn't a Tab Toolkit backup");
        const from = snapshot.createdAt ? ` from ${when(snapshot.createdAt)}` : "";
        if (!confirm(`Replace Tab Toolkit's settings and data with the ones in ${file.name}${from}?`)) return;
        await send("backupImportLocal", { snapshot });
        alert("Settings imported.");
        location.reload();
      } catch (err) {
        alert(err instanceof SyntaxError ? "That file couldn't be read as a backup." : err.message);
      }
    };

    render();
    chrome.storage.onChanged.addListener((c, area) => area === "local" && (c.backup || c.backupState) && render());
  }
  // ---- Tools layout: drag sections between the popup's tabs ----

  // The popup's tab icons, so the columns read like the tabs.
  const TAB_ICONS = Object.fromEntries(Object.entries({
    tools: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-5h4v5h5V9.5"/>',
    page: '<path d="M20 11V6.5A1.5 1.5 0 0 0 18.5 5h-13A1.5 1.5 0 0 0 4 6.5v11A1.5 1.5 0 0 0 5.5 19H11"/><path d="M4 9h16"/><path d="m14 13 7 2.5-3 1.2-1.2 3z"/>',
    extra: '<path d="M13.5 3 5 13.5h6L10.5 21 19 10.5h-6z"/>',
  }).map(([k, d]) => [k, `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`]));

  let dragging = null;
  function renderLayout() {
    if (dragging) return;
    const layout = TT.layoutOf(settings.layout);
    $("layoutBoard").replaceChildren(...Object.entries(TT.PANELS).map(([panel, name]) => {
      const col = document.createElement("div");
      col.className = "col";
      col.innerHTML = `<h3>${TAB_ICONS[panel]}<span></span></h3><div class="cards"></div>`;
      col.querySelector("h3 span").textContent = name;
      const cards = col.querySelector(".cards");
      cards.dataset.panel = panel;
      for (const id of layout[panel]) {
        const card = document.createElement("div");
        card.className = "card";
        card.draggable = true;
        card.dataset.id = id;
        card.textContent = TT.SECTIONS[id];
        cards.append(card);
      }
      return col;
    }));
  }

  function initLayout() {
    const board = $("layoutBoard");
    renderLayout();
    board.addEventListener("dragstart", (e) => {
      const card = e.target.closest?.(".card");
      if (!card) return;
      dragging = card;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.id);
      requestAnimationFrame(() => card.classList.add("dragging"));
    });
    // The card moves as you drag: before the first card whose middle is below the pointer.
    board.addEventListener("dragover", (e) => {
      const cards = e.target.closest?.(".col")?.querySelector(".cards");
      if (!dragging || !cards) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const after = [...cards.querySelectorAll(".card:not(.dragging)")].find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (after) { if (after.previousElementSibling !== dragging) cards.insertBefore(dragging, after); }
      else if (cards.lastElementChild !== dragging) cards.append(dragging);
    });
    board.addEventListener("drop", (e) => e.preventDefault());
    board.addEventListener("dragend", () => {
      if (!dragging) return;
      dragging.classList.remove("dragging");
      dragging = null;
      const layout = {};
      for (const cards of board.querySelectorAll(".cards")) layout[cards.dataset.panel] = [...cards.children].map((c) => c.dataset.id);
      if (JSON.stringify(layout) !== JSON.stringify(TT.layoutOf(settings.layout))) setPath("layout", layout);
    });
    $("layoutReset").onclick = () => setPath("layout", structuredClone(TT.DEFAULTS.layout), true);
  }
  // ---- Highlight words: global list, excluded sites, per-site lists ----

  function initHighlight() {
    const L = TT.HL_LIMITS;
    let hl = TT.hlOf();
    let importInto = null; // "global" or a site, for the file picker
    const notes = {}; // last add/import result per list, shown under it

    const siteName = (raw) => {
      let v = String(raw || "").trim().toLowerCase();
      try { if (/^[a-z]+:\/\//.test(v)) v = new URL(v).hostname; } catch {}
      v = v.replace(/^www\./, "").replace(/[/?#].*$/, "");
      return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : "";
    };

    async function edit(fn) {
      const next = TT.hlOf((await chrome.storage.local.get("hl")).hl);
      fn(next);
      await chrome.storage.local.set({ hl: next });
    }

    // Adds words to a list: trimmed, one space between words, no duplicates (any case), within limits.
    function addWords(list, incoming, max) {
      const have = new Set(list.words.map((w) => w.toLowerCase()));
      let added = 0, dup = 0, long = 0, over = 0;
      for (const raw of incoming) {
        const w = String(raw).replace(/\s+/g, " ").trim();
        if (!w) continue;
        if (w.length > L.length) { long++; continue; }
        if (have.has(w.toLowerCase())) { dup++; continue; }
        if (list.words.length >= max) { over++; continue; }
        list.words.push(w);
        have.add(w.toLowerCase());
        added++;
      }
      return [`added ${added}`, dup && `${dup} already there`, long && `${long} too long`, over && `${over} over the limit of ${max}`].filter(Boolean).join(" · ");
    }

    // First column of each CSV row; quoted fields and a "word" header are fine.
    function parseCsv(text) {
      const rows = [];
      let cell = "", row = [], q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
          if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
          else if (c === '"') q = false;
          else cell += c;
        } else if (c === '"') q = true;
        else if (c === ",") { row.push(cell); cell = ""; }
        else if (c === "\n" || c === "\r") {
          if (c === "\r" && text[i + 1] === "\n") i++;
          row.push(cell); rows.push(row); row = []; cell = "";
        } else cell += c;
      }
      row.push(cell); rows.push(row);
      const words = rows.map((r) => r[0].trim()).filter(Boolean);
      if (/^words?$/i.test(words[0] || "")) words.shift();
      return words;
    }

    function exportCsv(name, words) {
      const cell = (w) => (/[",\n\r]/.test(w) ? `"${w.replace(/"/g, '""')}"` : w);
      const blob = new Blob([["word", ...words.map(cell)].join("\n") + "\n"], { type: "text/csv" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `highlight-${name}.csv` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function colorPicker(value, onPick) {
      const box = document.createElement("span");
      box.className = "hl-colors";
      for (const c of TT.HL_COLORS) {
        const sw = Object.assign(document.createElement("button"), { type: "button", className: `sw${c.toLowerCase() === value.toLowerCase() ? " on" : ""}`, title: c });
        sw.style.background = c;
        sw.onclick = () => onPick(c);
        box.append(sw);
      }
      const pick = Object.assign(document.createElement("input"), { type: "color", value, title: "Any colour" });
      pick.onchange = () => onPick(pick.value);
      const hex = Object.assign(document.createElement("input"), { type: "text", className: "text hex", value, maxLength: 7, spellcheck: false, title: "Hex code" });
      hex.onchange = () => {
        const v = hex.value.trim().replace(/^#?/, "#");
        if (/^#[0-9a-f]{6}$/i.test(v)) onPick(v.toLowerCase());
        else hex.value = value;
      };
      box.append(pick, hex);
      return box;
    }

    function pills(words, onRemove) {
      const box = document.createElement("div");
      box.className = "hl-pills";
      box.append(...words.map((w) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        const text = Object.assign(document.createElement("span"), { className: "chip-text", textContent: w, title: w });
        text.style.paddingLeft = "10px";
        const x = Object.assign(document.createElement("button"), { type: "button", className: "chip-x", textContent: "×" });
        x.setAttribute("aria-label", `Remove ${w}`);
        x.onclick = () => onRemove(w);
        chip.append(text, x);
        return chip;
      }));
      return box;
    }

    // One list (global or a site): name, on/off, colour, count, CSV, words, add box.
    function listCard(key, list) {
      const isGlobal = key === "global";
      const max = isGlobal ? L.global : L.site;
      const at = (h) => (isGlobal ? h.global : h.sites[key]);
      const card = document.createElement("div");
      card.className = `hl-list${list.on ? "" : " off"}`;
      const head = document.createElement("div");
      head.className = "hl-head";
      const title = isGlobal ? Object.assign(document.createElement("h2"), { textContent: "Global list" }) : Object.assign(document.createElement("b"), { textContent: key });
      if (isGlobal) title.style.margin = "0";
      const on = document.createElement("label");
      on.className = "toggle";
      on.innerHTML = `<input type="checkbox" role="switch"><span></span>`;
      on.querySelector("input").checked = list.on;
      on.querySelector("span").textContent = list.on ? "on" : "off";
      on.querySelector("input").onchange = (e) => edit((h) => { if (at(h)) at(h).on = e.target.checked; });
      const count = Object.assign(document.createElement("span"), { className: "hint", textContent: `${list.words.length} / ${max}` });
      const grow = Object.assign(document.createElement("span"), { className: "grow" });
      const btn = (label, fn, title = "") => Object.assign(document.createElement("button"), { type: "button", className: "btn ghost", textContent: label, title, onclick: fn });
      head.append(title, on, count, grow,
        btn("import CSV", () => { importInto = key; $("hlImportFile").click(); }, "Add words from a .csv file (first column)"),
        btn("export CSV", () => exportCsv(isGlobal ? "global" : key, list.words)),
        btn("clear", () => list.words.length && confirm(`Remove all ${list.words.length} words from ${isGlobal ? "the global list" : key}?`) && edit((h) => { if (at(h)) at(h).words = []; })));
      if (!isGlobal) head.append(btn("delete site", () => confirm(`Delete the list for ${key}?`) && edit((h) => delete h.sites[key])));
      const add = document.createElement("div");
      add.className = "add-row";
      add.innerHTML = `<input type="text" class="text" spellcheck="false" placeholder="add words or phrases, separated by commas"><button type="button" class="btn">add</button>`;
      const input = add.querySelector("input");
      const go = () => {
        const words = input.value.split(/[,\n]/);
        if (!input.value.trim()) return;
        edit((h) => { if (at(h)) notes[key] = addWords(at(h), words, max); });
        input.value = "";
      };
      add.querySelector("button").onclick = go;
      input.onkeydown = (e) => { if (e.key === "Enter") go(); };
      const note = Object.assign(document.createElement("div"), { className: "hl-note", textContent: notes[key] || "" });
      const colors = document.createElement("div");
      colors.className = "hl-head";
      const partial = document.createElement("label");
      partial.className = "hl-partial";
      partial.title = "Also mark the words inside longer words: \"cat\" in \"category\"";
      partial.innerHTML = `<input type="checkbox"> partial matches`;
      partial.querySelector("input").checked = list.partial;
      partial.querySelector("input").onchange = (e) => edit((h) => { if (at(h)) at(h).partial = e.target.checked; });
      colors.append(Object.assign(document.createElement("span"), { className: "hint", textContent: "colour" }), colorPicker(list.color, (c) => edit((h) => { if (at(h)) at(h).color = c; })),
        Object.assign(document.createElement("span"), { className: "grow" }), partial);
      card.append(head, colors, pills(list.words, (w) => edit((h) => { if (at(h)) at(h).words = at(h).words.filter((x) => x !== w); })), add, note);
      return card;
    }

    function render() {
      $("hlEnabled").checked = hl.enabled;
      $("hlEnabled").nextElementSibling.textContent = hl.enabled ? "on" : "off";
      $("hlGlobal").replaceChildren(listCard("global", hl.global));
      $("hlExcludePills").replaceWith(Object.assign(pills(hl.exclude, (s) => edit((h) => (h.exclude = h.exclude.filter((x) => x !== s)))), { id: "hlExcludePills", className: "rm-pills wrap" }));
      const sites = Object.keys(hl.sites).sort();
      $("hlSitesCount").textContent = `${sites.length} / ${L.sites}`;
      $("hlSites").replaceChildren(...sites.map((site) => listCard(site, hl.sites[site])));
    }

    async function load() {
      hl = TT.hlOf((await chrome.storage.local.get("hl")).hl);
      render();
    }

    // An example to fill in: header, single words, a phrase, one with a comma (quoted), symbols.
    $("hlSample").onclick = () => {
      const sample = ["word", "apple", "machine learning", "\"red, ripe apple\"", "C++", "node.js"].join("\n") + "\n";
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([sample], { type: "text/csv" })), download: "highlight-sample.csv" });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $("hlEnabled").onchange = (e) => edit((h) => (h.enabled = e.target.checked));
    const addExclude = () => {
      const site = siteName($("hlExcludeAdd").value);
      if (!site) return void ($("hlExcludeAdd").value && alert("That doesn't look like a site, e.g. example.com"));
      $("hlExcludeAdd").value = "";
      edit((h) => (h.exclude = [...new Set([...h.exclude, site])].sort()));
    };
    $("hlExcludeBtn").onclick = addExclude;
    $("hlExcludeAdd").onkeydown = (e) => { if (e.key === "Enter") addExclude(); };
    const addSite = () => {
      const site = siteName($("hlSiteAdd").value);
      if (!site) return void ($("hlSiteAdd").value && alert("That doesn't look like a site, e.g. example.com"));
      $("hlSiteAdd").value = "";
      edit((h) => {
        if (h.sites[site]) return;
        if (Object.keys(h.sites).length >= L.sites) return alert(`Up to ${L.sites} sites can have their own list.`);
        h.sites[site] = { on: true, color: TT.HL_COLORS[(Object.keys(h.sites).length + 2) % TT.HL_COLORS.length], words: [] };
      });
    };
    $("hlSiteBtn").onclick = addSite;
    $("hlSiteAdd").onkeydown = (e) => { if (e.key === "Enter") addSite(); };
    $("hlImportFile").onchange = async () => {
      const file = $("hlImportFile").files[0];
      $("hlImportFile").value = "";
      if (!file || !importInto) return;
      const key = importInto;
      const words = parseCsv(await file.text());
      edit((h) => {
        const list = key === "global" ? h.global : h.sites[key];
        if (list) notes[key] = `${file.name}: ${addWords(list, words, key === "global" ? L.global : L.site)}`;
      });
    };

    load();
    chrome.storage.onChanged.addListener((c, area) => area === "local" && c.hl && load());
  }
})();
