const $ = (id) => document.getElementById(id);
let tab = null;
let settings = null;

TT.applyTheme();
init();

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await TT.getSettings();
  const isWeb = /^https?:/i.test(tab?.url || "");

  initTopBar();
  initScreenshot();
  initBlur();
  initRefresh();
  initAutoRefresh(isWeb);
  initShortener(isWeb);
  initVolume(isWeb);
  initAwake();
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
  $("settingsBtn").onclick = () => send("openSettings", { section: "general" }).then(() => window.close(), fail);
  $("stopAllBtn").onclick = () => send("stopAll").then(() => toast("Stopped everything"), fail);
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
        if (mode === "area") return window.close(); // the page shows the selection overlay
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
  $("blurSettings").onclick = () => send("openSettings", { section: "blur" }).then(() => window.close(), fail);
}

// ---- Hard refresh / nuke ----------------------------------------------------

function initRefresh() {
  $("hardRefresh").onclick = () => send("hardRefresh").then(() => window.close(), fail);

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
    nuke.classList.add("busy");
    try {
      await send("nuke");
      window.close();
    } catch (err) {
      fail(err);
    } finally {
      nuke.classList.remove("busy");
    }
  };
  function disarm() {
    nuke.classList.remove("armed");
    nuke.querySelector("span").textContent = "nuke";
  }
}

// ---- Auto-refresh -----------------------------------------------------------

async function initAutoRefresh(isWeb) {
  const box = $("autoRefresh");
  const toggle = $("arToggle");
  const fields = [$("arFixed"), $("arMin"), $("arMax"), $("arKeyword")];
  const modeBtns = box.querySelectorAll("[data-mode]");
  const prefs = settings.refresh;
  let mode = prefs.mode;
  let run = null;
  let found = null;

  $("arFixed").value = prefs.fixed;
  $("arMin").value = prefs.min;
  $("arMax").value = prefs.max;
  $("arKeyword").value = prefs.keyword;

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
        config: { mode, fixed: +$("arFixed").value, min: +$("arMin").value, max: +$("arMax").value, keyword: $("arKeyword").value },
      });
    } catch (err) {
      fail(err);
    }
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
    const latest = shortHistory[0];
    $("latestLink").hidden = !latest;
    if (latest) {
      $("latestLink").querySelector(".link-text").textContent = latest.short;
      $("latestLink").querySelector("[data-copy]").onclick = () => copy(latest.short);
    }
    renderHistory(shortHistory);
  }
  render();
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.shortHistory || c.shortCounts || c.tt)) render();
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

  $("historyBtn").onclick = () => ($("historySheet").hidden = false);
  $("closeSheet").onclick = () => ($("historySheet").hidden = true);
  $("clearHistory").onclick = () => send("clearShortHistory").catch(fail);
}

function renderHistory(items) {
  const list = $("historyList");
  if (!items.length) {
    list.innerHTML = '<li class="empty">No shortened links yet</li>';
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="meta"><span class="short"></span><span class="long"></span></span>
      <button class="icon-btn small" title="Copy"><svg><use href="#i-copy"/></svg></button>`;
    li.querySelector(".short").textContent = item.short;
    li.querySelector(".long").textContent = `${TT.SHORTENERS[item.service]?.label || item.service} · ${new Date(item.at).toLocaleDateString()} · ${item.url}`;
    li.querySelector(".long").title = item.url;
    li.querySelector("button").onclick = () => copy(item.short);
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
