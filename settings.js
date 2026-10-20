// Settings window: left-nav sections and every setting except blur (settings-blur.js).
// Inputs with data-path="a.b" are bound to that path in the "tt" settings object.
(() => {
  const $ = (id) => document.getElementById(id);

  // A question with plainly worded buttons (a browser confirm() only has OK / Cancel).
  // Resolves true for the first button; Esc or the second button is false.
  function ask(title, text, yes, no) {
    return new Promise((resolve) => {
      const d = document.createElement("dialog");
      d.className = "ask";
      d.innerHTML = `<h3></h3><p></p><div class="ask-btns"><button type="button" class="btn ghost no"></button><button type="button" class="btn blue yes"></button></div>`;
      d.querySelector("h3").textContent = title;
      d.querySelector("p").textContent = text;
      d.querySelector(".yes").textContent = yes;
      d.querySelector(".no").textContent = no;
      const done = (v) => { d.close(); d.remove(); resolve(v); };
      d.querySelector(".yes").onclick = () => done(true);
      d.querySelector(".no").onclick = () => done(false);
      d.addEventListener("cancel", (e) => { e.preventDefault(); done(false); });
      document.body.append(d);
      d.showModal();
      d.querySelector(".yes").focus();
    });
  }
  let settings;
  let saveTimer = 0;

  TT.applyTheme();
  // Left open for a while, Chrome's memory saver would unload the settings window, and it can come
  // back as a new tab page instead of these settings: this one stays loaded.
  chrome.tabs.getCurrent((tab) => tab && chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {}));
  init();

  async function init() {
    settings = await TT.getSettings();
    buildServices();
    bindPaths();
    initRedirect();
    initUpload();
    initRemoved();
    initDarkLists();
    initUnlock();
    initNewTab();
    initFocus();
    initOcr();
    initProxy();
    initBackup();
    initLayout();
    initHighlight();
    initClipboard();
    showPane();
    // Userscripts have a page of their own, in one tab.
    $("usPageLink").onclick = (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: "usOpen" }).catch(() => {}); };
    // So do the QR page and the scratch pads (each brought to the front if it's open), and image
    // annotate (the screenshot editor with no image yet, in a new tab).
    $("qrPageLink").onclick = (e) => { e.preventDefault(); openPageTab("qr.html").catch(() => {}); };
    $("scratchPageLink").onclick = (e) => { e.preventDefault(); openPageTab("scratch.html").catch(() => {}); };
    $("annotatePageLink").onclick = (e) => { e.preventDefault(); openPageTab("shot-view.html#annotate", true).catch(() => {}); };
    addEventListener("hashchange", showPane);
    // Footer: buttons rather than links, so hovering doesn't show the address bubble.
    document.querySelectorAll(".site-foot [data-open]").forEach((b) => (b.onclick = () => window.open(b.dataset.open, "_blank", "noopener")));
    $("testSound").onclick = testSound;
    initSound();
    chrome.storage.onChanged.addListener((c, area) => {
      // Changed elsewhere (the popup, another window): taken in, keeping this window's own
      // edits that aren't saved yet.
      if (area === "local" && c.tt) {
        const mine = [...dirty].map((path) => [path, structuredClone(getPath(path))]);
        settings = TT.merge(TT.DEFAULTS, c.tt.newValue);
        for (const [path, value] of mine) setIn(settings, path, value);
        if (!saveTimer) fill();
      }
      if (area === "local" && (c.shortCounts || c.shortUsage)) fillCounts();
      // A link made with your x.gd key says whether x.gd took it.
      if (area === "local" && c.shortKeyState) {
        delete keyChecked.xgd;
        const xgd = document.querySelector('.service[data-service="xgd"]');
        if (xgd) checkShortKey(xgd);
      }
    });
  }

  // One of the extension's pages in a browser window (not this settings window): the tab already
  // showing it is brought to the front, unless fresh asks for a new one every time.
  async function openPageTab(path, fresh = false) {
    const base = chrome.runtime.getURL(path.split("#")[0]);
    const tab = fresh ? null : (await chrome.tabs.query({})).find((t) => (t.url || t.pendingUrl || "").startsWith(base));
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      return void (await chrome.windows.update(tab.windowId, { focused: true }));
    }
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    await chrome.tabs.create({ url: chrome.runtime.getURL(path), ...(win ? { windowId: win.id } : {}) });
    if (win) await chrome.windows.update(win.id, { focused: true });
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
    save(path);
    if (refill) fill();
  }

  // Saves only what was changed here (by path), applied onto the settings as they're stored
  // by then, so a change made elsewhere meanwhile (the popup, another window) isn't lost.
  const dirty = new Set();
  function setIn(obj, path, value) {
    const keys = path.split(".");
    let o = obj;
    for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === "object" ? o[k] : (o[k] = {});
    o[keys.at(-1)] = value;
  }
  function save(path) {
    if (path) dirty.add(path);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      // Only the changed paths, as a patch for the one writer (see TT.updateSettings).
      const patch = {};
      for (const path of dirty) setIn(patch, path, structuredClone(getPath(path)));
      dirty.clear();
      try { await TT.updateSettings(patch); } catch (err) { console.error("settings not saved", err); }
      saveTimer = 0;
    }, 250);
  }

  function bindPaths() {
    for (const el of document.querySelectorAll("[data-path]")) {
      el.addEventListener(["text", "url", "password"].includes(el.type) ? "input" : "change", () => {
        const value = el.type === "checkbox" ? el.checked
          : el.type === "range" || el.type === "number" || el.dataset.number !== undefined ? +el.value
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
      else if (el.type === "radio") el.checked = el.value === String(v);
      else if (document.activeElement !== el) el.value = v ?? "";
    }
    fillServices();
    renderRules();
    fillUpload();
    renderLayout();
    renderClipExclude();
    fillSound();
    update();
  }

  function update() {
    for (const out of document.querySelectorAll("output[data-for]")) out.textContent = $(out.dataset.for).value;
    $("qualityRow").hidden = settings.shot.format !== "jpeg";
    $("ocrEndpointRow").hidden = settings.ocr.plan !== "pro";
  }

  // ---- Alert sound ----

  // Built-in chime, a link of your own, or none. The link typed in is kept while another
  // choice is picked, so switching back to "sound file link" brings it back.
  const soundKind = (v) => (v === "chime" ? "chime" : v ? "link" : "none");
  let soundLinkDraft = "", linkPicked = false; // picked with the box still empty
  function fillSound() {
    const v = settings.refresh.sound;
    const kind = linkPicked && !v ? "link" : soundKind(v);
    if (kind === "link") soundLinkDraft = v;
    for (const r of document.querySelectorAll('[name="soundKind"]')) r.checked = r.value === kind;
    $("soundLinkRow").hidden = kind !== "link";
    if (document.activeElement !== $("soundLink")) $("soundLink").value = soundLinkDraft;
  }
  function initSound() {
    for (const r of document.querySelectorAll('[name="soundKind"]')) {
      r.onchange = () => {
        $("soundError").textContent = "";
        linkPicked = r.value === "link";
        setPath("refresh.sound", r.value === "chime" ? "chime" : r.value === "none" ? "" : soundLinkDraft.trim(), true);
        $("soundLinkRow").hidden = r.value !== "link";
        if (r.value === "link") $("soundLink").focus();
      };
    }
    $("soundLink").oninput = () => {
      soundLinkDraft = $("soundLink").value;
      setPath("refresh.sound", soundLinkDraft.trim());
    };
  }

  async function testSound() {
    const err = $("soundError");
    err.textContent = "";
    const url = settings.refresh.sound;
    if (!url) return (err.textContent = $("soundLinkRow").hidden ? "No sound set." : "Paste a link to a sound file first.");
    try {
      if (url === "chime") return await playChime();
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
      save("redirect.rules");
      renderRules();
      $("ruleRows").querySelector(".rule:last-child input[data-k=domain]").focus();
    };
    $("tryUrl").addEventListener("input", tryUrl);
  }

  function renderRules(force = false) {
    const box = $("ruleRows");
    if (!force && box.contains(document.activeElement)) return; // don't rebuild under the cursor
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
          // The rule as it is now (the settings may have been reloaded since this row was drawn).
          const rule = rules()[i];
          if (!rule) return;
          rule[k] = input.type === "checkbox" ? input.checked : input.value.trim();
          row.classList.toggle("off", rule.on === false);
          showRuleError(row, rule);
          save("redirect.rules");
          tryUrl();
        });
      }
      row.classList.toggle("off", rule.on === false);
      row.querySelector(".del").onclick = () => {
        rules().splice(i, 1);
        save("redirect.rules");
        renderRules(true); // (the × itself has the focus, inside the list)
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
    $("imglinkKey").addEventListener("input", () => {
      $("imglinkState").textContent = $("imglinkKey").value.trim() === settings.upload.imglinkKey ? imglinkStateText() : "key not saved · save to check it";
      $("imglinkState").className = "hint";
      $("imglinkKey").classList.toggle("key-bad", $("imglinkKey").value.trim() === settings.upload.imglinkKey && imglinkBad());
    });
    $("imglinkSave").onclick = async () => {
      const btn = $("imglinkSave");
      btn.disabled = true;
      $("imglinkState").textContent = $("imglinkKey").value.trim() ? "checking…" : "";
      const res = await chrome.runtime.sendMessage({ type: "verifyImglink", key: $("imglinkKey").value });
      btn.disabled = false;
      settings = await TT.getSettings();
      fill();
      if (res?.ok && !res.verified && res.error) {
        $("imglinkState").textContent = uploadKeyError(res.error, "uploads are anonymous");
        $("imglinkState").className = "hint x02-bad";
      }
    };
    $("x02Key").addEventListener("input", () => {
      $("x02State").textContent = $("x02Key").value.trim() === settings.upload.x02Key ? x02StateText() : "key not saved · save to check it";
      $("x02State").className = "hint";
      $("x02Key").classList.toggle("key-bad", $("x02Key").value.trim() === settings.upload.x02Key && x02Bad());
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
        $("x02State").textContent = uploadKeyError(res.error, "X02 can't be used until it's fixed");
        $("x02State").className = "hint x02-bad";
      }
    };
  }

  const imglinkStateText = () => (settings.upload.imglinkVerified ? "✓ key accepted · uploads go to your account"
    : settings.upload.imglinkKey ? "✕ key not accepted · uploads are anonymous" : "no key · uploads are anonymous");
  // A saved key the host didn't accept: the field turns red.
  const imglinkBad = () => !!settings.upload.imglinkKey && !settings.upload.imglinkVerified;
  const x02Bad = () => !!settings.upload.x02Key && !settings.upload.x02Verified;
  const x02StateText = () => (settings.upload.x02Verified ? "✓ key accepted · uploads go to your account"
    : settings.upload.x02Key ? "✕ key not accepted · X02 can't be used until it's fixed" : "no key · X02 needs one to upload");
  // Just after saving: why the key didn't verify, said the way the other key fields say it.
  const uploadKeyError = (error, meaning) => (/^Couldn't reach/.test(error || "") ? `couldn't check the key · ${error}`
    : error === "Enter an API key" ? x02StateText() : `✕ key not accepted · ${meaning}`);

  function fillUpload() {
    if (document.activeElement !== $("imglinkKey")) $("imglinkKey").value = settings.upload.imglinkKey || "";
    $("imglinkState").textContent = imglinkStateText();
    $("imglinkState").className = `hint ${settings.upload.imglinkVerified ? "x02-ok" : imglinkBad() ? "x02-bad" : ""}`;
    if (document.activeElement !== $("imglinkKey") || $("imglinkKey").value.trim() === settings.upload.imglinkKey) $("imglinkKey").classList.toggle("key-bad", imglinkBad());
    if (document.activeElement !== $("x02Key")) $("x02Key").value = settings.upload.x02Key || "";
    $("x02State").textContent = x02StateText();
    $("x02State").className = `hint ${settings.upload.x02Verified ? "x02-ok" : x02Bad() ? "x02-bad" : ""}`;
    if (document.activeElement !== $("x02Key") || $("x02Key").value.trim() === settings.upload.x02Key) $("x02Key").classList.toggle("key-bad", x02Bad());
    $("x02UseRow").querySelector("input").disabled = !settings.upload.x02Verified;
    if (settings.upload.x02Verified && settings.upload.x02Key !== usageFor.x02) loadX02Usage();
    if (!settings.upload.x02Verified) { usageFor.x02 = null; $("x02Usage").hidden = true; }
    if (settings.upload.imglinkVerified && settings.upload.imglinkKey !== usageFor.imglink) loadImglinkUsage();
    if (!settings.upload.imglinkVerified) { usageFor.imglink = null; $("imglinkUsage").hidden = true; }
  }

  // x02 storage and daily uploads, fetched when settings open (and after a key is
  // verified). Sizes are shown the way x02 shows them: MB, or GB from 1 GB up.
  // Account usage for x02 and ImgLink, fetched when settings open (and after a key is
  // verified). Sizes are shown the way x02 shows them: MB, or GB from 1 GB up.
  const usageFor = { x02: null, imglink: null };
  const hostSize = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(2)} MB`);
  const pct = (u, l) => { const p = (u / l) * 100; return p > 0 && p < 0.1 ? "<0.1" : p.toFixed(1); };
  const inTime = (sec) => (sec >= 3600 ? `${Math.round(sec / 3600)} h` : `${Math.max(1, Math.round(sec / 60))} min`);
  // A meter: hidden when the host doesn't report it; limit null = unlimited (no bar).
  function meter(id, used, limit, text) {
    const el = $(id);
    el.hidden = used == null || limit === 0 || limit === undefined;
    if (el.hidden) return;
    el.querySelector("b").textContent = text;
    el.querySelector(".bar i").style.width = limit ? `${Math.min(100, (used / limit) * 100)}%` : "0";
  }
  async function loadX02Usage() {
    const key = (usageFor.x02 = settings.upload.x02Key);
    const res = await chrome.runtime.sendMessage({ type: "x02Usage" }).catch(() => null);
    if (!res?.ok || key !== settings.upload.x02Key) return void ($("x02Usage").hidden = true);
    meter("x02Storage", res.storageUsed, res.storageLimit,
      `${hostSize(res.storageUsed)} / ${hostSize(res.storageLimit)} (${pct(res.storageUsed, res.storageLimit)}%)`);
    meter("x02Daily", res.today, res.dailyLimit, `${res.today} / ${res.dailyLimit}`);
    const reset = res.resetsAt && new Date(res.resetsAt);
    const sec = reset && (reset - Date.now()) / 1000;
    $("x02UsageNote").textContent = [res.plan ? `${res.plan} plan` : "", sec > 0 ? `daily uploads reset in ${inTime(sec)}` : ""].filter(Boolean).join(" · ");
    $("x02Usage").hidden = $("x02Storage").hidden && $("x02Daily").hidden;
  }
  async function loadImglinkUsage() {
    const key = (usageFor.imglink = settings.upload.imglinkKey);
    const res = await chrome.runtime.sendMessage({ type: "imglinkUsage" }).catch(() => null);
    if (!res?.ok || key !== settings.upload.imglinkKey) return void ($("imglinkUsage").hidden = true);
    meter("imglinkStorage", res.storageUsed, res.storageLimit,
      res.storageLimit == null ? `${hostSize(res.storageUsed)} / unlimited`
        : `${hostSize(res.storageUsed)} / ${hostSize(res.storageLimit)} (${pct(res.storageUsed, res.storageLimit)}%)`);
    meter("imglinkHourly", res.used, res.limit, res.limit == null ? `${res.used} / unlimited` : `${res.used} / ${res.limit}`);
    $("imglinkUsageNote").textContent = [
      res.tier === "unverified" ? "unverified account · verify your email for 10 GB" : res.tier ? `${res.tier} account` : "",
      res.resetSeconds > 0 && res.used > 0 ? `hourly uploads reset in ${inTime(res.resetSeconds)}` : "",
    ].filter(Boolean).join(" · ");
    $("imglinkUsage").hidden = $("imglinkStorage").hidden && $("imglinkHourly").hidden;
  }

  // ---- URL shortener services ----

  // spoo.me's key form ticks only shorten:create; dynamic QR codes need more to be changed.
  const SPOO_KEY_TIP = "Making the key: tick admin:all (full access). spoo.me ticks only shorten:create by default, which makes dynamic QR codes but can't change where they go later.";
  // What each one does with and without a key.
  const SERVICE_ABOUT = {
    spoo: "Works without a key: links are anonymous, up to 200 a day, and their short link analytics are accessible to anyone with the link. With your key (spoo.me dashboard → developer) links are yours, up to 5,000 a day, only you can see their analytics, and it can make dynamic QR codes.",
    xgd: "Works without a key, with Extra Guac's own, and short link analytics stay off. Your key (sent to your email from x.gd's developer page) is used instead when added, and lets you turn analytics on below.",
    dub: "Needs your key (all permissions, the default). 25 new links a month on the free plan; also makes dynamic QR codes. Its count shows in the popup on the free plan; on a paid plan (ticked below, or a limit above 25 from dub.sh) only here.",
  };
  function buildServices() {
    const box = $("shortenerServices");
    const tpl = $("serviceTpl");
    for (const [id, info] of Object.entries(TT.SHORTENERS)) {
      const node = tpl.content.cloneNode(true);
      const section = node.querySelector(".service");
      section.dataset.service = id;
      section.querySelector(".name").textContent = info.label;
      const key = section.querySelector(".key");
      key.placeholder = `${info.label} API key${info.keyOptional ? " (optional)" : ""}`;
      section.querySelector(".about").textContent = SERVICE_ABOUT[id] || "";
      if (id === "spoo") Object.assign(section.querySelector(".key-tip"), { hidden: false, textContent: SPOO_KEY_TIP });
      if (id === "dub") {
        section.querySelector(".paid-row").hidden = false;
        const paid = section.querySelector(".paid");
        paid.addEventListener("change", () => { setPath("shortener.paid.dub", paid.checked); fillCounts(); });
      }
      if (id === "xgd") {
        const box = section.querySelector(".analytics");
        box.addEventListener("change", () => setPath("shortener.analytics.xgd", box.checked));
      }
      key.addEventListener("input", () => {
        setPath(`shortener.keys.${id}`, key.value.trim());
        if (id === "xgd") section.querySelector(".analytics-row").hidden = !key.value.trim();
        clearTimeout(keyTimers[id]);
        keyTimers[id] = setTimeout(() => checkShortKey(section), 700);
      });
      section.querySelector(".reveal").onclick = (e) => {
        key.type = key.type === "password" ? "text" : "password";
        e.target.textContent = key.type === "password" ? "show" : "hide";
      };
      const keyLink = section.querySelector(".keylink");
      keyLink.href = info.keyHelp;
      keyLink.textContent = new URL(info.keyHelp).host + new URL(info.keyHelp).pathname;
      box.append(node);
    }
  }

  // Each key is checked with its service as it's pasted or typed, and once when settings open:
  // a key that isn't accepted turns the field red and says what happens instead.
  // Every key field in settings says where its key stands the same way: "✓ key accepted",
  // "✕ key not accepted", "no key", "key not saved", "couldn't check the key" or "checking…",
  // then " · " and what that means for the feature (KEY_SAYS).
  const keyTimers = {};
  const keyChecked = {}; // service → { key, res }: the key last checked and its answer
  const SHORT_NONE = { xgd: "Extra Guac's own key is used", spoo: "links are anonymous", dub: "dub.sh needs one to make links" };
  const SHORT_BAD = { xgd: "no links are made until it's fixed or removed", spoo: "links are anonymous, not in your account", dub: "no links are made until it's fixed" };
  function showKeyState(section, res) {
    const id = section.dataset.service;
    const text = !res ? "checking…"
      : { none: `no key · ${SHORT_NONE[id]}`, ok: "✓ key accepted · links go to your account",
          limited: `✓ key accepted · links go to your account${id === "spoo" ? ", but dynamic QR codes can't be changed later (the key can only make links)" : ""}`,
          bad: `✕ key not accepted · ${SHORT_BAD[id]}`,
          unchecked: "key not checked yet · it's checked when the first link is made with it",
          unknown: `couldn't check the key · ${res.error || "try again later"}` }[res.state] || "";
    const state = section.querySelector(".key-state");
    state.textContent = text;
    state.className = `hint key-state ${res?.state === "bad" ? "x02-bad" : res?.state === "ok" || res?.state === "limited" ? "x02-ok" : ""}`;
    section.querySelector(".key").classList.toggle("key-bad", res?.state === "bad");
  }
  async function checkShortKey(section) {
    const id = section.dataset.service;
    const key = section.querySelector(".key").value.trim();
    if (keyChecked[id]?.key === key && keyChecked[id].res?.state !== "unknown") return showKeyState(section, keyChecked[id].res);
    keyChecked[id] = { key, res: null };
    showKeyState(section, null);
    const res = await chrome.runtime.sendMessage({ type: "checkShortKey", service: id, key }).catch((err) => ({ state: "unknown", error: err.message }));
    if (keyChecked[id]?.key !== key) return; // typed on meanwhile
    keyChecked[id].res = res?.state ? res : { state: "unknown", error: res?.error };
    showKeyState(section, keyChecked[id].res);
  }

  function fillServices() {
    for (const section of document.querySelectorAll(".service")) {
      const id = section.dataset.service;
      const key = section.querySelector(".key");
      if (document.activeElement !== key) key.value = settings.shortener.keys[id] || "";
      if (document.activeElement !== key && keyChecked[id]?.key !== key.value.trim()) checkShortKey(section);
      if (id === "dub") section.querySelector(".paid").checked = !!settings.shortener.paid?.dub;
      // x.gd's analytics switch: only with a key of your own (Extra Guac's always has them off).
      if (id === "xgd") {
        section.querySelector(".analytics-row").hidden = !(settings.shortener.keys.xgd || "").trim();
        section.querySelector(".analytics").checked = !!settings.shortener.analytics?.xgd;
      }
    }
    fillCounts();
    // The services' own numbers, where they give them (at most once a minute).
    chrome.runtime.sendMessage({ type: "shortUsage", services: ["dub"] }).catch(() => {});
  }

  // Each service's links: the service's own numbers when it gives them,
  // else the links made from this browser this month.
  async function fillCounts() {
    const { shortCounts = {}, shortUsage = {} } = await chrome.storage.local.get(["shortCounts", "shortUsage"]);
    for (const section of document.querySelectorAll(".service")) {
      const id = section.dataset.service;
      const q = TT.shortQuota(id, settings, shortCounts, shortUsage);
      const links = q.limit == null ? `${q.used} links` : `${q.used}/${q.limit} links`;
      const box = section.querySelector(".count");
      box.textContent = !q.live
        ? `${links} this month · counted in this browser${q.denied ? " (the key can't read the account's usage)" : ""}`
        : id === "dub"
          ? `${links}${q.resets ? ` · resets ${TT.shortDay(q.resets)}` : ""} · from dub.sh`
          : `${links} this month · from ${TT.SHORTENERS[id].label}`;
      box.title = q.live ? "" : "Links shortened from Extra Guac in this browser this month";
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
          chip.title = `${r.selector}\nremoved ${TT.when(r.at)}${on ? "" : "\n(off: shown on the page)"}`;
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

  // ---- Dark mode: which sites, in one card ----
  // "Dark on" picks the mode; under it, the list that mode uses (the sites to darken, or the
  // ones to leave as they are; the other mode's list is kept for when it's picked again); then
  // the sites whose own dark pages are inverted too.

  function initDarkLists() {
    const clean = (v) => {
      let h = v.trim().toLowerCase();
      try { if (h.includes("://")) h = new URL(h).hostname; } catch {}
      return h.split("/")[0].split(":")[0].replace(/^(\*\.|www\.)/, "");
    };
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    let refocus = ""; // the add box that was being typed in, focused again after the redraw
    async function change(key, fn) {
      const { dark } = await TT.getSettings();
      await TT.updateSettings({ dark: { [key]: fn(dark[key]) } });
    }
    // A list's sites as chips, with the add box at the foot of the same box.
    function siteBox(key, sites, placeholder, label) {
      const input = el("input", { type: "text", spellcheck: false, placeholder });
      input.setAttribute("aria-label", label);
      input.dataset.focus = key;
      const add = () => {
        const list = input.value.split(/[,\s]+/).map(clean).filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s));
        if (!list.length) return void (input.value.trim() && alert("That doesn't look like a site, e.g. example.com"));
        refocus = key;
        change(key, (l) => [...new Set([...l, ...list])].sort());
      };
      input.onkeydown = (e) => { if (e.key === "Enter") add(); };
      const chips = el("div", { className: "hl-chips" }, ...sites.map((site) => {
        const x = el("button", { type: "button", className: "chip-x", textContent: "×" });
        x.setAttribute("aria-label", `Remove ${site}`);
        x.onclick = () => change(key, (l) => l.filter((s) => s !== site));
        return el("span", { className: "chip dom" }, el("span", { className: "chip-text", textContent: site, title: site }), x);
      }));
      const box = el("div", { className: "hl-words" }, chips, input);
      box.onclick = (e) => { if (e.target === box || e.target === chips) input.focus(); };
      return box;
    }
    const field = (label, ...kids) => el("div", { className: "hl-field" }, el("span", { className: "hl-k", textContent: label }), el("div", { className: "hl-v" }, ...kids));

    async function render() {
      const { dark } = await TT.getSettings();
      const all = dark.mode === "all";
      const mode = (v, text) => {
        const b = el("button", { type: "button", textContent: text });
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(dark.mode === v));
        b.onclick = () => { if (dark.mode !== v) TT.updateSettings({ dark: { mode: v } }); };
        return b;
      };
      const seg = el("span", { className: "hl-seg" }, mode("sites", "the sites I pick"), mode("all", "all sites, except…"));
      seg.setAttribute("role", "radiogroup");
      seg.setAttribute("aria-label", "Dark on");

      const key = all ? "exclude" : "sites";
      const main = field(all ? "Except" : "Sites",
        siteBox(key, dark[key], all ? "add a site to leave as it is, e.g. example.com" : "add a site to darken, e.g. example.com", all ? "Add a site to leave as it is" : "Add a site to darken"));
      const force = field("Darken anyway",
        siteBox("force", dark.force, "add a site, e.g. example.com", "Add a site to darken anyway"),
        el("span", { className: "hint", textContent: "pages that are dark on their own are normally left as they are; on these sites they're inverted too" }));
      $("darkCard").replaceChildren(field("Dark on", seg), main, force);
      if (refocus) { $("darkCard").querySelector(`[data-focus="${refocus}"]`)?.focus(); refocus = ""; }
    }
    render();
    chrome.storage.onChanged.addListener((c, area) => area === "local" && c.tt && render());
  }
  // ---- Text from image: check the key with a tiny test image ----

  // Also checked by itself a moment after a key is pasted or typed; a key OCR.space refuses
  // turns the field red.
  function initOcr() {
    const say = (text, look = "", refused = false) => {
      $("ocrState").textContent = text;
      $("ocrState").className = `hint ${look === "ok" ? "x02-ok" : look}`;
      $("ocrKey").classList.toggle("key-bad", refused);
    };
    let timer = 0, typed = 0;
    $("ocrKey").addEventListener("input", () => {
      clearTimeout(timer);
      typed++;
      if (!$("ocrKey").value.trim()) return say(ocrNoKey());
      timer = setTimeout(check, 900);
    });
    $("ocrCheck").onclick = check;
    const ocrNoKey = () => (settings.ocr.plan === "pro" ? "no key · the PRO plan needs yours" : "no key · Extra Guac's shared keys are used");
    if (!$("ocrKey").value.trim()) say(ocrNoKey());
    async function check() {
      clearTimeout(timer);
      const run = typed;
      const key = $("ocrKey").value.trim();
      if (!key) return say(ocrNoKey(), "bad");
      const c = Object.assign(document.createElement("canvas"), { width: 160, height: 48 });
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, 160, 48);
      g.fillStyle = "#000"; g.font = "bold 28px Arial, sans-serif"; g.fillText("Guac 42", 10, 34);
      say("checking…");
      $("ocrCheck").disabled = true;
      try {
        const res = await chrome.runtime.sendMessage({ type: "ocrTest", key, endpoint: settings.ocr.endpoint, image: c.toDataURL("image/png") });
        if (!res?.ok) throw new Error(res?.error || "Something went wrong");
        if (run !== typed) return;
        // The plan the key turned out to be on is picked below (it can still be changed there).
        const switched = res.plan && res.plan !== settings.ocr.plan;
        if (switched) setPath("ocr.plan", res.plan, true);
        const plan = res.plan ? `${res.plan === "pro" ? "PRO" : "free"} plan${switched ? ", picked below" : ""}` : "text is read with your key";
        say(`✓ key accepted · ${plan}${/guac/i.test(res.text) ? "" : ` (the test read "${res.text || "nothing"}")`}`, "ok");
      } catch (err) {
        const refused = /refused the key/.test(err.message);
        if (run === typed) say(refused ? "✕ key not accepted · text can't be read until it's fixed or removed"
          : `couldn't check the key · ${err.message.replace(/\. Check it in settings.*$/, "")}`, "bad", refused);
      } finally {
        $("ocrCheck").disabled = false;
      }
    }
  }

  // ---- Proxy: the Webshare key, the plan and its data, countries, the site lists ----

  function initProxy() {
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    let cfg = TT.proxyOf(), st = {};
    let ss = []; // sites whose session switch profiles use a proxy (bg-sessions.js): they take some of the plan's sites
    let keyDraft = "", say = { text: "", bad: false }, refocus = "";
    const GB = 1024 ** 3;
    const size = (b) => (b >= GB ? `${+(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB` : `${Math.max(0, Math.round(b / 1024 ** 2))} MB`);
    const day = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const free = () => st.plan?.free !== false;
    const full = () => !free() && cfg.mode === "full";
    const slots = () => TT.proxySlots(cfg, st, ss); // one per site and country, with session switch profiles
    const total = () => slots().max;
    const max = () => slots().own; // how many of the list here can be used
    const out = () => !!(st.plan?.limit && st.used >= st.plan.limit);
    const countries = () => [...new Set((st.proxies || []).map((p) => p.c).filter(Boolean))].sort((a, b) => TT.countryName(a).localeCompare(TT.countryName(b)));
    async function save(fn) {
      const { proxy } = await chrome.storage.local.get("proxy");
      const next = TT.proxyOf(proxy);
      fn(next);
      await chrome.storage.local.set({ proxy: next });
    }
    const send = async (type, payload = {}) => {
      const res = await chrome.runtime.sendMessage({ type, ...payload });
      if (!res?.ok) throw new Error(res?.error || "Something went wrong");
      return res;
    };
    const section = (title, ...kids) => el("section", {}, ...(title ? [el("h2", { textContent: title })] : []), ...kids);
    const sw = (on, label, onchange) => {
      const t = el("label", { className: "toggle sm" });
      const i = el("input", { type: "checkbox", checked: on });
      i.setAttribute("role", "switch");
      i.setAttribute("aria-label", label);
      i.onchange = () => onchange(i.checked);
      t.append(i);
      return t;
    };
    // A country menu: "any country" (when allowed) and the account's countries; a country
    // that's gone from the account stays listed, marked.
    const countryMenu = (value, onchange, { any = "any country", cls = "" } = {}) => {
      const sel = el("select", { className: `px-select ${cls}` });
      const list = countries();
      if (any) sel.append(el("option", { value: "", textContent: any }));
      if (value && !list.includes(value)) sel.append(el("option", { value, textContent: `${TT.countryName(value)} (not in your list now)` }));
      for (const c of list) sel.append(el("option", { value: c, textContent: TT.countryName(c) }));
      sel.value = value || "";
      sel.onchange = () => onchange(sel.value);
      return sel;
    };

    // No key yet: where to get one, and what the proxy does.
    function setup() {
      const input = el("input", { type: "password", className: "text", placeholder: "paste your Webshare API key", spellcheck: false, autocomplete: "off", value: keyDraft });
      input.oninput = () => (keyDraft = input.value);
      const show = el("button", { type: "button", className: "btn ghost px-show", textContent: "show" });
      show.onclick = () => { input.type = input.type === "password" ? "text" : "password"; show.textContent = input.type === "password" ? "show" : "hide"; };
      const go = el("button", { type: "button", className: "btn blue", textContent: "connect" });
      const msg = el("p", { className: `hint${say.bad ? " bad" : ""}`, textContent: say.text });
      const connect = async () => {
        go.disabled = true;
        msg.className = "hint";
        msg.textContent = "checking with Webshare…";
        try {
          await send("proxyConnect", { key: input.value });
          keyDraft = "";
          say = { text: "", bad: false };
        } catch (err) {
          say = { text: err.message, bad: true };
          msg.className = "hint bad";
          msg.textContent = err.message;
        } finally {
          go.disabled = false;
        }
      };
      go.onclick = connect;
      input.onkeydown = (e) => { if (e.key === "Enter") connect(); };
      const link = el("a", { href: "https://dashboard.webshare.io/register", target: "_blank", rel: "noopener", textContent: "webshare.io" });
      return [
        section("Webshare key", el("div", { className: "row" }, input, show, go), msg,
          el("ol", { className: "px-steps" },
            el("li", {}, "Make a free account at ", link, ", no card needed"),
            el("li", {}, "In the dashboard, open ", el("b", { textContent: "API → Keys" }), " and copy a key"),
            el("li", {}, "Paste it here and press ", el("b", { textContent: "connect" }))),
          el("p", { className: "hint", textContent: "The free plan gives you 10 proxies and 1 GB a month. Your key stays in this browser." })),
        section("What it does", el("p", { className: "hint", textContent: "The sites you pick open through a proxy in another country, so they see the proxy's address instead of yours. Every other site uses your own connection as usual. It's a proxy for Chrome only, not a VPN: other apps aren't covered." })),
      ];
    }

    // The plan, the month's data, the main switch.
    function card() {
      const used = st.used || 0, limit = st.plan?.limit || 0;
      const share = limit ? Math.min(1, used / limit) : 0;
      const change = el("button", { type: "button", className: "btn ghost", textContent: "change key" });
      change.onclick = () => { if (confirm("Disconnect this Webshare key? Your site lists stay.")) save((p) => (p.key = "")); };
      const on = el("label", { className: "toggle" });
      const box = el("input", { type: "checkbox", checked: cfg.on });
      box.setAttribute("role", "switch");
      box.setAttribute("aria-label", "Proxy on");
      box.onchange = () => save((p) => (p.on = box.checked));
      on.append(box, el("span", { textContent: cfg.on ? "on" : "off" }));
      const count = st.proxies?.length ?? st.plan?.count ?? 0;
      const kids = [el("div", { className: "px-top" },
        el("span", { className: "px-plan", textContent: st.plan ? (free() ? "Free plan" : "Paid plan") : "Webshare" },
          el("span", { className: "hint", textContent: st.plan ? `${count} ${count === 1 ? "proxy" : "proxies"}` : "checking…" })),
        el("span", { className: "px-grow" }), change, on)];
      if (st.plan && st.usedAt) {
        const bar = el("div", { className: `px-bar${share >= 1 ? " out" : share >= 0.8 ? " warn" : ""}` }, el("i"));
        bar.firstChild.style.width = `${share * 100}%`;
        if (limit) kids.push(bar);
        kids.push(el("div", { className: "px-use" },
          el("span", {}, el("b", { textContent: size(used) }), limit ? ` of ${size(limit)} used this month` : " used this month"),
          el("span", { textContent: st.end ? `resets ${day(st.end)}` : "" })));
      }
      return el("div", { className: "px-card" }, ...kids);
    }

    function alerts() {
      const list = [];
      const alert = (title, text, cls = "") => el("div", { className: `px-alert ${cls}` }, el("b", { textContent: title }), el("span", { textContent: text }));
      if (st.blocked) list.push(alert("Chrome's proxy setting is in use elsewhere", "Something else on this computer controls it, so Extra Guac can't route sites now."));
      if (st.badKey) list.push(alert("Webshare doesn't accept this key", "It may have been deleted. Use change key to add a new one."));
      else if (st.error) list.push(alert("Couldn't check with Webshare", `${st.error}. The last known proxies are used meanwhile.`, "warn"));
      if (out()) list.push(alert(`Out of data until ${day(st.end)}`, cfg.whenOut === "direct"
        ? `This month's ${size(st.plan.limit)} is used up. Until it resets, the sites below open with your own connection.`
        : `This month's ${size(st.plan.limit)} is used up. The sites below won't open until it resets.`));
      return list;
    }

    // Paid plans: only the listed sites, or every site but the skipped ones.
    function modeSwitch() {
      const seg = el("span", { className: "hl-seg" });
      for (const [m, label] of [["sites", "only these sites"], ["full", "every site, except these"]]) {
        const b = el("button", { type: "button", textContent: label });
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(cfg.mode === m));
        b.onclick = () => save((p) => (p.mode = m));
        seg.append(b);
      }
      return el("div", { className: "row px-mode" }, seg);
    }

    function countrySection() {
      const kids = [];
      const perSite = !full() && cfg.countryMode === "each";
      if (!full()) {
        const radio = (value, label) => {
          const i = el("input", { type: "radio", name: "pxCountryMode", checked: cfg.countryMode === value });
          i.onchange = () => save((p) => (p.countryMode = value));
          return el("label", {}, i, label);
        };
        kids.push(el("div", { className: "px-radio" }, radio("same", "Same country for every site"), radio("each", "Choose a country for each site")));
      }
      if (!perSite) kids.push(el("div", { className: "px-field" }, el("span", { textContent: "Use" }), el("span", {}, countryMenu(cfg.country, (v) => save((p) => (p.country = v))))));
      const chips = el("span", { className: "px-chips" });
      cfg.backups.forEach((b, i) => {
        const x = el("button", { type: "button", textContent: "×", title: `Don't use ${TT.countryName(b)} as a backup` });
        x.onclick = () => save((p) => (p.backups = p.backups.filter((c) => c !== b)));
        chips.append(el("span", { className: "px-chip" }, el("span", { className: "n", textContent: String(i + 1) }), TT.countryName(b), x));
      });
      const left = ["*", ...countries()].filter((c) => !cfg.backups.includes(c));
      if (left.length) {
        const add = el("select", { className: "px-select px-addc" });
        add.setAttribute("aria-label", "Add a backup country");
        add.append(el("option", { value: "", textContent: "+ country" }), ...left.map((c) => el("option", { value: c, textContent: TT.countryName(c) })));
        add.onchange = () => { if (add.value) save((p) => p.backups.push(add.value)); };
        chips.append(add);
      }
      kids.push(el("div", { className: "px-field" }, el("span", { textContent: "If it's not working" }), chips));
      kids.push(el("p", { className: "hint", textContent: `${perSite ? "Each site below appears to be visited from the country next to it." : "Sites appear to be visited from this country."} If its proxies stop answering or leave your Webshare list, the backups are used, in this order, until it's back.` }));
      return section("Country", ...kids);
    }

    function whenOut() {
      const radio = (value, label, sub) => {
        const i = el("input", { type: "radio", name: "pxWhenOut", checked: cfg.whenOut === value });
        i.onchange = () => save((p) => (p.whenOut = value));
        return el("label", {}, i, label, el("small", { textContent: sub }));
      };
      return section("When the data runs out", el("div", { className: "px-radio" },
        radio("stop", "Stop these sites", "stays private: they wait until it resets"),
        radio("direct", "Open them with my own connection", "they'll see your real address")));
    }

    // The sites: "use the proxy" (or, in full mode, "skip the proxy"), each with its switch,
    // its country when chosen per site, and × to remove it; a box at the foot of each group
    // adds one. Sites on any ending ("name.*", TT.proxyName) have a group of their own.
    function siteList() {
      const key = full() ? "skip" : "sites";
      const list = cfg[key];
      const perSite = !full() && cfg.countryMode === "each";
      const tile = (site) => {
        let h = 0;
        for (const ch of site) h = (h * 31 + ch.charCodeAt(0)) % 360;
        const t = el("span", { className: "px-tile", textContent: site[0] });
        t.style.background = `hsl(${h} 45% 42%)`;
        return t;
      };
      const row = (s, i) => {
        const name = el("span", { className: "px-name" }, el("span", { textContent: TT.proxyLabel(s.site) }));
        if (!full()) {
          const c = TT.proxyCountry(cfg, st.proxies, s);
          if (!c.ok && st.proxies) name.append(el("small", { textContent: c.use ? `${TT.countryName(c.want)} unavailable · using ${TT.countryName(c.use)}` : `${TT.countryName(c.want)} unavailable · waiting for it` }));
          else if (i >= max() && s.on) name.append(el("small", { textContent: `over the ${max()}-site limit of this plan: not used` }));
          else if (ss.some((e) => e.domains.includes(s.site))) name.append(el("small", { className: "px-note", textContent: "while a session switch profile with a proxy is in use, its country goes first" }));
        }
        const label = TT.proxyLabel(s.site, true);
        const x = el("button", { type: "button", className: "px-x", textContent: "×", title: `Remove ${label}` });
        x.onclick = () => save((p) => (p[key] = p[key].filter((e) => e.site !== s.site)));
        const r = el("div", { className: `px-site${s.on ? "" : " off"}` }, tile(s.site), name);
        // A site without a country of its own shows the one it uses (the one last chosen for
        // every site); picking one keeps it for that site.
        if (perSite) r.append(countryMenu(s.country === "*" ? "" : s.country || cfg.country, (v) => save((p) => { const e = p.sites.find((e) => e.site === s.site); if (e) e.country = v || "*"; }), { cls: "sm" }));
        r.append(x, sw(s.on, `${label} ${full() ? "skips the proxy" : "uses the proxy"}`, (on) => save((p) => { const e = p[key].find((e) => e.site === s.site); if (e) e.on = on; })));
        return r;
      };
      const rows = [], nameRows = [];
      list.forEach((s, i) => (TT.proxyAnyEnding(s.site) ? nameRows : rows).push(row(s, i)));
      // A box that adds what parse makes of what's typed ("" when it isn't one).
      const adder = (focus, placeholder, parse, bad) => {
        const add = el("input", { type: "text", className: "text", placeholder, spellcheck: false });
        add.dataset.focus = focus;
        add.onkeydown = (e) => {
          if (e.key !== "Enter") return;
          const site = parse(add.value);
          if (!site) return void (add.value.trim() && alert(bad));
          if (list.some((e) => e.site === site)) return void (add.value = "");
          const label = TT.proxyLabel(site, true);
          // Already going through that country for a session switch profile: no new place taken.
          const country = full() ? "" : TT.proxyCountry(cfg, [], { country: "" }).want;
          if (slots().used >= total() && !slots().has(site, country)) return void alert(free()
            ? `The free plan takes up to ${total()} sites (one per site and country, session switch profiles included). Remove one to add ${label}.`
            : `Up to ${total()} sites (one per site and country, session switch profiles included). Remove one to add ${label}.`);
          refocus = focus;
          save((p) => p[key].push({ site, on: true, country: "" }));
        };
        return el("div", { className: "px-ladd" }, add);
      };
      // "xmovy.*" typed with the sites: the same as in its own box.
      const add = adder("add", "+ add a site, e.g. example.com", (v) => TT.proxySite(v) || (/\.\*\s*$/.test(v) ? TT.proxyName(v) : ""), "That doesn't look like a site, e.g. example.com");
      const addName = adder("addName", "+ add a name, e.g. google", TT.proxyName, "Enter just the site's name, without its ending: google, for google.com");
      const head = el("div", { className: "px-lhead" }, el("span", { textContent: full() ? "Sites that skip the proxy" : "Sites that use the proxy" }), el("span", { textContent: `${slots().used} / ${total()}` }));
      // Sites whose session switch profiles use a proxy: a group of their own above the sites
      // here (who and which country), counted with them, changed in the popup's session switch section (each profile's
      // proxy), which "change in popup" opens on the site.
      const group = (title, n) => el("div", { className: "px-group" }, el("span", { textContent: title }), el("span", { textContent: String(n) }));
      const profileRows = [];
      if (!full() && ss.length) {
        profileRows.push(group("Session switch profiles", ss.length), ...ss.map((e) => {
          const countries = [...new Set(e.profiles.map((p) => (p.country ? TT.countryName(p.country) : "any country")))].join(", ");
          const open = el("button", { type: "button", className: "px-open", textContent: "change in popup", title: `Opens ${e.site}; each profile's proxy is set in the popup's session switch section` });
          open.onclick = async () => {
            const r = await chrome.runtime.sendMessage({ type: "ss:open", site: e.site }).catch((err) => ({ error: err.message }));
            if (r?.error) alert(r.error);
          };
          return el("div", { className: "px-site px-session" }, tile(e.site),
            el("span", { className: "px-name" }, el("span", { textContent: e.domains.join(" + ") })),
            el("span", { className: "px-who", textContent: `${e.profiles.map((p) => p.name).join(", ")} · ${countries}` }),
            open);
        }));
      }
      const empty = el("p", { className: "hint px-empty", textContent: full() ? "none: every site goes through the proxy" : "none yet: add a site below, or use add this site in the panel" });
      const hint = el("p", { className: "hint px-empty", textContent: `Some sites change their ending every now and then, or have one per country. Enter just the name to match it on every real domain ending${full() ? " and keep it off the proxy" : ""}. For example, google covers google.com, google.co.uk and google.co.id, plus their subdomains.` });
      const kids = [el("div", { className: "px-list" }, head,
        ...profileRows, group("Your sites", rows.length), ...(rows.length ? rows : [empty]), add,
        group("Sites on any ending", nameRows.length), ...nameRows, hint, addName)];
      if (full()) kids.push(el("p", { className: "hint", textContent: "Everything goes through the proxy except these, which use your own connection (banks, or sites that block proxies). Webshare's own site always does." }));
      else if (free()) kids.push(el("div", { className: "px-note" }, "Only these sites use the proxy; everything else uses your own connection, so the data lasts. ", el("b", { textContent: "Every site through the proxy" }), " comes with Webshare's paid plans."));
      return section("", ...kids);
    }

    // WebRTC off on every site going through a proxy (bg-proxy.js), session switch profiles' too.
    function webrtc() {
      const box = el("input", { type: "checkbox", checked: cfg.webrtc, id: "pxWebrtc" });
      box.onchange = () => save((p) => (p.webrtc = box.checked));
      return section("WebRTC",
        el("label", { className: "row" }, box, " Turn off WebRTC on sites that go through a proxy"),
        el("p", { className: "hint", textContent: "WebRTC (used for calls and live connections) could otherwise show such a site your own address. It's turned off only on sites going through a proxy, the ones listed here and session switch profiles' sites, and only while the proxy is in use; everywhere else it works as usual." }));
    }

    // The proxy's place on proxied sites (bg-proxy.js): one switch each.
    function warp() {
      const row = (key, id, label) => {
        const box = el("input", { type: "checkbox", checked: cfg[key], id });
        box.onchange = () => save((p) => (p[key] = box.checked));
        return el("label", { className: "row" }, box, label);
      };
      return section("Match the proxy's place",
        row("location", "pxLocation", " Location: sites that ask where you are get a spot in the proxy's country"),
        row("time", "pxTime", " Time zone: dates and times on the page follow the proxy's time zone"),
        row("language", "pxLanguage", " Language: sites see the proxy country's language, with English after it"),
        el("p", { className: "hint", textContent: "Only on sites going through a proxy, while they do. The place comes from each proxy's country and city, with a list built into Extra Guac: nothing is looked up. Sites still need your OK to use your location, and get nothing if you say no. A page's background workers keep your own time zone and language." }));
    }

    function render() {
      const body = $("pxBody");
      if (!cfg.key) body.replaceChildren(...setup());
      else body.replaceChildren(...alerts(), card(), ...(free() ? [] : [modeSwitch()]), countrySection(), ...(st.plan?.limit ? [whenOut()] : []), siteList(), warp(), webrtc());
      if (refocus) { body.querySelector(`[data-focus="${refocus}"]`)?.focus(); refocus = ""; }
    }

    async function load() {
      const got = await chrome.storage.local.get(["proxy", "proxyState", "ssProxySites"]);
      cfg = TT.proxyOf(got.proxy);
      st = got.proxyState || {};
      ss = Array.isArray(got.ssProxySites) ? got.ssProxySites : [];
      render();
    }
    load().then(() => cfg.key && send("proxyRefresh", {}).catch(() => {}));
    chrome.storage.onChanged.addListener((c, area) => area === "local" && (c.proxy || c.proxyState || c.ssProxySites) && load());
  }

  // ---- Copy & right-click: remembered and this-session sites ----

  function initUnlock() {
    const clean = (v) => {
      let h = v.trim().toLowerCase();
      try { if (h.includes("://")) h = new URL(h).hostname; } catch {}
      return h.split("/")[0].split(":")[0].replace(/^(\*\.|www\.)/, "");
    };
    const session = async () => (await chrome.storage.session.get("unlockSession")).unlockSession || [];
    async function change(key, fn) {
      if (key === "session") return chrome.storage.session.set({ unlockSession: fn(await session()) });
      await TT.updateSettings({ unlock: { sites: fn((await TT.getSettings()).unlock.sites) } });
    }
    async function render() {
      const lists = { saved: (await TT.getSettings()).unlock.sites, session: await session() };
      for (const sec of document.querySelectorAll(".unlock-list")) {
        const key = sec.dataset.list, pills = sec.querySelector(".rm-pills");
        pills.replaceChildren(...lists[key].map((site) => {
          const chip = document.createElement("span");
          chip.className = "chip";
          const text = Object.assign(document.createElement("span"), { className: "chip-text", textContent: site });
          const x = Object.assign(document.createElement("button"), { type: "button", className: "chip-x", textContent: "×" });
          x.setAttribute("aria-label", `Remove ${site}`);
          x.onclick = () => change(key, (l) => l.filter((s) => s !== site));
          chip.append(text, x);
          return chip;
        }));
        if (!lists[key].length) pills.innerHTML = `<span class="rm-empty">None</span>`;
      }
    }
    const sec = document.querySelector('.unlock-list[data-list="saved"]');
    const input = sec.querySelector("input");
    const add = async () => {
      const site = clean(input.value);
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) return input.focus();
      input.value = "";
      await change("session", (l) => l.filter((s) => s !== site)); // now remembered instead
      await change("saved", (l) => [...new Set([...l, site])].sort());
    };
    sec.querySelector(".add-row button").onclick = add;
    input.addEventListener("keydown", (e) => e.key === "Enter" && add());
    render();
    chrome.storage.onChanged.addListener((c, area) => ((area === "local" && c.tt) || (area === "session" && c.unlockSession)) && render());
  }

  // ---- Open other sites' links in a new tab: sites ----

  function initNewTab() {
    const clean = (v) => {
      let h = v.trim().toLowerCase();
      try { if (h.includes("://")) h = new URL(h).hostname; } catch {}
      return h.split("/")[0].split(":")[0].replace(/^(\*\.|www\.)/, "");
    };
    const isHost = (h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h);
    const get = async () => (await TT.getSettings()).newTab;
    const chip = (text, label, onRemove) => {
      const c = Object.assign(document.createElement("span"), { className: "chip" });
      const x = Object.assign(document.createElement("button"), { type: "button", className: "chip-x", textContent: "×" });
      x.setAttribute("aria-label", label);
      x.onclick = onRemove;
      c.append(Object.assign(document.createElement("span"), { className: "chip-text", textContent: text }), x);
      return c;
    };
    const setAlso = async (site, fn) => {
      const { also } = await get();
      const hosts = fn(also.find((a) => a.site === site)?.hosts || []);
      const rest = also.filter((a) => a.site !== site);
      await TT.updateSettings({ newTab: { also: hosts.length ? [...rest, { site, hosts }] : rest } });
    };

    // One row per site: its name, the domains that also count as it (chips and a box), ×.
    async function renderSites() {
      const box = $("newTabRows");
      if (box.contains(document.activeElement) && document.activeElement.matches("input")) return;
      const { sites, also } = await get();
      if (!sites.length) return void (box.innerHTML = `<p class="rm-empty">None yet.</p>`);
      box.replaceChildren(...sites.map((site) => {
        const row = Object.assign(document.createElement("div"), { className: "nt-site" });
        const hosts = also.find((a) => a.site === site)?.hosts || [];
        const alsoBox = Object.assign(document.createElement("span"), { className: "nt-also", textContent: "also counts as this site:" });
        for (const h of hosts) alsoBox.append(chip(h, `Stop counting ${h} as ${site}`, () => setAlso(site, (l) => l.filter((x) => x !== h))));
        const input = Object.assign(document.createElement("input"), { type: "text", className: "text", placeholder: "e.g. google.com", spellcheck: false });
        input.addEventListener("keydown", async (e) => {
          if (e.key !== "Enter") return;
          const h = clean(input.value);
          if (!isHost(h) || h === site) return;
          input.value = "";
          input.blur();
          await setAlso(site, (l) => [...new Set([...l, h])].sort());
        });
        alsoBox.append(input);
        const del = Object.assign(document.createElement("button"), { type: "button", className: "del", textContent: "×", title: `Remove ${site}` });
        del.onclick = async () => {
          const nt = await get();
          await TT.updateSettings({ newTab: { sites: nt.sites.filter((s) => s !== site), also: nt.also.filter((a) => a.site !== site) } });
        };
        row.append(Object.assign(document.createElement("b"), { textContent: site }), alsoBox, del);
        return row;
      }));
    }
    const addSite = async () => {
      const input = $("newTabAdd"), site = clean(input.value);
      if (!isHost(site)) return input.focus();
      input.value = "";
      const { sites } = await get();
      await TT.updateSettings({ newTab: { sites: [...new Set([...sites.filter((s) => !(s === site || site.endsWith(`.${s}`))), site])].sort() } });
    };
    $("newTabAddBtn").onclick = addSite;
    $("newTabAdd").addEventListener("keydown", (e) => e.key === "Enter" && addSite());

    // Domains where each subdomain is a site of its own.
    const split = document.querySelector(".newtab-split"), splitInput = split.querySelector("input");
    async function renderSplit() {
      const list = (await get()).split, pills = split.querySelector(".rm-pills");
      pills.replaceChildren(...list.map((d) => chip(d, `Remove ${d}`, async () => TT.updateSettings({ newTab: { split: (await get()).split.filter((x) => x !== d) } }))));
      if (!list.length) pills.innerHTML = `<span class="rm-empty">None added</span>`;
    }
    const addSplit = async () => {
      const d = clean(splitInput.value);
      if (!isHost(d)) return splitInput.focus();
      splitInput.value = "";
      await TT.updateSettings({ newTab: { split: [...new Set([...(await get()).split, d])].sort() } });
    };
    split.querySelector(".add-row button").onclick = addSplit;
    splitInput.addEventListener("keydown", (e) => e.key === "Enter" && addSplit());

    renderSites();
    renderSplit();
    $("newTabRows").addEventListener("focusout", () => setTimeout(renderSites, 0));
    chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.tt) { renderSites(); renderSplit(); } });
  }

  // ---- Refresh on focus: entries (pattern, on/off, refresh type, expiry, threshold) ----

  function initFocus() {
    const box = $("focusRows");
    const entries = async () => (await TT.getSettings()).focus.entries;
    // Changes one at a time, each on the list as the one before left it (typing a number
    // then clicking a choice right away makes two).
    let queue = Promise.resolve();
    const change = (fn) => (queue = queue.then(async () => TT.updateSettings({ focus: { entries: fn(await entries()) } })).catch(() => {}));
    const edit = (id, fn) => change((list) => list.map((e) => (e.id === id ? fn({ ...e }) : e)));
    const when = (t) => TT.when(t);
    const seg = (options, current, onPick) => {
      const s = document.createElement("div");
      s.className = "seg";
      s.setAttribute("role", "radiogroup");
      for (const [value, label] of options) {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(value === current));
        b.onclick = () => onPick(value);
        s.append(b);
      }
      return s;
    };
    // A whole number, 0 or more. Empty (or 0) shows the placeholder when zeroShown is off.
    const num = (value, placeholder, zeroShown, onSet) => {
      const i = Object.assign(document.createElement("input"), { type: "number", className: "text num", min: 0, step: 1, placeholder });
      i.value = value > 0 || zeroShown ? String(value) : "";
      i.addEventListener("change", () => onSet(Math.max(0, Math.floor(Number(i.value) || 0))));
      return i;
    };
    const opt = (label, ...els) => {
      const o = Object.assign(document.createElement("span"), { className: "opt" });
      o.append(Object.assign(document.createElement("span"), { textContent: label }), ...els);
      return o;
    };

    // Not rebuilt while you're typing in it (a pattern or a number); once you leave, it is.
    let pending = false;
    async function render() {
      if (box.contains(document.activeElement) && document.activeElement.matches("input.text")) return void (pending = true);
      pending = false;
      const list = await entries();
      if (!list.length) return void (box.innerHTML = `<p class="rm-empty">Nothing yet.</p>`);
      const now = Date.now();
      box.replaceChildren(...list.map((e) => {
        const state = TT.focusState(e, now), until = TT.focusExpiresAt(e);
        const row = Object.assign(document.createElement("div"), { className: `focus-entry ${state}` });
        const top = Object.assign(document.createElement("div"), { className: "focus-top" });
        const on = document.createElement("label");
        on.className = "toggle";
        on.innerHTML = `<input type="checkbox" role="switch">`;
        on.querySelector("input").checked = state === "on";
        on.querySelector("input").setAttribute("aria-label", `Refresh ${e.pattern} on focus`);
        on.querySelector("input").onchange = (ev) => edit(e.id, (x) => ({ ...x, on: ev.target.checked, ...(ev.target.checked ? { enabledAt: Date.now() } : {}) }));
        const pattern = Object.assign(document.createElement("input"), { type: "text", className: "text", value: e.pattern, spellcheck: false });
        pattern.addEventListener("change", () => {
          const v = pattern.value.trim();
          if (!TT.focusPattern(v)) return void (pattern.value = e.pattern);
          edit(e.id, (x) => ({ ...x, pattern: v }));
        });
        const stateText = Object.assign(document.createElement("span"), { className: "hint state",
          textContent: state === "expired" ? `expired ${when(until)}` : state === "off" ? "off" : until ? `until ${when(until)}` : "no expiry" });
        const del = Object.assign(document.createElement("button"), { type: "button", className: "del", textContent: "×", title: "Delete" });
        del.onclick = () => change((list) => list.filter((x) => x.id !== e.id));
        top.append(on, pattern, stateText, del);
        const opts = Object.assign(document.createElement("div"), { className: "focus-opts" });
        opts.append(
          opt("refresh", seg([[false, "normal"], [true, "hard"]], !!e.hard, (v) => edit(e.id, (x) => ({ ...x, hard: v })))),
          opt("expires after",
            num(Number(e.expire?.n) || 0, "never", false, (n) => edit(e.id, (x) => ({ ...x, expire: { ...x.expire, n } }))),
            seg([["d", "days"], ["mo", "months"]], e.expire?.unit === "mo" ? "mo" : "d", (v) => edit(e.id, (x) => ({ ...x, expire: { ...x.expire, unit: v } })))),
          opt("if away at least",
            num(Number(e.threshold?.n) || 0, "0", true, (n) => edit(e.id, (x) => ({ ...x, threshold: { ...x.threshold, n } }))),
            seg([["s", "sec"], ["m", "min"]], e.threshold?.unit === "s" ? "s" : "m", (v) => edit(e.id, (x) => ({ ...x, threshold: { ...x.threshold, unit: v } })))),
        );
        row.append(top, opts);
        return row;
      }));
    }
    box.addEventListener("focusout", () => setTimeout(() => pending && render(), 0));
    const add = async () => {
      const v = $("focusNew").value.trim();
      const bad = !TT.focusPattern(v) ? "Enter an address, or a pattern with *" : (await entries()).some((e) => e.pattern.toLowerCase() === v.toLowerCase()) ? "That one is already in the list" : "";
      $("focusAddError").hidden = !bad;
      $("focusAddError").textContent = bad;
      if (bad) return $("focusNew").focus();
      $("focusNew").value = "";
      await change((list) => [...list, TT.focusNew(v)]);
    };
    $("focusAdd").onclick = add;
    $("focusNew").addEventListener("keydown", (e) => e.key === "Enter" && add());
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
    const when = (t) => TT.when(t);
    const age = (t) => { const d = (Date.now() - t) / 864e5; return d < 1 ? "today" : d < 2 ? "yesterday" : d < 60 ? `${Math.round(d)} days ago` : d < 730 ? `${Math.round(d / 30.4)} months ago` : `${Math.round(d / 365)} years ago`; };
    const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

    let listed = false;
    async function render() {
      const { backup = {}, backupState: st = {} } = await chrome.storage.local.get(["backup", "backupState"]);
      const interval = String(backup.interval ?? 24);
      document.querySelectorAll('[name="driveInterval"]').forEach((r) => (r.checked = r.value === interval));
      $("driveConnect").textContent = !st.connected ? "connect Google Drive" : st.needsSignIn ? "sign in again" : "reconnect";
      $("driveConnect").hidden = st.connected && !st.needsSignIn;
      // While connected, it says so (with the account) where the connect button was.
      $("driveOn").hidden = !st.connected || !!st.needsSignIn;
      $("driveOn").title = st.email ? `Connected as ${st.email}` : "";
      $("driveDisconnect").hidden = !st.connected;
      $("driveNow").disabled = !st.connected;
      if (!st.connected) say("not connected");
      else if (st.awaitingChoice) say("connected — Drive already has snapshots from another browser or an earlier install. Restore one below, or press sync now to start backing up this browser as it is.", true);
      else if (st.needsSignIn) say("signed out of Google — sign in again", true);
      else if (st.lastError) say(`last sync failed: ${st.lastError}`, true);
      else say(`connected${st.email ? ` as ${st.email}` : ""}${st.lastSnapshot ? ` · last snapshot ${when(st.lastSnapshot)}` : ""}${st.lastCheck ? ` · checked ${when(st.lastCheck)}` : ""}`);
      if (st.connected && !st.needsSignIn && !listed) listSnaps();
      const { preRestore } = await chrome.storage.local.get("preRestore");
      $("undoRestore").hidden = !preRestore?.data;
      if (preRestore?.at) $("undoRestore").title = `Put back the settings from just before the restore on ${when(preRestore.at)}`;
    }

    async function listSnaps() {
      listed = true;
      const box = $("driveSnaps");
      try {
        const { snapshots } = await send("backupList");
        const { backupDevice } = await chrome.storage.local.get("backupDevice");
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
          const tags = [];
          if (snap.kind === "pre-restore") tags.push("before a restore");
          if (backupDevice && snap.device === backupDevice) tags.push("this browser");
          else if (snap.device) tags.push("another browser");
          for (const t of tags) {
            const tag = document.createElement("span");
            tag.className = "tag";
            tag.textContent = t;
            tr.cells[0].append(tag);
          }
          tr.querySelector(".when .hint").textContent = age(snap.at);
          tr.cells[1].querySelector(".hint").textContent = size(snap.size);
          tr.title = snap.name;
          tr.querySelectorAll("[data-what]").forEach((b) => (b.onclick = async () => {
            const settingsToo = b.dataset.what === "settings";
            if (!confirm(settingsToo
              ? `Replace Extra Guac's settings and data with the snapshot from ${when(snap.at)}?`
              : `Add the bookmarks from ${when(snap.at)} in a new folder under Other bookmarks?`)) return;
            b.disabled = true;
            try {
              const res = await send("backupRestore", { id: snap.id, what: b.dataset.what });
              const profiles = res.profiles?.pending ? " This backup also holds session switch profiles: enter their passphrase next, at the top of this page."
                : res.profiles?.added ? ` ${res.profiles.added} session switch profile${res.profiles.added === 1 ? "" : "s"} added.` : "";
              alert(settingsToo ? `Settings restored.${profiles} ${savedNote(res)}` : `Bookmarks restored to “${res.folder}” in Other bookmarks.`);
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

    document.querySelectorAll('[name="driveInterval"]').forEach((r) => r.addEventListener("change", async () => {
      const { backup = {} } = await chrome.storage.local.get("backup");
      await chrome.storage.local.set({ backup: { ...backup, interval: Number(r.value) } });
    }));
    $("driveConnect").onclick = async () => {
      $("driveConnect").disabled = true;
      say("waiting for Google…");
      try {
        const res = await send("backupConnect");
        listed = false;
        if (res.awaitingChoice) alert("Google Drive already has snapshots from another browser or an earlier install, so nothing was backed up yet.\n\nIf this is a new install, restore one of them below. Otherwise press sync now to start backing up this browser.");
      } catch (err) { say(err.message, true); }
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
      const { backupState: st = {} } = await chrome.storage.local.get("backupState");
      if (st.awaitingChoice && !(await ask(
        "Back up this browser's settings to Drive?",
        "This uploads the settings in this browser now as the newest snapshot. Nothing in this browser changes. " +
        "Drive also has snapshots from another browser or an earlier install; if this browser is a fresh install that still " +
        "needs its settings, choose Not now and use restore settings on one of those instead.",
        "Back up this browser", "Not now"))) return;
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
        if (snapshot?.app !== "Extra Guac") throw new Error("That isn't an Extra Guac backup");
        const from = snapshot.createdAt ? ` from ${when(snapshot.createdAt)}` : "";
        if (!confirm(`Replace Extra Guac's settings and data with the ones in ${file.name}${from}?`)) return;
        const res = await send("backupImportLocal", { snapshot });
        alert(`Settings imported. ${savedNote(res)}`);
        location.reload();
      } catch (err) {
        alert(err instanceof SyntaxError ? "That file couldn't be read as a backup." : err.message);
      }
    };

    $("undoRestore").onclick = async () => {
      if (!confirm("Put back the settings and data from just before the last restore or import? (What's there now is kept, so you can flip back.)")) return;
      try {
        await send("backupUndoRestore");
        alert("Previous settings put back.");
        location.reload();
      } catch (err) { alert(err.message); }
    };

    render();
    chrome.storage.onChanged.addListener((c, area) => area === "local" && (c.backup || c.backupState || c.preRestore) && render());
  }

  // What happened to the settings that were there before a restore/import.
  function savedNote(res) {
    return res?.preRestore === "drive"
      ? "The previous settings were saved to Drive first (kept 30 days) — undo last restore puts them back."
      : "The previous settings were kept in this browser — undo last restore puts them back.";
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

    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    const ICON_MORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

    // The list picked on the left ("global" or a site), kept for next time.
    let sel = "global";
    try { sel = localStorage.getItem("hlSel") || "global"; } catch {}
    const pick = (key) => { sel = key; try { localStorage.setItem("hlSel", key); } catch {} render(); };
    // After a change re-renders the panel, the box that was being typed in gets the focus back.
    let refocus = "";

    // The six colors, or any color from the color menu (color-menu.js, the same one as the
    // screenshot editor's, with the same My colors). The menu stays open while the list is
    // drawn again around it; it closes on a pick, a click elsewhere, Esc, or scrolling.
    let cm = null; // { menu, key } while the menu is open
    const closeCm = () => { cm?.menu.remove(); cm = null; };
    addEventListener("pointerdown", (e) => { if (cm && !cm.menu.contains(e.target) && !e.target.closest(".hl-any")) closeCm(); }, true);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && cm) { closeCm(); $("hlDetail").querySelector(".hl-any")?.focus(); } });
    document.querySelector("main")?.addEventListener("scroll", () => cm && closeCm(), { passive: true });
    const EDITOR_COLORS = ["#000000", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#ff2d55", "#ffffff"];
    function colorPicker(key, value, onPick) {
      const box = el("span", { className: "hl-colors" });
      const preset = TT.HL_COLORS.some((c) => c.toLowerCase() === value.toLowerCase());
      for (const c of TT.HL_COLORS) {
        const sw = el("button", { type: "button", className: `sw${c.toLowerCase() === value.toLowerCase() ? " on" : ""}`, title: c });
        sw.setAttribute("aria-label", `Color ${c}`);
        sw.style.background = c;
        sw.onclick = () => { closeCm(); onPick(c); };
        box.append(sw);
      }
      const any = el("button", { type: "button", className: `hl-any${preset ? "" : " on"}`, title: preset ? "Any color" : `${value} · any color` });
      any.setAttribute("aria-label", "Any color");
      any.setAttribute("aria-haspopup", "dialog");
      if (!preset) any.style.setProperty("--c", value);
      any.onclick = () => {
        if (cm) return closeCm();
        const menu = ColorMenu.build({
          value,
          presets: EDITOR_COLORS,
          alpha: false, // marks need a solid color: their text is black or white to suit it
          onPick: (c, live) => {
            const dot = $("hlNav").querySelector(".hl-item.sel .hl-dot");
            if (dot) dot.style.background = c;
            if (!live) onPick(c);
          },
          onDone: closeCm,
          eyedrop: "EyeDropper" in window ? async () => {
            try { menu.setColor((await new EyeDropper().open()).sRGBHex); } catch {} // Esc: nothing picked
          } : null,
        });
        menu.classList.add("hl-cm-pop");
        const r = any.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 400))}px`;
        menu.style.top = `${r.bottom + 8}px`;
        document.body.append(menu);
        if (menu.getBoundingClientRect().bottom > innerHeight - 8) menu.style.top = `${Math.max(8, r.top - 8 - menu.offsetHeight)}px`; // no room below: above
        cm = { menu, key };
      };
      box.append(any);
      return box;
    }

    const chip = (text, label, onRemove) => {
      const x = el("button", { type: "button", className: "chip-x", textContent: "×" });
      x.setAttribute("aria-label", label);
      x.onclick = onRemove;
      return el("span", { className: "chip" }, el("span", { className: "chip-text", textContent: text, title: text }), x);
    };

    // The ⋯ menu: a small list of actions under the button; closes on a pick, outside click or Esc.
    function moreMenu(items) {
      const wrap = el("span", { className: "hl-more-wrap" });
      const btn = el("button", { type: "button", className: "hl-more", title: "More", innerHTML: ICON_MORE });
      btn.setAttribute("aria-haspopup", "menu");
      btn.setAttribute("aria-expanded", "false");
      const menu = el("div", { className: "hl-menu", hidden: true });
      menu.setAttribute("role", "menu");
      const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); removeEventListener("pointerdown", outside, true); removeEventListener("keydown", esc, true); };
      const outside = (e) => { if (!wrap.contains(e.target)) close(); };
      const esc = (e) => { if (e.key === "Escape") { close(); btn.focus(); } };
      for (const it of items) {
        if (it === "-") { menu.append(el("hr")); continue; }
        const b = el("button", { type: "button", className: it.danger ? "danger" : "", textContent: it.label, title: it.title || "" });
        b.setAttribute("role", "menuitem");
        b.onclick = () => { close(); it.run(); };
        menu.append(b);
      }
      btn.onclick = () => {
        if (!menu.hidden) return close();
        menu.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        addEventListener("pointerdown", outside, true);
        addEventListener("keydown", esc, true);
        menu.querySelector("button")?.focus();
      };
      wrap.append(btn, menu);
      return wrap;
    }

    // Every site with words: list sites and the sites linked to them (they count alike
    // toward the limit), and the list a site belongs to.
    const siteCount = () => Object.values(hl.sites).reduce((n, l) => n + 1 + l.also.length, 0);
    const ownerOf = (site) => (hl.sites[site] ? site : Object.keys(hl.sites).find((k) => hl.sites[k].also.includes(site)));
    let linking = ""; // the list whose "link a site" box is open
    let refocusLink = false; // put the typing back in that box after the redraw

    // Links a site to a list: it uses the list's words, color and on/off too.
    function linkSite(key, raw) {
      const site = siteName(raw);
      if (!site) return void (raw.trim() && alert("That doesn't look like a site, e.g. example.com"));
      const owner = ownerOf(site);
      if (owner === key) return;
      if (owner) return void alert(owner === site ? `${site} has a list of its own. Delete it first to link ${site} here.` : `${site} already uses the ${owner} list.`);
      if (siteCount() >= L.sites) return void alert(`Up to ${L.sites} sites can have words, linked ones included.`);
      linking = key;
      refocusLink = true;
      edit((h) => { if (h.sites[key] && !h.sites[key].also.includes(site)) h.sites[key].also.push(site); });
    }

    // Deleting a list with linked sites: only this site (the first linked one takes the list
    // over, the rest stay linked to it), or the list and every site linked to it.
    function deleteList(key) {
      const also = hl.sites[key]?.also || [];
      if (!also.length) return void (confirm(`Delete the list for ${key}?`) && edit((h) => delete h.sites[key]));
      const d = el("dialog", { className: "ask" });
      const opt = (label, sub, cls, run) => {
        const b = el("button", { type: "button", className: `ask-opt ${cls}` }, el("span", { textContent: label }), el("small", { textContent: sub }));
        b.onclick = () => { d.close(); run(); };
        return b;
      };
      const n = also.length === 1 ? "1 linked site" : `${also.length} linked sites`;
      const rest = `${also[0]} takes over the list` + (also.length === 1 ? "" : also.length === 2 ? ` and ${also[1]} stays linked to it` : " and the others stay linked to it");
      const cancel = el("button", { type: "button", className: "btn ghost", textContent: "Cancel" });
      cancel.onclick = () => d.close();
      d.append(el("h3", { textContent: `Delete ${key}?` }), el("p", { textContent: `Its words are also used on ${n}.` }),
        opt(`Delete only ${key}`, rest, "", () => {
          if (sel === key) { sel = also[0]; try { localStorage.setItem("hlSel", sel); } catch {} } // shown once saved
          edit((h) => { const l = h.sites[key]; if (!l) return; delete h.sites[key]; const [first, ...others] = l.also; if (first) h.sites[first] = { ...l, also: others }; });
        }),
        opt(`Delete ${key} and its ${n}`, "the words go too", "danger", () => edit((h) => delete h.sites[key])),
        el("div", { className: "ask-btns" }, cancel));
      d.addEventListener("close", () => d.remove());
      document.body.append(d);
      d.showModal();
      cancel.focus();
    }

    // Left: the global list, then each site's list, each with its color, word count and
    // on/off, and the sites linked to it on a branch below (+ links one more); a box at the
    // bottom adds a site.
    function renderNav() {
      const nav = $("hlNav");
      const item = (key, list, name) => {
        const row = el("div", { className: `hl-item${key === sel ? " sel" : ""}${list.on ? "" : " off"}`, tabIndex: 0, title: key === "global" ? "" : key });
        row.setAttribute("role", "button");
        row.setAttribute("aria-current", String(key === sel));
        const dot = el("span", { className: "hl-dot" });
        dot.style.background = list.color;
        const sw = el("label", { className: "toggle sm", title: list.on ? "On: click to switch this list off" : "Off: click to switch this list on" });
        sw.innerHTML = `<input type="checkbox" role="switch">`;
        const input = sw.querySelector("input");
        input.checked = list.on;
        input.setAttribute("aria-label", `${name} on`);
        input.onchange = (e) => edit((h) => { const l = key === "global" ? h.global : h.sites[key]; if (l) l.on = e.target.checked; });
        sw.onclick = (e) => e.stopPropagation();
        row.append(dot, el("span", { className: "hl-item-name", textContent: name }));
        if (key !== "global") {
          const plus = el("button", { type: "button", className: "hl-link-add", textContent: "+", title: `Use these words on another site too` });
          plus.setAttribute("aria-label", `Link another site to the ${key} list`);
          plus.onclick = (e) => { e.stopPropagation(); linking = linking === key ? "" : key; renderNav(); if (linking) nav.querySelector(".hl-link-input")?.focus(); };
          row.append(plus);
        }
        row.append(el("span", { className: "hl-item-count", textContent: String(list.words.length) }), sw);
        row.onclick = () => pick(key);
        row.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); pick(key); } };
        if (key === "global") return row;
        // The linked sites, then the box to link one more while it's open.
        const kids = list.also.map((site) => {
          const kid = el("div", { className: `hl-kid${list.on ? "" : " off"}`, title: `${site} uses the ${key} list` }, el("span", { className: "hl-kid-name", textContent: site }));
          const x = el("button", { type: "button", className: "hl-kid-x", textContent: "×", title: `Unlink ${site}` });
          x.setAttribute("aria-label", `Unlink ${site} from the ${key} list`);
          x.onclick = (e) => { e.stopPropagation(); edit((h) => { const l = h.sites[key]; if (l) l.also = l.also.filter((s) => s !== site); }); };
          kid.append(x);
          kid.onclick = () => pick(key);
          return kid;
        });
        if (linking === key) {
          const box = el("input", { type: "text", className: "hl-link-input", placeholder: "link a site, e.g. example.org", spellcheck: false });
          box.setAttribute("aria-label", `Link a site to the ${key} list`);
          box.onkeydown = (e) => {
            if (e.key === "Escape") { linking = ""; renderNav(); return; }
            if (e.key === "Enter") linkSite(key, box.value);
          };
          box.onblur = () => setTimeout(() => { if (linking === key && !box.value.trim() && !nav.contains(document.activeElement)) { linking = ""; renderNav(); } }, 150);
          kids.push(box);
        }
        return [row, ...kids];
      };
      const sites = Object.keys(hl.sites).sort();
      const add = el("input", { type: "text", className: "text", placeholder: "+ add a site, e.g. example.com", spellcheck: false });
      add.setAttribute("aria-label", "Add a site list");
      add.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        const site = siteName(add.value);
        if (!site) return void (add.value && alert("That doesn't look like a site, e.g. example.com"));
        const owner = ownerOf(site);
        if (owner && owner !== site) return pick(owner); // linked to a list already: show that one
        if (!owner && siteCount() >= L.sites) return alert(`Up to ${L.sites} sites can have words, linked ones included.`);
        sel = site;
        try { localStorage.setItem("hlSel", site); } catch {}
        refocus = "words";
        edit((h) => { if (!h.sites[site]) h.sites[site] = { on: true, color: TT.HL_COLORS[(Object.keys(h.sites).length + 2) % TT.HL_COLORS.length], words: [] }; });
      };
      nav.replaceChildren(
        item("global", hl.global, "Global list"),
        el("div", { className: "hl-nav-label" }, el("span", { textContent: "Site lists" }), el("span", { textContent: `${siteCount()} / ${L.sites}` })),
        el("div", { className: "hl-nav-sites" }, ...(sites.length ? sites.flatMap((s) => item(s, hl.sites[s], s)) : [el("p", { className: "hint hl-nav-empty", textContent: "none yet: add a site below to give it words of its own" })])),
        el("div", { className: "hl-nav-add" }, add));
      if (refocusLink) { nav.querySelector(".hl-link-input")?.focus(); refocusLink = false; }
    }

    // Right: the picked list: its words (with the add box), color, how words match, and for
    // the global list the sites it skips; import, export, clear and delete in ⋯.
    function renderDetail() {
      const key = sel;
      const isGlobal = key === "global";
      const list = isGlobal ? hl.global : hl.sites[key];
      const max = isGlobal ? L.global : L.site;
      const name = isGlobal ? "the global list" : key;
      const at = (h) => (isGlobal ? h.global : h.sites[key]);
      const change = (fn) => edit((h) => { if (at(h)) fn(at(h)); });

      const head = el("div", { className: "hl-dhead" },
        el("h3", { textContent: isGlobal ? "Global list" : key }),
        ...(list.on && !isGlobal ? [] : [el("span", { className: "hint", textContent: list.on ? "every site, except the ones skipped below" : "switched off: nothing marked" })]),
        el("span", { className: "grow" }),
        el("span", { className: "hl-count", textContent: `${list.words.length} / ${max.toLocaleString()}`, title: `Up to ${max.toLocaleString()} words or phrases` }),
        moreMenu([
          { label: "Import CSV…", title: "Add words from a .csv file (first column)", run: () => { importInto = key; $("hlImportFile").click(); } },
          { label: "Export CSV", run: () => exportCsv(isGlobal ? "global" : key, list.words) },
          "-",
          { label: "Remove all words", run: () => list.words.length && confirm(`Remove all ${list.words.length} words from ${name}?`) && change((l) => (l.words = [])) },
          ...(isGlobal ? [] : [{ label: `Delete the ${key} list`, danger: true, run: () => deleteList(key) }]),
        ]));

      // Words: the chips scroll inside the box; the add box stays at its foot.
      const input = el("input", { type: "text", spellcheck: false, placeholder: list.words.length ? "add more, comma between, Enter to add" : "add words or phrases, comma between, Enter to add" });
      input.setAttribute("aria-label", `Add words to ${name}`);
      input.dataset.focus = "words";
      input.onkeydown = (e) => {
        if (e.key !== "Enter" || !input.value.trim()) return;
        const words = input.value.split(/[,\n]/);
        refocus = "words";
        change((l) => (notes[key] = addWords(l, words, max)));
      };
      input.onpaste = (e) => { // a pasted list (lines or commas) goes in at once
        const t = e.clipboardData.getData("text");
        if (!/[\n,]/.test(t)) return;
        e.preventDefault();
        refocus = "words";
        change((l) => (notes[key] = addWords(l, (input.value + t).split(/[,\n]/), max)));
      };
      const chips = el("div", { className: "hl-chips" }, ...list.words.map((w) => chip(w, `Remove ${w}`, () => change((l) => (l.words = l.words.filter((x) => x !== w))))));
      const words = el("div", { className: "hl-words" }, chips, input);
      words.onclick = (e) => { if (e.target === words || e.target === chips) input.focus(); };

      const partial = (on) => {
        const b = el("button", { type: "button", textContent: on ? "inside words too" : "whole words" });
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(!!list.partial === on));
        b.onclick = () => change((l) => (l.partial = on));
        return b;
      };
      const seg = el("span", { className: "hl-seg" }, partial(false), partial(true));
      seg.setAttribute("role", "radiogroup");
      seg.setAttribute("aria-label", "How words match");

      const field = (label, ...kids) => el("div", { className: "hl-field" }, el("span", { className: "hl-k", textContent: label }), el("div", { className: "hl-v" }, ...kids));
      const rows = [
        field("Words", words, el("div", { className: "hl-note", textContent: notes[key] || "" })),
        field("Color", colorPicker(key, list.color, (c) => change((l) => (l.color = c)))),
        field("Match", seg, el("span", { className: "hint", textContent: list.partial ? "\"cat\" in \"category\" too" : "\"cat\", not the \"cat\" in \"category\"" })),
      ];
      if (isGlobal) {
        const skip = el("input", { type: "text", className: "hl-add-inline", spellcheck: false, placeholder: "+ site" });
        skip.setAttribute("aria-label", "Skip the global list on a site");
        skip.dataset.focus = "skip";
        skip.onkeydown = (e) => {
          if (e.key !== "Enter") return;
          const site = siteName(skip.value);
          if (!site) return void (skip.value && alert("That doesn't look like a site, e.g. example.com"));
          refocus = "skip";
          edit((h) => (h.exclude = [...new Set([...h.exclude, site])].sort()));
        };
        rows.push(field("Skip on",
          el("div", { className: "hl-skip" }, ...hl.exclude.map((s) => chip(s, `Use the global list on ${s} again`, () => edit((h) => (h.exclude = h.exclude.filter((x) => x !== s))))), skip),
          el("span", { className: "hint", textContent: "the global list isn't used on these sites (their own lists still are)" })));
      }
      if (cm && cm.key !== key) closeCm();
      $("hlDetail").classList.toggle("off", !list.on);
      $("hlDetail").replaceChildren(head, ...rows);
      if (refocus) { $("hlDetail").querySelector(`[data-focus="${refocus}"]`)?.focus(); refocus = ""; }
    }

    // The looks to choose from, each with a light-page and a dark-page example drawn with
    // the same ::highlight rules the pages get.
    const LOOKS = {
      clean: ["Clean", "solid color with black or white text"],
      underline: ["Underline only", "a thick underline, nothing behind the text"],
    };
    function renderLooks() {
      const box = $("hlLooks");
      const hex = hl.global.color;
      const n = parseInt(hex.slice(1), 16);
      const bg = [n >> 16, (n >> 8) & 255, n & 255];
      const fg = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) / 255 > 0.55 ? [0, 0, 0] : [255, 255, 255];
      let sheet = document.getElementById("hlLookStyle");
      if (!sheet) document.head.append((sheet = Object.assign(document.createElement("style"), { id: "hlLookStyle" })));
      sheet.textContent = TT.HL_LOOKS.map((look) => `::highlight(tt-prev-${look}) { ${TT.hlLookRule(look, bg, fg)} }`).join("\n");
      box.replaceChildren(...TT.HL_LOOKS.map((look) => {
        const opt = document.createElement("label");
        opt.className = `hl-look${hl.look === look ? " on" : ""}`;
        opt.innerHTML = `<input type="radio" name="hlLook"><span class="hl-look-text"><b></b><span class="hint"></span></span>
          <span class="hl-look-sample light"><span class="big">The quick brown fox</span><span>jumps over the lazy dog</span></span>
          <span class="hl-look-sample dark"><span class="big">The quick brown fox</span><span>jumps over the lazy dog</span></span>`;
        opt.querySelector("input").checked = hl.look === look;
        opt.querySelector("input").onchange = () => edit((h) => (h.look = look));
        opt.querySelector("b").textContent = LOOKS[look][0] + (look === "clean" ? " (default)" : "");
        opt.querySelector(".hint").textContent = LOOKS[look][1];
        return opt;
      }));
      // Mark "brown fox" and "lazy dog" in every example.
      for (const look of TT.HL_LOOKS) CSS.highlights.set(`tt-prev-${look}`, new Highlight());
      box.querySelectorAll(".hl-look").forEach((opt, i) => {
        const marks = CSS.highlights.get(`tt-prev-${TT.HL_LOOKS[i]}`);
        for (const span of opt.querySelectorAll(".hl-look-sample > span")) {
          const t = span.firstChild;
          const word = span.classList.contains("big") ? "brown fox" : "lazy dog";
          const at = t.data.indexOf(word);
          const r = new Range();
          r.setStart(t, at);
          r.setEnd(t, at + word.length);
          marks.add(r);
        }
      });
    }

    function render() {
      renderLooks();
      $("hlEnabled").checked = hl.enabled;
      $("hlEnabled").nextElementSibling.textContent = hl.enabled ? "on" : "off";
      if (sel !== "global" && !hl.sites[sel]) sel = "global"; // deleted, or gone from another window
      if (linking && !hl.sites[linking]) linking = "";
      renderNav();
      renderDetail();
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
  // ---- Clipboard history: excluded sites, count, clear ----

  function initClipboard() {
    const siteName = (raw) => {
      let v = String(raw || "").trim().toLowerCase();
      try { if (/^[a-z]+:\/\//.test(v)) v = new URL(v).hostname; } catch {}
      v = v.replace(/^www\./, "").replace(/[/?#].*$/, "");
      return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : "";
    };
    function renderExclude() {
      const box = $("clipExcludePills");
      box.replaceChildren(...settings.clip.exclude.map((site) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        const text = Object.assign(document.createElement("span"), { className: "chip-text", textContent: site });
        const x = Object.assign(document.createElement("button"), { type: "button", className: "chip-x", textContent: "×" });
        x.setAttribute("aria-label", `Record on ${site} again`);
        x.onclick = () => setPath("clip.exclude", settings.clip.exclude.filter((s) => s !== site), true);
        chip.append(text, x);
        return chip;
      }));
    }
    async function renderCount() {
      const res = await chrome.runtime.sendMessage({ type: "clipList" }).catch(() => null);
      const items = res?.items || [];
      const pinned = items.filter((e) => e.pinned).length;
      $("clipCount").textContent = `${items.length - pinned} saved · ${pinned} pinned`;
    }
    const add = () => {
      const site = siteName($("clipExcludeAdd").value);
      if (!site) return void ($("clipExcludeAdd").value && alert("That doesn't look like a site, e.g. example.com"));
      $("clipExcludeAdd").value = "";
      setPath("clip.exclude", [...new Set([...settings.clip.exclude, site])].sort(), true);
    };
    $("clipExcludeBtn").onclick = add;
    $("clipExcludeAdd").onkeydown = (e) => { if (e.key === "Enter") add(); };
    $("clipClearAll").onclick = async () => {
      if (!confirm("Delete the clipboard history? Pinned entries are kept.")) return;
      await chrome.runtime.sendMessage({ type: "clipClear" });
    };
    renderExclude();
    renderCount();
    renderClipExclude = renderExclude;
    chrome.storage.onChanged.addListener((c, area) => area === "local" && c.clipIndex && renderCount());
  }
  let renderClipExclude = () => {};
})();
