// Scratch pads: six pads that save themselves as you type. Each is rich text (bold,
// italic, colors, lists, links, images) or plain text (any text file, colored for its
// language). Storage and images: pad-store.js. Backups: bg-backup.js.
//
// The rich editor is an iframe of its own, so the page's styles can't leak into the text.
// Pasted text arrives as plain text; pasted or dropped images are scaled down and stored
// apart from the text. The plain editor is a transparent textarea under a colored copy
// of the same text (speed-highlight, loaded one language at a time).
//
// Markdown and HTML pads are plain pads with a preview (the eye at the top): Markdown drawn
// by md-render.js; HTML in a locked-down frame (no scripts, no forms, nothing fetched from
// the web unless allowed for that pad).
//
// Dropping a text file: an empty pad takes it (switching to plain); a pad with something
// in it never loses it: the file opens in the first empty pad, or nothing happens when
// all six are full. Anything that replaces a pad's content (switching rich/plain, clear,
// a restored backup) keeps the old version for "Restore previous".
(async () => {
  const $ = (id) => document.getElementById(id);
  const { PAD_COUNT, padKey, prevKey, padRefs, padEmpty, sameContent } = PADS;

  // One pad tab at a time: another one (a duplicated tab, a bookmark, a second window) hands
  // over to the first and closes. The oldest (lowest id) stays, so two opened at once can't
  // both go.
  const me = await chrome.tabs.getCurrent().catch(() => null);
  if (me) {
    const base = chrome.runtime.getURL("scratch.html");
    const first = (await chrome.tabs.query({}))
      .filter((t) => t.id !== me.id && (t.url || t.pendingUrl || "").startsWith(base))
      .sort((a, b) => a.id - b.id)[0];
    if (first && first.id < me.id) {
      const n = Number(location.hash.slice(1));
      await chrome.tabs.update(first.id, { active: true, ...(n >= 1 && n <= PAD_COUNT ? { url: `${base}#${n}` } : {}) });
      await chrome.windows.update(first.windowId, { focused: true }).catch(() => {});
      chrome.tabs.remove(me.id);
      return;
    }
  }
  const SAVE_DELAY = 600;
  const WRITER = crypto.randomUUID(); // this tab; its own saves coming back are ignored
  const ownSaves = new Set(); // "n:updatedAt" of this tab's writes still to come back
  const COLORS = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"];
  const TEXT_BARE = 1_000_000; // characters; above this: bare textarea, no colors or line numbers
  const TEXT_HL_MAX = 400_000; // above this: no colors
  const TEXT_HL_SYNC = 100_000; // up to this, colors follow every keystroke; above, after a pause

  // [speed-highlight language, label, extensions, exact file names]
  const LANGS = [
    ["asm", "Assembly", ["asm", "s", "nasm"]],
    ["c", "C / C++", ["c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"]],
    ["css", "CSS", ["css", "scss", "less"]],
    ["csv", "CSV", ["csv", "tsv"]],
    ["diff", "Diff", ["diff", "patch"]],
    ["docker", "Dockerfile", [], ["dockerfile", "containerfile"]],
    ["go", "Go", ["go"]],
    ["html", "HTML", ["html", "htm", "xhtml", "vue", "svelte"]],
    ["http", "HTTP", ["http"]],
    ["ini", "INI / config", ["ini", "cfg", "conf", "env", "properties", "editorconfig", "gitconfig", "desktop", "service"]],
    ["java", "Java", ["java"]],
    ["js", "JavaScript", ["js", "mjs", "cjs", "jsx"]],
    ["json", "JSON", ["json", "jsonc", "json5", "jsonl", "ndjson", "geojson", "webmanifest", "har"]],
    ["log", "Log", ["log"]],
    ["lua", "Lua", ["lua"]],
    ["make", "Makefile", ["mk", "mak"], ["makefile", "gnumakefile"]],
    ["md", "Markdown", ["md", "markdown", "mdx", "mkd"]],
    ["pl", "Perl", ["pl", "pm"]],
    ["py", "Python", ["py", "pyw", "pyi"]],
    ["rs", "Rust", ["rs"]],
    ["bash", "Shell", ["sh", "bash", "zsh", "ksh", "bashrc", "zshrc", "profile", "envrc", "command"]],
    ["sql", "SQL", ["sql"]],
    ["toml", "TOML", ["toml"]],
    ["ts", "TypeScript", ["ts", "tsx", "mts", "cts"]],
    ["xml", "XML / SVG", ["xml", "svg", "plist", "xsl", "xslt", "xsd", "rss", "atom", "kml", "gpx"]],
    ["yaml", "YAML", ["yaml", "yml"]],
  ];
  const LANG_BY_EXT = new Map(), LANG_BY_NAME = new Map(), LANG_LABEL = new Map();
  for (const [id, label, exts, names = []] of LANGS) {
    LANG_LABEL.set(id, label);
    for (const e of exts) LANG_BY_EXT.set(e, id);
    for (const n of names) LANG_BY_NAME.set(n, id);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const blank = () => ({ mode: "rich", title: "", body: "", lang: null, langManual: false, wrap: true, updatedAt: 0 });
  // Pads from before the preview: a Markdown pad was a rich pad showing it formatted (md).
  function upgrade(rec) {
    if (rec.md) {
      if (rec.mode === "rich") Object.assign(rec, { mode: "plain", lang: "md", wrap: true, preview: true });
      delete rec.md;
    }
    return rec;
  }
  const PREVIEWABLE = new Set(["md", "html"]);
  const canPreview = (p) => p.mode === "plain" && PREVIEWABLE.has(p.lang);
  const previewing = (p = cur()) => canPreview(p) && !!p.preview;

  // ---- State ----------------------------------------------------------------------------
  const pads = {}; // n -> record
  const prevs = {}; // n -> record or null
  let current = 1;
  let dirty = false;
  let saveTimer = 0;
  const imgSizes = new Map(); // image id -> bytes
  const imgUrls = new Map(); // image id -> blob: URL shown in the editor

  TT.applyTheme();
  const stored = await chrome.storage.local.get([...PADS.PAD_KEYS, ...PADS.PREV_KEYS, "padState"]);
  for (let n = 1; n <= PAD_COUNT; n++) {
    pads[n] = upgrade({ ...blank(), ...(stored[padKey(n)] || {}) });
    prevs[n] = stored[prevKey(n)] ? upgrade(stored[prevKey(n)]) : null;
    // A previous copy that's the same as the pad brings nothing back: dropped.
    if (prevs[n] && sameContent(prevs[n], pads[n])) { prevs[n] = null; chrome.storage.local.remove(prevKey(n)); }
  }
  const fromHash = () => {
    const n = Number(location.hash.slice(1));
    return n >= 1 && n <= PAD_COUNT ? n : 0;
  };
  current = fromHash() || Number(stored.padState?.current) || 1;
  if (!(current >= 1 && current <= PAD_COUNT)) current = 1;
  const cur = () => pads[current];
  const padName = (n) => pads[n].title || `Pad ${n}`;

  // ---- Toast ----------------------------------------------------------------------------
  let toastTimer = 0;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), Math.min(6000, Math.max(2500, 1000 + msg.length * 55)));
  }

  // ---- Pad strip and top bar ------------------------------------------------------------
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  };
  function paintStrip() {
    const box = $("pads");
    if (!box.children.length) {
      for (let n = 1; n <= PAD_COUNT; n++) {
        const b = document.createElement("button");
        b.className = "num";
        b.textContent = n;
        b.onclick = () => openPad(n);
        box.append(b);
      }
    }
    [...box.children].forEach((b, i) => {
      const n = i + 1, p = pads[n];
      const empty = n === current ? isCurrentEmpty() : padEmpty(p);
      b.classList.toggle("filled", !empty);
      b.classList.toggle("current", n === current);
      b.title = `${padName(n)} · ${n === current ? "open now" : empty ? "empty" : `${p.mode}, edited ${ago(p.updatedAt)}`}`;
      if (n === current) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
  }
  function paintTop() {
    const p = cur();
    $("title").textContent = padName(current);
    $("modeRich").setAttribute("aria-pressed", String(p.mode === "rich"));
    $("modePlain").setAttribute("aria-pressed", String(p.mode === "plain"));
    $("previewBtn").hidden = !canPreview(p);
    $("previewBtn").setAttribute("aria-pressed", String(previewing(p)));
    $("previewBtn").title = previewing(p) ? "Back to editing (Esc)" : `Preview the ${p.lang === "html" ? "page" : "Markdown"}`;
    $("restore").hidden = !prevs[current];
    $("restore").title = prevs[current]
      ? `Put back the ${prevs[current].mode} version from ${ago(prevs[current].savedAt || prevs[current].updatedAt)} (press again to swap back)`
      : "";
    document.title = `${padName(current)} · Scratch pads`;
  }

  // ---- Saving ---------------------------------------------------------------------------
  function syncFromEditor() {
    const p = cur();
    if (p.mode === "rich") {
      if (rich.doc) {
        const html = sanitize(rich.doc.body.innerHTML);
        p.body = padEmpty({ mode: "rich", body: html }) ? "" : html;
      }
    } else p.body = $("textInput").value;
  }
  function isCurrentEmpty() {
    const p = cur();
    if (p.mode === "plain") return $("textInput").value === "";
    if (!rich.doc) return padEmpty(p);
    return !rich.doc.body.querySelector("img") && !rich.doc.body.textContent.replace(/\s/g, "");
  }
  function changed() {
    dirty = true;
    $("status").textContent = statusText("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    syncFromEditor();
    const p = cur();
    p.updatedAt = Date.now();
    p.writer = WRITER;
    ownSaves.add(`${current}:${p.updatedAt}`);
    let state = "Saved";
    try {
      await chrome.storage.local.set({ [padKey(current)]: p });
    } catch (err) {
      dirty = true;
      state = "Not saved";
      toast(`Couldn't save: ${err.message}`);
    }
    paintStrip();
    paintMeter();
    $("status").textContent = statusText(state);
  }
  // Writes a pad that isn't being edited (or one whose editor is about to be reloaded); for
  // the open pad, a save still waiting would put the old editor text into it, so it's dropped.
  async function writePad(n, rec) {
    if (n === current) { clearTimeout(saveTimer); dirty = false; }
    pads[n] = { ...rec, updatedAt: Date.now(), writer: WRITER };
    ownSaves.add(`${n}:${pads[n].updatedAt}`);
    await chrome.storage.local.set({ [padKey(n)]: pads[n] });
  }
  async function keepPrev(n, rec) {
    prevs[n] = { ...rec, savedAt: Date.now() };
    delete prevs[n].writer;
    delete prevs[n].alt;
    await chrome.storage.local.set({ [prevKey(n)]: prevs[n] });
  }
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && saveNow());
  window.addEventListener("pagehide", () => saveNow());

  let lastState = "";
  function statusText(state) {
    lastState = state;
    const p = cur();
    if (previewing(p)) return state; // the footer already says it's a preview
    if (p.mode !== "plain") return state; // image space: the chip beside it
    const ta = $("textInput"), v = ta.value;
    const lines = countLines(v);
    const pos = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
    const before = v.lastIndexOf("\n", pos - 1);
    const ln = pos ? countLines(v.slice(0, pos)) : 1;
    return `Ln ${ln.toLocaleString()}, Col ${(pos - before).toLocaleString()} · ${lines.toLocaleString()} line${lines === 1 ? "" : "s"} · ${v.length.toLocaleString()} chars · ${state}`;
  }

  // Another tab (or a restored backup) changed a pad.
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    let repaint = false;
    for (let n = 1; n <= PAD_COUNT; n++) {
      const pc = c[padKey(n)], vc = c[prevKey(n)];
      if (vc) {
        // This page's own copy coming back (written just before the pad changes) is kept as is;
        // one from elsewhere that's the same as the pad brings nothing back, so it goes.
        const own = vc.newValue && prevs[n] && vc.newValue.savedAt === prevs[n].savedAt;
        if (!own) {
          prevs[n] = vc.newValue ? upgrade(vc.newValue) : null;
          if (prevs[n] && sameContent(prevs[n], pc?.newValue ? upgrade({ ...pc.newValue }) : pads[n])) { prevs[n] = null; chrome.storage.local.remove(prevKey(n)); }
        }
        repaint = true;
      }
      // This tab's own save coming back (a restored copy of one is not: it's not expected).
      if (!pc || (pc.newValue?.writer === WRITER && ownSaves.delete(`${n}:${pc.newValue.updatedAt}`))) continue;
      repaint = true;
      if (n === current && dirty) {
        // Replaced while being edited (a backup restored meanwhile): the restored version is
        // shown, and what was being typed goes to Restore previous.
        syncFromEditor();
        const mine = { ...cur() };
        clearTimeout(saveTimer);
        dirty = false;
        pads[n] = upgrade({ ...blank(), ...(pc.newValue || {}) });
        if (!padEmpty(mine) && !sameContent(mine, pads[n])) keepPrev(n, mine);
        showPad({ focus: false });
        toast("This pad was just replaced (a restored backup). What you were typing is in Restore previous.");
        continue;
      }
      pads[n] = upgrade({ ...blank(), ...(pc.newValue || {}) });
      if (n === current) showPad({ focus: false });
    }
    if (repaint) { paintStrip(); paintTop(); loadSizes().finally(paintMeter); }
  });

  // ---- Opening pads, modes, restore, clear ----------------------------------------------
  async function openPad(n) {
    if (n === current) return;
    await saveNow();
    current = n;
    history.replaceState(null, "", `#${n}`);
    chrome.storage.local.set({ padState: { current: n } });
    showPad();
  }
  window.addEventListener("hashchange", () => {
    const n = fromHash();
    if (n) openPad(n);
  });

  function paintViews() {
    const p = cur(), prev = previewing(p);
    $("richView").hidden = p.mode !== "rich";
    $("plainView").hidden = p.mode !== "plain" || prev;
    $("previewView").hidden = !prev;
    $("richTools").hidden = p.mode !== "rich";
    $("plainTools").hidden = p.mode !== "plain" || prev;
    $("previewNote").hidden = !prev;
  }
  function showPad({ focus = true } = {}) {
    const p = cur();
    closePops();
    paintViews();
    if (p.mode === "rich") loadRich(p.body, focus);
    else {
      loadPlain(p, focus && !previewing(p));
      if (previewing(p)) showPreview();
    }
    paintTop();
    paintStrip();
    paintMeter();
    $("status").textContent = statusText(p.updatedAt ? `Saved ${ago(p.updatedAt)}` : "Not saved yet");
  }

  // Switching keeps the other version alongside (alt): going back without editing in
  // between brings it back exactly, formatting, colors and images included. After an
  // edit the text is converted, and "Restore previous" holds the formatted version.
  const textOf = (rec) => (rec.mode === "rich" ? htmlToText(rec.body || "") : rec.body || "");
  async function setMode(mode) {
    const p = cur();
    if (p.mode === mode) return;
    syncFromEditor();
    const before = { ...p };
    const wasEmpty = padEmpty(before);
    const alt = !wasEmpty && p.alt?.mode === mode ? p.alt : null;
    const untouched = !!alt && textOf(before) === alt.text;
    if (untouched) {
      p.body = alt.body;
    } else {
      // The version Restore previous offers: the formatted one when coming back to it.
      const prev = alt ? { ...before, mode: alt.mode, body: alt.body } : before;
      if (!padEmpty(prev)) await keepPrev(current, prev);
      p.body = wasEmpty ? "" : mode === "plain" ? htmlToText(p.body) : textToHtml(p.body);
    }
    p.mode = mode;
    if (mode === "plain") {
      if (!p.langManual) p.lang = sniffLang(p.body);
      p.wrap = !p.lang || p.lang === "md";
    }
    if (wasEmpty) delete p.alt;
    else p.alt = { mode: before.mode, body: before.body, text: textOf(p) };
    // Written as is: the editor on screen still shows the old version until showPad.
    clearTimeout(saveTimer);
    dirty = false;
    await writePad(current, p);
    showPad();
    if (untouched || wasEmpty) return;
    if (mode === "plain" && before.mode === "rich") toast("Plain text now. Switch back to Rich before editing to keep the formatting.");
    else if (alt) toast("The text changed, so it's unformatted rich text now. Restore previous brings back the formatted version.");
  }
  $("modeRich").onclick = () => setMode("rich");
  $("modePlain").onclick = () => setMode("plain");

  $("restore").onclick = async () => {
    const prev = prevs[current];
    if (!prev) return;
    syncFromEditor();
    const now = { ...cur() };
    const { savedAt, ...rec } = prev;
    if (sameContent(upgrade({ ...rec }), now)) {
      prevs[current] = null;
      await chrome.storage.local.remove(prevKey(current));
      paintTop();
      paintMeter();
      return toast("The previous version is the same as what's here, so there's nothing to restore.");
    }
    await writePad(current, upgrade({ ...blank(), ...rec }));
    if (padEmpty(now)) {
      prevs[current] = null;
      await chrome.storage.local.remove(prevKey(current));
    } else await keepPrev(current, now);
    dirty = false;
    showPad();
    toast(padEmpty(now) ? "Previous version restored" : "Previous version restored. Press again to swap back.");
  };

  $("clearBtn").onclick = async () => {
    syncFromEditor();
    const p = cur();
    if (padEmpty(p)) return toast("This pad is already empty");
    await keepPrev(current, p);
    await writePad(current, { ...blank(), mode: p.mode });
    dirty = false;
    showPad();
    toast("Pad cleared. Restore previous brings it back.");
  };

  // ---- Name -----------------------------------------------------------------------------
  $("title").onclick = () => {
    const input = $("titleInput");
    input.value = cur().title;
    input.placeholder = `Pad ${current}`;
    $("title").hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  };
  function endRename(save) {
    const input = $("titleInput");
    if (input.hidden) return;
    if (save) {
      cur().title = input.value.trim().slice(0, 120);
      dirty = true;
      saveNow();
    }
    input.hidden = true;
    $("title").hidden = false;
    paintTop();
    paintStrip();
  }
  $("titleInput").onkeydown = (e) => {
    if (e.key === "Enter") endRename(true);
    else if (e.key === "Escape") endRename(false);
  };
  $("titleInput").onblur = () => endRename(true);

  // ---- Export ---------------------------------------------------------------------------
  const safeName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/^\.+/, "").trim() || "pad";
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
  }
  const blobToDataUrl = (blob) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
  // Light-theme colors, for a file read outside Extra Guac.
  // An exported rich pad says so (older exports are known by their stylesheet), so dropping
  // it back in opens it as a rich pad again; other .html files open as plain text.
  const PAD_EXPORT = "Extra Guac scratch pad";
  const EXPORT_STYLE = "body{max-width:720px;margin:32px auto;padding:0 16px;font:15px/1.6 system-ui,sans-serif;color:#1f2328}img{max-width:100%;height:auto}ul,ol{margin:0 0 0 1.5em;padding:0}a{color:#0066d6}";
  const EXPORT_MAX = PADS.TEXT_MAX + Math.ceil(PADS.IMG_LIMIT * 4 / 3) + 1048576; // text + base64 images + markup
  const isPadExport = (name, text) => /\.html?$/i.test(name) && (text.includes(`<meta name="generator" content="${PAD_EXPORT}">`) || text.includes(`<style>${EXPORT_STYLE}</style>`));
  const EXPORT_COLORS = { gray: "#6b7280", red: "#d92d20", orange: "#d9480f", yellow: "#a87d00", green: "#2b8a3e", blue: "#1c6fd1", purple: "#6741d9", pink: "#c2255c" };
  $("exportBtn").onclick = async () => {
    await saveNow();
    syncFromEditor();
    const p = cur();
    if (padEmpty(p)) return toast("Nothing to export: this pad is empty");
    const base = safeName(padName(current));
    if (p.mode === "plain") {
      const ext = (LANGS.find((l) => l[0] === p.lang)?.[2] || [])[0] || "txt";
      const name = /\.[a-z0-9]{1,8}$/i.test(base) ? base : p.lang === "docker" ? "Dockerfile" : p.lang === "make" ? "Makefile" : `${base}.${ext}`;
      return download(name, new Blob([p.body], { type: "text/plain;charset=utf-8" }));
    }
    const doc = new DOMParser().parseFromString(`<body>${p.body}`, "text/html");
    for (const img of doc.querySelectorAll("img[data-img]")) {
      const rec = await PADS.imgGet(img.dataset.img).catch(() => null);
      if (rec?.blob) img.src = await blobToDataUrl(rec.blob);
      img.removeAttribute("data-img");
    }
    for (const f of doc.querySelectorAll("font[data-c]")) {
      if (EXPORT_COLORS[f.dataset.c]) f.setAttribute("color", EXPORT_COLORS[f.dataset.c]);
      f.removeAttribute("data-c");
    }
    const html = `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="generator" content="${PAD_EXPORT}"><title>${esc(padName(current))}</title>
<style>${EXPORT_STYLE}</style>
</head><body>\n${doc.body.innerHTML}\n</body></html>\n`;
    download(`${base.replace(/\.html?$/i, "")}.html`, new Blob([html], { type: "text/html;charset=utf-8" }));
  };

  // ---- Rich editor ----------------------------------------------------------------------
  const rich = { doc: null, ready: null, linkRange: null };
  // Only what the toolbar can make survives a save or a restore; anything else is dropped
  // (or, for unknown wrappers, reduced to its text).
  const KEEP = new Set(["DIV", "P", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "UL", "OL", "LI", "A", "FONT", "IMG", "SPAN", "BLOCKQUOTE"]);
  const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH", "LINK", "META", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "VIDEO", "AUDIO", "CANVAS", "HEAD", "TITLE"]);
  function sanitize(html) {
    const src = new DOMParser().parseFromString(`<body>${html}`, "text/html").body;
    const out = document.implementation.createHTMLDocument("");
    const walk = (from, to) => {
      for (const n of from.childNodes) {
        if (n.nodeType === 3) { to.append(out.createTextNode(n.nodeValue)); continue; }
        if (n.nodeType !== 1 || DROP.has(n.tagName)) continue;
        if (!KEEP.has(n.tagName)) { walk(n, to); continue; }
        const el = out.createElement(n.tagName.toLowerCase());
        if (/^(DIV|P|LI|BLOCKQUOTE)$/.test(n.tagName)) {
          const align = (n.style.textAlign || n.getAttribute("align") || "").toLowerCase();
          if (/^(left|center|right|justify)$/.test(align)) el.style.textAlign = align;
        } else if (n.tagName === "A") {
          const href = n.getAttribute("href") || "";
          if (/^(https?:|mailto:)/i.test(href)) el.setAttribute("href", href);
        } else if (n.tagName === "FONT") {
          const c = n.getAttribute("data-c");
          if (COLORS.includes(c) || c === "default") el.setAttribute("data-c", c);
        } else if (n.tagName === "IMG") {
          const id = n.getAttribute("data-img") || "";
          if (!PADS.IMG_ID.test(id)) continue;
          el.setAttribute("data-img", id);
          const alt = n.getAttribute("alt");
          if (alt) el.setAttribute("alt", alt.slice(0, 200));
        }
        to.append(el);
        walk(n, el);
      }
    };
    walk(src, out.body);
    return out.body.innerHTML;
  }

  // Plain-text version of rich HTML: bullets become "- ", numbers "1. ", links "text <url>".
  function htmlToText(html) {
    const root = new DOMParser().parseFromString(`<body>${html}`, "text/html").body;
    let out = "";
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, " "); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (tag === "BR") out += "\n";
        else if (tag === "IMG") out += n.alt ? `[${n.alt}]` : "[image]";
        else if (tag === "LI") {
          if (out && !out.endsWith("\n")) out += "\n";
          out += n.parentElement?.tagName === "OL" ? `${[...n.parentElement.children].indexOf(n) + 1}. ` : "- ";
          walk(n);
          if (!out.endsWith("\n")) out += "\n";
        } else if (tag === "A") {
          const start = out.length;
          walk(n);
          const text = out.slice(start).trim();
          const href = n.getAttribute("href") || "";
          if (href && href !== text && !href.startsWith("mailto:")) out += ` <${href}>`;
        } else {
          const block = /^(DIV|P|UL|OL|BLOCKQUOTE)$/.test(tag);
          if (block && out && !out.endsWith("\n")) out += "\n";
          walk(n);
          if (block && out && !out.endsWith("\n")) out += "\n";
        }
      }
    };
    walk(root);
    return out.replace(/[ \t]+\n/g, "\n").replace(/^\n+|\n+$/g, "");
  }
  const textToHtml = (text) => text.split("\n").map((l) => (l ? `<div>${esc(l)}</div>` : "<div><br></div>")).join("");

  let frameSrc = ""; // the rich editor's page, reused for the Markdown preview
  function setupRich() {
    const frame = $("richFrame");
    const font = chrome.runtime.getURL("fonts/InterVariable.woff2");
    const palette = (shades) => COLORS.map((c, i) => `--c-${c}:${shades[i]};`).join("");
    const dark = palette(["#a1a1aa", "#ff6b6b", "#ff922b", "#ffd43b", "#69db7c", "#4dabf7", "#b197fc", "#f783ac"]) + "--fg:rgba(255,255,255,.92);--muted:rgba(255,255,255,.38);--accent:#4da3ff;--sel:rgba(10,132,255,.35);--box:rgba(255,255,255,.07);--line:rgba(255,255,255,.14);"
      + "--k-kwd:#ff7b72;--k-str:#7ee787;--k-cmnt:rgba(255,255,255,.42);--k-num:#79c0ff;--k-func:#d2a8ff;--k-class:#ffa657;--k-oper:rgba(255,255,255,.55);--k-var:#79c0ff;color-scheme:dark;";
    const light = palette(["#6b7280", "#d92d20", "#d9480f", "#a87d00", "#2b8a3e", "#1c6fd1", "#6741d9", "#c2255c"]) + "--fg:rgba(0,0,0,.88);--muted:rgba(0,0,0,.38);--accent:#0066d6;--sel:rgba(0,102,214,.2);--box:rgba(0,0,0,.05);--line:rgba(0,0,0,.12);"
      + "--k-kwd:#cf222e;--k-str:#0a7a30;--k-cmnt:#6e7781;--k-num:#0550ae;--k-func:#8250df;--k-class:#953800;--k-oper:#57606a;--k-var:#0550ae;color-scheme:light;";
    frame.srcdoc = frameSrc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src ${new URL(font).origin}">
<style>
@font-face { font-family: "Inter"; src: url("${font}") format("woff2"); font-weight: 100 900; }
:root { ${dark} }
@media (prefers-color-scheme: light) { :root[data-theme="auto"] { ${light} } }
:root[data-theme="light"] { ${light} }
html { height: 100%; }
body { margin: 0 auto; max-width: 760px; min-height: 100%; padding: 28px 32px 48px; box-sizing: border-box; font: 14px/1.6 "Inter", system-ui, sans-serif;
  color: var(--fg); background: transparent; word-wrap: break-word; outline: none; caret-color: var(--fg); -webkit-font-smoothing: antialiased; }
body.empty::before { content: "Start writing, or paste Markdown. Drop a text file to open it."; position: absolute; color: var(--muted); pointer-events: none; }
::selection { background: var(--sel); }
p { margin: 0; }
ul, ol { margin: 0 0 0 1.5em; padding: 0; }
blockquote { margin: 0 0 0 .8ex; border-left: 2px solid var(--muted); padding-left: 1ex; }
a { color: var(--accent); }
img { max-width: 100%; height: auto; border-radius: 6px; vertical-align: bottom; }
img.missing { display: inline-block; min-width: 120px; min-height: 40px; outline: 1px dashed var(--muted); }
${COLORS.map((c) => `font[data-c="${c}"] { color: var(--c-${c}); }`).join("\n")}
font[data-c="default"] { color: var(--fg); }
/* Markdown preview */
body.md { line-height: 1.65; }
body.md > :first-child { margin-top: 0; }
body.md h1, body.md h2, body.md h3, body.md h4, body.md h5, body.md h6 { margin: 1.2em 0 .5em; line-height: 1.25; font-weight: 650; }
body.md h1 { font-size: 1.8em; } body.md h2 { font-size: 1.45em; padding-bottom: .25em; border-bottom: 1px solid var(--line); } body.md h3 { font-size: 1.2em; } body.md h4, body.md h5, body.md h6 { font-size: 1em; }
body.md p { margin: 0 0 .8em; }
body.md .nolink { border-bottom: 1px dotted currentColor; cursor: help; }
body.md li p { margin: 0; }
body.md ul, body.md ol { margin: 0 0 .8em; padding-left: 1.6em; }
body.md li > ul, body.md li > ol { margin: .2em 0 0; }
body.md li.task { list-style: none; margin-left: -1.4em; }
body.md li.task input { margin: 0 .45em 0 0; vertical-align: -1px; }
body.md li.task > ul, body.md li.task > ol { margin-left: 1.4em; }
body.md blockquote { margin: 0 0 .8em; padding: .1em 0 .1em 1em; border-left: 3px solid var(--line); color: var(--muted); }
body.md blockquote p { margin: 0; }
body.md code { font: .9em ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: .1em .35em; border-radius: 5px; background: var(--box); }
body.md pre { margin: 0 0 .8em; padding: 12px 14px; border-radius: 8px; background: var(--box); overflow-x: auto; }
body.md pre code { padding: 0; background: none; font-size: .88em; line-height: 1.55; }
body.md table { border-collapse: collapse; margin: 0 0 .8em; display: block; overflow-x: auto; }
body.md th, body.md td { padding: 6px 12px; border: 1px solid var(--line); }
body.md th { background: var(--box); font-weight: 600; }
body.md hr { border: 0; border-top: 1px solid var(--line); margin: 1.2em 0; }
body.md a { cursor: pointer; }
.diagram-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px 6px 14px; border-radius: 8px 8px 0 0;
  background: var(--box); border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.diagram-head b { color: var(--fg); font-weight: 600; }
.diagram-head + pre { border-radius: 0 0 8px 8px; }
.diagram-head button { flex: none; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
.diagram-head button:hover { background: var(--box); }
.t-kwd, .t-err, .t-deleted { color: var(--k-kwd); } .t-str, .t-insert { color: var(--k-str); } .t-cmnt { color: var(--k-cmnt); }
.t-num, .t-bool { color: var(--k-num); } .t-func { color: var(--k-func); } .t-class { color: var(--k-class); } .t-oper { color: var(--k-oper); } .t-var, .t-type, .t-section { color: var(--k-var); }
</style></head><body></body></html>`;
    rich.ready = new Promise((resolve) => {
      frame.addEventListener("load", () => {
        const doc = frame.contentDocument;
        doc.documentElement.dataset.theme = document.documentElement.dataset.theme || "dark";
        doc.body.contentEditable = "true";
        doc.body.spellcheck = true;
        doc.execCommand("defaultParagraphSeparator", false, "div");
        doc.execCommand("styleWithCSS", false, false);
        rich.doc = doc;
        wireRich(doc);
        resolve(doc);
      }, { once: true });
    });
    new MutationObserver(() => {
      for (const doc of [rich.doc, mdView.doc]) if (doc) doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  async function loadRich(body, focus) {
    const doc = await rich.ready;
    doc.body.innerHTML = sanitize(body || "");
    await showImages(doc.body);
    doc.body.classList.toggle("empty", isCurrentEmpty());
    if (focus) {
      doc.body.focus({ preventScroll: true });
      const sel = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(doc.body);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      doc.scrollingElement.scrollTop = 0;
    }
    updateToolState();
    paintStrip();
    paintMeter();
  }
  // ---- Preview ---------------------------------------------------------------------------
  // Markdown: a read-only page like the rich editor's; code blocks get their language's
  // colors, and Mermaid diagrams stay as their text, with a copy button. HTML: the file in a
  // sandboxed frame (no scripts, forms or plug-ins), with a content policy that lets nothing
  // load from the web until "Load them for this pad"; every link opens in a new tab except
  // #links, which move within the page.
  const mdView = { doc: null, ready: null };
  function setupPreview() {
    const frame = $("mdFrame");
    frame.srcdoc = frameSrc;
    mdView.ready = new Promise((resolve) => {
      frame.addEventListener("load", () => {
        const doc = frame.contentDocument;
        doc.documentElement.dataset.theme = document.documentElement.dataset.theme || "dark";
        doc.body.classList.add("md");
        doc.body.addEventListener("click", (e) => {
          const copy = e.target.closest?.("[data-copy]");
          if (copy) return void copyDiagram(doc, copy);
          const a = e.target.closest?.("a[href]");
          if (!a) return;
          e.preventDefault();
          const href = a.getAttribute("href") || "";
          if (href.startsWith("#")) jumpTo(doc, href.slice(1));
          else window.open(a.href, "_blank", "noopener");
        });
        doc.addEventListener("keydown", previewKeys);
        mdView.doc = doc;
        resolve(doc);
      }, { once: true });
    });
  }
  async function copyDiagram(doc, btn) {
    const text = btn.closest(".diagram-head").nextElementSibling?.textContent || "";
    let ok = false;
    for (const clip of [doc.defaultView.navigator.clipboard, navigator.clipboard]) {
      try { await clip.writeText(text); ok = true; break; } catch {}
    }
    if (!ok) return toast("Couldn't copy: select the text and copy it instead");
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  }
  let htmlShown = "";
  async function showPreview() {
    const p = cur(), isMd = p.lang === "md";
    $("mdFrame").hidden = !isMd;
    $("htmlFrame").hidden = isMd;
    $("webBar").hidden = true;
    if (isMd) {
      htmlShown = "";
      showMarkdown(await mdView.ready, p.body);
    } else {
      const { html, usesWeb } = previewHtml(p.body || "", !!p.web);
      if (html !== htmlShown) $("htmlFrame").srcdoc = htmlShown = html;
      $("webBar").hidden = !usesWeb || !!p.web;
    }
    paintNote();
  }
  function paintNote() {
    const p = cur(), note = $("previewNote");
    const edit = "<b>Esc</b> or the eye to edit";
    if (p.lang === "md") return void (note.innerHTML = `Markdown preview · ${edit}`);
    note.innerHTML = p.web
      ? `HTML preview · no scripts or forms · web images and styles on (<button id="webBlock">block them</button>) · ${edit}`
      : `HTML preview · no scripts, forms or web content · ${edit}`;
    $("webBlock")?.addEventListener("click", () => setWeb(false));
  }
  const RESOURCE = /<(img|source|video|audio|track|link|image|use|input|embed)\b[^>]*?\s(src|srcset|href|xlink:href|poster)\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*["']?\s*(https?:)?\/\/|@import\s+["']?\s*(https?:)?\/\//i;
  function previewHtml(src, web) {
    const d = new DOMParser().parseFromString(src, "text/html"); // nothing in it runs or loads here
    // Scripts never run in the frame anyway; refreshes, base addresses and preloads go.
    d.querySelectorAll("script, noscript, base, meta[http-equiv], link:not([rel~='stylesheet' i])").forEach((n) => n.remove());
    for (const a of d.querySelectorAll("a[href], area[href]")) {
      const href = a.getAttribute("href").trim();
      // A #link on its own would resolve against this page's address and leave the preview.
      if (href.startsWith("#")) { a.setAttribute("href", `about:srcdoc${href}`); a.setAttribute("target", "_self"); }
      else { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); }
    }
    const usesWeb = RESOURCE.test(d.documentElement.outerHTML);
    const net = web ? " https: http:" : "";
    const csp = Object.assign(d.createElement("meta"), { httpEquiv: "Content-Security-Policy",
      content: `default-src 'none'; style-src 'unsafe-inline'${net}; img-src data: blob:${net}; font-src data:${net}; media-src data: blob:${net}` });
    const base = Object.assign(d.createElement("base"), { target: "_blank" });
    d.head.prepend(csp, base);
    return { html: `<!doctype html>\n${d.documentElement.outerHTML}`, usesWeb };
  }
  async function setWeb(on) {
    const p = cur();
    if (on) p.web = true;
    else delete p.web;
    dirty = true;
    await saveNow();
    showPreview();
  }
  $("webAllow").onclick = () => setWeb(true);
  async function setPreview(on) {
    const p = cur();
    if (!canPreview(p) || previewing(p) === on) return;
    syncFromEditor();
    if (on) p.preview = true;
    else delete p.preview;
    dirty = true;
    await saveNow();
    paintViews();
    paintTop();
    if (on) showPreview();
    else ta.focus({ preventScroll: true });
    $("status").textContent = statusText(lastState);
  }
  $("previewBtn").onclick = () => setPreview(!previewing());
  function previewKeys(e) {
    if (e.key === "Escape" && previewing() && !e.target.closest?.("input, textarea, select, [contenteditable='true']")) {
      e.preventDefault();
      setPreview(false);
    }
  }
  document.addEventListener("keydown", previewKeys);

  const FENCE_LANGS = { javascript: "js", typescript: "ts", python: "py", shell: "bash", sh: "bash", zsh: "bash", console: "bash", yml: "yaml", rust: "rs", golang: "go", cpp: "c", "c++": "c", markdown: "md", dockerfile: "docker", makefile: "make", perl: "pl" };
  function showMarkdown(doc, text) {
    doc.body.innerHTML = MD.render(text || "");
    doc.body.classList.remove("empty");
    doc.scrollingElement.scrollTop = 0;
    for (const code of doc.querySelectorAll("pre code[data-lang]")) {
      const n = code.dataset.lang, id = FENCE_LANGS[n] || LANG_BY_EXT.get(n) || (LANG_LABEL.has(n) ? n : null);
      if (id) tokensHtml(code.textContent, id).then((html) => { if (code.isConnected) code.innerHTML = html; }, () => {});
    }
    for (const code of doc.querySelectorAll('pre code[data-lang="mermaid"]')) {
      const head = doc.createElement("div");
      head.className = "diagram-head";
      head.innerHTML = '<span><b>Mermaid diagram</b> · paste it into any Mermaid viewer to see it drawn</span><button type="button" data-copy>Copy</button>';
      code.parentElement.before(head);
    }
    paintStrip();
    paintMeter();
  }
  function jumpTo(doc, frag) {
    let name = frag;
    try { name = decodeURIComponent(frag); } catch {}
    name = name.toLowerCase();
    const h = [...doc.querySelectorAll("[data-slug]")].find((x) => x.dataset.slug === name);
    if (!h) return;
    const sc = doc.scrollingElement;
    sc.scrollTo({ top: h.getBoundingClientRect().top + sc.scrollTop - 12, behavior: "smooth" });
  }
  // Text that reads as Markdown: at least two of headings, lists, bold, links, quotes, code
  // fences, tables or task boxes.
  function looksMarkdown(text) {
    const signs = [/^#{1,6}\s+\S/m, /^\s*[-*+]\s+\S.*\n\s*[-*+]\s+\S/m, /^\s*\d+[.)]\s+\S/m, /\*\*[^*\n]+\*\*/, /\[[^\]\n]+\]\([^)\s]+\)/, /^\s*(```|~~~)/m, /^>\s/m, /^\|.+\|\s*\n\|?\s*:?-+/m, /^\s*[-*]\s+\[[ xX]\]/m];
    return signs.filter((r) => r.test(text)).length >= 2;
  }
  async function imageUrl(id) {
    if (imgUrls.has(id)) return imgUrls.get(id);
    const rec = await PADS.imgGet(id).catch(() => null);
    if (!rec?.blob) return "";
    imgSizes.set(id, rec.size || rec.blob.size);
    const url = URL.createObjectURL(rec.blob);
    imgUrls.set(id, url);
    return url;
  }
  async function showImages(root) {
    for (const img of root.querySelectorAll("img[data-img]")) {
      const url = await imageUrl(img.dataset.img);
      if (url) img.src = url;
      else {
        img.classList.add("missing");
        img.alt ||= "Image not on this computer";
      }
    }
  }

  function wireRich(doc) {
    const body = doc.body;
    body.addEventListener("input", (e) => {
      normalizeColors();
      body.classList.toggle("empty", isCurrentEmpty());
      changed();
      // Undo or redo can bring back images without the limit being checked: say so.
      if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
        const { bytes } = imagesInUse();
        if (bytes > PADS.IMG_LIMIT) nudge(`${e.inputType === "historyUndo" ? "Undo" : "Redo"} brought images back past the limit: ${mbFine(bytes)} of ${mb(PADS.IMG_LIMIT)}. New images can't be added until it's under.`, true);
        else paintMeter();
      }
    });
    // Pasted text comes in plain; pasted images go in where the cursor is.
    body.addEventListener("paste", (e) => {
      e.preventDefault();
      const images = [...(e.clipboardData?.files || [])].filter((f) => PADS.IMG_TYPES.test(f.type));
      if (images.length) return void insertImages(images);
      const text = e.clipboardData?.getData("text/plain");
      if (text && isCurrentEmpty() && looksMarkdown(text)) return void pasteMarkdown(text);
      if (text) doc.execCommand("insertText", false, text);
    });
    body.addEventListener("dragover", (e) => e.preventDefault());
    body.addEventListener("drop", (e) => {
      if (hasFiles(e)) {
        e.preventDefault();
        e.stopPropagation();
        return void routeFiles([...e.dataTransfer.files], { x: e.clientX, y: e.clientY });
      }
      const text = e.dataTransfer?.getData("text/plain");
      if (text) {
        e.preventDefault();
        placeCaret(e.clientX, e.clientY);
        doc.execCommand("insertText", false, text);
      }
    });
    doc.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "k") { e.preventDefault(); openLinkForm(); }
      else if (mod && k === "u") e.preventDefault(); // no underline: it reads as a link
      else if (mod && k === "s") { e.preventDefault(); saveNow(); }
      else if (e.key === "Escape") closePops();
    });
    // Ctrl/⌘+click follows a link (a plain click just puts the cursor in it).
    body.addEventListener("click", (e) => {
      const a = e.target.closest?.("a[href]");
      if (a && (e.metaKey || e.ctrlKey)) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); }
      closePops();
    });
    doc.addEventListener("selectionchange", updateToolState);
  }
  // Markdown pasted into an empty rich pad makes it a Markdown pad, shown as a preview.
  async function pasteMarkdown(text) {
    const p = cur();
    clearTimeout(saveTimer);
    dirty = false;
    await writePad(current, { ...blank(), title: p.title, mode: "plain", lang: "md", preview: true, body: text.replace(/\r\n?/g, "\n") });
    showPad();
    toast("Pasted as Markdown, shown as a preview. Esc or the eye to edit it.");
  }
  function placeCaret(x, y) {
    const pos = rich.doc.caretRangeFromPoint?.(x, y);
    if (!pos) return;
    const sel = rich.doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(pos);
  }

  function updateToolState() {
    const doc = rich.doc;
    if (!doc) return;
    for (const b of document.querySelectorAll("#richTools [data-cmd]")) {
      let on = false;
      try { on = doc.queryCommandState(b.dataset.cmd); } catch {}
      b.classList.toggle("on", on);
    }
    const c = currentColor();
    $("colorBar").style.background = c === "default" ? "" : `var(--c-${c})`;
  }
  function exec(cmd, value = null) {
    const doc = rich.doc;
    if (!doc) return;
    doc.body.focus();
    doc.execCommand(cmd, false, value);
    normalizeColors();
    doc.body.classList.toggle("empty", isCurrentEmpty());
    changed();
    updateToolState();
  }
  for (const b of document.querySelectorAll("#richTools [data-cmd]")) {
    b.onmousedown = (e) => e.preventDefault(); // keep the selection in the editor
    b.onclick = () => { exec(b.dataset.cmd); closePops(); };
  }
  for (const b of document.querySelectorAll("[data-act]")) {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      if (cur().mode === "rich") exec(b.dataset.act);
      else { $("textInput").focus({ preventScroll: true }); document.execCommand(b.dataset.act); }
    };
  }

  // Colors: the browser's foreColor command writes <font color>; each color is given a
  // stand-in value and then rewritten as <font data-c="name">, which the stylesheet colors
  // per theme.
  const STAND_IN = Object.fromEntries([...COLORS, "default"].map((c, i) => [`#0000${String(i + 1).padStart(2, "0")}`, c]));
  function normalizeColors() {
    const body = rich.doc?.body;
    if (!body) return;
    for (const f of body.querySelectorAll("font[color]")) {
      const name = STAND_IN[(f.getAttribute("color") || "").toLowerCase()];
      f.removeAttribute("color");
      if (!name) continue;
      if (name === "default" && !f.parentElement?.closest("font[data-c]")) f.replaceWith(...f.childNodes);
      else f.dataset.c = name;
    }
  }
  function currentColor() {
    const sel = rich.doc?.getSelection();
    let node = sel?.anchorNode;
    if (node?.nodeType === 3) node = node.parentElement;
    return node?.closest?.("font[data-c]")?.dataset.c || "default";
  }
  const colorPop = $("colorPop");
  for (const c of ["default", ...COLORS]) {
    const b = document.createElement("button");
    b.className = `sw${c === "default" ? " default" : ""}`;
    b.title = c === "default" ? "Default color" : c[0].toUpperCase() + c.slice(1);
    b.dataset.c = c;
    if (c !== "default") b.style.setProperty("--sw", `var(--c-${c})`);
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const value = Object.keys(STAND_IN).find((k) => STAND_IN[k] === c);
      exec("foreColor", value);
      closePops();
    };
    colorPop.append(b);
  }
  $("colorBtn").onmousedown = (e) => e.preventDefault();
  $("colorBtn").onclick = () => {
    const open = colorPop.hidden;
    closePops();
    colorPop.hidden = !open;
    const c = currentColor();
    for (const s of colorPop.children) s.classList.toggle("on", s.dataset.c === c);
  };
  $("alignBtn").onmousedown = (e) => e.preventDefault();
  $("alignBtn").onclick = () => {
    const open = $("alignPop").hidden;
    closePops();
    $("alignPop").hidden = !open;
  };
  function closePops() {
    for (const p of document.querySelectorAll(".pop")) p.hidden = true;
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pop-wrap")) closePops();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePops();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
  });

  // Links: the form remembers the selection, since typing in it moves the focus away.
  function openLinkForm() {
    const doc = rich.doc;
    if (!doc) return;
    const sel = doc.getSelection();
    rich.linkRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const text = rich.linkRange?.toString() || "";
    $("linkText").value = text;
    $("linkText").hidden = !!text;
    let node = sel.anchorNode;
    if (node?.nodeType === 3) node = node.parentElement;
    $("linkUrl").value = node?.closest?.("a")?.getAttribute("href") || "";
    closePops();
    $("linkForm").hidden = false;
    $("linkUrl").focus();
  }
  $("linkBtn").onmousedown = (e) => e.preventDefault();
  $("linkBtn").onclick = () => ($("linkForm").hidden ? openLinkForm() : closePops());
  $("linkForm").onsubmit = (e) => {
    e.preventDefault();
    let url = $("linkUrl").value.trim();
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url)) url = /@/.test(url) && !/\//.test(url) ? `mailto:${url}` : `https://${url}`;
    const doc = rich.doc;
    doc.body.focus();
    const sel = doc.getSelection();
    if (rich.linkRange) {
      sel.removeAllRanges();
      sel.addRange(rich.linkRange);
    }
    if (sel.isCollapsed) {
      const text = $("linkText").value.trim() || url;
      doc.execCommand("insertHTML", false, `<a href="${esc(url)}">${esc(text)}</a>`);
    } else doc.execCommand("createLink", false, url);
    closePops();
    changed();
  };

  // ---- Images ---------------------------------------------------------------------------
  // Scaled down to IMG_EDGE and saved as WebP (an original that's already small and no
  // bigger than its WebP stays as it is; a small GIF stays as it is, so it keeps moving).
  async function prepareImage(file) {
    if (file.type === "image/gif" && file.size <= 2 * 1024 * 1024) return { blob: file, type: file.type };
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) throw new Error(`${file.name || "That image"} couldn't be read`);
    const scale = Math.min(1, PADS.IMG_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const webp = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
    const keep = scale === 1 && /^image\/(png|jpeg|webp)$/.test(file.type) && file.size <= webp.size;
    return keep ? { blob: file, type: file.type } : { blob: webp, type: "image/webp" };
  }
  async function insertImages(files, point) {
    await rich.ready;
    if (point) placeCaret(point.x, point.y);
    for (const file of files) {
      try {
        const { blob, type } = await prepareImage(file);
        const id = await PADS.imgId(blob);
        const used = imagesInUse();
        if (!used.ids.has(id) && used.bytes + blob.size > PADS.IMG_LIMIT) {
          nudge(`Image not added: images are full (${mbFine(used.bytes)} of ${mb(PADS.IMG_LIMIT)} in all pads).`, true);
          break;
        }
        if (!imgSizes.has(id)) await PADS.imgPut({ id, blob, type, size: blob.size, at: Date.now() });
        imgSizes.set(id, blob.size);
        const url = await imageUrl(id);
        const alt = esc((file.name || "").replace(/\.[^.]+$/, "").slice(0, 100));
        rich.doc.body.focus();
        rich.doc.execCommand("insertHTML", false, `<img data-img="${id}" src="${url}" alt="${alt}">`);
        rich.doc.body.classList.remove("empty");
        changed();
      } catch (err) {
        toast(err.message);
      }
    }
    paintMeter();
  }
  $("imageBtn").onmousedown = (e) => e.preventDefault();
  $("imageBtn").onclick = () => $("imageFile").click();
  $("imageFile").onchange = () => {
    const files = [...$("imageFile").files];
    $("imageFile").value = "";
    if (files.length) insertImages(files);
  };

  const mbFine = (n) => `${(n / 1048576).toFixed(1)} MB`; // near the limit, where rounding would hide it
  const mb = (n) => `${n >= 10 * 1048576 || n % 1048576 === 0 ? Math.round(n / 1048576) : (n / 1048576).toFixed(1)} MB`;
  // Images any pad (or a previous copy) points at, and their total size.
  function imagesInUse() {
    const ids = new Set();
    for (let n = 1; n <= PAD_COUNT; n++) {
      const p = n === current && cur().mode === "rich" && rich.doc ? { mode: "rich", body: rich.doc.body.innerHTML } : pads[n];
      for (const id of padRefs(p)) ids.add(id);
      for (const id of padRefs(prevs[n])) ids.add(id);
    }
    let bytes = 0;
    for (const id of ids) bytes += imgSizes.get(id) || 0;
    return { ids, bytes };
  }
  function paintMeter() {
    const { ids, bytes } = imagesInUse();
    const meter = $("meter");
    $("meterBtn").hidden = !ids.size;
    if (!ids.size) { $("imgPop").hidden = true; $("imgNudge").hidden = true; return; }
    if (!$("imgPop").hidden) paintImgPop();
    $("meterText").textContent = `Images ${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 && bytes < 0.9 * PADS.IMG_LIMIT ? 0 : 1)} / ${mb(PADS.IMG_LIMIT)}`;
    const level = bytes / PADS.IMG_LIMIT;
    $("meterBtn").classList.toggle("warn", level >= 0.8 && level < 1);
    $("meterBtn").classList.toggle("full", level >= 1);
    // Nearly full: said once; after "Not now", again only once another MB has gone in (or
    // it's full), and from scratch once it's back under 80%.
    if (!sizesReady) {} // not all sizes known yet: the levels would be wrong
    else if (level < 0.8) { nudgeQuiet = false; nudgeSeen(0); }
    else if (!nudgeQuiet && $("imgNudge").hidden && (bytes > nudgeSeen() + 1048576 || (level >= 1 && nudgeSeen() < PADS.IMG_LIMIT))) {
      nudge(`Images are nearly full: ${mbFine(bytes)} of ${mb(PADS.IMG_LIMIT)} in all pads.`);
    }
    const share = bytes / PADS.IMG_LIMIT;
    $("meterFill").style.width = `${Math.min(100, Math.max(3, share * 100))}%`;
    meter.classList.toggle("warn", share >= 0.8 && share < 1);
    meter.classList.toggle("full", share >= 1);
    $("meterBtn").title = `Images: ${mb(bytes)} of ${mb(PADS.IMG_LIMIT)} · click to see where`;
  }

  // ---- Image space running out: a banner with what's taking it and the way to the panel ----
  let nudgeQuiet = false; // shown on this page already
  // How full it was at the last "Not now" (kept in this browser only).
  function nudgeSeen(set) {
    try {
      if (set === undefined) return Number(localStorage.getItem("egImgNudge")) || 0;
      if (set) localStorage.setItem("egImgNudge", String(set));
      else localStorage.removeItem("egImgNudge");
    } catch {}
    return 0;
  }
  function nudge(text, urgent = false) {
    const { held } = imageBreakdown();
    const extra = held >= 0.5 * 1048576 ? ` ${mb(held)} of it is only kept for Restore previous or switching back to Rich, and can be freed.` : "";
    $("imgNudgeText").textContent = text + extra;
    $("imgNudge").classList.toggle("full", urgent || imagesInUse().bytes >= PADS.IMG_LIMIT);
    $("imgNudge").hidden = false;
    nudgeQuiet = true;
  }
  $("imgNudgeLater").onclick = () => { $("imgNudge").hidden = true; nudgeSeen(imagesInUse().bytes); };
  $("imgNudgeSee").onclick = (e) => {
    e.stopPropagation(); // the click that closes pop-ups mustn't close this one
    $("imgNudge").hidden = true;
    closePops();
    paintImgPop();
    $("imgPop").hidden = false;
  };

  // ---- Where the image megabytes are ---------------------------------------------------
  // Each image counts once, under the first of: in a pad now; kept for switching a pad back
  // to Rich (alt); kept for Restore previous. The last two are images you can't see, so each
  // can be forgotten here (its copy goes; the space is free at once).
  const refsNow = (n) => padRefs(n === current && cur().mode === "rich" && rich.doc ? { mode: "rich", body: rich.doc.body.innerHTML } : { ...pads[n], alt: null });
  // A held copy's row says what forgetting it frees: its images that neither a pad nor
  // another kept copy has (an image can be kept by both copies of a pad).
  function imageBreakdown() {
    const size = (ids) => [...ids].reduce((t, id) => t + (imgSizes.get(id) || 0), 0);
    const rows = { pads: [], alt: [], prev: [] }, inPads = new Set();
    for (let n = 1; n <= PAD_COUNT; n++) {
      const fresh = [...refsNow(n)].filter((id) => !inPads.has(id));
      fresh.forEach((id) => inPads.add(id));
      if (fresh.length) rows.pads.push({ n, count: fresh.length, bytes: size(fresh) });
    }
    const copies = [];
    for (let n = 1; n <= PAD_COUNT; n++) {
      copies.push({ kind: "alt", n, ids: [...padRefs({ ...(pads[n].alt || {}), alt: null })].filter((id) => !inPads.has(id)) });
      copies.push({ kind: "prev", n, ids: [...padRefs(prevs[n])].filter((id) => !inPads.has(id)) });
    }
    const held = new Set();
    for (const c of copies) {
      if (!c.ids.length) continue;
      c.ids.forEach((id) => held.add(id));
      const own = c.ids.filter((id) => !copies.some((o) => o !== c && o.ids.includes(id)));
      rows[c.kind].push({ n: c.n, count: c.ids.length, bytes: size(own), shared: own.length < c.ids.length });
    }
    return { rows, inPads: size(inPads), held: size(held) };
  }
  function paintImgPop() {
    const pop = $("imgPop"), { rows, inPads, held } = imageBreakdown();
    const pct = (b) => `${Math.min(100, (b / PADS.IMG_LIMIT) * 100)}%`;
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || "", textContent: text || "" });
    pop.replaceChildren(el("div", "total", `Images ${mb(inPads + held)} of ${mb(PADS.IMG_LIMIT)}`));
    const bar = el("div", "bar"), a = el("i"), b = el("i", "held");
    a.style.width = pct(inPads);
    b.style.width = pct(held);
    bar.append(a, b);
    pop.append(bar);
    const row = (r, label, forget) => {
      const line = el("div", "row");
      const sizeText = !forget ? mb(r.bytes) : r.bytes ? `frees ${mb(r.bytes)}` : "frees nothing";
      const sz = el("span", "size", sizeText);
      if (forget && r.shared) sz.title = r.bytes ? "Some of these images are also kept by another copy" : "These images are also kept by another copy, so forgetting this one alone frees no space";
      line.append(el("span", "name", `${padName(r.n)} · ${r.count} image${r.count === 1 ? "" : "s"}`), sz);
      if (forget) {
        const btn = el("button", "", "Forget");
        btn.title = `${label} (click twice)`;
        btn.onclick = () => {
          if (!btn.classList.contains("armed")) {
            btn.classList.add("armed");
            btn.textContent = "Sure?";
            setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "Forget"; }, 3000);
            return;
          }
          forget();
        };
        line.append(btn);
      }
      pop.append(line);
    };
    if (rows.pads.length) pop.append(el("h4", "", "In pads"));
    for (const r of rows.pads) row(r);
    if (rows.alt.length) pop.append(el("h4", "", "Kept for switching back to Rich"));
    for (const r of rows.alt) row(r, `Drop the formatted version ${padName(r.n)} keeps for switching back to Rich`, () => forgetCopy(r.n, "alt"));
    if (rows.prev.length) pop.append(el("h4", "", "Kept for Restore previous"));
    for (const r of rows.prev) row(r, `Drop ${padName(r.n)}'s Restore previous copy`, () => forgetCopy(r.n, "prev"));
    if (held) pop.append(el("div", "note", "Images you don't see in a pad still count while a pad keeps a copy that can bring them back. Forget a copy to free its space."));
  }
  async function forgetCopy(n, kind) {
    const before = imagesInUse().ids;
    if (kind === "prev") {
      prevs[n] = null;
      await chrome.storage.local.remove(prevKey(n));
    } else if (n === current) {
      syncFromEditor();
      delete cur().alt;
      dirty = true;
      await saveNow();
    } else {
      const { alt, ...rest } = pads[n];
      await writePad(n, rest);
    }
    // Images nothing points at any more go now (no other pad tab can be adding them).
    const now = imagesInUse().ids;
    for (const id of before) if (!now.has(id)) { await PADS.imgDelete(id).catch(() => {}); imgSizes.delete(id); }
    paintTop();
    paintMeter();
    toast(kind === "prev" ? `${padName(n)}'s Restore previous copy is gone` : `${padName(n)} no longer keeps its formatted version`);
  }
  $("meterBtn").onclick = () => {
    const pop = $("imgPop"), open = pop.hidden;
    closePops();
    if (open) { paintImgPop(); pop.hidden = false; }
  };
  // Sizes of every image in use, then images nothing points at any more are deleted
  // (only ones older than a day, so another open pad tab's brand-new image is safe).
  // Sizes of images in use that aren't known yet (at start, or after a restore changed a pad).
  let sizesReady = false;
  async function loadSizes() {
    for (const id of imagesInUse().ids) {
      if (imgSizes.has(id)) continue;
      const rec = await PADS.imgGet(id).catch(() => null);
      if (rec?.blob) imgSizes.set(id, rec.size || rec.blob.size);
    }
  }
  async function tidyImages() {
    try {
      const { ids } = imagesInUse();
      await loadSizes();
      for (const id of await PADS.imgKeys()) {
        if (ids.has(id)) continue;
        const rec = await PADS.imgGet(id);
        if (!rec || Date.now() - (rec.at || 0) > 864e5) await PADS.imgDelete(id);
      }
    } catch {}
    sizesReady = true;
    paintMeter();
  }

  // ---- Plain editor ---------------------------------------------------------------------
  const ta = $("textInput"), hl = $("hl"), gutter = $("gutter"), plainView = $("plainView");
  const langSelect = $("lang");
  langSelect.append(new Option("Plain text", ""));
  for (const [id, label] of [...LANGS].sort((a, b) => a[1].localeCompare(b[1]))) langSelect.append(new Option(label, id));
  let gutterLines = 0;

  function countLines(v) {
    let n = 1;
    for (let i = v.indexOf("\n"); i !== -1; i = v.indexOf("\n", i + 1)) n++;
    return n;
  }
  function loadPlain(p, focus) {
    ta.value = p.body || "";
    langSelect.value = p.lang || "";
    gutterLines = 0;
    applyPlainFlags();
    renderText();
    $("textScroll").scrollTop = 0;
    if (focus) {
      ta.setSelectionRange(0, 0);
      ta.focus({ preventScroll: true });
    }
  }
  function applyPlainFlags() {
    const p = cur();
    plainView.classList.toggle("wrap", !!p.wrap);
    plainView.classList.toggle("bare", ta.value.length > TEXT_BARE);
    $("wrapBtn").classList.toggle("on", !!p.wrap);
    $("wrapBtn").setAttribute("aria-pressed", String(!!p.wrap));
  }
  function renderText() {
    const v = ta.value;
    const bare = v.length > TEXT_BARE;
    if (bare !== plainView.classList.contains("bare")) { gutterLines = 0; applyPlainFlags(); }
    $("dropHint").hidden = v !== "";
    if (!bare) {
      paintHighlight(v, false);
      const lines = countLines(v);
      if (lines !== gutterLines) {
        gutterLines = lines;
        gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
      }
    } else {
      hl.textContent = "";
      gutter.textContent = "";
    }
  }

  // speed-highlight, loaded the first time a plain pad has a language.
  let shj = null;
  const readyLangs = new Set();
  let hlSeq = 0, hlTimer = 0;
  const SLOW = Symbol("slow");
  async function tokensHtml(src, lang) {
    shj ??= import("./vendor/speed-highlight/index.js");
    const m = await shj;
    let out = "";
    await m.tokenize(src, lang, (str, type) => {
      const e = str.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
      out += type ? `<span class="t-${type}">${e}</span>` : e;
    });
    return out;
  }
  async function paintHighlight(v, allowSlow) {
    const seq = ++hlSeq;
    clearTimeout(hlTimer);
    const lang = cur().lang;
    const can = !!lang && v.length <= TEXT_HL_MAX;
    if (can && readyLangs.has(lang) && (allowSlow || v.length <= TEXT_HL_SYNC)) {
      // Normally done before the next paint; if a sub-language is still loading, show the
      // plain text meanwhile so what's on screen always matches what's typed.
      const job = tokensHtml(v, lang).catch(() => null);
      let html = await Promise.race([job, new Promise((r) => setTimeout(() => r(SLOW), 0))]);
      if (html === SLOW) {
        if (seq === hlSeq) hl.textContent = v + "\n";
        html = await job;
      }
      if (seq !== hlSeq) return;
      if (html !== null) return void (hl.innerHTML = html + "\n");
    }
    if (seq !== hlSeq) return;
    hl.textContent = v + "\n"; // the trailing line break keeps the copy as tall as the textarea
    if (!can) return;
    if (!readyLangs.has(lang)) {
      tokensHtml("x", lang).then(() => {
        readyLangs.add(lang);
        if (seq === hlSeq) paintHighlight(ta.value, true);
      }, () => {});
    } else hlTimer = setTimeout(() => seq === hlSeq && paintHighlight(ta.value, true), 140);
  }

  function replaceRange(start, end, str) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
    if (!document.execCommand("insertText", false, str)) {
      ta.setRangeText(str, start, end, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  function indentUnit(text) {
    let tabs = 0, spaces = 0;
    for (const line of text.slice(0, 60000).split("\n", 400)) {
      if (line[0] === "\t") tabs++;
      else if (/^ {2,}\S/.test(line)) spaces++;
    }
    if (tabs > spaces) return "\t";
    const m = /^( {2,8})\S/m.exec(text.slice(0, 60000));
    return m && m[1].length <= 4 ? m[1] : "  ";
  }
  // Tab / Shift+Tab indent or outdent the lines the selection touches.
  function indentSelection(outdent) {
    const unit = indentUnit(ta.value);
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e && !outdent) return replaceRange(s, e, unit);
    const from = s === 0 ? 0 : v.lastIndexOf("\n", s - 1) + 1;
    const stop = e > s && v[e - 1] === "\n" ? e - 1 : e;
    const nl = v.indexOf("\n", stop);
    const to = nl === -1 ? v.length : nl;
    const block = v.slice(from, to);
    const lines = block.split("\n");
    const strip = (l) => (l[0] === "\t" ? l.slice(1) : l.replace(new RegExp(`^ {1,${unit === "\t" ? 4 : unit.length}}`), ""));
    const out = lines.map(outdent ? strip : (l) => (l === "" ? l : unit + l));
    const replaced = out.join("\n");
    if (replaced === block) return;
    const firstDelta = out[0].length - lines[0].length;
    replaceRange(from, to, replaced);
    const start = Math.max(from, s + firstDelta);
    ta.setSelectionRange(start, Math.max(start, e + replaced.length - block.length));
  }
  let tabEscape = false;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { tabEscape = true; return; } // Esc, then Tab: leave the editor
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      if (tabEscape) { tabEscape = false; return; }
      e.preventDefault();
      indentSelection(e.shiftKey);
      return;
    }
    if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) tabEscape = false;
  });
  let pastedIntoEmpty = false;
  ta.addEventListener("paste", () => (pastedIntoEmpty = ta.value === ""));
  ta.addEventListener("input", () => {
    const p = cur();
    // Text pasted into an empty pad gets its language guessed (JSON, HTML, a script…).
    if (pastedIntoEmpty && !p.langManual) {
      p.lang = sniffLang(ta.value);
      langSelect.value = p.lang || "";
      if (p.lang && p.lang !== "md") { p.wrap = false; applyPlainFlags(); }
      if (canPreview(p)) { paintTop(); toast(`${p.lang === "md" ? "Markdown" : "HTML"}: the eye at the top shows a preview`); }
    }
    pastedIntoEmpty = false;
    renderText();
    changed();
  });
  // The cursor's row and column in the status line follow it around.
  let caretRaf = 0;
  for (const ev of ["keyup", "mouseup", "select", "focus"]) {
    ta.addEventListener(ev, () => {
      if (caretRaf) return;
      caretRaf = requestAnimationFrame(() => { caretRaf = 0; $("status").textContent = statusText(lastState); });
    });
  }

  // Jump to row: scrolls the row into the middle, puts the cursor at its start and lights it
  // up for a moment. Wrapped text is measured, since one row can take several lines there.
  function rowTop(start, end, line) {
    const pad = parseFloat(getComputedStyle(ta).paddingTop) || 0;
    if (!cur().wrap) return { top: pad + (line - 1) * 20, height: 20 };
    const cs = getComputedStyle(ta);
    const m = document.createElement("div");
    for (const k of ["fontFamily", "fontSize", "lineHeight", "letterSpacing", "tabSize", "whiteSpace", "overflowWrap", "wordBreak", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "boxSizing"]) m.style[k] = cs[k];
    m.style.cssText += ";position:absolute;visibility:hidden;left:-99999px;top:0";
    m.style.width = `${ta.clientWidth}px`;
    document.body.append(m);
    const at = (i) => {
      m.textContent = ta.value.slice(0, i);
      const mark = document.createElement("span");
      mark.textContent = "\u200b";
      m.append(mark);
      return mark.offsetTop;
    };
    const top = at(start), bottom = at(end);
    m.remove();
    return { top, height: Math.max(20, bottom - top + 20) };
  }
  function jumpToRow(n) {
    const v = ta.value, total = countLines(v);
    const line = Math.min(n, total);
    let start = 0;
    for (let i = 1; i < line; i++) start = v.indexOf("\n", start) + 1;
    let end = v.indexOf("\n", start);
    if (end === -1) end = v.length;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, start);
    const bare = plainView.classList.contains("bare");
    const { top, height } = rowTop(start, end, line);
    const box = bare ? ta : $("textScroll");
    box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, top + height / 2 - box.clientHeight / 2));
    if (!cur().wrap) box.scrollLeft = 0;
    document.querySelectorAll(".jump-flash").forEach((x) => x.remove());
    if (!bare) {
      const flash = Object.assign(document.createElement("div"), { className: "jump-flash" });
      flash.style.top = `${top}px`;
      flash.style.height = `${height}px`;
      document.querySelector(".text-stack").append(flash);
      setTimeout(() => flash.remove(), 1700);
    }
    $("status").textContent = statusText(lastState);
    if (n > total) toast(`Only ${total.toLocaleString()} row${total === 1 ? "" : "s"}, so it went to the last one`);
  }
  const jumpInput = $("jumpInput");
  $("jumpForm").onsubmit = (e) => {
    e.preventDefault();
    const raw = jumpInput.value.trim().replace(/[,\s_]/g, "");
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      jumpInput.classList.remove("invalid");
      void jumpInput.offsetWidth; // restart the shake
      jumpInput.classList.add("invalid");
      return toast(`Type a row number from 1 to ${countLines(ta.value).toLocaleString()}`);
    }
    jumpInput.classList.remove("invalid");
    jumpInput.value = "";
    jumpToRow(Number(raw));
  };
  jumpInput.oninput = () => jumpInput.classList.remove("invalid");
  jumpInput.onkeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); jumpInput.value = ""; ta.focus({ preventScroll: true }); }
  };
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "g" && cur().mode === "plain") {
      e.preventDefault();
      jumpInput.focus();
      jumpInput.select();
    }
  });

  langSelect.onchange = () => {
    const p = cur();
    p.lang = langSelect.value || null;
    p.langManual = true;
    if (!PREVIEWABLE.has(p.lang)) delete p.preview;
    paintTop();
    renderText();
    changed();
    ta.focus({ preventScroll: true });
  };
  $("wrapBtn").onclick = () => {
    const p = cur();
    p.wrap = !p.wrap;
    applyPlainFlags();
    changed();
    ta.focus({ preventScroll: true });
  };

  function langFor(name, text) {
    const lower = name.toLowerCase();
    if (LANG_BY_NAME.has(lower)) return LANG_BY_NAME.get(lower);
    if (/^dockerfile\./.test(lower)) return "docker";
    if (/^\.env(\.|$)/.test(lower)) return "ini";
    const dot = lower.lastIndexOf(".");
    const ext = dot < 0 ? "" : lower.slice(dot + 1);
    if (LANG_BY_EXT.has(ext)) return LANG_BY_EXT.get(ext);
    return ext ? null : sniffLang(text);
  }
  // A peek at text with no file name: a script's first line, an XML/HTML start, or JSON.
  function sniffLang(text) {
    const head = text.slice(0, 2048);
    const shebang = /^#!\s*(?:\S*\/env\s+(?:-\S+\s+)*)?(\S+)/.exec(head);
    if (shebang) {
      const bin = shebang[1].split("/").pop().toLowerCase();
      if (/^(ba|z|k|da|a)?sh$/.test(bin)) return "bash";
      if (/^(python|pypy)[\d.]*$/.test(bin)) return "py";
      if (/^(node|nodejs|deno|bun)$/.test(bin)) return "js";
      if (bin === "perl") return "pl";
      if (bin === "lua") return "lua";
      return null;
    }
    const first = head.trimStart();
    if (/^<\?xml\b/i.test(first)) return "xml";
    if (/^<!doctype\s+html/i.test(first) || /^<html[\s>]/i.test(first)) return "html";
    if ((first[0] === "{" || first[0] === "[") && text.length <= 262144) {
      try { JSON.parse(text); return "json"; } catch {}
    }
    return looksMarkdown(text) ? "md" : null;
  }

  // ---- Dropped files --------------------------------------------------------------------
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    routeFiles([...e.dataTransfer.files]);
  });

  async function routeFiles(files, point) {
    const images = files.filter((f) => PADS.IMG_TYPES.test(f.type));
    const texts = files.filter((f) => !images.includes(f));
    if (images.length) {
      if (cur().mode === "rich") await insertImages(images, point);
      else toast("Images go in rich pads. Switch this pad to Rich to add them.");
    }
    for (const f of texts) if (!(await openTextFile(f))) break;
  }

  const BINARY = [[0x25, 0x50, 0x44, 0x46, 0x2d], [0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x50, 0x4b, 0x03, 0x04], [0x1f, 0x8b], [0x7f, 0x45, 0x4c, 0x46], [0xd0, 0xcf, 0x11, 0xe0]];
  function looksBinary(bytes) {
    if (BINARY.some((sig) => sig.every((b, i) => bytes[i] === b))) return true;
    const n = Math.min(bytes.length, 8192);
    let odd = 0;
    for (let i = 0; i < n; i++) {
      const b = bytes[i];
      if (b === 0) return true;
      if ((b < 32 && ![8, 9, 10, 11, 12, 13, 27].includes(b)) || b === 127) odd++;
    }
    return n > 0 && odd / n > 0.1;
  }
  // The file's text (UTF-8, UTF-16 with a byte-order mark, or old Windows-1252), or null.
  function decodeText(bytes) {
    try {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
      if (looksBinary(bytes)) return null;
      const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
      try { return new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { return new TextDecoder("windows-1252").decode(body); }
    } catch {
      return null;
    }
  }

  // Returns false when there's no room (so the rest of a multi-file drop stops too).
  async function openTextFile(file) {
    // A rich pad's own export carries its images inside (a third bigger than they are), so it
    // may be as big as the text limit plus a full image allowance; anything else, the text limit.
    const exported = /\.html?$/i.test(file.name) && file.size <= EXPORT_MAX && isPadExport(file.name, await file.slice(0, 8192).text());
    const max = exported ? EXPORT_MAX : PADS.TEXT_MAX;
    if (file.size > max) return toast(`${file.name} is too big for a pad (${mb(max)} at most)`), true;
    const text = decodeText(new Uint8Array(await file.arrayBuffer()));
    if (text === null) return toast(`${file.name} isn't a text file`), true;
    syncFromEditor();
    let n = padEmpty(cur()) ? current : 0;
    for (let i = 1; !n && i <= PAD_COUNT; i++) if (padEmpty(pads[i])) n = i;
    if (!n) {
      toast(`All ${PAD_COUNT} pads are full. Clear one to open ${file.name}.`);
      return false;
    }
    let rec, note = "";
    if (isPadExport(file.name, text)) ({ rec, note } = await importRich(file.name, text));
    else {
      const lang = langFor(file.name, text);
      rec = { ...blank(), mode: "plain", title: file.name.slice(0, 120), body: text.replace(/\r\n?/g, "\n"), lang, wrap: !lang || lang === "md", preview: PREVIEWABLE.has(lang) || undefined };
    }
    if (n === current) { clearTimeout(saveTimer); dirty = false; }
    await writePad(n, rec);
    if (n === current) {
      showPad();
      toast(`Opened ${file.name}${note}`);
    } else {
      await openPad(n);
      toast(`Opened ${file.name} in pad ${n}${note}`);
    }
    return true;
  }

  // An exported rich pad back into a pad record: its images go into the image store (within
  // the limit), its colors back to the theme-aware ones.
  async function importRich(name, text) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const byHex = Object.fromEntries(Object.entries(EXPORT_COLORS).map(([c, hex]) => [hex, c]));
    for (const f of doc.querySelectorAll("font[color]")) {
      const c = byHex[(f.getAttribute("color") || "").toLowerCase()];
      if (c) f.setAttribute("data-c", c);
    }
    let skipped = 0, added = 0;
    const addedIds = new Set(); // this import's images count toward the limit as they go in
    for (const img of doc.querySelectorAll("img")) {
      try {
        const src = img.getAttribute("src") || "";
        if (!/^data:image\/(png|jpe?g|gif|webp|bmp|avif);/i.test(src)) throw new Error("not an embedded image");
        const blob = await (await fetch(src)).blob();
        const id = await PADS.imgId(blob);
        const used = imagesInUse(), isNew = !used.ids.has(id) && !addedIds.has(id);
        if (isNew && used.bytes + added + blob.size > PADS.IMG_LIMIT) throw new Error("over the limit");
        if (isNew) { added += blob.size; addedIds.add(id); }
        if (!imgSizes.has(id)) await PADS.imgPut({ id, blob, type: blob.type, size: blob.size, at: Date.now() });
        imgSizes.set(id, blob.size);
        img.setAttribute("data-img", id);
      } catch {
        skipped++;
        img.remove();
      }
    }
    const note = skipped ? ` · ${skipped} image${skipped === 1 ? "" : "s"} left out (not in the file, or over the ${mb(PADS.IMG_LIMIT)} limit)` : "";
    const title = (doc.title || name.replace(/\.html?$/i, "")).trim();
    const body = sanitize(doc.body.innerHTML).trim();
    return { note, rec: { ...blank(), mode: "rich", title: /^Pad \d+$/.test(title) ? "" : title.slice(0, 120), body: padEmpty({ mode: "rich", body }) ? "" : body } };
  }

  // ---- Start ----------------------------------------------------------------------------
  setupRich();
  setupPreview();
  history.replaceState(null, "", `#${current}`);
  chrome.storage.local.set({ padState: { current } });
  showPad();
  tidyImages();
})();
