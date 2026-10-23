const $ = (id) => document.getElementById(id);
let tab = null;
let settings = null;

// The same page runs as the toolbar popup or in the side panel. The popup closes after
// actions that hand over to the page; the panel stays open and follows the active tab.
const inPopup = chrome.extension.getViews({ type: "popup" }).includes(window);
// ?tab=<id> opens the popup for that tab as a page, which the Session Switch tests use.
const fixedTab = Number(new URLSearchParams(location.search).get("tab")) || null;
const closePopup = () => inPopup && window.close();

TT.applyTheme();
init();
setTimeout(reveal, 600); // never stay blank if setup fails

// Shown once the sections have read their settings, so switches open in their real state;
// switches only animate after that, on a change.
function reveal() {
  $("main").classList.add("laid-out");
  setTimeout(() => document.body.classList.add("settled"), 300);
}

// The parts that depend on the tab (its site, its auto-refresh, its volume...) are set up
// for each tab: the side panel stays open and moves on to the tab you switch to, without
// reloading. Their listeners and timers belong to the tab's scope and go when it changes;
// work they started for the tab before is dropped (live.aborted).
let scope = new AbortController();
function onStorage(fn, signal = scope.signal) {
  chrome.storage.onChanged.addListener(fn);
  signal.addEventListener("abort", () => chrome.storage.onChanged.removeListener(fn), { once: true });
}
function every(fn, ms, signal = scope.signal) {
  const id = setInterval(fn, ms);
  signal.addEventListener("abort", () => clearInterval(id), { once: true });
}

function initForTab() {
  const isWeb = /^https?:/i.test(tab?.url || "");
  initDark(isWeb);
  initNuke();
  initAutoRefresh(isWeb);
  $("shortenBtn").disabled = !isWeb;
  initVolume(isWeb);
  for (const id of ["pickColor", "pickElement", "pickFont"]) $(id).disabled = !isWeb;
  initRemove(isWeb);
  initHighlight(isWeb);
  initUnlock(isWeb);
  initNewTab(isWeb);
  initFocus(isWeb);
  initOcr(isWeb);
  initProxy(isWeb);
  globalThis.initSessions?.(tab);
  globalThis.initUserscripts?.(tab);
}

async function init() {
  [tab] = fixedTab ? [await chrome.tabs.get(fixedTab)] : await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await TT.getSettings();
  document.body.classList.toggle("side-panel", !inPopup);
  applyLayout(settings.layout);
  chrome.storage.onChanged.addListener((c, area) => {
    const layout = (tt) => JSON.stringify(TT.merge(TT.DEFAULTS, tt).layout);
    if (area === "local" && c.tt && layout(c.tt.oldValue) !== layout(c.tt.newValue)) applyLayout(TT.merge(TT.DEFAULTS, c.tt.newValue).layout);
  });
  if (!inPopup && !fixedTab) {
    followActiveTab();
    // In the side panel the keyboard stays here while a picker runs on the page, so Esc
    // is passed on to close it (only Extra Guac's own overlays; see "pageEscape").
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || !tab?.id) return;
      send("pageEscape").catch(() => {});
    });
  }
  initTopBar();
  initTabs();
  initHistorySheet();
  initScreenshot();
  initShotHistory();
  initBlur();
  initScratch();
  initRefresh();
  initKeywords();
  initShortener();
  initQr();
  initAwake();
  initColor();
  initElement();
  initFont();
  initRedirect();
  initUploads();
  initBackup();
  initClipboard();
  initImgZoom();
  initImgDl();
  initForTab();
  await new Promise((r) => setTimeout(r, 60)); // their first reads of storage come back
  reveal();
}

// Puts each section in the tab and order chosen in settings → general → tools layout.
// The third tab only opens once it has sections.
function applyLayout(saved) {
  for (const [panel, ids] of Object.entries(TT.layoutOf(saved))) {
    const box = $(`panel-${panel}`);
    box.querySelector(".empty-panel")?.remove();
    for (const id of ids) {
      const section = document.querySelector(`[data-section="${id}"]`);
      if (section) box.append(section);
    }
    const button = document.querySelector(`.tab[data-panel="${panel}"]`);
    if (panel === "extra") {
      button.disabled = !ids.length;
      if (!ids.length && button.classList.contains("active")) document.querySelector('.tab[data-panel="tools"]').click();
    } else if (!ids.length) {
      box.insertAdjacentHTML("beforeend", `<p class="empty-panel">Nothing here yet. Drag sections into this tab in settings → general.</p>`);
    }
  }
  // The word search starts when the tab it's in is first shown (here, if it moved into the open one).
  if (tabsShown && document.querySelector(".panel:not([hidden])")?.contains($("wordSearch"))) initWordSearch();
}

// Side panel: moves on to the tab you switch to, or this tab's new page. The per-tab parts
// are set up again in place; switches change without sliding while that happens.
let switching = 0;
function followActiveTab() {
  chrome.tabs.onActivated.addListener(({ windowId }) => windowId === tab?.windowId && switchTab());
  chrome.tabs.onUpdated.addListener((id, info) => id === tab?.id && info.url && switchTab());
}
async function switchTab() {
  const mine = ++switching;
  const [next] = await chrome.tabs.query({ active: true, currentWindow: true });
  const fresh = await TT.getSettings();
  if (mine !== switching || !next) return; // a later switch took over
  tab = next;
  settings = fresh;
  scope.abort();
  scope = new AbortController();
  document.body.classList.remove("settled");
  initForTab();
  setTimeout(() => mine === switching && document.body.classList.add("settled"), 300);
}

// Sends a message to the background worker; rejects with its error message.
async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, tabId: tab?.id, ...payload });
  if (!res?.ok) throw new Error(res?.error || "Something went wrong");
  return res;
}

let toastTimer = 0;
// Stays long enough to read: about 2 s for a word or two, up to 6 s for a sentence (errors
// at least 4 s), and while the pointer is on it.
function toast(text, isError = false) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("error", isError);
  t.hidden = false;
  const ms = Math.min(6000, Math.max(isError ? 4000 : 2000, 1000 + text.length * 55));
  const hide = () => (t.hidden = true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, ms);
  t.onpointerenter = () => clearTimeout(toastTimer);
  t.onpointerleave = () => { clearTimeout(toastTimer); toastTimer = setTimeout(hide, 1200); };
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

function onSession(key, fn, signal) {
  const listener = (changes, area) => {
    if (area === "session" && changes[key]) fn(changes[key].newValue);
  };
  if (signal) onStorage(listener, signal);
  else chrome.storage.onChanged.addListener(listener);
}

// ---- Scratch pads -----------------------------------------------------------

// Pads 1–6: a tinted button with a green dot has something in it. Beside them, image.
function initScratch() {
  const strip = $("padStrip");
  for (let n = 1; n <= PADS.PAD_COUNT; n++) {
    const b = document.createElement("button");
    b.textContent = n;
    b.onclick = () => send("openScratch", { pad: n }).then(() => closePopup(), fail);
    strip.append(b);
  }
  // Image annotate: the screenshot editor with no image yet, in a tab beside this one.
  $("shotImage").onclick = async () => {
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.create({ url: chrome.runtime.getURL("shot-view.html#annotate"), ...(t ? { index: t.index + 1, openerTabId: t.id } : {}) });
      closePopup();
    } catch (err) { fail(err); }
  };
  const paint = async () => {
    const got = await chrome.storage.local.get(PADS.PAD_KEYS);
    [...strip.children].forEach((b, i) => {
      const pad = got[PADS.padKey(i + 1)];
      const empty = PADS.padEmpty(pad);
      b.classList.toggle("filled", !empty);
      b.title = `${pad?.title || `Pad ${i + 1}`} · ${empty ? "empty" : pad.md || (pad.mode === "plain" && pad.lang === "md") ? "markdown" : pad.mode === "plain" && pad.lang === "html" ? "HTML" : `${pad.mode} text`}`;
    });
  };
  paint();
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && PADS.PAD_KEYS.some((k) => c[k])) paint();
  });
}

// ---- Top bar ----------------------------------------------------------------

function initTopBar() {
  $("settingsBtn").onclick = () => send("openSettings", { section: "general" }).then(() => closePopup(), fail);
  $("stopAllBtn").onclick = () => send("stopAll").then(() => toast("Stopped everything"), fail);
}

// Remembers which tab of the popup was open last.
let tabsShown = false;
function initTabs() {
  tabsShown = true;
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
    if (name === "backup") initBeam();
    if ($(`panel-${name}`).contains($("wordSearch"))) initWordSearch();
  };
  tabs.forEach((t) => (t.onclick = () => show(t.dataset.panel)));
  let last = "tools";
  try { last = localStorage.getItem("panel") || last; } catch {}
  show(document.querySelector(`.tab[data-panel="${last}"]:not(:disabled)`) ? last : "tools");
}

// ---- Beam (backup tab) ------------------------------------------------------
// Sending files needs Beam to stay open, which the popup doesn't: there it's a preview with
// the way to Beam's own tab, and nothing connects. In the side panel it runs here, started
// the first time this tab is shown (so it doesn't sit on the connection service unasked).
let beamStarted = false;
async function initBeam() {
  if (beamStarted || !globalThis.Beam) return;
  beamStarted = true;
  const openTab = () => send("openBeam").then(() => closePopup(), fail);
  $("beamOpenTab").onclick = openTab;
  if (inPopup) return Beam.mount($("beam"), { preview: true, onOpenTab: openTab });
  const load = (src) => new Promise((resolve, reject) => {
    document.head.append(Object.assign(document.createElement("script"), { src, onload: resolve, onerror: reject }));
  });
  try {
    await Promise.all(["beam/lib/peerjs.min.js", "beam/lib/qrcode.min.js", "beam/lib/jsQR.min.js", "beam/lib/qr-render.js"].map(load));
  } catch { return toast("Beam couldn't start here: open it in a tab", true); }
  Beam.mount($("beam"));
}

// ---- Word search (tab 3 at first, movable) --------------------------------------------
// Easy plays here; the bigger levels open the game's own tab, with a new game at that level.
let wordSearchStarted = false;
function initWordSearch() {
  if (wordSearchStarted || !globalThis.WordSearch) return;
  wordSearchStarted = true;
  const openTab = (level) => send("openWordSearch", { level }).then(() => closePopup(), fail);
  $("wsOpenTab").onclick = () => openTab();
  WordSearch.mount($("wordSearch"), { panel: true, onOpenTab: openTab, onRoom: () => openTab("room") });
}

// ---- QR code ------------------------------------------------------------------
// This page's address as a QR code (static, or dynamic: a dub.sh link), shown in the page's
// card; customize opens the QR page; and whether the right-click menu has it. Static or
// dynamic isn't kept: the popup or panel opens on static every time.
function initQr() {
  const seg = $("qrMode");
  let mode = "static";
  async function render() {
    const s = await TT.getSettings();
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === mode)));
    setSwitch($("qrMenu"), s.qr.menu === true);
    // Dynamic: spoo.me (the default) or dub.sh, whichever is picked and linked.
    let status = "", title = "";
    const has = (id) => !!s.shortener.keys[id]?.trim();
    const service = (s.qr.dynamic === "dub" ? ["dub", "spoo"] : ["spoo", "dub"]).find(has);
    if (mode === "dynamic") {
      if (!service) status = "link spoo.me";
      else if (service === "spoo") { status = "spoo.me"; title = "Dynamic codes are spoo.me links (no monthly limit)"; }
      else {
        send("shortUsage", { services: ["dub"] }).catch(() => {});
        const { shortCounts = {}, shortUsage = {} } = await chrome.storage.local.get(["shortCounts", "shortUsage"]);
        const q = TT.shortQuota("dub", s, shortCounts, shortUsage);
        if (q.showCount && q.left != null) status = q.live && q.resets ? `${q.left} left` : `${q.left} left this month`;
        else status = "dub.sh";
        title = q.live
          ? `dub.sh: ${q.left ?? "unlimited"} new links left${q.resets ? `, until ${TT.shortDay(q.resets)}` : ""}`
          : "dub.sh new links left this month (counted in this browser)";
      }
    }
    $("qrStatus").textContent = status;
    $("qrStatus").title = title;
    $("qrGo").title = mode === "dynamic" ? `Dynamic QR code for this page (a ${service === "dub" ? "dub.sh" : "spoo.me"} link)` : "QR code for this page";
  }
  seg.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    mode = b.dataset.v === "dynamic" ? "dynamic" : "static";
    render();
  };
  $("qrMenu").onclick = async () => TT.updateSettings({ qr: { menu: $("qrMenu").getAttribute("aria-checked") !== "true" } });
  $("qrCustomize").onclick = () => send("qrOpenPage", { open: tab?.url ? { kind: "url", content: { url: tab.url }, mode } : null }).then(() => closePopup(), fail);
  $("qrGo").onclick = async () => {
    const btn = $("qrGo");
    if (btn.classList.contains("busy") || !tab) return;
    btn.classList.add("busy");
    try {
      await send("qrNow", { tabId: tab.id, mode });
      closePopup();
    } catch (err) { fail(err); }
    finally { btn.classList.remove("busy"); }
  };
  render();
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && (c.tt || c.shortCounts || c.shortUsage)) render(); });
}

// ---- Screenshot -------------------------------------------------------------

function initScreenshot() {
  $("shotSettings").onclick = () => send("openSettings", { section: "screenshot" }).then(() => closePopup(), fail);
  for (const btn of document.querySelectorAll("[data-shot]")) {
    btn.onclick = async () => {
      const mode = btn.dataset.shot;
      if (btn.classList.contains("busy")) return; // a second click while it's still capturing
      btn.classList.add("busy");
      if (mode === "full") toast("Capturing the full page…");
      try {
        const res = await send("shot", { mode });
        if (mode === "area") return closePopup(); // the page shows the selection overlay
        if (res.card) {
          // The card on the page takes it from here (save / upload, then the link).
          const cut = res.truncated ? ` Only the top ${res.screens} screens were captured.` : "";
          const said = { preview: "Preview at the bottom-right of the page", pick: "Pick a host on the card at the bottom-right of the page",
            cloud: "Uploading; the link shows on the page", notified: "Uploaded, link copied" };
          toast((said[res.card] || said.preview) + cut, !!cut);
          return;
        }
        const n = res.files.length;
        const saved = n > 1 ? `Saved ${n} parts to Downloads` : `Saved ${res.files[0].split("/").pop()}`;
        if (res.truncated) toast(`${saved}. The page is longer than ${res.screens} screens, so only the top part was captured.`, true);
        else toast(saved);
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
// The main switch turns dark mode on or off everywhere (the mode and site lists stay).
// While it's on, a second row handles this tab's site: in "all" mode "exclude <site>",
// in "sites" mode "dark on <site>". bg-dark.js keeps the lists and open tabs in step.
// A page that's dark on its own is left as it is and says "already dark".

function initDark(isWeb) {
  const site = isWeb ? new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "") : "";
  const covers = (list) => list.some((s) => site === s || site.endsWith(`.${s}`));
  const seg = $("darkMode"), main = $("darkToggle"), siteSwitch = $("darkSiteToggle");
  const live = scope.signal;
  let ready = false, saving = false;
  async function render() {
    const { dark } = await TT.getSettings();
    if (live.aborted) return;
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === dark.mode)));
    setSwitch(main, dark.enabled);
    $("darkSiteRow").hidden = !dark.enabled || !isWeb;
    const all = dark.mode === "all";
    const on = all ? !covers(dark.exclude) : covers(dark.sites);
    $("darkSiteLabel").textContent = `${all ? "exclude" : "dark on"} ${site}`;
    siteSwitch.setAttribute("aria-label", $("darkSiteLabel").textContent);
    setSwitch(siteSwitch, all ? !on : on);
    const [probe] = dark.enabled && isWeb && on && !covers(dark.force)
      ? await chrome.scripting.executeScript({ target: { tabId: tab.id },
        func: () => (window.__ttNativeOn ? "site's dark theme" : window.__ttDarkPage === true ? "already dark" : "") }).catch(() => [])
      : [];
    if (live.aborted) return;
    $("darkStatus").textContent = probe?.result || "";
    ready = true;
  }
  $("darkStatus").textContent = "";
  render();
  onStorage((c, area) => area === "local" && c.tt && render());
  seg.querySelectorAll("button").forEach((b) => (b.onclick = () => TT.updateSettings({ dark: { mode: b.dataset.mode } })));

  // Both switches flip at once and take no second click until it's saved.
  async function flip(el, save) {
    if (!ready || saving) return;
    const value = el.getAttribute("aria-checked") !== "true";
    setSwitch(el, value);
    saving = true;
    try { await save(value); }
    catch (err) { fail(err); render(); }
    finally { saving = false; }
  }
  main.onclick = () => flip(main, (on) => TT.updateSettings({ dark: { enabled: on } }));
  siteSwitch.onclick = () => flip(siteSwitch, async (checked) => {
    const { dark } = await TT.getSettings();
    await send("darkSite", { site, on: dark.mode === "all" ? !checked : checked });
  });
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
}

// While a nuke runs on this tab (even one started before the popup was opened), the
// buttons give way to "cookies… 2/4" and a thin bar.
function showProgress(p) {
  $("refreshActions").hidden = !!p;
  $("nukeProgress").hidden = !p;
  if (!p) return;
  $("nukeProgress").classList.toggle("done", !!p.done);
  $("nukeLabel").textContent = p.done ? "nuked ✓ reloading" : `${p.label}… ${p.step}/${p.total}`;
  $("nukeBar").style.width = `${((p.done ? p.total : Math.max(p.step - 0.5, 0.15)) / p.total) * 100}%`;
}

function initNuke() {
  const live = scope.signal, key = `nuke:${tab.id}`;
  showProgress(null);
  chrome.storage.session.get(key).then((r) => !live.aborted && r[key] && showProgress(r[key]));
  onSession(key, (v) => v && showProgress(v), live);
}

// ---- Auto-refresh -----------------------------------------------------------

let arRun = null; // this tab's auto-refresh, if it's running

async function initAutoRefresh(isWeb) {
  $("arSettings").onclick = () => send("openSettings", { section: "refresh" }).then(() => closePopup(), fail);
  const live = scope.signal;
  const box = $("autoRefresh");
  const toggle = $("arToggle");
  const fields = [$("arFixed"), $("arMin"), $("arMax")];
  const modeBtns = box.querySelectorAll("[data-mode]");
  const prefs = settings.refresh;
  let mode = prefs.mode;
  let run = null;
  let found = null;
  arRun = null;

  $("arFixed").value = prefs.fixed;
  $("arMin").value = prefs.min;
  $("arMax").value = prefs.max;

  const setMode = (m) => {
    mode = m;
    box.dataset.mode = m;
    modeBtns.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === m)));
  };
  setMode(mode);
  modeBtns.forEach((b) => (b.onclick = () => !run && setMode(b.dataset.mode)));

  const { refresh: runs = {} } = await chrome.storage.session.get("refresh");
  const foundKey = `refreshFound:${tab.id}`;
  const got = (await chrome.storage.session.get(foundKey))[foundKey] || null;
  if (live.aborted) return;
  arRun = run = runs[tab.id] || null;
  found = got;

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
  every(render, 500);

  const tabId = tab.id;
  onSession("refresh", (v) => { arRun = run = v?.[tabId] || null; render(); }, live);
  onSession(foundKey, (v) => { found = v || null; render(); }, live);

  toggle.onclick = async () => {
    try {
      if (run) {
        await send("refreshStop");
        return;
      }
      await chrome.storage.session.remove(foundKey);
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

function initKeywords() {
  const prefs = settings.refresh;
  const legacy = prefs.keyword?.trim() ? [{ text: prefs.keyword.trim(), enabled: true }] : [];
  keywords = (prefs.keywords?.length ? prefs.keywords : legacy).map((k) => ({ text: k.text, enabled: k.enabled !== false }));

  const save = () => {
    TT.updateSettings({ refresh: { keywords, keyword: "" } });
    if (arRun) send("refreshKeywords", { keywords: enabledKeywords() }).catch(fail);
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

async function initShortener() {
  $("shortSettings").onclick = () => send("openSettings", { section: "shortener" }).then(() => closePopup(), fail);
  const services = $("shortServices");
  let service = TT.SHORTENERS[settings.shortener.service] ? settings.shortener.service : "xgd";
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

  async function render() {
    services.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.service === service)));
    const { shortCounts = {}, shortUsage = {} } = await chrome.storage.local.get(["shortCounts", "shortUsage"]);
    const s = await TT.getSettings();
    // Only dub.sh's count, on its free plan (dub.sh's own numbers when it gives them, else
    // counted here); x.gd and spoo.me have no limit, so their counts are only in settings.
    // spoo.me without a key makes anonymous links, whose stats spoo.me shows to anyone: said here.
    const q = TT.shortQuota(service, s, shortCounts, shortUsage);
    const counter = $("shortCount");
    const n = q.limit == null ? `${q.used}` : `${q.used}/${q.limit}`;
    const open = service === "spoo" && !s.shortener.keys.spoo?.trim();
    counter.classList.toggle("two", open);
    if (open) {
      // Two lines where the count goes, until a spoo.me key is added.
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = "anonymous · public analytics";
      counter.replaceChildren("account not linked", document.createElement("br"), warn);
    } else counter.textContent = !q.showCount ? "" : q.live && q.resets ? `${n} until ${TT.shortDay(q.resets)}` : `${n} this month`;
    counter.title = q.live
      ? `From ${TT.SHORTENERS[service].label}`
      : open
        ? "No spoo.me account is linked: links are anonymous, and their short link analytics are accessible to anyone with the link (spoo.me/stats/…). Add your spoo.me key in settings → URL shortener so only you can see them."
        : "Links shortened from this browser this month";
    counter.classList.toggle("limit", q.left === 0);
    const latest = await latestShown("short");
    showCopyRow($("latestLink"), latest?.short, null, latest && (() => dismiss("short", latest)));
    if (sheetKind === "short") renderSheet();
  }
  render();
  // Ask the service for its own numbers (at most once a minute), now and on switching.
  const usage = () => TT.getSettings().then((s) => s.shortener.keys[service]?.trim() && send("shortUsage", { services: [service] })).catch(() => {});
  usage();
  services.addEventListener("click", usage);
  onRowChange("short", render);
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.shortCounts || c.shortUsage || c.tt)) render();
  });

  $("shortenBtn").onclick = async () => {
    const btn = $("shortenBtn");
    if (btn.classList.contains("busy")) return; // one request at a time (a double click would shorten twice)
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
const when = (at) => (at ? TT.when(at) : "earlier");

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
    line: (i) => [i.short, `${TT.SHORTENER_LABEL(i.service)} · ${when(i.at)} · ${i.url}`, i.url] },
  upload: { title: "uploaded images", icon: "i-upload", key: "uploadHistory", clear: "clearUploadHistory", empty: "No uploads yet",
    line: (i) => [i.link, `${TT.hostName(i.host)} · ${when(i.at)} · ${i.source}`, i.source] },
  color: { title: "picked colors", icon: "i-dropper", key: "colorHistory", clear: "clearColorHistory", empty: "No colors picked yet",
    line: (i) => [i.value, when(i.at), i.value], swatch: (i) => i.value },
  selector: { title: "picked elements", icon: "i-pointer", key: "selectorHistory", clear: "clearSelectorHistory", empty: "No elements picked yet",
    line: (i) => [i.value, `${i.format === "xpath" ? "XPath" : "CSS"} · ${when(i.at)}`, i.value] },
  font: { title: "picked fonts", icon: "i-font", key: "fontHistory", clear: "clearFontHistory", empty: "No fonts picked yet",
    line: (i) => [i.value, when(i.at), i.value], copyText: (i) => i.value.split(" · ")[0] },
};
let sheetKind = null;

function initHistorySheet() {
  $("closeSheet").onclick = () => { $("historySheet").hidden = true; sheetKind = null; freeUploadThumbs(); };
  $("historyList").addEventListener("scroll", markRange, { passive: true });
  // Keys 1–9 and 0 jump to 1–10 … 81–90 and 91–100 in the upload history.
  addEventListener("keydown", (e) => {
    if (sheetKind !== "upload" || $("historySheet").hidden || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea, select")) return;
    if (!/^[0-9]$/.test(e.key) || $("rangeBar").hidden) return;
    e.preventDefault();
    jumpTo(e.key === "0" ? 91 : Number(e.key) * 10 - 9);
  });
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
  list.classList.toggle("shot-list", sheetKind === "upload");
  paintRanges(sheetKind === "upload" ? items.length : 0);
  if (!items.length) {
    freeUploadThumbs();
    list.innerHTML = `<li class="empty">${cfg.empty}</li>`;
    return;
  }
  if (sheetKind === "upload") return renderUploads(items, list);
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
    // Uploads that the host lets us delete (x02, ImgLink with your key): first click arms,
    // the second deletes it from the host and from this list.
    if (sheetKind === "upload" && item.del) {
      const del = document.createElement("button");
      del.className = "icon-btn small del";
      del.title = `Delete from ${TT.hostName(item.host)}`;
      del.innerHTML = '<svg><use href="#i-trash"/></svg>';
      del.onclick = async () => {
        if (!del.classList.contains("armed")) {
          del.classList.add("armed");
          del.title = "Click again to delete";
          setTimeout(() => { del.classList.remove("armed"); del.title = `Delete from ${TT.hostName(item.host)}`; }, 3000);
          return;
        }
        del.disabled = true;
        try {
          await send("deleteUploads", { links: [item.link] });
          toast(`Deleted from ${TT.hostName(item.host)}`);
        } catch (err) { del.disabled = false; fail(err); }
      };
      li.append(del);
    }
    return li;
  }));
}

// ---- Upload history ranges: a chip per ten (1–10, 11–20 … up to 91–100, as far as the
// list goes) pinned over the list; hidden for ten or fewer ----
function paintRanges(count) {
  const bar = $("rangeBar");
  bar.hidden = count <= 10;
  if (bar.hidden) return;
  bar.replaceChildren(...Array.from({ length: Math.ceil(count / 10) }, (_, k) => { // only ranges with uploads in them
    const from = k * 10 + 1;
    const b = Object.assign(document.createElement("button"), { textContent: `${from}–${from + 9}`, title: `Jump to ${from}–${from + 9} (key ${(k + 1) % 10})` });
    b.dataset.from = from;
    b.onclick = () => jumpTo(from);
    return b;
  }));
  markRange();
}
function jumpTo(n) {
  const list = $("historyList"), li = list.children[n - 1];
  if (!li || !li.classList.contains("shot")) return;
  list.scrollTo({ top: li.offsetTop - list.offsetTop - 8 });
  markRange();
}
// The range of the first card on screen.
function markRange() {
  const bar = $("rangeBar"), list = $("historyList");
  if (bar.hidden) return;
  const box = list.getBoundingClientRect(), cards = [...list.children];
  let first = 0;
  for (const [i, li] of cards.entries()) if (li.getBoundingClientRect().bottom > box.top + 12) { first = i; break; }
  let from = Math.floor(first / 10) * 10 + 1;
  // Scrolled to the end: the last range whose first card shows (it may not reach the top).
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 2) {
    for (let f = Math.floor((cards.length - 1) / 10) * 10 + 1; f > from; f -= 10) {
      if (cards[f - 1].getBoundingClientRect().top < box.bottom) { from = f; break; }
    }
  }
  for (const b of bar.children) b.setAttribute("aria-current", String(Number(b.dataset.from) === from));
}

// ---- Upload history as cards: thumbnail (kept on this computer, upload-thumbs.js), link,
// host and time, then the serial number (1 = newest) and copy link, open, delete. Uploads
// without a thumbnail get one fetched from their link, once; the cards fill in when it's in.
let uploadThumbUrls = [], uploadRenderSeq = 0;
const freeUploadThumbs = () => { uploadThumbUrls.forEach((u) => URL.revokeObjectURL(u)); uploadThumbUrls = []; };
async function renderUploads(items, list, fetched = false) {
  const seq = ++uploadRenderSeq;
  const recs = await Promise.all(items.map((it) => UPTHUMBS.get(it.link).catch(() => null)));
  if (seq !== uploadRenderSeq || sheetKind !== "upload") return;
  freeUploadThumbs();
  list.replaceChildren(...items.map((item, i) => uploadCard(item, i + 1, recs[i])));
  const missing = items.filter((it, i) => !recs[i]?.thumb && !recs[i]?.failed).map((it) => it.link);
  if (missing.length && !fetched) {
    send("uploadThumbs", { links: missing }).then(() => {
      if (sheetKind === "upload" && seq === uploadRenderSeq) renderUploads(items, list, true);
    }, () => {});
  }
}
function uploadCard(item, n, rec) {
  const li = Object.assign(document.createElement("li"), { className: "shot" });
  const open = () => chrome.tabs.create({ url: item.link });
  let thumb;
  if (rec?.thumb) {
    const url = URL.createObjectURL(rec.thumb);
    uploadThumbUrls.push(url);
    thumb = Object.assign(document.createElement("img"), { className: "thumb", src: url, alt: "", title: "Open in a new tab" });
  } else {
    thumb = Object.assign(document.createElement("div"), { className: "thumb missing", title: "Open in a new tab", textContent: rec?.failed ? "No preview" : "Loading preview…" });
  }
  thumb.onclick = open;
  const meta = Object.assign(document.createElement("div"), { className: "shot-meta" });
  const left = document.createElement("span"), right = document.createElement("span");
  left.textContent = item.link.replace(/^https?:\/\//, "");
  left.title = item.link;
  right.textContent = `${TT.hostName(item.host)} · ${when(item.at)}`;
  right.title = `${item.source || ""}\n${item.at ? new Date(item.at).toLocaleString() : ""}`.trim();
  meta.append(left, right);
  const actions = Object.assign(document.createElement("div"), { className: "shot-actions" });
  actions.append(Object.assign(document.createElement("span"), { className: "serial", textContent: n, title: `Number ${n}, newest first` }));
  const button = (icon, title, fn, cls = "") => {
    const b = Object.assign(document.createElement("button"), { className: `icon-btn ${cls}`, title, innerHTML: `<svg><use href="#${icon}"/></svg>` });
    b.onclick = fn;
    actions.append(b);
    return b;
  };
  button("i-copy", "Copy link", () => copy(item.link, "Link copied"));
  button("i-open", "Open in a new tab", open);
  const del = button("i-trash", `Delete from ${TT.hostName(item.host)} (click twice)`, async () => {
    if (!del.classList.contains("armed")) {
      del.classList.add("armed");
      del.title = "Click again to delete";
      setTimeout(() => { del.classList.remove("armed"); del.title = `Delete from ${TT.hostName(item.host)} (click twice)`; }, 3000);
      return;
    }
    del.disabled = true;
    try {
      await send("deleteUploads", { links: [item.link] });
      toast(`Deleted from ${TT.hostName(item.host)}`);
    } catch (err) { del.disabled = false; fail(err); }
  }, "del");
  if (!item.del) { del.disabled = true; del.title = `${TT.hostName(item.host)} doesn't let this upload be deleted from here`; }
  li.append(thumb, meta, actions);
  return li;
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
  const live = scope.signal;
  slider.disabled = !isWeb;
  const { volume: vols = {} } = await chrome.storage.session.get("volume");
  if (live.aborted) return;
  const show = (v) => {
    slider.value = v;
    slider.style.setProperty("--fill", `${v}%`);
    out.textContent = `${v}%`;
  };
  show(vols[tab.id] ?? 100);
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
    // While awake (a preset or a custom time), ▶ becomes ■ and stops it.
    $("awakeGoIcon").setAttribute("href", on ? "#i-stop" : "#i-play");
    $("awakeGo").title = on ? "Stop keeping awake" : "Keep awake for this long";
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
    if (state) return send("awakeStop").catch(fail);
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

function initColor() {
  initPickRow("color", "lastColor", (row, c) => (row.querySelector(".swatch").style.background = c.value));
  $("pickColor").onclick = () => send("pickColor").then(() => closePopup(), fail);
}

function initElement() {
  const seg = $("selectorFormat");
  const setFormat = (f) => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.format === f)));
  setFormat(settings.picker.selectorFormat);
  seg.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    setFormat(b.dataset.format);
    TT.updateSettings({ picker: { selectorFormat: b.dataset.format } });
  }));
  initPickRow("selector", "lastSelector");
  $("pickElement").onclick = () => send("pickElement").then(() => closePopup(), fail);
}

function initFont() {
  // Copies just the family name (the stored value is "Inter · SemiBold · 16px").
  initPickRow("font", "lastFont", (row, f) => {
    row.querySelector("[data-copy]").onclick = () => copy(f.value.split(" · ")[0]);
  });
  $("pickFont").onclick = () => send("pickFont").then(() => closePopup(), fail);
}

// ---- Page tools: remove elements -----------------------------------------------
// Counts this site's removed elements, starts the remove picker, and switches "show
// removed" for the site (bg-remove.js).

// Highlight words: main switch; "exclude <site>" while the global list applies here;
// "<site> list" when the site has its own list (off keeps the list).
function initHighlight(isWeb) {
  const site = isWeb ? new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "") : "";
  const covers = (s) => site === s || site.endsWith(`.${s}`);
  const live = scope.signal;
  let hl = TT.hlOf();
  async function render() {
    const got = TT.hlOf((await chrome.storage.local.get("hl")).hl);
    if (live.aborted) return;
    hl = got;
    setSwitch($("hlToggle"), hl.enabled);
    const globalOn = hl.enabled && hl.global.on && hl.global.words.length > 0;
    const excluded = hl.exclude.some(covers);
    $("hlExcludeRow").hidden = !isWeb || !globalOn;
    $("hlExcludeLabel").textContent = `exclude ${site} from global`;
    $("hlExclude").setAttribute("aria-label", $("hlExcludeLabel").textContent);
    setSwitch($("hlExclude"), excluded);
    const own = TT.hlSiteKey(hl, covers);
    $("hlSiteRow").hidden = !isWeb || !hl.enabled || !own;
    if (own) {
      $("hlSiteLabel").textContent = `${own} list · ${hl.sites[own].words.length} word${hl.sites[own].words.length === 1 ? "" : "s"}`;
      $("hlSite").setAttribute("aria-label", `${own} list on or off`);
      setSwitch($("hlSite"), hl.sites[own].on);
      $("hlSite").dataset.site = own;
    }
    const [res] = hl.enabled && isWeb
      ? await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__ttHlCount?.() ?? null }).catch(() => [])
      : [];
    if (live.aborted) return;
    const n = res?.result;
    $("hlStatus").textContent = !hl.enabled ? "" : n == null ? (isWeb ? "" : "not on this page") : n >= 5000 ? "5,000+ found" : `${n} found`;
  }
  $("hlStatus").textContent = "";
  render();
  onStorage((c, area) => area === "local" && c.hl && setTimeout(render, 300));
  // Saved straight from here (no trip through the background, which may be asleep), so the
  // page reacts at once. The switch flips right away too.
  async function save(el, fn) {
    const on = el.getAttribute("aria-checked") !== "true";
    setSwitch(el, on);
    const next = TT.hlOf((await chrome.storage.local.get("hl")).hl);
    fn(next, on);
    await chrome.storage.local.set({ hl: next }).catch(fail);
  }
  $("hlToggle").onclick = () => save($("hlToggle"), (h, on) => (h.enabled = on));
  $("hlExclude").onclick = () => save($("hlExclude"), (h, on) => {
    h.exclude = on ? [...new Set([...h.exclude, site])].sort() : h.exclude.filter((s) => !covers(s));
  });
  $("hlSite").onclick = () => save($("hlSite"), (h, on) => { if (h.sites[$("hlSite").dataset.site]) h.sites[$("hlSite").dataset.site].on = on; });
  $("hlSettings").onclick = () => send("openSettings", { section: "highlight" }).then(() => closePopup(), fail);
}

// ---- Proxy ------------------------------------------------------------------------------
// Set up: a link to settings. With a Webshare key: how many sites are listed (or, on a paid
// plan, sites / full), the month's data, and this tab's site: add it, its country, its switch.
// Adding when the free plan's 20 are taken shows the list to remove one from first.

function initProxy(isWeb) {
  const live = scope.signal;
  const host = isWeb ? TT.proxySite(tab.url) : "";
  const GB = 1024 ** 3;
  const size = (b) => (b >= GB ? `${+(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB` : `${Math.max(0, Math.round(b / 1024 ** 2))} MB`);
  const day = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  let cfg = TT.proxyOf(), st = {}, making = false; // making: the "remove one to add this site" list is open
  let ss = []; // sites whose session switch profiles use a proxy: they take some of the plan's sites
  const free = () => st.plan?.free !== false;
  const full = () => !free() && cfg.mode === "full";
  const slots = () => TT.proxySlots(cfg, st, ss); // one per site and country, with session switch profiles
  const total = () => slots().max;
  const max = () => slots().own; // how many of the proxy's own list can be used
  // Room to add this site: a place left, or this site already going through that country.
  const roomFor = (site) => slots().used < total() || slots().has(site, TT.proxyCountry(cfg, [], { country: "" }).want);
  async function save(fn) {
    const { proxy } = await chrome.storage.local.get("proxy");
    const next = TT.proxyOf(proxy);
    fn(next);
    await chrome.storage.local.set({ proxy: next }).catch(fail);
  }
  const subRow = (...kids) => el("div", { className: "row tight sub-row" }, ...kids);
  const sw = (on, label, onclick) => {
    const b = el("button", { className: "switch", role: "switch" });
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", String(on));
    b.setAttribute("aria-label", label);
    b.onclick = () => { setSwitch(b, b.getAttribute("aria-checked") !== "true"); onclick(b.getAttribute("aria-checked") === "true"); };
    return b;
  };

  function usage() {
    if (!st.plan || !st.usedAt) return st.error ? subRow(el("span", { className: "status bad", textContent: st.badKey ? "Webshare doesn't accept the key; see settings" : st.error })) : null;
    const used = st.used || 0, limit = st.plan.limit || 0, share = limit ? Math.min(1, used / limit) : 0;
    const kids = [];
    if (limit) {
      const bar = el("div", { className: `px-bar${share >= 1 ? " out" : share >= 0.8 ? " warn" : ""}` }, el("i"));
      bar.firstChild.style.width = `${share * 100}%`;
      kids.push(bar);
    }
    const text = share >= 1 ? `out of data until ${day(st.end)}` : `${size(used)}${limit ? ` of ${size(limit)}` : ""} used${st.end ? ` · resets ${day(st.end)}` : ""}`;
    kids.push(el("span", { className: `status${share >= 1 ? " bad" : ""}`, textContent: st.blocked ? "Chrome's proxy setting is in use elsewhere" : text }));
    return subRow(el("div", { className: "px-usage" }, ...kids));
  }

  // This tab's site: in the list (its country, and its switch), or not (add it).
  function thisSite() {
    if (!host) return null;
    if (full()) {
      const skip = TT.proxyBest(host, cfg.skip.filter((s) => s.on)); // the most specific
      // Switching it back on takes this site's own entry out; one skipped as part of a wider
      // entry (google.com for mail.google.com) is changed in settings, not here.
      return subRow(el("span", { className: "px-site" }, el("span", { textContent: skip ? TT.proxyLabel(skip.site, true) : host }), el("small", { textContent: skip ? "skips the proxy" : "goes through the proxy" })),
        sw(!skip, `${host} through the proxy`, (on) => {
          if (on && skip && skip.site !== host) {
            toast(`Skipped as part of ${TT.proxyLabel(skip.site, true)}; change it in settings → proxy`, true);
            return render();
          }
          save((p) => {
            if (on) p.skip = p.skip.filter((s) => s.site !== host);
            else if (p.skip.length >= max()) toast(`Up to ${max()} skipped sites`, true);
            else p.skip.push({ site: host, on: true, country: "" });
          });
        }));
    }
    // A site whose session switch profiles use a proxy goes the way the active profile says.
    const viaProfiles = ss.find((e) => e.profiles.some((p) => p.inUse) && e.domains.some((d) => TT.proxyCovers(host, d)));
    if (viaProfiles) return subRow(el("span", { className: "px-site" }, el("span", { textContent: viaProfiles.site }), el("small", { textContent: "proxy set by its session switch profiles" })));
    const entry = TT.proxyBest(host, cfg.sites);
    if (!entry) {
      const add = el("button", { className: "text-btn", innerHTML: '<svg><use href="#i-plus"/></svg>add this site' });
      add.onclick = () => {
        if (!roomFor(host)) { making = true; return render(); }
        save((p) => p.sites.push({ site: host, on: true, country: "" }));
      };
      return subRow(el("span", { className: "px-site" }, el("span", { textContent: host })), add);
    }
    // Past the plan's limit (left from a paid plan): kept, but not used.
    if (cfg.sites.indexOf(entry) >= max()) {
      const note = el("small", { className: "warn", textContent: `over the ${max()}-site limit: not used` });
      return subRow(el("span", { className: "px-site" }, el("span", { textContent: TT.proxyLabel(entry.site, true) }), note));
    }
    const c = TT.proxyCountry(cfg, st.proxies, entry);
    const end = el("span", { className: "px-end" });
    const note = el("small", { textContent: !c.ok ? (c.use ? `via ${TT.countryName(c.use)} (${TT.countryName(c.want)} unavailable)` : `${TT.countryName(c.want)} unavailable`) : c.use ? `via ${TT.countryName(c.use)}` : "via any country" });
    if (!c.ok) note.className = "warn";
    if (cfg.countryMode === "each") {
      const sel = el("select", { className: "mini-sel" });
      sel.setAttribute("aria-label", `Country for ${TT.proxyLabel(entry.site, true)}`);
      const have = [...new Set((st.proxies || []).map((p) => p.c).filter(Boolean))].sort((a, b) => TT.countryName(a).localeCompare(TT.countryName(b)));
      const now = entry.country === "*" ? "" : entry.country || cfg.country; // without its own: the one it uses
      sel.append(el("option", { value: "", textContent: "any country" }));
      if (now && !have.includes(now)) sel.append(el("option", { value: now, textContent: TT.countryName(now) }));
      for (const cc of have) sel.append(el("option", { value: cc, textContent: TT.countryName(cc) }));
      sel.value = now;
      sel.onchange = () => save((p) => { const e = p.sites.find((e) => e.site === entry.site); if (e) e.country = sel.value || "*"; });
      end.append(sel);
      if (c.ok) note.textContent = "";
    }
    end.append(sw(entry.on, `${TT.proxyLabel(entry.site, true)} through the proxy`, (on) => save((p) => { const e = p.sites.find((e) => e.site === entry.site); if (e) e.on = on; })));
    return subRow(el("span", { className: "px-site" }, el("span", { textContent: TT.proxyLabel(entry.site, true) }), note), end);
  }

  // The plan's sites are all taken: remove one, and this site takes its place.
  function makeRoom() {
    const pills = el("div", { className: "px-pills" });
    for (const s of cfg.sites) {
      const b = el("button", { title: `Remove ${TT.proxyLabel(s.site, true)} and add ${host}` }, TT.proxyLabel(s.site, true), el("i", { textContent: "×" }));
      b.onclick = () => { making = false; save((p) => { p.sites = p.sites.filter((e) => e.site !== s.site); p.sites.push({ site: host, on: true, country: "" }); }); };
      pills.append(b);
    }
    const cancel = el("button", { className: "px-cancel", textContent: "not now" });
    cancel.onclick = () => { making = false; render(); };
    return el("div", { className: "px-full" }, el("p", {}, "All ", el("b", { textContent: String(total()) }), ` sites are used (one per site and country, session switch profiles included). Remove one to add `, el("b", { textContent: host }), ":"), pills, cancel);
  }

  function render() {
    const keyed = !!cfg.key;
    $("pxToggle").hidden = !keyed;
    setSwitch($("pxToggle"), cfg.on);
    $("pxMode").hidden = !keyed || free();
    for (const b of $("pxMode").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.mode === cfg.mode));
    $("pxStatus").textContent = !keyed ? "set up" : free() ? `${slots().used} / ${total()}` : "";
    const more = keyed ? [usage(), !roomFor(host) && making && host && !full() ? makeRoom() : thisSite()].filter(Boolean) : [];
    $("pxMore").replaceChildren(...more);
  }

  async function load() {
    const got = await chrome.storage.local.get(["proxy", "proxyState", "ssProxySites"]);
    if (live.aborted) return;
    cfg = TT.proxyOf(got.proxy);
    ss = Array.isArray(got.ssProxySites) ? got.ssProxySites : [];
    st = got.proxyState || {};
    if (cfg.sites.some((s) => TT.proxyCovers(host, s.site))) making = false;
    render();
  }
  load().then(() => {
    if (cfg.key && Date.now() - (st.usedAt || 0) > 120e3) send("proxyRefresh").catch(() => {});
  });
  onStorage((c, area) => area === "local" && (c.proxy || c.proxyState || c.ssProxySites) && load());
  $("pxToggle").onclick = () => save((p) => (p.on = $("pxToggle").getAttribute("aria-checked") !== "true"));
  $("pxStatus").onclick = () => { if (!cfg.key) $("pxSettings").click(); };
  for (const b of $("pxMode").querySelectorAll("button")) b.onclick = () => save((p) => (p.mode = b.dataset.mode));
  $("pxSettings").onclick = () => send("openSettings", { section: "proxy" }).then(() => closePopup(), fail);
}

function initRemove(isWeb) {
  const site = isWeb ? new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "") : "";
  const covers = (s) => site === s || site.endsWith(`.${s}`);
  const toggle = $("removeShow");
  const live = scope.signal;
  async function render() {
    const { removed = {}, removedShow = {} } = await chrome.storage.local.get(["removed", "removedShow"]);
    if (live.aborted) return;
    const n = Object.keys(removed).filter(covers).reduce((sum, s) => sum + removed[s].filter((r) => r.enabled !== false).length, 0);
    $("removeStatus").textContent = !isWeb ? "not on this page" : n ? `${n} removed here` : "";
    setSwitch(toggle, !!removedShow[site]);
    toggle.disabled = !isWeb || !n;
  }
  render();
  onStorage((c, area) => area === "local" && (c.removed || c.removedShow) && render());
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
      const usable = id === "imglink" || s.upload.x02Verified; // imglink works without a key
      b.disabled = !usable;
      b.title = usable ? `Right-click an image → upload to ${TT.hostName(id)}` : "Save a working X02 API key in settings first";
      b.setAttribute("aria-pressed", String(usable && !!s.upload[id]));
    }
    uploadTargets = TT.uploadHosts(s.upload);
    renderUploadStatus();
    $("uploadDrop").title = uploadTargets.length === 2 ? "Drop images here, or click to pick them; you choose the host as they go"
      : `Drop images here, or click to pick them. They go to ${uploadTargets.length ? TT.hostName(uploadTargets[0]) : "imglink without an account (no host is on)"}`;
    const latest = await latestShown("upload");
    showCopyRow($("latestUpload"), latest?.link, null, latest && (() => dismiss("upload", latest)));
    renderUploadTray();
  };
  render(settings);
  onRowChange("upload", async () => render(await TT.getSettings()));
  initUploadDrop();
  // Each click flips the button at once, so a quick second click flips it back rather
  // than repeating the first; the changes are saved one at a time, in order.
  hosts.forEach((b) => (b.onclick = async () => {
    const id = b.dataset.host, on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    render(await TT.updateSettings({ upload: { [id]: on } }));
  }));
  $("uploadSettings").onclick = () => send("openSettings", { section: "upload" }).then(() => closePopup(), fail);
  $("uploadHistoryBtn").onclick = () => openSheet("upload");
  chrome.storage.onChanged.addListener(async (c, area) => {
    if (area === "local" && c.tt) render(await TT.getSettings());
  });
}

// ---- Upload images: drop, paste or pick ----------------------------------------
// Where images go: no host on → imglink without an account; one host on → that one; both on
// → the section shows a zone per host, and where they're dropped (or which is clicked, after
// picking files or pasting) is where they go. One image per message, in turn; the links are
// copied together once all are done.

let uploadTargets = [];
const uploadRunning = []; // { preview } for each image still on its way, oldest first
let uploadCount = { done: 0, total: 0 };
let traySeq = 0, trayShown = "", trayFetched = new Set();
const trayThumbUrls = new Map(); // link -> object URL of its thumbnail, kept while it's in the tray

function renderUploadStatus() {
  const { done, total } = uploadCount;
  $("uploadStatus").textContent = uploadRunning.length ? `uploading ${Math.min(done + 1, total)} of ${total}…`
    : uploadTargets.length ? "drop or right-click an image" : "no host on: imglink, no account";
}

// The drop tile, then images on their way, then the newest uploads, 4 in all.
async function renderUploadTray() {
  const seq = ++traySeq;
  const { uploadHistory = [] } = await chrome.storage.local.get("uploadHistory");
  const items = uploadHistory.slice(0, Math.max(0, 4 - uploadRunning.length));
  const recs = await Promise.all(items.map((it) => UPTHUMBS.get(it.link).catch(() => null)));
  if (seq !== traySeq) return;
  // Settings, the history and a timer all ask for this often: the tiles are only rebuilt
  // when what they show changes, so the thumbnails don't reload and flicker.
  const shown = JSON.stringify([uploadRunning.map((r) => r.preview), items.map((it, i) => [it.link, it.at, !!recs[i]?.thumb])]);
  if (shown === trayShown) return;
  trayShown = shown;
  for (const [link, url] of trayThumbUrls) {
    if (!items.some((it, i) => it.link === link && recs[i]?.thumb)) { URL.revokeObjectURL(url); trayThumbUrls.delete(link); }
  }
  const tray = $("uploadTray");
  const tile = (title, bg) => {
    const b = Object.assign(document.createElement("button"), { className: "up-thumb", title });
    if (bg) b.style.backgroundImage = `url("${bg.replace(/"/g, "%22")}")`;
    return b;
  };
  // Tiles already showing stay as they are (moved, not redrawn).
  const kept = new Map([...tray.querySelectorAll(".up-thumb[data-link]")].map((b) => [b.dataset.link, b]));
  const keptBusy = new Map([...tray.querySelectorAll(".up-thumb.busy")].map((b) => [b.dataset.preview, b]));
  const busy = [...uploadRunning].reverse().map((r) => {
    if (keptBusy.has(r.preview)) return keptBusy.get(r.preview);
    const b = Object.assign(tile("Uploading…", r.preview), { className: "up-thumb busy", disabled: true });
    b.dataset.preview = r.preview;
    return b;
  });
  const done = items.map((item, i) => {
    const old = kept.get(item.link);
    if (old && old.classList.contains("none") === !recs[i]?.thumb) return old;
    let url = "";
    if (recs[i]?.thumb) {
      if (!trayThumbUrls.has(item.link)) trayThumbUrls.set(item.link, URL.createObjectURL(recs[i].thumb));
      url = trayThumbUrls.get(item.link);
    }
    const b = tile(`${item.link}\n${TT.hostName(item.host)} · ${when(item.at)}\nClick to copy the link`, url);
    b.dataset.link = item.link;
    if (!url) { b.classList.add("none"); b.innerHTML = '<svg><use href="#i-upload"/></svg>'; }
    b.onclick = () => copy(item.link, "Link copied");
    return b;
  });
  tray.replaceChildren($("uploadDrop"), ...busy, ...done);
  tray.classList.toggle("empty", !busy.length && !done.length);
  $("uploadDrop").querySelector("span").textContent = tray.classList.contains("empty") ? "Drop images here, or click to pick" : "drop";
  // Uploads without a thumbnail get one fetched from their link, once per popup.
  const missing = items.filter((it, i) => !recs[i]?.thumb && !recs[i]?.failed && !trayFetched.has(it.link)).map((it) => it.link);
  if (missing.length) {
    missing.forEach((l) => trayFetched.add(l));
    send("uploadThumbs", { links: missing }).then(() => renderUploadTray(), () => {});
  }
}

function initUploadDrop() {
  const sec = $("uploader"), over = $("uploadOver"), pick = $("uploadPick");
  const isImageDrag = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === "Files" || t === "text/uri-list");

  // The zones: one for a single target, one per host when both are on. onPick: clicked
  // (the host picker after picking files or pasting).
  let picking = null;
  function showZones(n, onPick) {
    const hosts = uploadTargets.length ? uploadTargets : [""];
    const what = n > 1 ? `${n} images` : n === 1 ? "the image" : "images";
    over.replaceChildren(...hosts.map((h) => {
      const z = document.createElement(onPick ? "button" : "div");
      z.className = "up-zone";
      z.dataset.host = h;
      const name = h ? TT.hostName(h) : "imglink";
      z.innerHTML = `<svg><use href="#i-cloud"/></svg><b></b><small></small>`;
      z.querySelector("b").textContent = hosts.length > 1 ? name : `Upload ${what} to ${name}`;
      z.querySelector("small").textContent = onPick ? (hosts.length > 1 ? `upload ${what} here` : "")
        : hosts.length > 1 ? "drop here" : h ? "release to upload" : "no account (no host is on)";
      if (onPick) z.onclick = (e) => { e.stopPropagation(); hideZones(); onPick(h); };
      return z;
    }));
    picking = onPick || null;
    if (onPick) over.onclick = () => hideZones(); // around the zones: cancel
    over.hidden = false;
  }
  function hideZones() { over.hidden = true; picking = null; over.onclick = null; }
  addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) { e.preventDefault(); hideZones(); } });

  // Images to send: the image files dropped or pasted, else (a picture dragged from a page
  // that came without its file) the picture's address.
  function imagesOf(dt) {
    const files = [...(dt.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) return files.map((file) => ({ file }));
    const src = /<img[^>]+src=["']([^"']+)/i.exec(dt.getData("text/html") || "")?.[1]?.replace(/&amp;/g, "&");
    const link = (dt.getData("text/uri-list") || "").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
    const url = src || link;
    return url ? [{ url }] : [];
  }
  // Both hosts on: ask which one (unless it was dropped on one).
  const start = (images, host) => {
    if (!images.length) return toast("No images in that", true);
    if (host !== undefined || uploadTargets.length < 2) return uploadImages(images, host ?? uploadTargets[0] ?? "");
    showZones(images.length, (h) => uploadImages(images, h));
  };

  sec.addEventListener("dragenter", (e) => {
    if (!isImageDrag(e)) return;
    e.preventDefault();
    if (over.hidden || picking) showZones([...e.dataTransfer.items].filter((i) => i.kind === "file").length);
  });
  sec.addEventListener("dragover", (e) => {
    if (!isImageDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const zone = e.target.closest?.(".up-zone");
    over.querySelectorAll(".up-zone").forEach((z) => z.classList.toggle("hot", z === zone || over.children.length === 1));
  });
  sec.addEventListener("dragleave", (e) => { if (!picking && !sec.contains(e.relatedTarget)) hideZones(); });
  sec.addEventListener("drop", (e) => {
    if (!isImageDrag(e)) return;
    e.preventDefault();
    const zone = e.target.closest?.(".up-zone") || (over.children.length === 1 && over.firstElementChild);
    hideZones();
    if (zone) start(imagesOf(e.dataTransfer), zone.dataset.host);
  });
  // Files dropped anywhere else would open in the panel in place of Extra Guac.
  addEventListener("dragover", (e) => { if (isImageDrag(e) && !sec.contains(e.target)) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; } });
  addEventListener("drop", (e) => { if (isImageDrag(e) && !sec.contains(e.target)) e.preventDefault(); });

  $("uploadDrop").onclick = () => pick.click();
  pick.onchange = () => {
    const images = [...pick.files].filter((f) => f.type.startsWith("image/")).map((file) => ({ file }));
    pick.value = "";
    start(images);
  };
  // Pasting an image anywhere in the popup, outside a text box, uploads it too.
  addEventListener("paste", (e) => {
    if (e.target.closest?.("input, textarea, [contenteditable]") || !sec.offsetParent) return;
    const images = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/")).map((file) => ({ file }));
    if (!images.length) return;
    e.preventDefault();
    start(images);
  });
}

const fileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error(`Couldn't read ${file.name || "the image"}`));
  r.readAsDataURL(file);
});

async function uploadImages(images, host) {
  const runs = images.map((it) => ({ preview: it.file ? URL.createObjectURL(it.file) : it.url }));
  if (!uploadRunning.length) uploadCount = { done: 0, total: 0 };
  uploadRunning.push(...runs);
  uploadCount.total += runs.length;
  renderUploadStatus();
  renderUploadTray();
  const links = [], errors = [];
  let label = host ? TT.hostName(host) : "imglink";
  for (const [i, it] of images.entries()) {
    try {
      const file = it.file && { dataUrl: await fileAsDataUrl(it.file), name: it.file.name || "image.png" };
      const res = await send("uploadDropped", { host, file, url: it.url });
      links.push(res.link);
      label = res.host;
    } catch (err) { errors.push(err.message); }
    uploadRunning.splice(uploadRunning.indexOf(runs[i]), 1);
    if (runs[i].preview.startsWith("blob:")) URL.revokeObjectURL(runs[i].preview);
    uploadCount.done++;
    renderUploadStatus();
    renderUploadTray();
  }
  if (errors.length) {
    const lead = links.length ? `${links.length} of ${images.length} uploaded (links copied). ` : "";
    if (links.length) navigator.clipboard.writeText(links.join("\n")).catch(() => {});
    return toast(lead + errors[0], true);
  }
  copy(links.join("\n"), `Uploaded to ${label} · ${links.length > 1 ? `${links.length} links` : "link"} copied`);
}

// ---- Screenshot history -----------------------------------------------------

// The last 10 shots (shot-store.js), newest first: the thumbnail (click to edit), then edit
// (opens the editor tab), copy image, upload and delete (click twice).
function initShotHistory() {
  const btn = $("shotHistoryBtn"), sheet = $("shotSheet"), list = $("shotList");
  let urls = [];
  const free = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };
  const on = (s) => s.shot?.history !== false;
  btn.hidden = !on(settings);
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.tt) {
      btn.hidden = !on(TT.merge(TT.DEFAULTS, c.tt.newValue));
      if (btn.hidden) close();
    }
    if (c.shotHistory && !sheet.hidden) render();
  });
  const close = () => { sheet.hidden = true; free(); list.replaceChildren(); };
  btn.onclick = () => { sheet.hidden = false; render(); };
  $("shotClose").onclick = close;
  let clearArmed = 0;
  $("shotClear").onclick = () => {
    const b = $("shotClear");
    if (!b.classList.contains("armed")) {
      b.classList.add("armed", "danger");
      b.textContent = "sure?";
      clearArmed = setTimeout(() => { b.classList.remove("armed", "danger"); b.textContent = "clear"; }, 3000);
      return;
    }
    clearTimeout(clearArmed);
    b.classList.remove("armed", "danger");
    b.textContent = "clear";
    send("shotHistoryClear").catch(fail);
  };

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const { shotHistory = [] } = await chrome.storage.local.get("shotHistory");
    const cards = await Promise.all(shotHistory.map((s, i) => card(s, i + 1)));
    if (seq !== renderSeq) return cards.forEach((c) => c.url && URL.revokeObjectURL(c.url));
    free();
    urls = cards.map((c) => c.url).filter(Boolean);
    list.replaceChildren(...cards.map((c) => c.li));
    $("shotClear").hidden = !shotHistory.length;
    if (!shotHistory.length) {
      const li = Object.assign(document.createElement("li"), { className: "empty", textContent: "No screenshots yet. Your last 10 show up here." });
      list.append(li);
    }
  }

  const icon = (id) => `<svg><use href="#${id}"/></svg>`;
  async function card(s, n) {
    const li = Object.assign(document.createElement("li"), { className: "shot" });
    const rec = await SHOTS.get(s.id).catch(() => null);
    const url = rec?.thumb ? URL.createObjectURL(rec.thumb) : "";
    const img = Object.assign(document.createElement("img"), { className: `thumb${url ? "" : " missing"}`, alt: s.name, title: "Edit in a new tab" });
    if (url) img.src = url;
    img.onclick = () => edit();
    let site = "";
    try { site = new URL(s.source).hostname.replace(/^www\./, ""); } catch {}
    const meta = document.createElement("div");
    meta.className = "shot-meta";
    const left = document.createElement("span"), right = document.createElement("span");
    left.textContent = `${s.label || "screenshot"} · ${s.w} × ${s.h}${s.parts > 1 ? ` · ${s.parts} parts` : ""}`;
    right.textContent = [site, ago(s.at)].filter(Boolean).join(" · ");
    right.title = new Date(s.at).toLocaleString();
    meta.append(left, right);
    const actions = document.createElement("div");
    actions.className = "shot-actions";
    actions.append(Object.assign(document.createElement("span"), { className: "serial", textContent: n, title: `Number ${n}, newest first` }));
    const button = (id, title, fn, cls = "") => {
      const b = Object.assign(document.createElement("button"), { className: `icon-btn ${cls}`, title, innerHTML: icon(id) });
      b.onclick = fn;
      actions.append(b);
      return b;
    };
    const edit = () => send("shotHistoryOpen", { id: s.id }).then(() => closePopup(), fail);
    button("i-edit", "Edit in a new tab", edit);
    button("i-copy", s.parts > 1 ? "Copy image (the first part)" : "Copy image", () => copy(s));
    const up = button("i-cloud", "Upload", () => upload(s, actions));
    const choices = TT.uploadChoices(settings.upload);
    if (!choices.length) { up.disabled = true; up.title = "Turn on imglink or X02 in settings → image upload to upload"; }
    else if (choices.length === 1) up.title = `Upload to ${TT.hostName(choices[0])}`;
    let armed = 0;
    const del = button("i-trash", "Delete (click twice)", () => {
      if (!del.classList.contains("armed")) {
        del.classList.add("armed");
        del.title = "Click again to delete";
        armed = setTimeout(() => { del.classList.remove("armed"); del.title = "Delete (click twice)"; }, 3000);
        return;
      }
      clearTimeout(armed);
      send("shotHistoryDelete", { id: s.id }).catch(fail);
    }, "del");
    if (!rec) for (const b of actions.querySelectorAll("button:not(.del)")) { b.disabled = true; b.title = "This screenshot isn't on this computer"; }
    li.append(img, meta, actions);
    return { li, url };
  }

  async function copy(s) {
    try {
      const rec = await SHOTS.get(s.id);
      if (!rec) throw new Error("it isn't on this computer any more");
      const blob = rec.items[0].blob;
      const png = blob.type === "image/png" ? blob : (async () => {
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext("2d").drawImage(bmp, 0, 0);
        return c.convertToBlob({ type: "image/png" });
      })();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toast(s.parts > 1 ? `Image copied (part 1 of ${s.parts})` : "Image copied");
    } catch (err) { toast(`Couldn't copy the image: ${err.message}`, true); }
  }

  async function upload(s, actions, host) {
    const choices = TT.uploadChoices(settings.upload);
    if (!host && choices.length > 1) {
      if (actions.querySelector(".hosts")) return actions.querySelector(".hosts").remove();
      const row = Object.assign(document.createElement("div"), { className: "hosts" });
      for (const h of choices) {
        const b = Object.assign(document.createElement("button"), { className: "text-btn", textContent: TT.hostName(h), title: `Upload to ${TT.hostName(h)}` });
        b.onclick = () => { row.remove(); upload(s, actions, h); };
        row.append(b);
      }
      return actions.append(row);
    }
    host ||= choices[0];
    toast(`Uploading to ${TT.hostName(host)}…`);
    try {
      const r = await send("shotHistoryUpload", { id: s.id, host });
      let copied = r.copied;
      try { await navigator.clipboard.writeText(r.links.join("\n")); copied = true; } catch {}
      toast(`${copied ? "Link copied" : "Uploaded"} · ${TT.hostName(host)}`);
    } catch (err) { toast(`Upload failed: ${err.message}`, true); }
  }
}

// ---- Backup tab ----

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

function initBackup() {
  const BACKUP_CLOUDS = TT.BACKUP_CLOUDS;
  const row = $("driveRow"), now = $("driveNow"), seg = $("driveInterval");
  let busy = false;
  const clouds = async () => {
    const got = await chrome.storage.local.get(BACKUP_CLOUDS.map((c) => c.key));
    return BACKUP_CLOUDS.map((c) => ({ c, st: got[c.key] || {} })).filter(({ st }) => st.connected);
  };
  async function render() {
    const { backup = {} } = await chrome.storage.local.get("backup");
    const interval = Number(backup.interval ?? 24);
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.h) === interval)));
    const on = await clouds();
    // The one that needs something comes first; with both connected, the status names it.
    const signedOut = on.find(({ st }) => st.needsSignIn), waiting = on.find(({ st }) => st.awaitingChoice), failed = on.find(({ st }) => st.lastError);
    const which = (x) => (on.length > 1 ? `${x.c.short} ` : "");
    row.classList.toggle("problem", !on.length || !!(signedOut || waiting || failed));
    now.textContent = !on.length ? "set up" : signedOut ? "sign in" : "sync now";
    now.hidden = !!waiting && !signedOut; // the choice is made in settings (⚙ beside it)
    const last = Math.max(0, ...on.map(({ st }) => st.lastSnapshot || 0));
    $("driveStatus").textContent = busy ? "syncing…"
      : !on.length ? "not connected"
      : signedOut ? `${which(signedOut)}signed out`
      : waiting ? "waiting: choose in settings"
      : failed ? `${which(failed)}last sync failed`
      : last ? `saved ${ago(last)}` : "connected";
    $("driveStatus").title = failed?.st.lastError || on.map(({ c, st }) => [c.short, st.lastCheck ? `checked ${TT.when(st.lastCheck)}` : "", st.email].filter(Boolean).join(" · ")).join("\n");
    now.disabled = busy;
    // Tab 1 notice: signed out without being disconnected (until signed in, or hidden with ×).
    const hidden = await chrome.storage.local.get(BACKUP_CLOUDS.map((c) => `${c.id}NoticeHidden`));
    const notice = on.find(({ c, st }) => st.needsSignIn && !hidden[`${c.id}NoticeHidden`]);
    $("driveNotice").hidden = !notice;
    if (notice) {
      $("driveNotice").dataset.cloud = notice.c.id;
      $("driveNotice").querySelector(".msg").textContent = `${notice.c.name} got signed out, so backups ${on.length > 1 ? "there " : ""}are paused.`;
    }
  }
  render();
  chrome.storage.onChanged.addListener((c, area) => area === "local" && (c.backup || BACKUP_CLOUDS.some((x) => c[x.key] || c[`${x.id}NoticeHidden`])) && render());
  seg.querySelectorAll("button").forEach((b) => (b.onclick = async () => {
    const { backup = {} } = await chrome.storage.local.get("backup");
    await chrome.storage.local.set({ backup: { ...backup, interval: Number(b.dataset.h) } });
  }));
  const settings = () => send("openSettings", { section: "backup" }).then(() => closePopup(), fail);
  $("driveSettings").onclick = settings;
  $("importLocal").onclick = settings;
  const signIn = async (cloud) => {
    const res = await send("backupConnect", { cloud: cloud.c.id });
    return res.awaitingChoice ? `Signed in · ${cloud.c.short} has other snapshots — choose in settings` : `Signed in to ${cloud.c.name}`;
  };
  now.onclick = async () => {
    const on = await clouds();
    const signedOut = on.find(({ st }) => st.needsSignIn);
    if (!on.length || (!signedOut && on.some(({ st }) => st.awaitingChoice))) return settings();
    busy = true;
    render();
    try {
      if (signedOut) toast(await signIn(signedOut));
      else {
        const res = await send("backupNow");
        const saved = res.uploaded ? `Snapshot saved to ${res.savedTo.join(" and ")}` : "Nothing changed since the last snapshot";
        toast(res.failed.length ? `${saved} · ${res.failed.map((f) => f.name).join(" and ")} failed` : saved);
      }
    } catch (err) { fail(err); }
    busy = false;
    render();
  };
  $("exportLocal").onclick = () => send("backupExportLocal").then(() => closePopup(), fail);
  $("driveNoticeClose").onclick = () => chrome.storage.local.set({ [`${$("driveNotice").dataset.cloud || "drive"}NoticeHidden`]: true });
  $("driveNoticeSignIn").onclick = async () => {
    const cloud = (await clouds()).find(({ c }) => c.id === ($("driveNotice").dataset.cloud || "drive"));
    if (!cloud) return;
    $("driveNoticeSignIn").disabled = true;
    try { toast(await signIn(cloud)); } catch (err) { fail(err); }
    $("driveNoticeSignIn").disabled = false;
  };
}

// ---- Clipboard history ----

function initClipboard() {
  let enabled = false, query = "";
  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast("Copied"), fail);
  const oneLine = (t) => t.replace(/\s+/g, " ").trim();

  async function render() {
    ({ clip: { enabled } } = await TT.getSettings());
    setSwitch($("clipToggle"), enabled);
    const { items } = await send("clipList").catch(() => ({ items: [] }));
    const unpinned = items.filter((e) => !e.pinned).length, pinned = items.length - unpinned;
    $("clipStatus").textContent = enabled ? `${unpinned} saved${pinned ? ` · ${pinned} pinned` : ""}` : "";
    // The newest copy, until dismissed with × (it stays in the list; the next copy shows again).
    const { dismissed = {} } = await chrome.storage.local.get("dismissed");
    const latest = items[0]?.at > (dismissed.clip || 0) ? items[0] : null;
    $("clipLatest").hidden = !enabled || !latest;
    if (latest) {
      $("clipLatest").querySelector(".link-text").textContent = oneLine(latest.text);
      $("clipLatest").querySelector("[data-copy]").onclick = () => copy(latest.text);
      $("clipLatest").querySelector("[data-dismiss]").onclick = () => dismiss("clip", latest).then(render);
    }
    if (!$("clipSheet").hidden) renderList(items);
  }

  function renderList(items) {
    const q = query.toLowerCase();
    const shown = items.filter((e) => !q || e.text.toLowerCase().includes(q) || e.site.includes(q))
      .sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at));
    const list = $("clipList");
    if (!shown.length) {
      list.innerHTML = `<li class="empty"></li>`;
      list.firstChild.textContent = items.length ? "Nothing matches" : enabled ? "Copy some text on a page and it shows up here" : "Switch clipboard history on to start saving copied text";
      return;
    }
    list.replaceChildren(...shown.map((e) => {
      const li = document.createElement("li");
      li.className = e.pinned ? "pinned" : "";
      li.title = "Click to copy";
      li.innerHTML = `<div class="meta"><span class="clip-text"></span><span class="clip-meta"></span></div>
        <div class="actions">
          <button class="icon-btn small pin" title="${e.pinned ? "Unpin" : "Pin: kept for good"}"><svg><use href="#i-pin"/></svg></button>
          <button class="icon-btn small del" title="Delete"><svg><use href="#i-close"/></svg></button>
        </div>`;
      li.querySelector(".clip-text").textContent = e.text.length > 600 ? `${e.text.slice(0, 600)}…` : e.text;
      li.querySelector(".clip-meta").textContent = `${e.site} · ${ago(e.at)} · ${e.text.length.toLocaleString()} chars${e.trimmed ? " (trimmed)" : ""}`;
      li.querySelector(".pin").classList.toggle("on", e.pinned);
      li.onclick = (ev) => { if (!ev.target.closest("button")) copy(e.text); };
      li.querySelector(".pin").onclick = () => send("clipPin", { id: e.id, pinned: !e.pinned }).catch(fail);
      li.querySelector(".del").onclick = () => send("clipDelete", { id: e.id }).catch(fail);
      return li;
    }));
  }

  render();
  chrome.storage.onChanged.addListener((c, area) => area === "local" && (c.clipIndex || c.tt) && render());
  $("clipToggle").onclick = async () => {
    const on = $("clipToggle").getAttribute("aria-checked") !== "true";
    setSwitch($("clipToggle"), on);
    await TT.updateSettings({ clip: { enabled: on } }).catch(fail);
    if (on) toast("Copies on web pages are saved from now on");
  };
  $("clipListBtn").onclick = () => { $("clipSheet").hidden = false; query = $("clipSearch").value = ""; render(); $("clipSearch").focus(); };
  $("clipClose").onclick = () => ($("clipSheet").hidden = true);
  $("clipSearch").oninput = () => { query = $("clipSearch").value.trim(); render(); };
  $("clipSettings").onclick = () => send("openSettings", { section: "clipboard" }).then(() => closePopup(), fail);
  // Clearing asks for a second click, like the other lists.
  let armed = 0;
  $("clipClear").onclick = () => {
    const b = $("clipClear");
    if (!b.classList.contains("armed")) {
      b.classList.add("armed", "danger");
      b.textContent = "sure?";
      armed = setTimeout(() => { b.classList.remove("armed"); b.textContent = "clear"; }, 3000);
      return;
    }
    clearTimeout(armed);
    b.classList.remove("armed");
    b.textContent = "clear";
    send("clipClear").catch(fail);
  };
}

// ---- Zoom & rotate images ----

function initImgZoom() {
  const mac = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  const names = { alt: mac ? "option" : "alt", ctrl: mac ? "⌘ cmd" : "ctrl", shift: "shift" };
  $("imgMod").querySelector('[data-mod="alt"]').textContent = names.alt;
  $("imgMod").querySelector('[data-mod="ctrl"]').textContent = names.ctrl;
  async function render() {
    const { imgZoom } = await TT.getSettings();
    setSwitch($("imgToggle"), imgZoom.enabled);
    $("imgMod").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mod === imgZoom.modifier)));
    $("imgModRow").hidden = !imgZoom.enabled;
    $("imgHint").textContent = imgZoom.enabled ? "right-click an image for rotate & zoom controls" : "";
  }
  render();
  chrome.storage.onChanged.addListener((c, area) => area === "local" && c.tt && render());
  $("imgToggle").onclick = () => {
    const on = $("imgToggle").getAttribute("aria-checked") !== "true";
    setSwitch($("imgToggle"), on);
    TT.updateSettings({ imgZoom: { enabled: on } }).catch(fail);
  };
  $("imgMod").querySelectorAll("button").forEach((b) => (b.onclick = () => TT.updateSettings({ imgZoom: { modifier: b.dataset.mod } }).catch(fail)));
}

// ---- Save images on click ----

function initImgDl() {
  const mac = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  const names = { alt: mac ? "option" : "alt", ctrl: mac ? "⌘ cmd" : "ctrl", shift: "shift" };
  $("imgDlMod").querySelector('[data-mod="alt"]').textContent = names.alt;
  $("imgDlMod").querySelector('[data-mod="ctrl"]').textContent = names.ctrl;
  async function render() {
    const { imgDl } = await TT.getSettings();
    setSwitch($("imgDlToggle"), imgDl.enabled);
    $("imgDlKeyRow").hidden = $("imgDlFmtRow").hidden = !imgDl.enabled;
    $("imgDlMod").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mod === imgDl.modifier)));
    $("imgDlFmt").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.fmt === imgDl.format)));
    const folder = TT.cleanFolder(imgDl.folder);
    $("imgDlHint").textContent = imgDl.enabled ? `${names[imgDl.modifier]} + click an image · saved to Downloads${folder ? `/${folder}` : ""}` : "";
  }
  render();
  chrome.storage.onChanged.addListener((c, area) => area === "local" && c.tt && render());
  $("imgDlToggle").onclick = () => {
    const on = $("imgDlToggle").getAttribute("aria-checked") !== "true";
    setSwitch($("imgDlToggle"), on);
    TT.updateSettings({ imgDl: { enabled: on } }).catch(fail);
  };
  $("imgDlMod").querySelectorAll("button").forEach((b) => (b.onclick = () => TT.updateSettings({ imgDl: { modifier: b.dataset.mod } }).catch(fail)));
  $("imgDlFmt").querySelectorAll("button").forEach((b) => (b.onclick = () => TT.updateSettings({ imgDl: { format: b.dataset.fmt } }).catch(fail)));
  $("imgDlSettings").onclick = () => send("openSettings", { section: "screenshot" }).then(() => closePopup(), fail);
}

// ---- Copy & right-click ----
// Only for one site at a time (bg-unlock.js): the first switch unlocks this tab's site and
// ticks "remember" below it; unticking remember keeps it only until Chrome closes. Switching
// it off forgets the site. A remembered site shows both switches on when you come back.

function initUnlock(isWeb) {
  const site = isWeb ? new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "") : "";
  const match = (list) => list.find((s) => site === s || site.endsWith(`.${s}`));
  const main = $("unlockToggle"), remember = $("unlockRemember");
  const live = scope.signal;
  let busy = false;
  async function state() {
    const { unlock } = await TT.getSettings();
    const { unlockSession = [] } = await chrome.storage.session.get("unlockSession");
    const saved = match(unlock.sites), session = match(unlockSession);
    return { on: !!(saved || session), remembered: !!saved, entry: saved || session || site };
  }
  async function render() {
    main.disabled = !isWeb;
    if (!isWeb) {
      setSwitch(main, false);
      $("unlockHint").textContent = "not on this page";
      $("unlockRememberRow").hidden = true;
      return;
    }
    const s = await state();
    if (live.aborted) return;
    setSwitch(main, s.on);
    setSwitch(remember, s.remembered);
    main.setAttribute("aria-label", `Unlock copy and right-click on ${s.entry}`);
    $("unlockHint").textContent = s.on ? `unlocked on ${s.entry}` : `off on ${site}`;
    $("unlockHint").title = s.on && !s.remembered ? `${$("unlockHint").textContent} until Chrome closes` : $("unlockHint").textContent;
    $("unlockRememberRow").hidden = !s.on;
  }
  async function save(on, keep) {
    if (busy) return;
    busy = true;
    try { await send("unlockSite", { site: (await state()).entry, on, remember: keep }); }
    catch (err) { fail(err); }
    finally { busy = false; render(); }
  }
  render();
  onStorage((c, area) => ((area === "local" && c.tt) || (area === "session" && c.unlockSession)) && render());
  // On: remembered by default. Off: forgotten, so "remember" goes off with it.
  main.onclick = () => {
    const on = main.getAttribute("aria-checked") !== "true";
    setSwitch(main, on);
    setSwitch(remember, on);
    $("unlockRememberRow").hidden = !on;
    save(on, on);
  };
  remember.onclick = () => {
    const keep = remember.getAttribute("aria-checked") !== "true";
    setSwitch(remember, keep);
    save(true, keep);
  };
  $("unlockSettings").onclick = () => send("openSettings", { section: "unlock" }).then(() => closePopup(), fail);
}

// ---- Open other sites' links in a new tab ----
// For this tab's site only (bg-newtab.js): links to other sites open in a new tab.

function initNewTab(isWeb) {
  const site = isWeb ? new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "") : "";
  const toggle = $("newTabToggle"), hint = $("newTabHint");
  const live = scope.signal;
  let busy = false;
  const entry = async () => (await TT.getSettings()).newTab.sites.find((s) => site === s || site.endsWith(`.${s}`));
  async function render() {
    toggle.disabled = !isWeb;
    if (!isWeb) {
      setSwitch(toggle, false);
      hint.textContent = "not on this page";
      $("newTabLastRow").hidden = true;
      return;
    }
    const e = await entry();
    if (live.aborted) return;
    setSwitch(toggle, !!e);
    toggle.setAttribute("aria-label", `Open links to other sites in a new tab on ${e || site}`);
    hint.textContent = e ? `on for ${e}` : `off on ${site}`;
    hint.title = e ? `Links to other sites open in a new tab on ${e}` : hint.textContent;
    // A link that just opened in a new tab, seen from either end: from the tab it was clicked
    // in, or from the tab it opened. One click keeps that site's links in place from then on.
    const all = isWeb ? await chrome.storage.session.get(null) : {};
    if (live.aborted) return;
    const recent = Object.entries(all).filter(([k, v]) => k.startsWith("newTabLast:") && Date.now() - v.at < 120000);
    const own = recent.find(([k, v]) => k === `newTabLast:${tab?.id}` && v.site === e);
    const [key, last] = own || recent.filter(([, v]) => v.host === site).sort((a, b) => b[1].at - a[1].at)[0] || [];
    $("newTabLastRow").hidden = !last;
    if (last) {
      $("newTabLastText").textContent = own ? `opened ${last.base} in a new tab` : `opened from ${last.site}`;
      $("newTabLastText").title = `${last.host}, from a link on ${last.site}`;
      $("newTabSame").textContent = "treat as same site";
      $("newTabSame").title = `Links from ${last.site} to ${last.base} (and its subdomains) open in place from now on`;
      $("newTabSame").onclick = async () => {
        try {
          const { newTab } = await TT.getSettings();
          const others = newTab.also.filter((a) => a.site !== last.site);
          const hosts = newTab.also.find((a) => a.site === last.site)?.hosts || [];
          await TT.updateSettings({ newTab: { also: [...others, { site: last.site, hosts: [...new Set([...hosts, last.base])].sort() }] } });
          await chrome.storage.session.remove(key);
          toast(`Links to ${last.base} stay in place on ${last.site}`);
        } catch (err) { fail(err); }
        render();
      };
    }
  }
  render();
  onStorage((c, area) => area === "local" && c.tt && render());
  toggle.onclick = async () => {
    if (busy) return;
    busy = true;
    const on = toggle.getAttribute("aria-checked") !== "true";
    setSwitch(toggle, on);
    try { await send("newTabSite", { site: on ? site : (await entry()) || site, on }); }
    catch (err) { fail(err); }
    finally { busy = false; render(); }
  };
  $("newTabSettings").onclick = () => send("openSettings", { section: "newtab" }).then(() => closePopup(), fail);
}

// ---- Refresh on focus ----
// This tab is refreshed when you come back to it (bg-focus.js). The switch adds this page's
// exact address (or turns on the entry that already matches it; settings can widen an entry
// with *); refresh type, expiry and the threshold are set per entry in settings.

function initFocus(isWeb) {
  const address = isWeb ? TT.focusAddress(tab.url) : "";
  const toggle = $("focusToggle"), hint = $("focusHint");
  const day = (t) => TT.when(t);
  const live = scope.signal, url = tab.url;
  let busy = false;
  // The entry for this page: the one in use, else any that matches it.
  async function entry() {
    const { focus } = await TT.getSettings();
    const all = focus.entries.filter((e) => TT.focusMatches(e.pattern, url));
    return { entries: focus.entries, e: all.find((e) => TT.focusState(e) === "on") || all[0] };
  }
  async function render() {
    toggle.disabled = !isWeb;
    if (!isWeb) {
      setSwitch(toggle, false);
      hint.textContent = "not on this page";
      return;
    }
    const { e } = await entry();
    if (live.aborted) return;
    const state = e ? TT.focusState(e) : "off";
    setSwitch(toggle, state === "on");
    if (!e) hint.textContent = "off for this page";
    else if (state === "expired") hint.textContent = `expired ${day(TT.focusExpiresAt(e))} · ${e.pattern}`;
    else if (state === "off") hint.textContent = `off · ${e.pattern}`;
    else hint.textContent = `${e.hard ? "hard" : "normal"} · ${TT.focusExpiresAt(e) ? `until ${day(TT.focusExpiresAt(e))}` : "no expiry"} · ${e.pattern}`;
    hint.title = e ? hint.textContent : `off for ${address}`;
    toggle.setAttribute("aria-label", `Refresh ${e?.pattern || address} when you come back to it`);
  }
  render();
  onStorage((c, area) => area === "local" && c.tt && render());
  toggle.onclick = async () => {
    if (busy || toggle.disabled) return;
    busy = true;
    try {
      const { entries, e } = await entry();
      const on = !e || TT.focusState(e) !== "on";
      setSwitch(toggle, on);
      // Off keeps the entry (and its settings); on again restarts its expiry.
      const next = !e ? [...entries, TT.focusNew(address)]
        : entries.map((x) => (x.id === e.id ? { ...x, on, ...(on ? { enabledAt: Date.now() } : {}) } : x));
      await TT.updateSettings({ focus: { entries: next } });
    } catch (err) { fail(err); }
    finally { busy = false; render(); }
  };
  $("focusSettings").onclick = () => send("openSettings", { section: "focus" }).then(() => closePopup(), fail);
}

// ---- Text from image ----
// "area" lets you drag a box on the page (like an area screenshot); bg-ocr.js reads it with
// OCR.space and the card on the page shows the text, already copied. No key of your own:
// Extra Guac's shared ones, until they're used up, then settings to add one.

function initOcr(isWeb) {
  const btn = $("ocrArea");
  btn.disabled = !isWeb;
  btn.title = isWeb ? "Drag over text on the page to read and copy it" : "Only on web pages";
  btn.onclick = async () => {
    const { ocr } = await TT.getSettings();
    // No key of its own: Extra Guac's shared ones are used (free plan), until they run out.
    if (!ocr.key.trim() && ocr.plan === "pro") {
      toast("Add your OCR.space PRO key first", true);
      return send("openSettings", { section: "ocr" }).then(() => closePopup(), fail);
    }
    if (btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    try {
      await send("ocr");
      closePopup(); // the page shows the selection overlay
    } catch (err) {
      // The shared keys are used up: settings, to add a key of your own.
      if (/shared OCR\.space keys are used up/.test(err.message)) { toast(err.message, true); return send("openSettings", { section: "ocr" }).then(() => closePopup(), fail); }
      fail(/Cannot access|cannot be scripted|chrome:\/\//i.test(err.message) ? new Error("Chrome doesn't allow reading this page") : err);
    } finally {
      btn.classList.remove("busy");
    }
  };
  $("ocrSettings").onclick = () => send("openSettings", { section: "ocr" }).then(() => closePopup(), fail);
}
