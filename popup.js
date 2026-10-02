const $ = (id) => document.getElementById(id);
let tab = null;
let settings = null;

// The same page runs as the toolbar popup or in the side panel. The popup closes after
// actions that hand over to the page; the panel stays open and follows the active tab.
const inPopup = chrome.extension.getViews({ type: "popup" }).includes(window);
const closePopup = () => inPopup && window.close();

TT.applyTheme();
init();

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await TT.getSettings();
  document.body.classList.toggle("side-panel", !inPopup);
  if (!inPopup) followActiveTab();
  const isWeb = /^https?:/i.test(tab?.url || "");

  initTopBar();
  initTabs();
  initHistorySheet();
  initScreenshot();
  initBlur();
  initDark(isWeb);
  initRefresh();
  initAutoRefresh(isWeb);
  initShortener(isWeb);
  initVolume(isWeb);
  initAwake();
  initColor(isWeb);
  initElement(isWeb);
  initFont(isWeb);
  initRemove(isWeb);
  initRedirect();
  initUploads();
}

// Side panel: start over for the tab you switch to, or when this tab goes to another page.
function followActiveTab() {
  chrome.tabs.onActivated.addListener(({ windowId }) => windowId === tab?.windowId && location.reload());
  chrome.tabs.onUpdated.addListener((id, info) => id === tab?.id && info.url && location.reload());
}

// Sends a message to the background worker; rejects with its error message.
async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, tabId: tab?.id, ...payload });
  if (!res?.ok) throw new Error(res?.error || "Something went wrong");
  return res;
}

let toastTimer = 0;
function toast(text, isError = false) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 4000 : 2200);
}

const fail = (err) => toast(err.message, true);

function setSwitch(el, on) {
  el.setAttribute("aria-checked", String(on));
}

function formatLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function onSession(key, fn) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[key]) fn(changes[key].newValue);
  });
}

// ---- Top bar ----------------------------------------------------------------

function initTopBar() {
  $("settingsBtn").onclick = () => send("openSettings", { section: "general" }).then(() => closePopup(), fail);
  $("stopAllBtn").onclick = () => send("stopAll").then(() => toast("Stopped everything"), fail);
}

// Remembers which tab of the popup was open last.
function initTabs() {
  const tabs = document.querySelectorAll(".tab[data-panel]");
  const show = (name) => {
    tabs.forEach((t) => {
      const on = t.dataset.panel === name;
      t.classList.toggle("active", on);
      if (on) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `panel-${name}`));
    try { localStorage.setItem("panel", name); } catch {}
  };
  tabs.forEach((t) => (t.onclick = () => show(t.dataset.panel)));
  let last = "tools";
  try { last = localStorage.getItem("panel") || last; } catch {}
  show(document.getElementById(`panel-${last}`) ? last : "tools");
}

// ---- Screenshot -------------------------------------------------------------

function initScreenshot() {
  for (const btn of document.querySelectorAll("[data-shot]")) {
    btn.onclick = async () => {
      const mode = btn.dataset.shot;
      btn.classList.add("busy");
      if (mode === "full") toast("Capturing the full page…");
      try {
        const res = await send("shot", { mode });
        if (mode === "area") return closePopup(); // the page shows the selection overlay
        const n = res.files.length;
        toast(n > 1 ? `Saved ${n} parts to Downloads` : `Saved ${res.files[0].split("/").pop()}`);
      } catch (err) {
        fail(/Cannot access|cannot be scripted|chrome:\/\//i.test(err.message)
          ? new Error("Chrome doesn't allow capturing this page") : err);
      } finally {
        btn.classList.remove("busy");
      }
    };
  }
}

// ---- Privacy blur -----------------------------------------------------------

async function initBlur() {
  const toggle = $("blurToggle");
  const { pii } = await chrome.storage.local.get("pii");
  setSwitch(toggle, !!pii?.enabled);
  toggle.onclick = async () => {
    const { pii: cur } = await chrome.storage.local.get("pii");
    const on = !cur?.enabled;
    await chrome.storage.local.set({ pii: { ...(cur || {}), enabled: on } });
    setSwitch(toggle, on);
  };
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c.pii) setSwitch(toggle, !!c.pii.newValue?.enabled);
  });
  $("blurSettings").onclick = () => send("openSettings", { section: "blur" }).then(() => closePopup(), fail);
}

// ---- Dark mode ----------------------------------------------------------------
// "sites": on only where switched on; "all": on everywhere except where switched off.
// The switch is for this tab's site (bg-dark.js keeps the lists and open tabs in step).
// It shows the choice, not whether the page is inverted: a page that's dark on its own
// stays as it is and says "already dark" (settings can darken such sites anyway).

function initDark(isWeb) {
  const site = isWeb ? new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "") : "";
  const covers = (list) => list.some((s) => site === s || site.endsWith(`.${s}`));
  const seg = $("darkMode"), toggle = $("darkToggle");
  let ready = false, saving = false;
  async function render() {
    const { dark } = await TT.getSettings();
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === dark.mode)));
    const on = dark.mode === "all" ? !covers(dark.exclude) : covers(dark.sites);
    setSwitch(toggle, on);
    const [probe] = isWeb && on && !covers(dark.force)
      ? await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__ttDarkPage === true }).catch(() => [])
      : [];
    $("darkStatus").textContent = dark.mode === "all" && !on ? "excluded" : probe?.result ? "already dark" : "";
    toggle.disabled = !isWeb;
    toggle.title = isWeb ? "" : "Not available on this page";
    ready = true;
  }
  render();
  chrome.storage.onChanged.addListener((c, area) => area === "local" && c.tt && render());
  seg.querySelectorAll("button").forEach((b) => (b.onclick = () => TT.updateSettings({ dark: { mode: b.dataset.mode } })));
  // Flips at once and takes no second click until it's saved: reading a not-yet-redrawn
  // switch made two quick clicks both mean "off", leaving the site excluded.
  toggle.onclick = async () => {
    if (!ready || saving) return;
    const on = toggle.getAttribute("aria-checked") !== "true";
    setSwitch(toggle, on);
    saving = true;
    try { await send("darkSite", { site, on }); }
    catch (err) { fail(err); render(); }
    finally { saving = false; }
  };
  $("darkSettings").onclick = () => send("openSettings", { section: "dark" }).then(() => closePopup(), fail);
}

// ---- Hard refresh / nuke ----------------------------------------------------

function initRefresh() {
  $("hardRefresh").onclick = () => send("hardRefresh").then(() => closePopup(), fail);

  // Nuke asks for a second click within 3 seconds.
  const nuke = $("nukeBtn");
  let armedTimer = 0;
  nuke.onclick = async () => {
    if (!nuke.classList.contains("armed")) {
      nuke.classList.add("armed");
      nuke.querySelector("span").textContent = "sure?";
      armedTimer = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armedTimer);
    disarm();
    showProgress({ step: 0, total: 4, label: "starting" });
    try {
      await send("nuke");
      setTimeout(() => closePopup(), 900);
    } catch (err) {
      showProgress(null);
      fail(err);
    }
  };
  function disarm() {
    nuke.classList.remove("armed");
    nuke.querySelector("span").textContent = "nuke";
  }

  // While a nuke runs (even one started before the popup was opened), the
  // buttons give way to "cookies… 2/4" and a thin bar.
  function showProgress(p) {
    $("refreshActions").hidden = !!p;
    $("nukeProgress").hidden = !p;
    if (!p) return;
    $("nukeProgress").classList.toggle("done", !!p.done);
    $("nukeLabel").textContent = p.done ? "nuked ✓ reloading" : `${p.label}… ${p.step}/${p.total}`;
    $("nukeBar").style.width = `${((p.done ? p.total : Math.max(p.step - 0.5, 0.15)) / p.total) * 100}%`;
  }
  const key = `nuke:${tab.id}`;
  chrome.storage.session.get(key).then((r) => r[key] && showProgress(r[key]));
  onSession(key, (v) => v && showProgress(v));
}

// ---- Auto-refresh -----------------------------------------------------------

async function initAutoRefresh(isWeb) {
  const box = $("autoRefresh");
  const toggle = $("arToggle");
  const fields = [$("arFixed"), $("arMin"), $("arMax")];
  const modeBtns = box.querySelectorAll("[data-mode]");
  const prefs = settings.refresh;
  let mode = prefs.mode;
  let run = null;
  let found = null;

  $("arFixed").value = prefs.fixed;
  $("arMin").value = prefs.min;
  $("arMax").value = prefs.max;
  initKeywords(() => run);

  const setMode = (m) => {
    mode = m;
    box.dataset.mode = m;
    modeBtns.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === m)));
  };
  setMode(mode);
  modeBtns.forEach((b) => (b.onclick = () => !run && setMode(b.dataset.mode)));

  const { refresh: runs = {} } = await chrome.storage.session.get("refresh");
  run = runs[tab.id] || null;
  found = (await chrome.storage.session.get(`refreshFound:${tab.id}`))[`refreshFound:${tab.id}`] || null;

  function render() {
    const on = !!run;
    setSwitch(toggle, on);
    box.classList.toggle("running", on);
    box.classList.toggle("found", !on && !!found);
    fields.forEach((f) => (f.disabled = on || !isWeb));
    modeBtns.forEach((b) => (b.disabled = on || !isWeb));
    toggle.disabled = !isWeb;
    let status = "";
    if (on) {
      if (run.loadingSince) status = `refreshing… · ${run.count}×`;
      else status = `next ${formatLeft(run.nextAt - Date.now())} · ${run.count}×`;
    } else if (found) {
      status = `found "${found.keyword}"`;
    } else if (!isWeb) {
      status = "not on this page";
    }
    $("arStatus").textContent = status;
  }
  render();
  setInterval(render, 500);

  onSession("refresh", (v) => { run = v?.[tab.id] || null; render(); });
  onSession(`refreshFound:${tab.id}`, (v) => { found = v || null; render(); });

  toggle.onclick = async () => {
    try {
      if (run) {
        await send("refreshStop");
        return;
      }
      await chrome.storage.session.remove(`refreshFound:${tab.id}`);
      found = null;
      await send("refreshStart", {
        config: { mode, fixed: +$("arFixed").value, min: +$("arMin").value, max: +$("arMax").value, keywords: enabledKeywords() },
      });
    } catch (err) {
      fail(err);
    }
  };
}

// ---- Auto-refresh keywords ---------------------------------------------------
// Pills in one sideways-scrolling line, saved as they change (settings.refresh.keywords,
// { text, enabled }). Click toggles a pill, a second click within DOUBLE_CLICK_MS
// deletes it instead; + opens a sheet with one keyword per line. Changes reach a
// refresh already running on this tab straight away.

const DOUBLE_CLICK_MS = 300;
let keywords = [];

const enabledKeywords = () => keywords.filter((k) => k.enabled).map((k) => k.text);

function initKeywords(getRun) {
  const prefs = settings.refresh;
  const legacy = prefs.keyword?.trim() ? [{ text: prefs.keyword.trim(), enabled: true }] : [];
  keywords = (prefs.keywords?.length ? prefs.keywords : legacy).map((k) => ({ text: k.text, enabled: k.enabled !== false }));

  const save = () => {
    TT.updateSettings({ refresh: { keywords, keyword: "" } });
    if (getRun()) send("refreshKeywords", { keywords: enabledKeywords() }).catch(fail);
  };

  const chips = $("arChips");
  const fade = () => {
    chips.classList.toggle("fade-l", chips.scrollLeft > 1);
    chips.classList.toggle("fade-r", chips.scrollLeft + chips.clientWidth < chips.scrollWidth - 1);
  };
  chips.addEventListener("scroll", fade, { passive: true });
  function render() {
    const scroll = chips.scrollLeft; // rebuilding would jump a long list back to the start
    chips.replaceChildren();
    if (!keywords.length) {
      const empty = document.createElement("span");
      empty.className = "chips-empty";
      empty.textContent = `no keywords · + to add up to ${TT.MAX_KEYWORDS}`;
      chips.append(empty);
    }
    for (const k of keywords) {
      const chip = document.createElement("span");
      chip.className = "chip" + (k.enabled ? "" : " off");
      chip.textContent = k.text;
      chip.title = `${k.enabled ? "Click to turn off" : "Off · click to turn on"} · double-click to delete`;
      let timer = 0;
      chip.onclick = () => {
        if (timer) {
          clearTimeout(timer);
          keywords = keywords.filter((x) => x !== k);
        } else {
          timer = setTimeout(() => {
            k.enabled = !k.enabled;
            render();
            save();
          }, DOUBLE_CLICK_MS);
          return;
        }
        render();
        save();
      };
      chips.append(chip);
    }
    chips.scrollLeft = scroll;
    fade();
    $("arKwCount").textContent = `${keywords.length}/${TT.MAX_KEYWORDS}`;
  }
  render();

  // Editor sheet: one keyword per line. Keywords that stay keep their on/off state.
  const sheet = $("kwSheet"), text = $("kwText"), counter = $("kwCounter");
  const lines = () => {
    const seen = new Set();
    return text.value.split("\n").map((l) => l.trim())
      .filter((l) => l && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
  };
  const count = () => {
    const n = lines().length;
    counter.textContent = `${Math.min(n, TT.MAX_KEYWORDS)}/${TT.MAX_KEYWORDS}`;
    counter.classList.toggle("over", n > TT.MAX_KEYWORDS);
  };
  const close = () => (sheet.hidden = true);
  $("arKwAdd").onclick = () => {
    text.value = keywords.map((k) => k.text).join("\n");
    count();
    sheet.hidden = false;
    if (text.value) text.value += "\n"; // ready for the next one
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  };
  text.oninput = count;
  $("kwClose").onclick = $("kwCancel").onclick = close;
  sheet.addEventListener("keydown", (e) => e.key === "Escape" && (e.preventDefault(), close()));
  $("kwSave").onclick = () => {
    const was = new Map(keywords.map((k) => [k.text.toLowerCase(), k.enabled]));
    keywords = lines().slice(0, TT.MAX_KEYWORDS).map((t) => ({ text: t, enabled: was.get(t.toLowerCase()) ?? true }));
    close();
    render();
    save();
  };
}

// ---- URL shortener ----------------------------------------------------------

async function initShortener(isWeb) {
  const services = $("shortServices");
  let service = settings.shortener.service;
  for (const [id, info] of Object.entries(TT.SHORTENERS)) {
    const b = document.createElement("button");
    b.dataset.service = id;
    b.setAttribute("role", "radio");
    b.textContent = info.label;
    b.onclick = () => {
      service = id;
      TT.updateSettings({ shortener: { service } });
      render();
    };
    services.append(b);
  }
  $("shortenBtn").disabled = !isWeb;

  async function render() {
    services.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.service === service)));
    const { shortCounts = {}, shortHistory = [] } = await chrome.storage.local.get(["shortCounts", "shortHistory"]);
    const s = await TT.getSettings();
    const count = shortCounts.month === TT.monthKey() ? shortCounts[service] || 0 : 0;
    const limit = TT.SHORTENERS[service].freeLimit;
    const counter = $("shortCount");
    counter.textContent = s.shortener.paid[service] ? `${count} this month` : `${count}/${limit} this month`;
    counter.classList.toggle("limit", !s.shortener.paid[service] && count >= limit);
    const latest = await latestShown("short");
    showCopyRow($("latestLink"), latest?.short, null, latest && (() => dismiss("short", latest)));
    if (sheetKind === "short") renderSheet();
  }
  render();
  onRowChange("short", render);
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.shortCounts || c.tt)) render();
  });

  $("shortenBtn").onclick = async () => {
    const btn = $("shortenBtn");
    btn.classList.add("busy");
    try {
      const { short } = await send("shorten", { service, url: tab.url });
      await copy(short, "Shortened and copied");
    } catch (err) {
      fail(err);
    } finally {
      btn.classList.remove("busy");
    }
  };

  $("historyBtn").onclick = () => openSheet("short");
}

// ---- Latest rows -------------------------------------------------------------
// The short link, upload, color, selector and font rows show the newest item until it's
// an hour old or dismissed with ×; the ↗ sheet keeps the whole history either way.

const ROW_TTL_MS = 60 * 60 * 1000;
const when = (at) => (at ? new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "earlier");

async function latestShown(kind) {
  const key = SHEETS[kind].key;
  const { [key]: list = [], dismissed = {} } = await chrome.storage.local.get([key, "dismissed"]);
  const latest = list[0];
  return latest && latest.at > (dismissed[kind] || 0) && Date.now() - latest.at < ROW_TTL_MS ? latest : null;
}

async function dismiss(kind, item) {
  const { dismissed = {} } = await chrome.storage.local.get("dismissed");
  await chrome.storage.local.set({ dismissed: { ...dismissed, [kind]: item.at } });
}

// Re-renders a row when its history or the dismissals change, and when its hour runs out.
function onRowChange(kind, render) {
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c[SHEETS[kind].key] || c.dismissed)) render();
  });
  setInterval(render, 30000);
}

// ---- History sheet (links, uploads, colors, selectors, fonts) -----------------

const SHEETS = {
  short: { title: "shortened links", icon: "i-link", key: "shortHistory", clear: "clearShortHistory", empty: "No shortened links yet",
    line: (i) => [i.short, `${TT.SHORTENERS[i.service]?.label || i.service} · ${when(i.at)} · ${i.url}`, i.url] },
  upload: { title: "uploaded images", icon: "i-upload", key: "uploadHistory", clear: "clearUploadHistory", empty: "No uploads yet",
    line: (i) => [i.link, `${i.host} · ${when(i.at)} · ${i.source}`, i.source] },
  color: { title: "picked colors", icon: "i-dropper", key: "colorHistory", clear: "clearColorHistory", empty: "No colors picked yet",
    line: (i) => [i.value, when(i.at), i.value], swatch: (i) => i.value },
  selector: { title: "picked elements", icon: "i-pointer", key: "selectorHistory", clear: "clearSelectorHistory", empty: "No elements picked yet",
    line: (i) => [i.value, `${i.format === "xpath" ? "XPath" : "CSS"} · ${when(i.at)}`, i.value] },
  font: { title: "picked fonts", icon: "i-font", key: "fontHistory", clear: "clearFontHistory", empty: "No fonts picked yet",
    line: (i) => [i.value, when(i.at), i.value], copyText: (i) => i.value.split(" · ")[0] },
};
let sheetKind = null;

function initHistorySheet() {
  $("closeSheet").onclick = () => { $("historySheet").hidden = true; sheetKind = null; };
  // Clearing asks for a second click: the button turns red first.
  const clear = $("clearHistory");
  let armed = 0;
  clear.onclick = () => {
    if (!clear.classList.contains("armed")) {
      clear.classList.add("armed");
      clear.textContent = "sure?";
      armed = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armed);
    disarm();
    send(SHEETS[sheetKind].clear).catch(fail);
  };
  function disarm() {
    clear.classList.remove("armed");
    clear.textContent = "clear";
  }
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && sheetKind && c[SHEETS[sheetKind].key]) renderSheet();
  });
}

function openSheet(kind) {
  sheetKind = kind;
  $("sheetTitle").textContent = SHEETS[kind].title;
  $("sheetIcon").setAttribute("href", `#${SHEETS[kind].icon}`);
  $("historySheet").hidden = false;
  renderSheet();
}

async function renderSheet() {
  const cfg = SHEETS[sheetKind];
  const items = (await chrome.storage.local.get(cfg.key))[cfg.key] || [];
  const list = $("historyList");
  if (!items.length) {
    list.innerHTML = `<li class="empty">${cfg.empty}</li>`;
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const [main, meta, title] = cfg.line(item);
    const li = document.createElement("li");
    li.innerHTML = `${cfg.swatch ? '<i class="swatch"></i>' : ""}<span class="meta"><span class="short"></span><span class="long"></span></span>
      <button class="icon-btn small" title="Copy"><svg><use href="#i-copy"/></svg></button>`;
    if (cfg.swatch) li.querySelector(".swatch").style.background = cfg.swatch(item);
    li.querySelector(".short").textContent = main;
    li.querySelector(".short").title = main;
    li.querySelector(".long").textContent = meta;
    li.querySelector(".long").title = title;
    li.querySelector("button").onclick = () => copy(cfg.copyText ? cfg.copyText(item) : main);
    return li;
  }));
}

async function copy(text, message = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast(text);
  }
}

// ---- Tab volume -------------------------------------------------------------

async function initVolume(isWeb) {
  const slider = $("volume");
  const out = $("volumeOut");
  const { volume: vols = {} } = await chrome.storage.session.get("volume");
  const show = (v) => {
    slider.value = v;
    slider.style.setProperty("--fill", `${v}%`);
    out.textContent = `${v}%`;
  };
  show(vols[tab.id] ?? 100);
  slider.disabled = !isWeb;
  let pending = 0;
  slider.oninput = () => {
    show(+slider.value);
    clearTimeout(pending);
    pending = setTimeout(() => send("setVolume", { volume: +slider.value }).catch(fail), 40);
  };
}

// ---- Keep awake -------------------------------------------------------------

async function initAwake() {
  const box = $("awake");
  const presets = $("awakePresets").querySelectorAll("button");
  const amount = $("awakeAmount");
  const unit = $("awakeUnit");
  let state = (await chrome.storage.session.get("awake")).awake || null;

  amount.value = settings.awake.lastAmount;
  unit.textContent = settings.awake.lastUnit === "h" ? "h" : "min";

  // Scroll (or click) on the unit to flip between minutes and hours.
  const flip = () => (unit.textContent = unit.textContent === "min" ? "h" : "min");
  unit.onclick = flip;
  unit.addEventListener("wheel", (e) => {
    e.preventDefault();
    unit.textContent = e.deltaY > 0 ? "h" : "min";
  }, { passive: false });
  // Scrolling over the number changes it quickly.
  amount.addEventListener("wheel", (e) => {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    amount.value = Math.max(1, (+amount.value || 0) + (e.deltaY < 0 ? step : -step));
  }, { passive: false });

  function render() {
    const on = !!state;
    box.classList.toggle("active", on);
    presets.forEach((b) => b.classList.toggle("active", on && +b.dataset.min === state.minutes));
    $("awakeStatus").textContent = !on ? "keeps the screen on"
      : state.until ? `awake · ${formatLeft(state.until - Date.now())} left` : "awake until turned off";
  }
  render();
  setInterval(render, 1000);
  onSession("awake", (v) => { state = v || null; render(); });

  const start = (minutes) => send("awakeStart", { minutes }).catch(fail);
  presets.forEach((b) => (b.onclick = () => {
    const minutes = +b.dataset.min;
    if (state && state.minutes === minutes) send("awakeStop").catch(fail);
    else start(minutes);
  }));
  $("awakeGo").onclick = () => {
    const n = +amount.value;
    if (!(n > 0)) return toast("Enter how long to stay awake", true);
    start(Math.round(unit.textContent === "h" ? n * 60 : n));
  };
}

// ---- Page tools: color & element pickers ------------------------------------

function showCopyRow(row, value, extra, onDismiss) {
  row.hidden = !value;
  if (!value) return;
  row.querySelector(".link-text").textContent = value;
  row.querySelector(".link-text").title = value;
  row.querySelector("[data-copy]").onclick = () => copy(value);
  const x = row.querySelector("[data-dismiss]");
  if (x) x.onclick = onDismiss;
  extra?.(row);
}

// One of the picker rows: the newest pick, the ↗ sheet, and dismissal.
function initPickRow(kind, rowId, extra) {
  const render = async () => {
    const latest = await latestShown(kind);
    showCopyRow($(rowId), latest?.value, latest && extra && ((row) => extra(row, latest)), latest && (() => dismiss(kind, latest)));
    if (sheetKind === kind) renderSheet();
  };
  render();
  onRowChange(kind, render);
  $(`${kind}HistoryBtn`).onclick = () => openSheet(kind);
}

async function initColor(isWeb) {
  initPickRow("color", "lastColor", (row, c) => (row.querySelector(".swatch").style.background = c.value));
  $("pickColor").disabled = !isWeb;
  $("pickColor").onclick = () => send("pickColor").then(() => closePopup(), fail);
}

async function initElement(isWeb) {
  const seg = $("selectorFormat");
  const setFormat = (f) => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.format === f)));
  setFormat(settings.picker.selectorFormat);
  seg.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    setFormat(b.dataset.format);
    TT.updateSettings({ picker: { selectorFormat: b.dataset.format } });
  }));
  initPickRow("selector", "lastSelector");
  $("pickElement").disabled = !isWeb;
  $("pickElement").onclick = () => send("pickElement").then(() => closePopup(), fail);
}

async function initFont(isWeb) {
  // Copies just the family name (the stored value is "Inter · SemiBold · 16px").
  initPickRow("font", "lastFont", (row, f) => {
    row.querySelector("[data-copy]").onclick = () => copy(f.value.split(" · ")[0]);
  });
  $("pickFont").disabled = !isWeb;
  $("pickFont").onclick = () => send("pickFont").then(() => closePopup(), fail);
}

// ---- Page tools: remove elements -----------------------------------------------
// Counts this site's removed elements, starts the remove picker, and switches "show
// removed" for the site (bg-remove.js).

function initRemove(isWeb) {
  const site = isWeb ? new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "") : "";
  const covers = (s) => site === s || site.endsWith(`.${s}`);
  const toggle = $("removeShow");
  async function render() {
    const { removed = {}, removedShow = {} } = await chrome.storage.local.get(["removed", "removedShow"]);
    const n = Object.keys(removed).filter(covers).reduce((sum, s) => sum + removed[s].length, 0);
    $("removeStatus").textContent = !isWeb ? "not on this page" : n ? `${n} removed here` : "";
    setSwitch(toggle, !!removedShow[site]);
    toggle.disabled = !isWeb || !n;
  }
  render();
  chrome.storage.onChanged.addListener((c, area) => area === "local" && (c.removed || c.removedShow) && render());
  $("pickRemove").disabled = !isWeb;
  $("pickRemove").onclick = () => send("pickRemove").then(() => closePopup(), fail);
  toggle.onclick = () => send("removeShow", { site, on: toggle.getAttribute("aria-checked") !== "true" }).catch(fail);
  $("removeSettings").onclick = () => send("openSettings", { section: "remove" }).then(() => closePopup(), fail);
}

// ---- Page tools: auto redirect ------------------------------------------------

function initRedirect() {
  const toggle = $("redirectToggle");
  const render = (s) => {
    setSwitch(toggle, s.redirect.enabled);
    const rules = s.redirect.rules.filter((r) => r.on !== false && r.find);
    const auto = rules.filter((r) => r.auto).length;
    $("redirectStatus").textContent = rules.length ? `${auto} auto · ${rules.length - auto} manual` : "no rules yet";
  };
  render(settings);
  toggle.onclick = async () => render(await TT.updateSettings({ redirect: { enabled: toggle.getAttribute("aria-checked") !== "true" } }));
  $("redirectSettings").onclick = () => send("openSettings", { section: "redirect" }).then(() => closePopup(), fail);
  $("redirectNow").onclick = () => send("redirectNow").then(() => closePopup(), fail);
  chrome.storage.onChanged.addListener((c, area) => area === "local" && c.tt && render(TT.merge(TT.DEFAULTS, c.tt.newValue)));
}

// ---- Page tools: image upload -------------------------------------------------

async function initUploads() {
  const hosts = $("uploadHosts").querySelectorAll(".host");
  const render = async (s) => {
    for (const b of hosts) {
      const id = b.dataset.host;
      const usable = id === "catbox" || s.upload.x02Verified;
      b.disabled = !usable;
      b.title = usable ? `Right-click an image → upload to ${id}` : "Save a working x02 API key in settings first";
      b.setAttribute("aria-pressed", String(usable && !!s.upload[id]));
    }
    const on = [...hosts].filter((b) => b.getAttribute("aria-pressed") === "true").length;
    $("uploadStatus").textContent = on ? "right-click an image" : "pick a host";
    const latest = await latestShown("upload");
    showCopyRow($("latestUpload"), latest?.link, null, latest && (() => dismiss("upload", latest)));
  };
  render(settings);
  onRowChange("upload", async () => render(await TT.getSettings()));
  hosts.forEach((b) => (b.onclick = async () => {
    const id = b.dataset.host;
    render(await TT.updateSettings({ upload: { [id]: b.getAttribute("aria-pressed") !== "true" } }));
  }));
  $("uploadSettings").onclick = () => send("openSettings", { section: "upload" }).then(() => closePopup(), fail);
  $("uploadHistoryBtn").onclick = () => openSheet("upload");
  chrome.storage.onChanged.addListener(async (c, area) => {
    if (area === "local" && c.tt) render(await TT.getSettings());
  });
}
