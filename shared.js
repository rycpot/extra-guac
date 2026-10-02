// Settings shared by the background worker, popup and settings window.
// Blur settings live separately under "pii" (see pii-rules.js).
(() => {
  const DEFAULTS = {
    theme: "dark", // "dark" | "light" | "auto" (follow the system)
    openIn: "panel", // what the toolbar icon opens: "popup" | "panel" (Chrome's side panel)
    shot: { format: "png", quality: 92, folder: "" },
    refresh: {
      mode: "fixed", // "fixed" | "random"
      fixed: 30,
      min: 20,
      max: 45,
      // { text, enabled }; any enabled one on the page counts. Older versions kept a
      // single "keyword" string, which the popup turns into the first of these.
      keywords: [],
      continueAfterMatch: false,
      notify: true,
      sound: "https://audio.jukehost.co.uk/sKgfWrjaHsuxPYeGQiFoGuWXg14F0xfV",
    },
    shortener: {
      service: "cuttly",
      keys: { cuttly: "", tinyurl: "", dub: "" },
      paid: { cuttly: false, tinyurl: false, dub: false },
    },
    awake: { lastAmount: 45, lastUnit: "min" },
    picker: { selectorFormat: "css" }, // "css" | "xpath"
    // Rules: { domain, find, replace, auto, on }. Auto rules redirect on navigation;
    // manual ones run from the page's right-click menu.
    redirect: { enabled: false, rules: [] },
    // Dark mode: enabled = on/off everywhere; "sites" = only the sites listed, "all" =
    // everywhere except exclude; force = dark pages darkened (inverted) anyway.
    dark: { enabled: false, mode: "sites", sites: [], exclude: [], force: [] },
    upload: { catbox: false, x02: false, catboxUserhash: "", x02Key: "", x02Verified: false },
    // Clipboard history: limit = unpinned entries kept; maxAgeDays 0 = no age limit;
    // menu = pinned entries in the right-click menu; exclude = sites never recorded.
    clip: { enabled: false, limit: 200, maxAgeDays: 0, menu: false, exclude: [] },
    // Zoom & rotate images: modifier + scroll over an image ("alt" = Option on a Mac).
    imgZoom: { enabled: false, modifier: "alt" },
    // Save images on click: modifier + click; format "original" | "png" | "jpg" | "webp";
    // folder = sub-folder of Downloads ("" = Downloads itself).
    imgDl: { enabled: false, modifier: "alt", format: "original", folder: "" },
    // Which of the first three popup tabs each section is in, top to bottom (settings →
    // general → tools layout). The fourth tab (backup) is fixed.
    layout: {
      tools: ["screenshot", "blur", "dark", "refresh", "autoRefresh", "shortener", "volume", "awake", "redirect", "highlight", "color", "font", "element", "remove", "clipboard"],
      page: ["imgzoom", "imgdl", "upload"],
      extra: [],
    },
  };

  // Popup tabs that hold sections, and the sections' names.
  const PANELS = { tools: "tab 1", page: "tab 2", extra: "tab 3" };
  const SECTIONS = {
    screenshot: "screenshot", blur: "privacy blur", dark: "dark mode", refresh: "refresh", autoRefresh: "auto-refresh",
    shortener: "URL shorten", volume: "volume", awake: "awake", color: "what color?", element: "what element?",
    font: "what font?", remove: "remove elements", highlight: "highlight words", imgzoom: "zoom & rotate images", imgdl: "save images on click", clipboard: "clipboard history", redirect: "URL auto redirect", upload: "upload images",
  };

  // A saved layout with unknown sections dropped and any missing ones (new in an update)
  // added to the end of their usual tab.
  function layoutOf(saved) {
    const out = {}, seen = new Set();
    for (const p of Object.keys(PANELS)) {
      out[p] = (Array.isArray(saved?.[p]) ? saved[p] : []).filter((id) => SECTIONS[id] && !seen.has(id) && seen.add(id));
    }
    for (const [p, ids] of Object.entries(DEFAULTS.layout)) for (const id of ids) if (!seen.has(id)) out[p].push(id);
    return out;
  }

  const MAX_KEYWORDS = 20;

  // Highlight words (storage.local "hl"). Limits keep pages fast and the settings usable.
  const HL_LIMITS = { global: 1000, site: 300, sites: 200, length: 100 };
  // Neon, so marks catch the eye even while scrolling fast: yellow, green, cyan, orange, magenta, purple.
  const HL_COLORS = ["#fff01f", "#39ff14", "#00f0ff", "#ff5f1f", "#ff2fd6", "#b026ff"];
  function hlOf(hl) {
    const h = hl && typeof hl === "object" ? hl : {};
    const list = (l, color) => ({ on: l?.on !== false, color: /^#[0-9a-f]{6}$/i.test(l?.color || "") ? l.color : color, partial: !!l?.partial, words: Array.isArray(l?.words) ? l.words : [] });
    const sites = {};
    for (const [site, l] of Object.entries(h.sites || {})) sites[site] = list(l, HL_COLORS[2]);
    return { enabled: !!h.enabled, global: list(h.global, HL_COLORS[0]), exclude: Array.isArray(h.exclude) ? h.exclude : [], sites };
  }

  const SHORTENERS = {
    cuttly: { label: "cutt.ly", freeLimit: 30, keyHelp: "https://cutt.ly/edit", docs: "https://cutt.ly/api-documentation/regular-api" },
    tinyurl: { label: "tinyurl", freeLimit: 30, keyHelp: "https://tinyurl.com/app/dev", docs: "https://tinyurl.com/app/dev" },
    dub: { label: "dub.co", freeLimit: 25, keyHelp: "https://app.dub.co/settings/tokens", docs: "https://dub.co/docs/api-reference/authentication" },
  };

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  function merge(base, over) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
    return out;
  }

  async function getSettings() {
    const { tt } = await chrome.storage.local.get("tt");
    return merge(DEFAULTS, tt);
  }

  async function updateSettings(patch) {
    const next = merge(await getSettings(), patch);
    await chrome.storage.local.set({ tt: next });
    return next;
  }

  const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  // A sub-folder of Downloads: no "..", no absolute paths, only safe characters.
  function cleanFolder(folder = "") {
    return folder
      .split(/[\\/]+/)
      .map((p) => p.trim().replace(/[<>:"|?*\x00-\x1f]/g, "").replace(/^\.+$/, ""))
      .filter(Boolean)
      .join("/");
  }

  // Applies the theme setting to a page: sets data-theme on <html>. Pages are dark
  // until this runs; "auto" follows the system.
  async function applyTheme() {
    const apply = (t) => (document.documentElement.dataset.theme = t);
    apply((await getSettings()).theme);
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.tt) apply(merge(DEFAULTS, c.tt.newValue).theme);
    });
  }

  globalThis.TT = { DEFAULTS, MAX_KEYWORDS, HL_LIMITS, HL_COLORS, hlOf, SHORTENERS, PANELS, SECTIONS, layoutOf, merge, getSettings, updateSettings, monthKey, cleanFolder, applyTheme };
})();
