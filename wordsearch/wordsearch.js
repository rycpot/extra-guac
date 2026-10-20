// Word search: find the hidden words, in 42 languages and four levels.
//
// One copy serves both places it shows: its section in the side panel (popup.html, Easy only, the
// others need more room) and its own tab (wordsearch/index.html). WordSearch.mount() builds it
// inside the element it's given.
//
// The words come from lists made from wordfreq (tools/word-packs.py, words/<language>.txt), most
// common first. The release publishes them on rycpot.github.io; a language's list is downloaded
// the first time it's picked and kept here, so after that it plays offline. A level is a slice of
// that order plus a grid size and the directions words may run. Drag across a word, or tap its
// first and last letter.
(() => {
"use strict";
const WORDS_URL = "https://rycpot.github.io/extra-guac/words/";
const REFRESH_DAYS = 30;                 // a kept list is fetched again (quietly) after this long
const KEY = "ws";                        // localStorage: settings, stats and the game in progress
const IDLE_MS = 60000;                   // the clock pauses after this long with no touch
const TAB_CARD = 500;                    // the tab's puzzle card, px, on every level (less only if the window is small)
const LIST_KEY = (lang) => `ws-words:${lang}`;

// Native names. The picker shows English first, then the rest in alphabetical order.
const LANGS = [
  ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"], ["pt", "Português"],
  ["nl", "Nederlands"], ["sv", "Svenska"], ["nb", "Norsk"], ["da", "Dansk"], ["fi", "Suomi"], ["is", "Íslenska"],
  ["pl", "Polski"], ["cs", "Čeština"], ["sk", "Slovenčina"], ["sl", "Slovenščina"], ["sh", "Srpskohrvatski"], ["hu", "Magyar"],
  ["ro", "Română"], ["ca", "Català"], ["lt", "Lietuvių"], ["lv", "Latviešu"], ["tr", "Türkçe"], ["id", "Bahasa Indonesia"],
  ["ms", "Bahasa Melayu"], ["fil", "Filipino"], ["vi", "Tiếng Việt"], ["ru", "Русский"], ["uk", "Українська"], ["bg", "Български"],
  ["mk", "Македонски"], ["el", "Ελληνικά"], ["he", "עברית"], ["ar", "العربية"], ["fa", "فارسی"], ["ur", "اردو"],
  ["hi", "हिन्दी"], ["bn", "বাংলা"], ["ta", "தமிழ்"], ["zh", "中文"], ["ja", "日本語"], ["ko", "한국어"],
];
{
  const order = new Intl.Collator("en", { sensitivity: "base" });
  LANGS.splice(1, Infinity, ...LANGS.slice(1).sort((a, b) => order.compare(a[1], b[1])));
}
const RTL = new Set(["he", "ar", "fa", "ur"]);
// Where a cell holds a syllable or a character, words are fewer cells long.
const SYLLABIC = new Set(["zh", "ja", "ko", "hi", "bn", "ta"]);

const E = [0, 1], S = [1, 0], SE = [1, 1], NE = [-1, 1];
const ALL = [E, S, SE, NE, [0, -1], [-1, 0], [-1, -1], [1, -1]];
// from/to: the slice of a 6,000-word list the words are drawn from (scaled to shorter lists).
const LEVELS = {
  easy:   { name: "Easy",   size: 8,  count: 6,  from: 120,  to: 1500, dirs: [E, S],          len: [4, 7],  syl: [2, 4], rtl: [3, 5] },
  medium: { name: "Medium", size: 10, count: 9,  from: 250,  to: 3000, dirs: [E, S, SE, NE],  len: [4, 8],  syl: [2, 5], rtl: [3, 6] },
  hard:   { name: "Hard",   size: 12, count: 12, from: 600,  to: 4500, dirs: ALL,             len: [4, 10], syl: [3, 6], rtl: [3, 8] },
  expert: { name: "Expert", size: 14, count: 15, from: 1200, to: 6000, dirs: ALL,             len: [5, 12], syl: [3, 7], rtl: [4, 10], hidden: true },
};
const LEVEL_IDS = Object.keys(LEVELS);
const HUES = [205, 145, 30, 345, 265, 175, 10, 50, 290, 100, 230, 320, 190, 125, 0];
const ICON = {
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z"/></svg>',
  again: '<svg viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/></svg>',
  bulb: '<svg viewBox="0 0 24 24"><path d="M9 17.5h6M10 20.5h4M12 3.5a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3.5z"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M5 19.5V11M12 19.5V5M19 19.5v-6"/></svg>',
  soundOn: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.2 6.4a8 8 0 0 1 0 11.2"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5l-8 8M17 14v5.5H4.5V7H10"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.8 14.1A4.6 4.6 0 0 1 20.5 18.5"/></svg>',
};
const SVG = "http://www.w3.org/2000/svg";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const langName = (code) => (LANGS.find((l) => l[0] === code) || [code, code])[1];
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

// ---- saved state ------------------------------------------------------------------------
function load() {
  let d = {};
  try { d = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  d.stats ||= {};
  // For a while the tab kept a puzzle for each level; now it's one again.
  if (d.games) { d.game ??= d.games[d.level] || null; delete d.games; }
  if (!LEVELS[d.level]) d.level = "easy";
  if (!LANGS.some((l) => l[0] === d.lang)) d.lang = null;
  return d;
}
// The panel and a tab can both be open: each change is made to what's stored now, so neither
// undoes the other's.
function persist(change) {
  const d = load();
  change(d);
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch {}
  return d;
}

// ---- word lists -------------------------------------------------------------------------
const lists = {}, refreshing = new Set();
const hasList = (lang) => !!lists[lang] || (() => { try { return localStorage.getItem(LIST_KEY(lang)) !== null; } catch { return false; } })();
function keptList(lang) {
  try { return JSON.parse(localStorage.getItem(LIST_KEY(lang))); } catch { return null; }
}
async function fetchList(lang) {
  const res = await fetch(`${WORDS_URL}${lang}.txt`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const words = (await res.text()).split("\n").map((w) => w.trim()).filter(Boolean);
  if (words.length < 500) throw new Error("short list");
  try { localStorage.setItem(LIST_KEY(lang), JSON.stringify({ at: Date.now(), words })); } catch {}
  return words;
}
// The list for a language: the kept copy (refreshed in the background when it's old), or a download.
async function wordsFor(lang) {
  if (lists[lang]) return lists[lang];
  const kept = keptList(lang);
  if (kept?.words?.length) {
    if (Date.now() - kept.at > REFRESH_DAYS * 864e5 && !refreshing.has(lang)) {
      refreshing.add(lang);
      fetchList(lang).then((w) => { lists[lang] = w; delete fillers[lang]; for (const k in pools) if (k.startsWith(`${lang}:`)) delete pools[k]; }, () => {});
    }
    return (lists[lang] = kept.words);
  }
  return (lists[lang] = await fetchList(lang));
}

// A word's cells: one per letter, or per syllable where letters join (Hindi, Bengali, Tamil).
const segmenters = {};
function cellsOf(text, lang) {
  segmenters[lang] ||= new Intl.Segmenter(lang, { granularity: "grapheme" });
  return Array.from(segmenters[lang].segment(text), (s) => s.segment);
}
const upper = (w, lang) => w.toLocaleUpperCase(lang === "fil" ? "tl" : lang);

// ---- puzzle -----------------------------------------------------------------------------
const pools = {};   // the words a level can use, per "language:level"
function generate(words, lang, level) {
  const L = LEVELS[level], n = L.size;
  const scale = Math.min(1, words.length / 6000);
  const [min, max] = SYLLABIC.has(lang) ? L.syl : RTL.has(lang) ? L.rtl : L.len;
  // Right-to-left languages read forward from the right.
  const dirs = RTL.has(lang) ? L.dirs.map(([dr, dc]) => [dr, -dc]) : L.dirs;
  const pool = (pools[`${lang}:${level}`] ||= words.slice(Math.floor(L.from * scale), Math.floor(L.to * scale))
    .map((w) => [cellsOf(upper(w, lang), lang), cellsOf(w, lang).length])
    .filter(([cells, len]) => cells.length >= min && cells.length <= Math.min(max, n) && cells.length === len)
    .map(([cells]) => cells));
  let best = null;
  for (let attempt = 0; attempt < 12 && !(best && best.words.length === L.count); attempt++) {
    const grid = Array.from({ length: n }, () => Array(n).fill(null));
    const placed = [];
    // Longer words first: they're the hard ones to fit.
    const picks = shuffle(pool.slice()).slice(0, L.count * 4).sort((a, b) => b.length - a.length);
    for (const cells of picks) {
      if (placed.length === L.count) break;
      const text = cells.join("");
      if (placed.some((w) => w.text.includes(text) || text.includes(w.text))) continue;
      const spot = place(grid, cells, dirs);
      if (!spot) continue;
      const [r, c, dr, dc] = spot;
      cells.forEach((ch, i) => { grid[r + dr * i][c + dc * i] = ch; });
      placed.push({ text, r, c, dr, dc, len: cells.length });
    }
    if (!best || placed.length > best.words.length) best = { grid, words: placed };
  }
  const fill = fillerFor(words, lang);
  const grid = best.grid.map((row) => row.map((ch) => ch || fill()));
  best.words.sort((a, b) => a.text.localeCompare(b.text, lang));
  return { lang, level, n, grid, words: best.words, found: [], elapsed: 0, hints: 0 };
}
// Every spot the word fits; crossing another word is preferred, so the grid stays dense.
function place(grid, cells, dirs) {
  const n = grid.length, spots = [];
  for (const [dr, dc] of dirs) for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const er = r + dr * (cells.length - 1), ec = c + dc * (cells.length - 1);
    if (er < 0 || er >= n || ec < 0 || ec >= n) continue;
    let cross = 0, ok = true;
    for (let i = 0; i < cells.length && ok; i++) {
      const g = grid[r + dr * i][c + dc * i];
      if (g === null) continue;
      if (g === cells[i]) cross++; else ok = false;
    }
    if (ok && cross < cells.length) spots.push([r, c, dr, dc, cross]);
  }
  if (!spots.length) return null;
  const crossing = spots.filter((s) => s[4] > 0);
  const from = crossing.length && Math.random() < 0.55 ? crossing : spots;
  return from[Math.floor(Math.random() * from.length)];
}
// Filler letters as often as they show up in the language's common words.
const fillers = {};
function fillerFor(words, lang) {
  if (fillers[lang]) return fillers[lang];
  const counts = new Map();
  for (const w of words.slice(0, 3000)) for (const ch of cellsOf(upper(w, lang), lang)) counts.set(ch, (counts.get(ch) || 0) + 1);
  const letters = [...counts.keys()], cum = [];
  let total = 0;
  for (const ch of letters) cum.push((total += counts.get(ch)));
  return (fillers[lang] = () => {
    const x = Math.random() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > x) hi = mid; else lo = mid + 1; }
    return letters[lo];
  });
}

// ---- sound ------------------------------------------------------------------------------
let audio = null;
function tone(muted, freq, at = 0, dur = 0.5, vol = 0.08) {
  if (muted) return;
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime + at, o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur);
  } catch {}
}
const SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760];

// What shows, dimmed, until a language is picked: an Easy puzzle half done.
const SAMPLE = {
  lang: "en", level: "easy", n: 8, elapsed: 0, hints: 0, sample: true,
  grid: ["AVOCADOT", "RKEWBOJO", "SALSANFM", "LUYGPIZA", "IWQDHOXT", "MFBRKNUO", "ECHIPSGV", "DNTJYEWL"].map((r) => [...r]),
  words: ["AVOCADO", "LIME", "SALSA", "CHIPS", "TOMATO", "ONION"].map((text) => ({ text })),
  found: [{ i: 0, hue: HUES[0], r1: 0, c1: 0, r2: 0, c2: 6 }, { i: 2, hue: HUES[1], r1: 2, c1: 0, r2: 2, c2: 4 },
    { i: 5, hue: HUES[2], r1: 1, c1: 5, r2: 5, c2: 5 }],
};
let english = null;
try { english = new Intl.DisplayNames(["en"], { type: "language" }); } catch {}

// ---- the game ---------------------------------------------------------------------------
// opts.panel: the side panel's version (Easy only); opts.onOpenTab(level): open the game's own tab;
// opts.onRoom(button): Play with others (the tab only, wordsearch/room.js). mount() returns what
// a room needs to play a shared puzzle here (api.room).
function mount(root, opts = {}) {
  const panel = !!opts.panel;
  const data = load();

  root.classList.add("ws");
  root.classList.toggle("ws-panel", panel);
  root.innerHTML = "";
  const bar = el("div", "ws-bar");
  const langBtn = el("button", "ws-lang");
  langBtn.title = "Language";
  const levelEl = el("div", "ws-level");
  const timerEl = el("div", "ws-timer", "0:00");
  const ib = (icon, label, onClick) => {
    const b = el("button", "ws-ib", ICON[icon]);
    b.title = label;
    b.setAttribute("aria-label", label);
    b.onclick = onClick;
    return b;
  };
  data.mute ??= true;                    // quiet until the sound is turned on
  const soundBtn = ib(data.mute ? "soundOff" : "soundOn", "Sound", () => {
    data.mute = !data.mute;
    persist((d) => { d.mute = data.mute; });
    soundBtn.innerHTML = ICON[data.mute ? "soundOff" : "soundOn"];
  });
  const hintBtn = ib("bulb", "Hint", hint);
  const statsBtn = ib("chart", "Stats", showStats);
  const roomBtn = !panel && opts.onRoom ? ib("people", "Play with others", () => opts.onRoom(roomBtn)) : null;
  roomBtn?.classList.add("ws-roombtn");
  const tools = [roomBtn, hintBtn, statsBtn, soundBtn].filter(Boolean);
  // The two ways out of the puzzle: Stop, and New game (which asks for a level).
  const stopBtn = ib("stop", "Stop", stop);
  stopBtn.className = "ws-stop";
  const newBtn = ib("plus", "New game", pickLevel);
  newBtn.className = "ws-new";
  // One strip: language | level and time | hint, stats, sound | Stop, New game.
  const clock = el("div", "ws-clock");
  clock.append(levelEl, timerEl);
  bar.append(langBtn, el("i", "ws-sep"), clock, el("div", "ws-grow"), ...tools, el("i", "ws-sep"), stopBtn, newBtn);
  const play = el("div", "ws-play");
  const card = el("div", "ws-card");
  const gridEl = el("div", "ws-grid");
  const svg = document.createElementNS(SVG, "svg");
  svg.classList.add("ws-marks");
  const lettersEl = el("div", "ws-letters");
  gridEl.append(svg, lettersEl);
  card.append(gridEl);
  const wordsEl = el("div", "ws-words");
  // Over the card: Start (or Resume) each time the panel or the tab opens, and Start after Stop.
  const start = el("div", "ws-start");
  const startBtn = el("button", "ws-btn");
  startBtn.onclick = () => {
    if (game.sample) return pickLevel();
    ready = true;
    setState();
    startClock();
  };
  start.append(startBtn);
  play.append(card, wordsEl, start);
  // The word lists' source, as their CC BY-SA 4.0 license asks.
  const credit = el("p", "ws-credit", `<svg class="ws-gh" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Powered by <a href="https://github.com/rspeer/wordfreq" target="_blank" rel="noopener" title="Word lists made from wordfreq, CC BY-SA 4.0">wordfreq</a>`);
  root.append(bar, play, credit);

  let game = null, cells = [], chips = [], startedAt = 0, ticking = null, overlay = null, menu = null, visible = true, lastSave = 0;
  let idle = false, lastActive = 0, ready = false;
  // In a room (room.js): its hooks, and the puzzle everyone in it plays.
  let room = null;
  const level = () => (room ? room.level() : panel ? "easy" : data.level);
  // The tab's address names the level played (#new-<level> is the panel asking for a new game).
  const markLevel = () => { if (!panel && !room) history.replaceState(null, "", `#${game && !game.sample ? game.level : data.level}`); };
  const done = (g) => g.found.length === g.words.length;
  const isSolved = () => game && done(game);

  function updateBar() {
    markLevel();
    const lang = room ? room.lang() : game && !game.sample ? game.lang : data.lang;
    const name = lang ? langName(lang) : "Choose a language";
    langBtn.inert = !!room && !room.canPick();
    langBtn.innerHTML = `${ICON.globe}${lang ? `<span class="ws-code">${lang.toUpperCase()}</span>` : ""}<span class="ws-name">${name}</span>`;
    langBtn.title = lang ? `Language: ${name}` : "Language";
    const lv = LEVELS[game && !game.sample ? game.level : level()];
    levelEl.textContent = lv.name;
    levelEl.title = `${lv.size}×${lv.size}, ${lv.count} words`;
    fit();
  }

  // When the strip is too narrow: the language's code for its name, then no level, closer
  // buttons, no clock (and the first time, no Stop or New game), then a shortened name.
  function fit() {
    for (let i = 1; i <= 5; i++) bar.classList.remove(`ws-f${i}`);
    for (let i = 1; i <= 5 && bar.scrollWidth > bar.clientWidth; i++) bar.classList.add(`ws-f${i}`);
  }

  // A new puzzle, in the language picked last (here or in the other place) or the one given;
  // a language becomes the default once its words are here.
  let pending = null;
  // wait: the puzzle shows dimmed until Start, as when the panel or the tab opens.
  // id: the level, when it's a new choice.
  async function newGame(lang = load().lang || data.lang, wait = false, id = null) {
    ready = !wait;
    stopClock();
    dropOverlay();
    if (!lang) return showSample();
    pending = lang;
    let words;
    try {
      if (!hasList(lang)) showMessage(`Getting ${langName(lang)} words…`);
      words = await wordsFor(lang);
    } catch {
      if (pending === lang) showMessage(`Couldn't get the ${langName(lang)} words. Check the connection and try again.`, () => newGame(lang, false, id));
      return;
    }
    if (pending !== lang) return;
    pending = null;
    dropOverlay();
    if (lang !== data.lang) persist((d) => { d.lang = data.lang = lang; });
    // The tab remembers the level chosen; the panel only plays Easy.
    if (!panel && id && id !== data.level) persist((d) => { d.level = data.level = id; });
    game = generate(words, lang, panel ? "easy" : id || data.level);
    saveGame();
    render(true);
  }
  // One puzzle at a time: the panel's (Easy) and the tab's.
  const keep = (d) => { if (panel) d.panelGame = game; else d.game = game; };
  const saveGame = () => { if (game && !game.sample && !room) persist(keep); };
  // A kept puzzle worth going back to: unfinished, and still the shape its level has.
  const usable = (g) => g && LANGS.some((l) => l[0] === g.lang) && LEVELS[g.level] && (!panel || g.level === "easy") &&
    g.grid?.length === LEVELS[g.level].size && !done(g);

  // Stop ends the puzzle: its time isn't counted, and it isn't kept.
  function stop() {
    if (!game || game.sample) return;
    stopClock(false);
    clearAnchor();
    pending = null;
    dropOverlay();
    persist((d) => { if (panel) d.panelGame = null; else d.game = null; });
    showSample();
  }
  // Without a puzzle (the first time, or after Stop): one to look at, all dimmed. The first time
  // only the language button is there to press; after that, Start in the middle asks for a level.
  function showSample() {
    game = structuredClone(SAMPLE);
    render(false);
  }

  function setState() {
    const sample = !!game.sample, first = sample && !data.lang;
    const waiting = !ready && !sample && !isSolved();
    root.classList.toggle("ws-preview", sample && !room);
    root.classList.toggle("ws-first", first && !room);
    root.classList.toggle("ws-waiting", waiting);
    // In a room's lobby the strip stays usable: only the sample under the lobby card is out of reach.
    for (const n of [clock, stopBtn, newBtn, card, wordsEl, credit, ...tools]) n.inert = sample && n !== roomBtn && (!room || n === card || n === wordsEl);
    gridEl.inert = waiting;
    if (!sample) wordsEl.inert = waiting;
    hintBtn.inert = waiting || sample;
    start.hidden = !!room || first || !(sample || waiting);
    const begun = !sample && (game.elapsed >= 1000 || game.found.length > 0);
    startBtn.innerHTML = `${ICON.play}${begun ? `Resume · ${fmt(game.elapsed)}` : "Start"}`;
    fit();
  }

  function render(fresh) {
    updateBar();
    setState();
    const n = game.n;
    root.lang = game.lang;
    wordsEl.dir = RTL.has(game.lang) ? "rtl" : "ltr";
    lettersEl.style.gridTemplate = `repeat(${n}, 1fr) / repeat(${n}, 1fr)`;
    svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
    svg.innerHTML = "";
    lettersEl.innerHTML = "";
    cells = game.grid.map((row, r) => row.map((ch, c) => {
      const s = el("span");
      s.textContent = ch;
      s.style.setProperty("--d", r + c);
      lettersEl.append(s);
      return s;
    }));
    game.found.forEach((f) => drawFound(f, false));
    renderWords();
    lettersEl.classList.remove("ws-enter", "ws-wave");
    if (fresh && !reducedMotion()) { void lettersEl.offsetWidth; lettersEl.classList.add("ws-enter"); }
    layout();
    timerEl.classList.toggle("ws-done", isSolved());
    timerEl.textContent = fmt(game.elapsed);
    if (!isSolved()) startClock();
  }

  function renderWords() {
    wordsEl.innerHTML = "";
    const hidden = LEVELS[game.level].hidden;
    chips = game.words.map((w, i) => {
      const got = game.found.some((f) => f.i === i);
      const chip = el("span", "ws-word" + (got ? " ws-got" : ""));
      // Expert keeps a word hidden until it's found: a blank as long as the word, and its length.
      if (hidden && !got) {
        chip.classList.add("ws-blank");
        chip.title = `${w.len} letters`;
        chip.innerHTML = `<i style="--n:${w.len}"></i><b>${w.len}</b>`;
      } else chip.textContent = w.text;
      return chip;
    });
    // Blanks longest first, so their order gives nothing away.
    const order = chips.map((_, i) => i);
    if (hidden) order.sort((a, b) => game.words[b].len - game.words[a].len);
    for (const i of order) wordsEl.append(chips[i]);
  }

  function line(r1, c1, r2, c2, cls) {
    const l = document.createElementNS(SVG, "line");
    l.setAttribute("x1", c1 + 0.5); l.setAttribute("y1", r1 + 0.5);
    l.setAttribute("x2", c2 + 0.5); l.setAttribute("y2", r2 + 0.5);
    if (cls) l.setAttribute("class", cls);
    svg.append(l);
    return l;
  }
  function drawFound(f, animate) {
    const l = line(f.r1, f.c1, f.r2, f.c2, "ws-found" + (animate ? " ws-pop" : ""));
    l.style.setProperty("--h", f.hue);
    for (const [r, c] of foundCells(f)) cells[r][c].classList.add("ws-in-word");
  }
  function foundCells(f) {
    const dr = Math.sign(f.r2 - f.r1), dc = Math.sign(f.c2 - f.c1);
    return pathOf(f.r1, f.c1, { len: Math.max(Math.abs(f.r2 - f.r1), Math.abs(f.c2 - f.c1)), dr, dc });
  }

  // The grid as big as fits in the panel's width; in a tab, the same size on every level, smaller
  // only when the window can't hold it and the list below.
  function layout() {
    fit();
    if (!game) return;
    const pad = 2 * parseFloat(getComputedStyle(card).paddingLeft || 0);
    let size = root.clientWidth - pad;
    if (!panel) {
      const gap = (n) => parseFloat(getComputedStyle(n).rowGap) || 0;
      // A room's players strip (narrow windows) sits between the strip and the puzzle.
      const extra = [...root.querySelectorAll(":scope > .ws-extra")].reduce((h, n) => h + (n.offsetHeight ? n.offsetHeight + gap(root) : 0), 0);
      const H = root.clientHeight - bar.offsetHeight - credit.offsetHeight - 2 * gap(root) - extra - Math.max(parseFloat(getComputedStyle(wordsEl).minHeight), wordsEl.offsetHeight) - gap(play);
      size = Math.min(TAB_CARD, size + pad, H) - pad;
    }
    size = Math.max(180, Math.floor(size));
    // The bars span what's below them.
    if (!panel) root.style.setProperty("--ws-span", `${size + pad}px`);
    gridEl.style.width = gridEl.style.height = `${size}px`;
    root.style.setProperty("--cell", `${size / game.n}px`);
    start.style.height = `${size + pad}px`;
    root.style.setProperty("--ws-card-h", `${size + pad}px`);
  }
  new ResizeObserver(layout).observe(root);

  // ---- clock: runs only while the puzzle is on screen ----
  // In a room the clock is the race's: it runs from the start to the last word, whatever the tab does.
  function startClock() {
    stopClock();
    if (!game || game.sample || !ready || isSolved()) return;
    if (!room && (document.hidden || overlay || menu || !visible)) return;
    setIdle(false);
    startedAt = performance.now() - game.elapsed;
    lastActive = performance.now();
    ticking = setInterval(() => {
      tick();
      // The minute nobody touched it doesn't count.
      if (!room && performance.now() - lastActive > IDLE_MS) { stopClock(); game.elapsed = lastActive - startedAt; timerEl.textContent = fmt(game.elapsed); saveGame(); setIdle(true); }
    }, 250);
  }
  function tick() {
    game.elapsed = performance.now() - startedAt;
    timerEl.textContent = fmt(game.elapsed);
    if (performance.now() - lastSave > 5000) { lastSave = performance.now(); saveGame(); }
  }
  function stopClock(save = true) {
    if (!ticking) return;
    tick();
    clearInterval(ticking);
    ticking = null;
    if (save) saveGame();
  }
  // Left alone for a minute, the clock waits for the next touch.
  function setIdle(on) {
    idle = on;
    timerEl.classList.toggle("ws-paused", on);
    timerEl.title = on ? "Paused. Touch the puzzle to go on." : "";
  }
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel"]) {
    root.addEventListener(type, () => { lastActive = performance.now(); if (idle) startClock(); }, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", () => { if (!room) document.hidden ? stopClock() : startClock(); });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (!room) visible ? startClock() : stopClock(); }).observe(gridEl);
  addEventListener("pagehide", () => { if (ticking) { tick(); saveGame(); } });

  // ---- selecting ----
  let drag = null, anchor = null, anchorEl = null;
  function cellAt(e) {
    const rect = gridEl.getBoundingClientRect(), n = game.n;
    const x = ((e.clientX - rect.left) / rect.width) * n, y = ((e.clientY - rect.top) / rect.height) * n;
    return { x, y, r: Math.min(n - 1, Math.max(0, Math.floor(y))), c: Math.min(n - 1, Math.max(0, Math.floor(x))) };
  }
  // From the start cell toward the pointer, snapped to the nearest of the eight directions.
  function snap(r0, c0, x, y) {
    const dx = x - (c0 + 0.5), dy = y - (r0 + 0.5);
    if (Math.hypot(dx, dy) < 0.5) return { r: r0, c: c0, len: 0, dr: 0, dc: 0 };
    const oct = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    const dc = [1, 1, 0, -1, -1, -1, 0, 1][oct], dr = [0, 1, 1, 1, 0, -1, -1, -1][oct];
    let len = Math.max(0, Math.round((dx * dc + dy * dr) / (dc * dc + dr * dr)));
    const n = game.n;
    while (len > 0 && (r0 + dr * len < 0 || r0 + dr * len >= n || c0 + dc * len < 0 || c0 + dc * len >= n)) len--;
    return { r: r0 + dr * len, c: c0 + dc * len, len, dr, dc };
  }
  function lit(path) {
    for (const s of lettersEl.querySelectorAll(".ws-on")) s.classList.remove("ws-on");
    if (path) for (const [r, c] of path) cells[r][c].classList.add("ws-on");
  }
  const pathOf = (r0, c0, end) => Array.from({ length: end.len + 1 }, (_, k) => [r0 + end.dr * k, c0 + end.dc * k]);

  gridEl.addEventListener("pointerdown", (e) => {
    if (!game || game.sample || isSolved() || e.button > 0) return;
    e.preventDefault();
    gridEl.setPointerCapture(e.pointerId);
    const { r, c } = cellAt(e);
    drag = { r0: r, c0: c, end: { r, c, len: 0, dr: 0, dc: 0 }, moved: false, line: line(r, c, r, c, "ws-sel") };
    lit([[r, c]]);
  });
  gridEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const { x, y } = cellAt(e);
    const end = snap(drag.r0, drag.c0, x, y);
    if (end.len > 0) drag.moved = true;
    if (end.r === drag.end.r && end.c === drag.end.c) return;
    drag.end = end;
    drag.line.setAttribute("x2", end.c + 0.5);
    drag.line.setAttribute("y2", end.r + 0.5);
    lit(pathOf(drag.r0, drag.c0, end));
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.end.len > 0) { clearAnchor(); return finish(d.r0, d.c0, d.end, d.line); }
    d.line.remove();
    lit(null);
    if (!d.moved && e.type !== "pointercancel") tap(d.r0, d.c0);
  };
  gridEl.addEventListener("pointerup", endDrag);
  gridEl.addEventListener("pointercancel", endDrag);

  // Tap the first letter, then the last.
  function tap(r, c) {
    if (anchor && anchor.r === r && anchor.c === c) return clearAnchor();
    if (anchor) {
      const dr = r - anchor.r, dc = c - anchor.c;
      if (dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc)) {
        const end = { r, c, len: Math.max(Math.abs(dr), Math.abs(dc)), dr: Math.sign(dr), dc: Math.sign(dc) };
        const { r: r0, c: c0 } = anchor;
        clearAnchor();
        return finish(r0, c0, end, line(r0, c0, r, c, "ws-sel"));
      }
    }
    clearAnchor();
    anchor = { r, c };
    anchorEl = document.createElementNS(SVG, "circle");
    anchorEl.setAttribute("cx", c + 0.5); anchorEl.setAttribute("cy", r + 0.5); anchorEl.setAttribute("r", 0.4);
    anchorEl.setAttribute("class", "ws-anchor");
    svg.append(anchorEl);
  }
  function clearAnchor() {
    anchor = null;
    anchorEl?.remove();
    anchorEl = null;
  }

  function finish(r0, c0, end, sel) {
    lit(null);
    const path = pathOf(r0, c0, end);
    const text = path.map(([r, c]) => game.grid[r][c]).join("");
    const back = path.map(([r, c]) => game.grid[r][c]).reverse().join("");
    const i = game.words.findIndex((w, k) => (w.text === text || w.text === back) && !game.found.some((f) => f.i === k));
    if (i < 0) {
      sel.classList.add("ws-miss");
      setTimeout(() => sel.remove(), 400);
      if (path.length >= 3 && !game.words.some((w) => w.text === text || w.text === back)) tone(data.mute, 196, 0, 0.18, 0.04);
      return;
    }
    sel.remove();
    const used = new Set(game.found.map((f) => f.hue));
    const hue = HUES.find((h) => !used.has(h)) ?? HUES[game.found.length % HUES.length];
    const f = { i, hue, r1: r0, c1: c0, r2: end.r, c2: end.c };
    game.found.push(f);
    drawFound(f, true);
    renderWords();
    const note = SCALE[Math.min(SCALE.length - 1, game.found.length - 1)];
    tone(data.mute, note, 0, 0.55);
    tone(data.mute, note * 1.5, 0.06, 0.5, 0.04);
    try { navigator.vibrate?.(12); } catch {}
    room?.onFound(game.found.length);
    if (isSolved()) solved(); else saveGame();
  }

  // A ring around one end of a word not found yet, and that word lights up in the list. The end
  // is one no found word covers, so the ring never points into a band already there.
  function hint() {
    if (!game || game.sample || isSolved()) return;
    const covered = new Set(game.found.flatMap((f) => foundCells(f).map(([r, c]) => `${r},${c}`)));
    const ends = [];
    game.words.forEach((w, i) => {
      if (game.found.some((f) => f.i === i)) return;
      for (const [r, c] of [[w.r, w.c], [w.r + w.dr * (w.len - 1), w.c + w.dc * (w.len - 1)]]) ends.push({ i, r, c, free: !covered.has(`${r},${c}`) });
    });
    const free = ends.filter((e) => e.free), pool = free.length ? free : ends;
    const { i, r, c } = pool[Math.floor(Math.random() * pool.length)];
    game.hints++;
    saveGame();
    svg.querySelector(".ws-flash")?.remove();
    const ring = document.createElementNS(SVG, "circle");
    ring.setAttribute("cx", c + 0.5); ring.setAttribute("cy", r + 0.5); ring.setAttribute("r", 0.44);
    ring.setAttribute("class", "ws-flash");
    svg.append(ring);
    setTimeout(() => ring.remove(), 1800);
    for (const chip of chips) chip.classList.remove("ws-hinted");
    const chip = chips[i];
    chip.classList.add("ws-hinted");
    setTimeout(() => chip.classList.remove("ws-hinted"), 1800);
    tone(data.mute, 880, 0, 0.3, 0.03);
  }

  function solved() {
    stopClock();
    timerEl.classList.add("ws-done");
    const t = Math.round(game.elapsed);
    // A race's times are the room's (its results), not this device's stats.
    if (room) {
      [0, 2, 4, 6].forEach((k, j) => tone(data.mute, SCALE[k], j * 0.09, 0.7, 0.06));
      if (!reducedMotion()) { lettersEl.classList.remove("ws-enter", "ws-wave"); void lettersEl.offsetWidth; lettersEl.classList.add("ws-wave"); }
      return room.onSolved(t);
    }
    data.stats = persist((d) => {
      const s = (d.stats[game.level] ||= { played: 0, total: 0, best: 0 });
      game.record = s.played > 0 && t < s.best;
      s.played++;
      s.total += t;
      if (!s.best || t < s.best) s.best = t;
      keep(d);
    }).stats;
    [0, 2, 4, 6].forEach((k, j) => tone(data.mute, SCALE[k], j * 0.09, 0.7, 0.06));
    if (!reducedMotion()) { lettersEl.classList.remove("ws-enter", "ws-wave"); void lettersEl.offsetWidth; lettersEl.classList.add("ws-wave"); }
    setTimeout(showSolved, reducedMotion() ? 200 : 900 + game.n * 40);
  }

  // ---- cards: language, stats, solved, messages ----
  function openOverlay(build, closable = true) {
    closeMenu(false);
    stopClock();
    dropOverlay();
    overlay = el("div", "ws-overlay");
    const box = el("div", "ws-box");
    if (closable) {
      const x = ib("close", "Close", closeOverlay);
      x.classList.add("ws-x");
      box.append(x);
      overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) closeOverlay(); });
    }
    build(box);
    overlay.append(box);
    root.append(overlay);
    box.querySelector("button:not(.ws-x)")?.focus({ preventScroll: true });
  }
  function dropOverlay() {
    overlay?.remove();
    overlay = null;
  }
  function closeOverlay() {
    if (!overlay) return;
    dropOverlay();
    startClock();
  }
  root.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay?.querySelector(".ws-x")) closeOverlay(); });

  // retry: tries the failed download again.
  function showMessage(text, retry) {
    openOverlay((box) => {
      box.append(el("p", null, text));
      if (retry) {
        const b = el("button", "ws-btn", `${ICON.again}Try again`);
        b.onclick = retry;
        box.append(b);
        const other = el("button", "ws-link", "Pick another language");
        other.onclick = () => { dropOverlay(); openMenu(); };
        box.append(other);
      }
    }, false);
  }

  // ---- languages: a list dropping from the language button, searchable by either name ----
  function openMenu() {
    stopClock();
    menu = el("div", "ws-menu");
    const search = el("input", "ws-search");
    Object.assign(search, { type: "search", placeholder: "Search languages", spellcheck: false, autocomplete: "off" });
    search.setAttribute("aria-label", "Search languages");
    const list = el("div", "ws-options");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Languages");
    const none = el("p", "ws-none", "No language matches");
    none.hidden = true;
    const cur = game && !game.sample ? game.lang : data.lang;
    const fold = (t) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const items = LANGS.map(([code, name]) => {
      const en = english?.of(code);
      const b = el("button", code === cur ? "ws-cur" : null);
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(code === cur));
      const native = el("span");
      native.lang = code;
      native.textContent = name;
      b.append(native);
      if (en && en !== name) b.append(Object.assign(el("small"), { textContent: en }));
      b.dataset.code = code;
      b.dataset.find = fold(`${name} ${en || ""} ${code}`);
      b.onclick = () => pick(code);
      list.append(b);
      return b;
    });
    search.oninput = () => {
      const q = fold(search.value.trim());
      for (const b of items) b.hidden = !!q && !b.dataset.find.includes(q);
      none.hidden = items.some((b) => !b.hidden);
    };
    menu.addEventListener("keydown", (e) => {
      const shown = items.filter((b) => !b.hidden), at = shown.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = at + (e.key === "ArrowDown" ? 1 : -1);
        (next < 0 ? search : shown[Math.min(next, shown.length - 1)])?.focus();
      } else if (e.key === "Enter" && e.target === search && shown.length) {
        e.preventDefault();
        pick(shown[0].dataset.code);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        langBtn.focus();
      }
    });
    menu.append(search, list, none);
    bar.append(menu);
    langBtn.setAttribute("aria-expanded", "true");
    const curBtn = list.querySelector(".ws-cur");
    if (curBtn) list.scrollTop = curBtn.offsetTop - (list.clientHeight - curBtn.offsetHeight) / 2;
    search.focus({ preventScroll: true });
  }
  function closeMenu(resume = true) {
    if (!menu) return;
    menu.remove();
    menu = null;
    langBtn.setAttribute("aria-expanded", "false");
    if (resume) startClock();
  }
  function pick(code) {
    closeMenu(false);
    if (room) return room.onLang(code);
    if (game && !game.sample && code === game.lang && !isSolved()) return startClock();
    newGame(code);
  }
  langBtn.setAttribute("aria-haspopup", "listbox");
  langBtn.setAttribute("aria-expanded", "false");
  langBtn.onclick = () => (menu ? closeMenu() : openMenu());
  document.addEventListener("pointerdown", (e) => { if (menu && !menu.contains(e.target) && !langBtn.contains(e.target)) closeMenu(); }, true);

  function showStats() {
    data.stats = load().stats;
    openOverlay((box) => {
      box.append(el("h2", null, "Stats"));
      const t = el("table", "ws-stats");
      t.innerHTML = "<tr><th>Level</th><th>Solved</th><th>Best</th><th>Average</th></tr>" + LEVEL_IDS.map((id) => {
        const s = data.stats[id];
        return `<tr><td>${LEVELS[id].name}</td><td>${s ? s.played : 0}</td><td>${s?.best ? fmt(s.best) : "–"}</td><td>${s?.played ? fmt(s.total / s.played) : "–"}</td></tr>`;
      }).join("");
      box.append(t);
    });
  }

  function showSolved() {
    if (!game || game.sample) return;        // stopped before the card came up
    openOverlay((box) => {
      const s = data.stats[game.level];
      box.append(el("h2", null, `${LEVELS[game.level].name} solved`));
      box.append(el("div", "ws-big", fmt(game.elapsed)));
      box.append(game.record ? el("p", "ws-best", "New best time") : el("p", null, `Best ${fmt(s.best)} · Average ${fmt(s.total / s.played)}`));
      if (game.hints) box.append(el("p", null, `${game.hints} hint${game.hints === 1 ? "" : "s"} used`));
      const b = el("button", "ws-btn", `${ICON.plus}New game`);
      b.onclick = pickLevel;
      box.append(b);
    });
  }

  // New game: a level, then a new puzzle in it. In the panel, the bigger levels open in a tab.
  function pickLevel() {
    openOverlay((box) => {
      box.append(el("h2", null, "Select difficulty"));
      const list = el("div", "ws-levels");
      for (const id of LEVEL_IDS) {
        const lv = LEVELS[id], away = panel && id !== "easy";
        const b = el("button", null, `<span>${lv.name}</span><small>${away ? "opens in a tab" : `${lv.size}×${lv.size} · ${lv.count} words`}</small>${away ? ICON.open : ""}`);
        b.onclick = () => {
          if (away) { closeOverlay(); return opts.onOpenTab?.(id); }
          newGame(undefined, false, id);
        };
        list.append(b);
      }
      box.append(list);
    });
  }

  // ---- start ----
  // The panel asks the tab for a new game with #new-<level>.<n>; it waits behind Start like any
  // opening. Without a language yet, the level is kept for the first puzzle.
  function takeAsk(hash = location.hash) {
    const m = /^#new-([a-z]+)/.exec(hash), id = m && LEVELS[m[1]] ? m[1] : null;
    if (panel || !id || room) return false;
    if (id !== data.level) persist((d) => { d.level = data.level = id; });
    if (load().lang) newGame(undefined, true, id);
    else { if (game) stop(); else showSample(); }
    return true;
  }
  const hash = location.hash;               // before the bar puts the level there
  updateBar();
  const g = panel ? data.panelGame : data.game;
  if (!takeAsk(hash)) {
    if (usable(g)) { game = g; render(true); }
    else showSample();
  }

  if (!panel) addEventListener("hashchange", () => takeAsk());
  document.fonts?.ready.then(fit);       // the strip measured again in its own font

  // ---- a room (room.js): one puzzle for everyone, its clock from the countdown's end ----
  // hooks: lang(), level(), canPick(), onLang(code), onFound(n), onSolved(ms); nodes: the room's
  // own parts of the strip (start: before the tools, end: after them) and of the credit line.
  function enterRoom(hooks, nodes) {
    stopClock();
    clearAnchor();
    closeMenu(false);
    dropOverlay();
    pending = null;
    room = hooks;
    root.classList.add("ws-in-room");
    for (const b of [roomBtn, hintBtn, statsBtn, stopBtn, newBtn]) b.hidden = true;
    bar.insertBefore(nodes.start, tools[0]);
    bar.append(nodes.end);
    credit.append(nodes.credit);
    showSample();
  }
  function exitRoom(nodes) {
    if (!room) return;
    stopClock(false);
    room = null;
    root.classList.remove("ws-in-room", "ws-lobby");
    for (const b of [roomBtn, hintBtn, statsBtn, stopBtn, newBtn]) b.hidden = false;
    for (const n of Object.values(nodes)) n.remove();
    ready = false;
    const g = data.game = load().game;
    if (usable(g)) { game = g; render(true); }
    else showSample();
  }
  return {
    room: {
      enter: enterRoom,
      exit: exitRoom,
      stage: play,
      langName,
      hasLang: (code) => LANGS.some((l) => l[0] === code),
      levels: LEVELS,
      // The host's puzzle: a new one in that language and level (the words downloaded if needed).
      async make(lang, id) {
        const words = await wordsFor(lang);
        const g = generate(words, lang, id);
        return { lang, level: id, n: g.n, grid: g.grid, words: g.words };
      },
      // A puzzle from the room, dimmed until go(); sample: back to the dimmed sample (the lobby).
      load(p) {
        stopClock(false);
        clearAnchor();
        closeMenu(false);
        ready = false;
        game = { lang: p.lang, level: p.level, n: p.n, grid: p.grid, words: p.words, found: [], elapsed: 0, hints: 0 };
        render(true);
      },
      sample() { stopClock(false); clearAnchor(); ready = false; showSample(); },
      go() { ready = true; setState(); startClock(); },
      // The puzzle can't be played any more (the round ended): it stays on screen, out of reach.
      freeze() { stopClock(); clearAnchor(); gridEl.inert = true; },
      elapsed: () => game?.elapsed || 0,
      // The language and level picked last, which the host's room starts with and keeps.
      prefs: () => { const d = load(); return { lang: d.lang, level: d.level }; },
      savePrefs(p) { persist((d) => { if (p.lang) d.lang = data.lang = p.lang; if (LEVELS[p.level]) d.level = data.level = p.level; }); },
      refresh: updateBar,
      relayout: layout,
    },
  };
}

globalThis.WordSearch = { mount };
})();
