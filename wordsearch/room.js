// Word search with others: a room of up to six (the one who makes it and five who join with its
// code), everyone racing on the same puzzle. The room is a Beam connection of its own
// (beam/beam.js, mounted hidden with opts.game): direct between the devices over WebRTC, or
// through Beam's encrypted relay when that can't open.
//
// The host (who made the room) keeps the room's state and passes everything on: who's in it and
// how they're connected, the round, each player's progress and time, and the chat. A player who
// joined only talks to the host. The host's device makes the puzzle when Start is pressed and
// sends it to everyone; it's hidden on every screen, the host's too, until the 10-second
// countdown ends. Each device times its own race from the end of its countdown.
//
// The same page runs in the extension and on rycpot.github.io/wordsearch, so a phone or another
// browser can join from the web.
(() => {
"use strict";
const APP = "egws1";                    // the rooms' own codes and relay inboxes, apart from Beam's
const WEB_URL = "https://rycpot.github.io/wordsearch/";
const NAME_KEY = "eg-name";             // the name, shared with Beam
const PID_KEY = APP + "-pid";           // this tab's player, the same after a reload
const COUNTDOWN = 10;                   // seconds
const NAME_MAX = 24, CHAT_MAX = 200, CHAT_KEEP = 100;
const IS_EXTENSION = location.protocol === "chrome-extension:";
// A QR code's link: #join-<code>.<relay>, read before the game puts its level in the address.
const linkJoin = /^#join-(\d{6,10})(?:\.(\d))?$/.exec(location.hash);
const COLORS = ["#7dd3fc", "#f9a8d4", "#fcd34d", "#86efac", "#c4b5fd", "#fdba74", "#93c5fd", "#f0abfc"];
const ICON = {
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.8 14.1A4.6 4.6 0 0 1 20.5 18.5"/></svg>',
  leave: '<svg viewBox="0 0 24 24"><path d="M14.5 4.5h4v15h-4M10 8l-4 4 4 4M6 12h10.5"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M12 18.5v-13M6.5 11 12 5.5l5.5 5.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M5 5.5h14v10H10l-5 4z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  again: '<svg viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M5 19h3.5L18.5 9 15 5.5 5 15.5z"/></svg>',
  crown: '<svg viewBox="0 0 24 24"><path d="M4 8.5l4 3.5 4-6 4 6 4-3.5-1.8 10H5.8z"/></svg>',
};

const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const fmtExact = (ms) => `${fmt(ms)}.${Math.floor((ms % 1000) / 100)}`;
const spaced = (code) => code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function iconBtn(cls, icon, label, onClick) {
  const b = el("button", cls);
  b.type = "button";
  b.innerHTML = ICON[icon];
  b.title = label;
  b.setAttribute("aria-label", label);
  b.onclick = onClick;
  return b;
}
const store = (s, k, v) => { try { s.setItem(k, v); } catch {} };
const read = (s, k) => { try { return s.getItem(k) || ""; } catch { return ""; } };
// Names and chat are someone else's words: plain text, no control characters, kept short.
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const myPid = () => {
  let id = read(sessionStorage, PID_KEY);
  if (!/^[a-z0-9]{8,24}$/.test(id)) { id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store(sessionStorage, PID_KEY, id); }
  return id;
};
const defaultName = () => (globalThis.Beam?.deviceName?.() || "Player");
const savedName = () => clean(read(localStorage, NAME_KEY), NAME_MAX);
// Each player's color is their place in the room, so no two share one.
const colorOf = (pid) => {
  const i = view?.players?.findIndex((p) => p.pid === pid) ?? -1;
  if (i >= 0) return COLORS[i % COLORS.length];
  let h = 0; for (const ch of pid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
const initial = (name) => ([...(name || "?")][0] || "?").toLocaleUpperCase();

let api = null, page = null, levels = {};
// The room on this device: Beam's connection, and what this device last knew of the room.
let beam = null, beamRoot = null;
let hosting = false, connected = false, ever = false;
let view = null;                  // the room as the host last told it (the host's own, here)
let mine = { round: 0, playing: false, ms: null };
let lines = [], unread = 0, chatOpen = false;
let closed = "";                  // the room ended: why (the stage says so)
let countdown = null, editing = false, pendingStart = false, startNote = "";
// The host's own record of the room.
let H = null;
const me = { pid: "", name: "" };

// ---- the room's parts of the page -------------------------------------------------------
const nodes = {};
const ui = {};
function build() {
  // In the strip: the room's code (copies an invite link), and Leave.
  nodes.start = el("button", "ws-roomchip");
  nodes.start.type = "button";
  nodes.start.onclick = copyLink;
  nodes.end = iconBtn("ws-leave", "leave", "Leave room", leave);
  nodes.credit = el("span", "ws-credit-more");
  nodes.credit.innerHTML = ' · <a href="https://github.com/peers/peerjs" target="_blank" rel="noopener">PeerJS</a> · <a href="https://github.com/nwtgck/piping-server" target="_blank" rel="noopener">Piping Server</a>';
  // Over the puzzle card: the lobby, the countdown, the results.
  ui.stage = el("div", "ws-stage");
  // Narrow windows: the players as a strip above the puzzle, the chat behind a button.
  ui.chips = el("div", "ws-chips ws-extra");
  // Beside the puzzle: the players and the chat.
  ui.rail = el("aside", "ws-rail");
  ui.rail.setAttribute("aria-label", "Room");
  const players = el("section", "ws-panel-box ws-players");
  ui.playersHead = el("div", "ws-ph");
  ui.list = el("div", "ws-plist");
  players.append(ui.playersHead, ui.list);
  const chat = el("section", "ws-panel-box ws-chat");
  chat.setAttribute("aria-label", "Chat");
  const chatHead = el("div", "ws-ph");
  chatHead.append(el("span", null, "Chat"));
  ui.chatX = iconBtn("ws-chat-x", "close", "Close chat", () => setChat(false));
  chatHead.append(ui.chatX);
  ui.msgs = el("div", "ws-msgs");
  ui.msgs.setAttribute("aria-live", "polite");
  const form = el("form", "ws-compose");
  ui.input = el("input");
  Object.assign(ui.input, { type: "text", placeholder: "Message", maxLength: CHAT_MAX, autocomplete: "off", spellcheck: true });
  ui.input.setAttribute("aria-label", "Message");
  const send = iconBtn("ws-send", "send", "Send", null);
  send.type = "submit";
  form.append(ui.input, send);
  form.onsubmit = (e) => { e.preventDefault(); say(ui.input.value); ui.input.value = ""; };
  chat.append(chatHead, ui.msgs, form);
  ui.rail.append(players, chat);
  ui.fab = iconBtn("ws-fab", "chat", "Chat", () => setChat(!chatOpen));
  ui.badge = el("span", "ws-badge");
  ui.fab.append(ui.badge);
}
function setChat(on) {
  chatOpen = on;
  page.classList.toggle("ws-chat-open", on);
  ui.fab.innerHTML = ICON[on ? "close" : "chat"];
  ui.fab.title = on ? "Close chat" : "Chat";
  ui.fab.append(ui.badge);
  if (on) { unread = 0; ui.input.focus({ preventScroll: true }); }
  paintBadge();
}
function paintBadge() {
  ui.badge.textContent = unread > 9 ? "9+" : String(unread);
  ui.badge.hidden = !unread;
}
const narrow = matchMedia("(max-width: 879px)");

// ---- Play with others: make a room, or join one ------------------------------------------
let menuEl = null;
function menu(btn) {
  if (menuEl) return closeMenu();
  if (beam) return;
  menuEl = el("div", "ws-roommenu");
  menuEl.setAttribute("role", "dialog");
  menuEl.setAttribute("aria-label", "Play with others");
  menuEl.append(el("b", null, "Play with others"));
  menuEl.append(el("p", "ws-rm-hint", "Race on the same puzzle with up to 5 others, connected straight to each other and encrypted."));
  const nameRow = el("label", "ws-rm-name");
  nameRow.append(el("span", null, "Your name"));
  const name = el("input");
  Object.assign(name, { type: "text", maxLength: NAME_MAX, placeholder: defaultName(), value: savedName(), autocomplete: "off", spellcheck: false });
  nameRow.append(name);
  const create = el("button", "ws-btn ws-rm-create", "Create a room");
  create.type = "button";
  const or = el("div", "ws-rm-or");
  or.append(el("i"), el("span", null, "or join one"), el("i"));
  const form = el("form", "ws-rm-join");
  const code = el("input");
  Object.assign(code, { type: "text", inputMode: "numeric", placeholder: "6-digit code", maxLength: 7, autocomplete: "off" });
  code.setAttribute("aria-label", "Room code");
  const join = el("button", "ws-rm-go", "Join");
  join.type = "submit";
  form.append(code, join);
  const note = el("p", "ws-rm-note");
  note.setAttribute("aria-live", "polite");
  menuEl.append(nameRow, create, or, form, note);
  const keepName = () => setName(name.value, true);
  create.onclick = () => { keepName(); closeMenu(); open({}); };
  form.onsubmit = (e) => {
    e.preventDefault();
    const c = code.value.replace(/\D/g, "");
    if (!/^\d{6,10}$/.test(c)) { note.textContent = "Enter the 6-digit code shown on the host's screen."; return code.focus(); }
    keepName();
    closeMenu();
    open({ join: c });
  };
  menuEl.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); btn.focus(); } });
  btn.closest(".ws-bar").append(menuEl);
  btn.setAttribute("aria-expanded", "true");
  menuEl._btn = btn;
  create.focus({ preventScroll: true });
}
function closeMenu() {
  if (!menuEl) return;
  menuEl._btn.setAttribute("aria-expanded", "false");
  menuEl.remove();
  menuEl = null;
}
document.addEventListener("pointerdown", (e) => { if (menuEl && !menuEl.contains(e.target) && !menuEl._btn.contains(e.target)) closeMenu(); }, true);

// ---- the room's lifetime -----------------------------------------------------------------
// o.join: a code to join; o.server: the relay its QR code names; o.resume: this tab's room
// again (a reload).
function open(o) {
  if (beam || typeof Beam === "undefined" || !Beam.mount) return;
  me.pid = myPid();
  me.name = savedName() || defaultName();
  hosting = !o.join && !o.resume;
  connected = false; ever = false; closed = ""; view = null; lines = []; unread = 0;
  pendingStart = false; startNote = ""; editing = false;
  mine = { round: 0, playing: false, ms: null };
  H = null;
  page.classList.add("ws-room-on");
  api.room.enter(hooks, nodes);
  root().classList.add("ws-lobby");
  api.stage.append(ui.stage);
  root().insertBefore(ui.chips, api.stage);
  page.append(ui.rail, ui.fab);
  setChat(false);
  beamRoot = el("div");
  document.body.append(beamRoot);
  beam = Beam.mount(beamRoot, { game: { app: APP, join: o.join, server: o.server, resume: o.resume, onChange, onData, onEnd } });
  hosting = beam.info().host;
  if (hosting) {
    const p = api.room.prefs();
    H = { players: new Map(), byLink: new Map(), phase: "lobby", round: 0, total: 0, lang: p.lang, level: levels[p.level] ? p.level : "easy", timer: 0 };
    H.players.set(me.pid, { pid: me.pid, name: me.name, link: null, st: "host", n: 0, ms: null, spect: false, left: false });
    view = snapshot();
    sys("You made the room. Share its code to let others in.", true);
    api.room.refresh();
  }
  onChange();
}
// Leave: the others are told, this device goes back to playing alone.
function leave() {
  if (!beam && !closed) return;
  stopCountdown();
  clearTimeout(H?.timer);
  clearTimeout(syncTimer);
  try { beam?.dispose(); } catch {}
  beam = null;
  beamRoot?.remove();
  beamRoot = null;
  H = null; view = null; closed = ""; connected = false;
  pendingStart = false; startNote = ""; editing = false;
  page.classList.remove("ws-room-on", "ws-chat-open");
  ui.rail.remove(); ui.fab.remove(); ui.chips.remove(); ui.stage.remove();
  api.room.exit(nodes);
  api.room.relayout();
}
// Beam ended the room: nobody answered, it was full, the host left, or it sat idle. A race
// already on goes on here; its time counts on this screen.
function onEnd(why) {
  const host = hostName();
  const text = {
    gone: "Nobody answered on that code. Check it on the host's screen and try again.",
    full: `That room already has ${Beam.maxDevices + 1} players.`,
    declined: "That room didn't let this device in.",
    bye: `${host} closed the room.`,
    idle: "The room closed after 30 minutes without anything happening.",
  }[why] || "The room closed.";
  try { beam?.dispose(); } catch {}
  beam = null;
  beamRoot?.remove();
  beamRoot = null;
  connected = false;
  closed = text;
  sys(text, true);
  paint();
}
const root = () => api.stage.parentElement;
const hostName = () => view?.players?.find((p) => p.host)?.name || "The host";

// ---- the hooks the game calls --------------------------------------------------------------
const hooks = {
  lang: () => (hosting ? H?.lang : view?.lang) || null,
  level: () => (hosting ? H?.level : view?.level) || "easy",
  canPick: () => hosting && !!H && (H.phase === "lobby" || H.phase === "done") && !closed && !pendingStart,
  onLang(code) {
    if (!hooks.canPick()) return;
    H.lang = code;
    api.room.savePrefs({ lang: code });
    api.room.refresh();
    sync();
  },
  onFound(n) {
    if (!mine.playing) return;
    if (hosting) hostFound(me.pid, mine.round, n);
    else if (!closed) beam?.send("hub", { t: "found", round: mine.round, n });
  },
  onSolved(ms) {
    if (!mine.playing) return;
    mine.playing = false;
    mine.ms = ms;
    if (hosting) hostDone(me.pid, mine.round, ms);
    else if (!closed) beam?.send("hub", { t: "done", round: mine.round, ms });
    paint();
  },
};

// ---- Beam: who's connected, and messages ---------------------------------------------------
function onChange() {
  if (!beam) return;
  const info = beam.info();
  if (hosting) return hostPeers(info);
  const hub = info.peers[0];
  const now = !!(info.connected && hub && hub.state !== "away");
  // Each time the link to the host (re)opens: who this is. A host that reloaded starts over and
  // needs to hear it again.
  if (now && !connected) beam.send("hub", { t: "hi", pid: me.pid, name: me.name });
  connected = now;
  if (now) ever = true;
  paint();
}
function onData(from, d) {
  if (!d || typeof d !== "object" || typeof d.t !== "string") return;
  if (hosting) return hostData(from, d);
  if (from !== "hub") return;
  switch (d.t) {
    case "state": if (validState(d.s)) { view = tidy(d.s); onState(); } break;
    case "start": if (validPuzzle(d.puzzle) && Number.isInteger(d.round)) begin(d.round, d.puzzle); break;
    case "chat": if (d.line) addLine(d.line); break;
    case "hist": if (Array.isArray(d.lines)) { lines = lines.filter((l) => l.local); for (const l of d.lines.slice(-CHAT_KEEP)) addLine({ ...l, local: false }, true); paintChat(); } break;
  }
}
function validState(s) {
  return s && typeof s === "object" && ["lobby", "count", "play", "done"].includes(s.phase) && Array.isArray(s.players) && s.players.length <= 8 &&
    Number.isInteger(s.round) && levels[s.level];
}
// The host's room, as plain values: names cleaned, numbers whole, states known ones.
function tidy(s) {
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    phase: s.phase, round: s.round, level: s.level, total: int(s.total),
    lang: api.room.hasLang(s.lang) ? s.lang : null,
    players: s.players.filter((p) => p && typeof p.pid === "string").map((p) => ({
      pid: p.pid.slice(0, 24), name: clean(p.name, NAME_MAX) || "Player", host: !!p.host, st: STATES[p.st] ? p.st : "direct",
      n: int(p.n), ms: Number.isFinite(p.ms) && p.ms >= 0 ? p.ms : null, spect: !!p.spect,
    })),
  };
}
function validPuzzle(p) {
  if (!p || !levels[p.level] || !Number.isInteger(p.n) || p.n !== levels[p.level].size || !api.room.hasLang(p.lang)) return false;
  if (!Array.isArray(p.grid) || p.grid.length !== p.n || !p.grid.every((r) => Array.isArray(r) && r.length === p.n && r.every((c) => typeof c === "string" && c.length <= 8))) return false;
  return Array.isArray(p.words) && p.words.length > 0 && p.words.length <= 20 &&
    p.words.every((w) => w && typeof w.text === "string" && w.text.length <= 60 && [w.r, w.c, w.dr, w.dc, w.len].every(Number.isInteger) &&
      Math.abs(w.dr) <= 1 && Math.abs(w.dc) <= 1 && (w.dr || w.dc) && w.len > 0 &&
      [w.r, w.r + w.dr * (w.len - 1)].every((r) => r >= 0 && r < p.n) && [w.c, w.c + w.dc * (w.len - 1)].every((c) => c >= 0 && c < p.n));
}
// The host's word: a state where this device's round ended, or a new lobby.
function onState() {
  const p = view.players.find((x) => x.pid === me.pid);
  if (mine.playing && (view.phase === "done" || view.round !== mine.round)) {
    mine.playing = false;
    stopCountdown();
    api.room.freeze();
  }
  if (view.phase === "lobby" && mine.round && !mine.playing) backToLobby();
  if (p && p.name !== me.name && !editing) me.name = p.name;
  api.room.refresh();
  paint();
}

// ---- the host ------------------------------------------------------------------------------
function snapshot() {
  return {
    phase: H.phase, round: H.round, level: H.level, lang: H.lang, total: H.total,
    players: [...H.players.values()].map((p) => ({ pid: p.pid, name: p.name, host: !p.link, st: p.left ? "left" : p.st, n: p.n, ms: p.ms, spect: p.spect })),
  };
}
// Everyone gets the room as it is now, a moment after it changes (a burst of changes goes as one).
let syncTimer = 0;
function sync() {
  if (!H) return;
  view = snapshot();
  paint();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (!H || !beam) return;
    const s = snapshot();
    for (const p of H.players.values()) if (p.link && !p.left) beam.send(p.link, { t: "state", s });
  }, 120);
}
function toAll(d) { for (const p of H.players.values()) if (p.link && !p.left) beam.send(p.link, d); }
function hostPeers(info) {
  if (!H) return;
  const live = new Map(info.peers.map((p) => [p.id, p]));
  for (const p of [...H.players.values()]) {
    if (!p.link) continue;
    const peer = live.get(p.link);
    if (peer) { p.st = peer.state; continue; }
    if (p.left) continue;
    // Gone from the room (left, or didn't come back within 2 minutes).
    H.byLink.delete(p.link);
    if (H.phase === "lobby" || p.spect) H.players.delete(p.pid);
    else p.left = true;
    sys(`${p.name} left`);
    checkEnd();
  }
  sync();
}
function hostData(from, d) {
  if (d.t === "hi") {
    if (typeof d.pid !== "string" || !/^[a-z0-9]{8,24}$/.test(d.pid) || d.pid === me.pid) return;
    const name = clean(d.name, NAME_MAX) || "Player";
    let p = H.players.get(d.pid);
    const racing = H.phase === "count" || H.phase === "play";
    if (p) {
      // The same player on a new connection (it reloaded): back in, but a race it was in is lost.
      if (p.link !== from) {
        if (p.link) H.byLink.delete(p.link);
        p.link = from;
        if (racing && p.ms == null) p.spect = true;
      }
      p.left = false;
      p.name = name;
    } else {
      if (H.players.size >= Beam.maxDevices + 1) return;
      p = { pid: d.pid, name, link: from, st: "direct", n: 0, ms: null, spect: racing, left: false };
      H.players.set(d.pid, p);
      sys(`${name} joined`);
    }
    H.byLink.set(from, d.pid);
    beam.send(from, { t: "hist", lines: lines.filter((l) => !l.local).slice(-CHAT_KEEP) });
    onChange();
    return;
  }
  const p = H.players.get(H.byLink.get(from));
  if (!p) return;
  switch (d.t) {
    case "name": { const n = clean(d.name, NAME_MAX); if (n) { p.name = n; sync(); } break; }
    case "chat": { const text = clean(d.text, CHAT_MAX); if (text) post({ pid: p.pid, name: p.name, text }); break; }
    case "found": hostFound(p.pid, d.round, d.n); break;
    case "done": hostDone(p.pid, d.round, d.ms); break;
  }
}
function hostFound(pid, round, n) {
  const p = H?.players.get(pid);
  if (!p || round !== H.round || p.spect || p.ms != null || !Number.isInteger(n)) return;
  p.n = Math.max(0, Math.min(H.total, n));
  sync();
}
function hostDone(pid, round, ms) {
  const p = H?.players.get(pid);
  if (!p || round !== H.round || p.spect || p.ms != null || !Number.isFinite(ms) || ms < 0) return;
  if (H.phase !== "count" && H.phase !== "play") return;
  p.ms = Math.round(ms);
  p.n = H.total;
  sync();
  checkEnd();
}
// The round ends when everyone in it has finished (or left), or when the host ends it.
function checkEnd() {
  if (!H || (H.phase !== "play" && H.phase !== "count")) return;
  const racing = [...H.players.values()].filter((p) => !p.spect && !p.left);
  if (racing.length && racing.every((p) => p.ms != null)) endRound();
}
function endRound() {
  if (!H) return;
  clearTimeout(H.timer);
  H.phase = "done";
  if (mine.playing) { mine.playing = false; api.room.freeze(); }
  stopCountdown();
  const best = [...H.players.values()].filter((p) => p.ms != null).sort((a, b) => a.ms - b.ms)[0];
  sys(best ? `${best.name} won in ${fmtExact(best.ms)}` : "The round ended");
  sync();
}
async function startRound() {
  if (!H || pendingStart || (H.phase !== "lobby" && H.phase !== "done")) return;
  const others = [...H.players.values()].filter((p) => p.link && !p.left);
  if (!others.length) return;
  if (!H.lang) { startNote = "Pick a language first (the button at the top left)."; return paint(); }
  pendingStart = true;
  startNote = "Getting the words…";
  paint();
  const room = H;
  let puzzle;
  try { puzzle = await api.room.make(H.lang, H.level); }
  catch { if (H !== room) return; pendingStart = false; startNote = "Couldn't get the words. Check the connection and try again."; return paint(); }
  if (H !== room) return; // left (or a new room) while the words came
  pendingStart = false;
  startNote = "";
  // Who's here now is in this round; whoever left is let go.
  for (const p of [...H.players.values()]) {
    if (p.left) { H.players.delete(p.pid); continue; }
    Object.assign(p, { n: 0, ms: null, spect: false });
  }
  H.round++;
  H.total = puzzle.words.length;
  H.phase = "count";
  sys(`Round ${H.round} · ${levels[H.level].name} · ${api.room.langName(H.lang)}`);
  sync();
  clearTimeout(syncTimer);
  // The puzzle first (its countdown starts as it arrives), then the room in its new round.
  const s = snapshot();
  for (const p of H.players.values()) if (p.link) { beam.send(p.link, { t: "start", round: H.round, puzzle }); beam.send(p.link, { t: "state", s }); }
  begin(H.round, puzzle);
  H.timer = setTimeout(() => { if (H && H.phase === "count") { H.phase = "play"; sync(); } }, COUNTDOWN * 1000);
}
function toLobby() {
  if (!H || H.phase !== "done") return;
  H.phase = "lobby";
  for (const p of [...H.players.values()]) { if (p.left) H.players.delete(p.pid); else Object.assign(p, { n: 0, ms: null, spect: false }); }
  backToLobby();
  sync();
}
function backToLobby() {
  mine = { round: 0, playing: false, ms: null };
  root().classList.add("ws-lobby");
  api.room.sample();
}

// ---- a round on this device: the countdown, then the race ----------------------------------
function begin(round, puzzle) {
  stopCountdown();
  mine = { round, playing: true, ms: null };
  root().classList.remove("ws-lobby");
  api.room.load(puzzle);
  let left = COUNTDOWN;
  countdown = { left, timer: setInterval(() => {
    countdown.left = --left;
    if (left <= 0) { stopCountdown(); if (mine.playing && mine.round === round) api.room.go(); }
    paint();
  }, 1000) };
  paint();
}
function stopCountdown() {
  if (!countdown) return;
  clearInterval(countdown.timer);
  countdown = null;
}

// ---- chat ----------------------------------------------------------------------------------
function say(text) {
  text = clean(text, CHAT_MAX);
  if (!text || closed || !beam) return;
  if (hosting) post({ pid: me.pid, name: me.name, text });
  else beam.send("hub", { t: "chat", text });
}
// The host gives every line its place and passes it on.
function post(line) {
  line = { ...line, at: Date.now() };
  addLine(line);
  toAll({ t: "chat", line });
}
// A line about the room (the host's go to everyone; a local one only here).
function sys(text, local) {
  const line = { sys: true, text, at: Date.now(), local: !!local };
  addLine(line);
  if (!local && H && beam) toAll({ t: "chat", line });
}
function addLine(l, quiet) {
  const line = { sys: !!l.sys, pid: typeof l.pid === "string" ? l.pid : "", name: clean(l.name, NAME_MAX), text: clean(l.text, CHAT_MAX), local: !!l.local };
  if (!line.text) return;
  lines.push(line);
  if (lines.length > CHAT_KEEP) lines.splice(0, lines.length - CHAT_KEEP);
  if (quiet) return;
  if (!line.sys && line.pid !== me.pid && (narrow.matches && !chatOpen)) unread++;
  paintChat();
  paintBadge();
}
function paintChat() {
  if (!ui.msgs) return;
  const atEnd = ui.msgs.scrollHeight - ui.msgs.scrollTop - ui.msgs.clientHeight < 40;
  ui.msgs.replaceChildren(...lines.map((l) => {
    if (l.sys) return el("div", "ws-sys", l.text);
    const own = l.pid === me.pid;
    const m = el("div", "ws-m" + (own ? " ws-mine" : ""));
    if (!own) m.append(avatar(l.pid, l.name));
    const b = el("div", "ws-bub");
    if (!own) b.append(el("small", null, l.name));
    b.append(document.createTextNode(l.text));
    m.append(b);
    return m;
  }));
  if (atEnd) ui.msgs.scrollTop = ui.msgs.scrollHeight;
}

// ---- names ---------------------------------------------------------------------------------
function setName(v, quiet) {
  const name = clean(v, NAME_MAX);
  store(localStorage, NAME_KEY, name);
  me.name = name || defaultName();
  if (quiet || !beam) return;
  if (hosting) { const p = H?.players.get(me.pid); if (p) { p.name = me.name; sync(); } }
  else beam.send("hub", { t: "name", name: me.name });
  paint();
}
function editName(row, nameEl) {
  if (editing) return;
  editing = true;
  const input = el("input", "ws-name-edit");
  Object.assign(input, { type: "text", value: me.name, maxLength: NAME_MAX, spellcheck: false, autocomplete: "off" });
  input.setAttribute("aria-label", "Your name");
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    editing = false;
    if (save && clean(input.value, NAME_MAX) !== me.name) setName(input.value);
    else paint();
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") { e.stopPropagation(); finish(false); } };
  input.onblur = () => finish(true);
}

// ---- painting ------------------------------------------------------------------------------
function avatar(pid, name) {
  const a = el("span", "ws-av", initial(name));
  a.style.background = colorOf(pid || name);
  a.setAttribute("aria-hidden", "true");
  return a;
}
const STATES = { direct: ["Direct", ""], relay: ["Relay", "ws-relay"], away: ["Reconnecting", "ws-away"], left: ["Left", "ws-gone"] };
function status(st) {
  const [text, cls] = STATES[st] || STATES.direct;
  const s = el("span", "ws-st");
  s.append(el("i", "ws-dot " + cls), document.createTextNode(text));
  return s;
}
function progress(p, total) {
  const w = el("span", "ws-prog");
  const bar = el("span", "ws-bar-p");
  const fill = el("i");
  fill.style.width = `${total ? (p.n / total) * 100 : 0}%`;
  bar.append(fill);
  w.append(bar, el("span", "ws-count", `${p.n}/${total}`));
  return w;
}
// What a player's row says on the right: their connection in the lobby, then their race.
function standing(p, short) {
  const racing = view.phase !== "lobby" && view.round > 0;
  if (p.st === "left") return status("left");
  if (!racing) return p.host ? null : status(p.st);
  if (p.spect) return el("span", "ws-st", short ? "next" : "Next round");
  if (p.ms != null) return el("span", "ws-time", fmt(p.ms));
  return short ? el("span", "ws-count", `${p.n}/${view.total}`) : progress(p, view.total);
}
function paint() {
  if (!api || (!beam && !closed)) return;
  const code = beam?.info().code || "";
  if (!nodes.start.classList.contains("ws-copied")) {
    nodes.start.innerHTML = `${ICON.people}<b></b>`;
    nodes.start.querySelector("b").textContent = spaced(code);
  }
  nodes.start.title = code ? "Copy the invite link" : "";
  nodes.start.hidden = !code || (!hosting && !connected);
  paintPlayers();
  paintStage();
  api.room.relayout();
}
function players() { return view?.players || []; }
function paintPlayers() {
  if (editing) return; // the name being typed stays; the list catches up after
  const list = players();
  const here = list.filter((p) => p.st !== "left").length;
  ui.playersHead.replaceChildren(el("span", null, `Players · ${here}/${Beam.maxDevices + 1}`));
  if (hosting && H && (H.phase === "play" || H.phase === "count") && !closed) {
    const end = el("button", "ws-endround", "End round");
    end.type = "button";
    end.onclick = endRound;
    ui.playersHead.append(end);
  }
  ui.list.replaceChildren(...list.map((p) => {
    const own = p.pid === me.pid;
    const row = el("div", "ws-p" + (own ? " ws-me" : ""));
    const nm = el("span", "ws-pn");
    const b = el("b", null, p.name);
    if (own && !closed) {
      const pen = iconBtn("ws-pen", "pencil", "Change your name", () => editName(row, b));
      b.append(pen);
      b.ondblclick = () => editName(row, b);
    }
    nm.append(b);
    const sub = [own && "You", p.host && "Host"].filter(Boolean).join(" · ");
    if (sub) nm.append(el("small", null, sub));
    row.append(avatar(p.pid, p.name), nm);
    // A player who joined sees its own link to the host.
    const right = own && !hosting && view.phase === "lobby" ? status(connected ? beamState() : "away") : standing(p);
    if (right) row.append(right);
    return row;
  }));
  if (!list.length) ui.list.append(el("p", "ws-empty", closed ? "" : "Connecting…"));
  ui.chips.replaceChildren(...list.map((p) => {
    const c = el("span", "ws-chip" + (p.ms != null ? " ws-fin" : "") + (p.st === "left" ? " ws-chip-left" : ""));
    c.append(avatar(p.pid, p.name), el("span", "ws-chip-n", p.pid === me.pid ? "You" : p.name.split(" ")[0]));
    const s = standing(p, true);
    if (s && view.phase !== "lobby") c.append(s);
    else if (p.st !== "direct" && p.st !== "host") c.append(el("i", "ws-dot " + (STATES[p.st]?.[1] || "")));
    return c;
  }));
}
const beamState = () => beam?.info().peers[0]?.state || "away";

function paintStage() {
  const box = el("div", "ws-sbox");
  let kind = "card";
  if (closed && !mine.playing && !(view && view.round && mine.ms != null)) {
    box.append(el("span", "ws-eyebrow", "Room closed"), el("p", "ws-shint", closed));
    box.append(btn("ws-btn", null, "Play alone", leave));
  } else if (!hosting && !connected && !ever) {
    const code = beam?.info().code || "";
    box.append(el("span", "ws-eyebrow", `Room ${spaced(code)}`), el("div", "ws-stitle", "Joining…"), el("p", "ws-shint", "Waiting for the host's device to answer."));
    box.append(btn("ws-btn ws-ghost", "leave", "Cancel", leave));
  } else if (countdown) {
    kind = "count";
    const ring = el("div", "ws-ring");
    ring.innerHTML = `<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${100 - (countdown.left / COUNTDOWN) * 100}"/></svg>`;
    ring.append(el("b", null, String(countdown.left)));
    box.append(ring, el("p", "ws-cap", "Get ready"));
  } else if (mine.playing) {
    kind = "none";
  } else if (view && view.round && (mine.ms != null || view.phase === "done") && (mine.round === view.round || view.phase === "done")) {
    kind = "board";
    results(box);
  } else if (view && (view.phase === "count" || view.phase === "play")) {
    box.append(el("span", "ws-eyebrow", `Round ${view.round}`), el("div", "ws-stitle", "A round is on"), el("p", "ws-shint", "You'll play the next one. The players' progress is beside the puzzle."));
  } else lobby(box);
  ui.stage.className = `ws-stage ws-s-${kind}`;
  ui.stage.hidden = kind === "none";
  ui.stage.replaceChildren(box);
}
function btn(cls, icon, text, onClick) {
  const b = el("button", cls);
  b.type = "button";
  if (icon) b.innerHTML = ICON[icon];
  b.append(document.createTextNode(text));
  b.onclick = onClick;
  return b;
}
function lobby(box) {
  const lv = levels[hooks.level()];
  const langName = hooks.lang() ? api.room.langName(hooks.lang()) : "";
  if (hosting) {
    const code = beam?.info().code || "";
    box.append(el("span", "ws-eyebrow", "Room code"), el("div", "ws-roomcode", spaced(code)));
    const qr = el("div", "ws-qr");
    qr.setAttribute("aria-label", "QR code that opens the word search in this room");
    drawQR(qr);
    box.append(qr, el("p", "ws-shint", "Others open Word search in Extra Guac and enter this code, or scan it with a phone. Up to 5 can join."));
    const seg = el("div", "ws-seg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Level");
    for (const [id, l] of Object.entries(levels)) {
      const b = el("button", id === H.level ? "ws-on" : null, l.name);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(id === H.level));
      b.title = `${l.size}×${l.size} · ${l.count} words`;
      b.onclick = () => { if (!hooks.canPick()) return; H.level = id; api.room.savePrefs({ level: id }); api.room.refresh(); sync(); };
      seg.append(b);
    }
    box.append(seg);
    const others = players().filter((p) => !p.host && p.st !== "left").length;
    const go = btn("ws-btn ws-go", "play", others ? "Start game" : "Waiting for players", startRound);
    go.disabled = !others || pendingStart;
    box.append(go);
    if (startNote) box.append(el("p", "ws-snote", startNote));
  } else {
    box.append(el("span", "ws-eyebrow", `Room ${spaced(beam?.info().code || "")}`), el("div", "ws-stitle", connected ? `Waiting for ${hostName()} to start` : "Reconnecting…"));
    const n = players().filter((p) => p.st !== "left").length;
    box.append(el("p", "ws-shint", [lv.name, langName, n ? `${n} players` : ""].filter(Boolean).join(" · ")));
    box.append(btn("ws-btn ws-ghost", "leave", "Leave room", leave));
  }
}
// Finished first, fastest first; then the ones still going, most words first; then who left.
function results(box) {
  const list = players().filter((p) => !p.spect);
  const done = view.phase === "done";
  const fin = list.filter((p) => p.ms != null).sort((a, b) => a.ms - b.ms);
  const rest = list.filter((p) => p.ms == null && p.st !== "left").sort((a, b) => b.n - a.n);
  const gone = list.filter((p) => p.ms == null && p.st === "left");
  const winner = fin[0];
  const lv = levels[view.level];
  box.append(el("span", "ws-eyebrow", [lv.name, view.lang ? api.room.langName(view.lang) : ""].filter(Boolean).join(" · ")));
  box.append(el("h2", "ws-stitle", done ? (winner ? (winner.pid === me.pid ? "You win" : `${winner.name} wins`) : "Round over") : `You finished in ${fmt(mine.ms ?? 0)}`));
  if (!done) box.append(el("p", "ws-shint", "Waiting for the others to finish…"));
  if (closed) box.append(el("p", "ws-shint", closed));
  const rows = el("div", "ws-rows");
  const row = (p, rank, right) => {
    const r = el("div", "ws-r" + (rank === 1 && done ? " ws-win" : ""));
    r.append(el("span", "ws-rank", rank ? String(rank) : ""), avatar(p.pid, p.name));
    const nm = el("span", "ws-pn");
    const b = el("b", null, p.name);
    if (rank === 1 && done) { const c = el("span", "ws-crown"); c.innerHTML = ICON.crown; b.append(c); }
    nm.append(b);
    if (p.pid === me.pid) nm.append(el("small", null, "You"));
    r.append(nm, right);
    rows.append(r);
  };
  fin.forEach((p, i) => row(p, i + 1, el("span", "ws-time", fmtExact(p.ms))));
  rest.forEach((p) => row(p, 0, el("span", "ws-st", `${p.n}/${view.total}${done ? "" : " · playing"}`)));
  gone.forEach((p) => row(p, 0, el("span", "ws-st", "Left")));
  box.append(rows);
  const acts = el("div", "ws-acts");
  if (closed) acts.append(btn("ws-btn", null, "Play alone", leave));
  else if (hosting && done) {
    const others = players().filter((p) => !p.host && p.st !== "left").length;
    const again = btn("ws-btn ws-go", "again", "Rematch", startRound);
    again.disabled = !others || pendingStart;
    acts.append(again, btn("ws-btn ws-ghost", null, "Back to room", toLobby));
  } else if (done) acts.append(el("p", "ws-shint", `Waiting for ${hostName()} to start the next round`));
  if (acts.childNodes.length) box.append(acts);
  if (startNote && hosting) box.append(el("p", "ws-snote", startNote));
}

// ---- inviting ------------------------------------------------------------------------------
function inviteLink() {
  const info = beam?.info();
  if (!info) return "";
  const base = IS_EXTENSION ? WEB_URL : location.href.split("#")[0].split("?")[0];
  return `${base}#join-${info.code}.${info.server}`;
}
// One drawing per link: a box that asks while it's being made waits for the same one.
let qrFor = "", qrMade = null;
async function drawQR(box) {
  const text = inviteLink();
  if (text !== qrFor) {
    qrFor = text;
    qrMade = (async () => {
      try {
        if (globalThis.EGQR && globalThis.jsQR) {
          const made = await EGQR.make(text, { icon: await EGQR.dataUrlOf(new URL("../icons/icon128.png", location.href).href) });
          if (made.ok) return made.svg;
        }
      } catch {}
      return null;
    })();
  }
  const svg = await qrMade;
  if (text !== qrFor || !box.isConnected) return;
  if (svg) { box.innerHTML = svg; return; }
  try { box.textContent = ""; box.classList.add("ws-plain"); new QRCode(box, { text, width: 236, height: 236, correctLevel: QRCode.CorrectLevel.M }); }
  catch { box.textContent = ""; }
}
async function copyLink() {
  const link = inviteLink();
  if (!link) return;
  try { await navigator.clipboard.writeText(link); } catch { return; }
  nodes.start.classList.add("ws-copied");
  nodes.start.querySelector("b").textContent = "Copied";
  setTimeout(() => { nodes.start.classList.remove("ws-copied"); paint(); }, 1400);
}

// ---- start ---------------------------------------------------------------------------------
function init(a, pageEl) {
  api = a.room ? a : null;
  if (!api || typeof Beam === "undefined") return;
  api.stage = api.room.stage;
  levels = api.room.levels;
  page = pageEl;
  build();
  narrow.addEventListener("change", () => { if (!narrow.matches) setChat(false); api.room.relayout(); });
  // Opened from a room's link (the web page), or this tab was in a room before a reload.
  if (linkJoin) {
    history.replaceState(null, "", location.href.split("#")[0]);
    open({ join: linkJoin[1], server: linkJoin[2] != null ? Number(linkJoin[2]) : undefined });
  } else if (/^\d{6,10}$/.test(read(sessionStorage, APP + "-room"))) open({ resume: true });
}

globalThis.WordSearchRoom = { init, menu };
})();
