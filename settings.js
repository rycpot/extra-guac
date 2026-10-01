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
})();
