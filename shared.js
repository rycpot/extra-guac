// Settings shared by the background worker, popup and settings window.
// Blur settings live separately under "pii" (see pii-rules.js).
(() => {
  const DEFAULTS = {
    theme: "dark", // "dark" | "light" | "auto" (follow the system)
    openIn: "popup", // what the toolbar icon opens: "popup" | "panel" (Chrome's side panel)
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
    upload: { catbox: false, x02: false, catboxUserhash: "", x02Key: "", x02Verified: false },
  };

  const MAX_KEYWORDS = 20;

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

  globalThis.TT = { DEFAULTS, MAX_KEYWORDS, SHORTENERS, merge, getSettings, updateSettings, monthKey, cleanFolder, applyTheme };
})();
