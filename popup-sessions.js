// Session Switch in the popup (the "session switch" section, tab 3 unless moved): the current
// site's profiles, and switching between them. The background side is bg-sessions.js; popup.js
// calls initSessions for each tab the popup shows.
(() => {
const $ = (id) => document.getElementById(id);
const content = $("ssContent");
const sheet = $("ssSheet");
const toastBox = $("ssToast");
const countryName = (code) => TT.countryName(code);

let tabId = null;
let state = null;
let busy = false;
let renaming = null;
let sheetView = null;
let stale = false; // a change came in while busy or renaming; load once that's over
let armed = null; // { id, at }: a delete waiting for its second click

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

async function call(type, data = {}) {
  const reply = await chrome.runtime.sendMessage({ type: `ss:${type}`, ...data });
  if (reply?.error) throw new Error(reply.error);
  return reply;
}

const site = () => state.domains[0];

// ---- Messages at the bottom ----

let toastTimer;
function toast(text, kind = "", items = []) {
  clearTimeout(toastTimer);
  if (!text) {
    toastBox.hidden = true;
    return;
  }
  toastBox.className = `toast ss-toast ${kind}`;
  toastBox.replaceChildren(h("div", {}, text), ...(items.length ? [h("ul", {}, items.map((item) => h("li", {}, item)))] : []));
  toastBox.hidden = false;
  if (kind !== "busy") toastTimer = setTimeout(() => (toastBox.hidden = true), kind ? 9000 : 4500);
}
toastBox.addEventListener("click", () => toast(""));

// ---- Time ----

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relative(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units = [["year", 365 * 864e5], ["month", 30 * 864e5, 60 * 864e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
  for (const [unit, size, from = size] of units) if (abs >= from) return rtf.format(Math.round(diff / size), unit);
  return diff >= 0 ? "in under a minute" : "just now";
}

const absolute = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// What a profile's login state says, short and long.
function loginLine(login) {
  const from = login.name ? ` (${login.name}${login.how === "guess" ? ", best guess" : ""})` : "";
  switch (login.state) {
    case "in":
      return {
        text: `login expires ${relative(login.expires)}`,
        long: `The login cookie${from} expires ${relative(login.expires)}, on ${absolute(login.expires)}.`,
        title: `${absolute(login.expires)}${from}`,
        kind: login.expires - Date.now() < 2 * 864e5 ? "warn" : "",
      };
    case "expired":
      return {
        text: `login expired ${relative(login.expires)}`,
        long: `The login cookie${from} expired on ${absolute(login.expires)}. Switch to this profile and log in again: the new login is saved to it automatically.`,
        title: `${absolute(login.expires)}${from}`,
        kind: "bad",
      };
    case "session":
      return {
        text: "login has no expiry date",
        long: `The login cookie${from} has no expiry date: it lasts until the site ends the session.`,
        title: login.name,
        kind: "",
      };
    case "gone":
      return {
        text: "logged out",
        long: `Logged out: the login cookie ${login.name} is gone. Log in again while this profile is active and the login is saved to it.`,
        title: `${login.name} is gone`,
        kind: "bad",
      };
    default:
      return {
        text: "no login yet",
        long: "No cookie here looks like a login. If this profile is logged in, pick its login cookie below to see when it expires.",
        title: "",
        kind: "",
      };
  }
}

// ---- Profiles' look ----

function initials(name) {
  const words = name.split(/\s+/).filter(Boolean);
  const text = words.length > 1 ? Array.from(words[0])[0] + Array.from(words[1])[0] : Array.from(name).slice(0, 2).join("");
  return text.toUpperCase();
}

const swatch = (hue) => `hsl(${hue} 55% 42%)`;
const proxyLabel = (proxy) => (proxy.country ? `${countryName(proxy.country)} proxy` : "proxy, any country");

// ---- Drawing ----

async function load() {
  try {
    state = await call("state", { tabId });
  } catch (e) {
    state = { supported: false, reason: e.message };
  }
  render();
}

function render() {
  const ok = state?.supported;
  $("ssSite").textContent = ok ? state.domains.join(" + ") : "";
  $("ssNewBtn").hidden = !ok;
  $("ssNewBtn").disabled = busy;
  $("ssNewBtn").title = ok ? `Log ${site()} out here and start a new profile; the next login you make is saved to it` : "";
  content.replaceChildren(...[].concat(drawList()).filter(Boolean));
  // A sheet that shows the list's state follows it, unless the user is typing in it.
  const typing = sheet.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
  if (sheetView?.kind === "proxy" && !typing) drawSheet();
}

function drawList() {
  if (!state) return null;
  if (!state.supported) return h("p", { class: "hint" }, state.reason || "Profiles work on http and https pages only.");
  const out = [];
  if (state.paused) {
    // The login was swapped or cleared from outside; the profile that was active kept its login.
    const paused = state.profiles.find((p) => p.id === state.paused.id);
    out.push(h("div", { class: "notice stack" },
      h("p", {}, `The login on ${site()} was changed outside Session Switch, so ${state.paused.name} kept its own login. What should happen to the login now in the browser?`),
      h("div", { class: "notice-actions" },
        h("button", { class: "text-btn primary", type: "button", disabled: busy, id: "ssSaveNewBtn", onclick: () => run(() => saveCurrent()) }, icon("save"), "save as new profile"),
        h("button", {
          class: "text-btn", type: "button", disabled: busy, id: "ssAdoptBtn", title: `Replace ${state.paused.name}'s saved login with this one`,
          onclick: () => run(async () => toast(`${(await call("adopt", { tabId })).name} now has this login.`)),
        }, `update ${state.paused.name}`),
        paused && h("button", {
          class: "text-btn", type: "button", disabled: busy, id: "ssPutBackBtn", title: `Discard this login and put ${state.paused.name}'s back`,
          onclick: () => run(() => switchTo(paused, true)),
        }, `put ${state.paused.name} back`))));
  } else if (state.unsaved) {
    out.push(h("div", { class: "notice" },
      h("p", {}, state.profiles.length ? `The login now on ${site()} isn't in a profile.` : `Save the login now on ${site()} as your first profile.`),
      h("button", { class: "text-btn primary", type: "button", disabled: busy, onclick: () => run(() => saveCurrent()) }, icon("save"), "save")));
  }
  const list = h("ul", { class: "profiles", id: "ssProfiles" }, state.profiles.map(row));
  if (state.profiles.length > 1) wireDrag(list);
  out.push(state.profiles.length > 0 && list,
    !state.profiles.length && !state.unsaved && h("p", { class: "hint" },
      `Several logins for ${site()}: new profile logs the site out on this page and starts a profile, and the login you make next is saved to it. Each profile stays up to date as you use the site.`));
  return out;
}

function row(p) {
  const login = loginLine(p.login);
  const draggable = state.profiles.length > 1;
  const sub = p.active ? login.text : `${login.text} · used ${relative(p.lastUsed)}`;
  const meta = renaming === p.id ? renameField(p) : [
    h("span", { class: "name" },
      h("span", {}, p.name),
      p.active && h("span", { class: "pill" }, "active"),
      p.proxy && h("span", { class: `pill proxy${p.proxy.ok ? "" : " bad"}`, title: p.proxy.ok ? proxyLabel(p.proxy) : p.proxy.reason }, p.proxy.country || "proxy")),
    h("span", { class: `sub ${login.kind}`, title: login.title }, sub),
  ];
  return h("li", {
    class: `profile${p.active ? " active" : ""}`, "data-id": p.id, draggable: draggable && renaming !== p.id ? "true" : null,
    title: p.active ? null : `Switch to ${p.name}`,
    onclick: (e) => {
      if (e.target.closest("button, input") || p.active || busy || renaming) return;
      run(() => switchTo(p, false));
    },
  },
    draggable && h("button", {
      class: "grip", type: "button", title: "Drag to change the order (or use the arrow keys)", "aria-label": `Move ${p.name}`,
      onkeydown: (e) => keyMove(e, p),
    }, icon("grip")),
    h("button", {
      class: "avatar", type: "button", style: `background:${swatch(p.hue)}`, title: "Change color", "aria-label": `Change the color of ${p.name}`,
      onclick: () => run(() => call("hue", { profileId: p.id, hue: (p.hue + 47) % 360 })),
    }, initials(p.name)),
    h("span", { class: "meta" }, meta),
    h("span", { class: "row-actions" },
      h("button", { class: "icon-btn small", type: "button", title: p.proxy ? "Change proxy" : "Use a proxy", "aria-label": `Proxy for ${p.name}`, onclick: () => openSheet({ kind: "proxy", profileId: p.id }) }, icon("globe")),
      h("button", { class: "icon-btn small", type: "button", title: "Details", "aria-label": `Details of ${p.name}`, onclick: () => openDetails(p.id) }, icon("info")),
      h("button", { class: "icon-btn small", type: "button", title: "Rename", "aria-label": `Rename ${p.name}`, onclick: () => startRename(p) }, icon("edit")),
      deleteButton(p)));
}

function renameField(p) {
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = null;
    const name = input.value.trim();
    if (save && name && name !== p.name) run(() => call("rename", { profileId: p.id, name }));
    else if (stale) load();
    else render();
  };
  const input = h("input", {
    class: "field rename", type: "text", maxlength: "40", value: p.name, "aria-label": "Profile name",
    onkeydown: (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    },
    onblur: () => finish(true),
  });
  setTimeout(() => {
    input.focus();
    input.select();
  });
  return input;
}

function startRename(p) {
  renaming = p.id;
  render();
}

// Deleting takes a second, separate click within a few seconds (not the second half of a
// double-click). The armed state lives outside the row, so a redraw keeps it.
function deleteButton(p) {
  const isArmed = () => armed?.id === p.id && Date.now() - armed.at < 3000;
  const button = h("button", {
    class: `icon-btn small${isArmed() ? " armed" : ""}`, type: "button", title: isArmed() ? "Click again to delete" : "Delete", "aria-label": `Delete ${p.name}`,
  }, icon("trash"));
  button.addEventListener("click", (e) => {
    if (e.detail > 1) return;
    if (!isArmed()) {
      armed = { id: p.id, at: Date.now() };
      button.classList.add("armed");
      button.title = "Click again to delete";
      setTimeout(() => {
        if (armed?.id !== p.id || isArmed()) return;
        armed = null;
        render();
      }, 3100);
      return;
    }
    if (Date.now() - armed.at < 400) return;
    armed = null;
    run(async () => {
      await call("remove", { profileId: p.id });
      toast(p.active ? `${p.name} deleted. ${site()} stays logged in, but that login isn't saved in a profile anymore.` : `${p.name} deleted.`);
    });
  });
  return button;
}

// ---- Order: drag a row, or use the arrow keys on its grip ----

function wireDrag(list) {
  let dragged = null;
  const clear = () => list.querySelectorAll(".drop-before, .drop-after").forEach((li) => li.classList.remove("drop-before", "drop-after"));
  list.addEventListener("dragstart", (e) => {
    dragged = e.target.closest?.(".profile");
    if (!dragged || busy || renaming) {
      dragged = null;
      e.preventDefault();
      return;
    }
    dragged.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragged.dataset.id);
  });
  list.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    clear();
    const li = e.target.closest(".profile");
    if (!li || li === dragged) return;
    const box = li.getBoundingClientRect();
    li.classList.add(e.clientY < box.top + box.height / 2 ? "drop-before" : "drop-after");
  });
  list.addEventListener("drop", (e) => {
    if (!dragged) return;
    e.preventDefault();
    const li = e.target.closest(".profile");
    if (li && li !== dragged) {
      if (li.classList.contains("drop-before")) li.before(dragged);
      else li.after(dragged);
      saveOrder([...list.children].map((item) => item.dataset.id));
    }
  });
  list.addEventListener("dragend", () => {
    dragged?.classList.remove("dragging");
    dragged = null;
    clear();
  });
}

function keyMove(e, p) {
  const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
  if (!delta) return;
  e.preventDefault();
  const ids = state.profiles.map((x) => x.id);
  const from = ids.indexOf(p.id);
  const to = from + delta;
  if (to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ...ids.splice(from, 1));
  saveOrder(ids, p.id);
}

async function saveOrder(ids, focusId) {
  if (busy) return render();
  // Shown in the new order straight away; the saved order follows.
  const byId = new Map(state.profiles.map((p) => [p.id, p]));
  state.profiles = ids.map((id) => byId.get(id)).filter(Boolean);
  await run(async () => {
    if (!(await call("reorder", { groupId: state.group.id, ids })).ok) throw new Error("The profiles changed meanwhile, so the order was kept. Try again.");
  });
  if (focusId) content.querySelector(`.profile[data-id="${focusId}"] .grip`)?.focus();
}

// ---- Actions ----

// Runs an action with the section marked busy, then redraws. Errors show at the bottom.
async function run(task) {
  if (busy) return;
  busy = true;
  const slow = setTimeout(() => toast("Working…", "busy"), 250);
  render();
  try {
    await task();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    clearTimeout(slow);
    if (toastBox.classList.contains("busy")) toast("");
    busy = false;
    stale = false;
    await load();
  }
}

async function saveCurrent() {
  const result = await call("save", { tabId });
  report(result, `Saved as ${result.name}. It stays up to date as you use the site; rename it any time.`);
}

async function switchTo(p, discard) {
  const result = await call("switch", { tabId, profileId: p.id, discard });
  if (result.confirm) return askUnsaved(() => switchTo(p, true), () => switchTo(p, false));
  report(result, `Switched to ${p.name}.`);
}

// The connection is chosen first: the page isn't touched until then, so the new profile's very
// first request already goes out the chosen way.
function newProfile() {
  openSheet({ kind: "new", proxy: null });
}

async function startNew(discard, proxy = null) {
  const result = await call("add", { tabId, discard, proxy });
  if (result.confirm) return askUnsaved(() => startNew(true, proxy), () => startNew(false, proxy));
  report(result, `${result.name} started, logged out. Log in to ${site()} now: the login is saved to ${result.name} automatically.`);
}

function report(result, text) {
  const items = [...(result.problems || [])];
  let kind = items.length ? "warn" : "";
  if (result.login?.state === "expired") {
    text += ` Its login expired ${relative(result.login.expires)}, so log in again: the new login is saved to this profile automatically.`;
    kind = "warn";
  } else if (result.expired) {
    items.unshift(`${result.expired} saved cookie${result.expired > 1 ? "s had" : " had"} expired and ${result.expired > 1 ? "were" : "was"} left out.`);
    kind = "warn";
  }
  toast(text, kind, items);
}

// The browser holds a login no profile has; a switch would replace it.
function askUnsaved(replace, afterSave) {
  openSheet({
    kind: "confirm",
    title: "Save the current login first?",
    text: `The login now on ${site()} isn't in a profile, and switching replaces it.`,
    buttons: [
      ["cancel", closeSheet],
      ["replace it", () => { closeSheet(); run(replace); }, "danger"],
      ["save it first", () => { closeSheet(); run(async () => { await saveCurrent(); await afterSave(); }); }, "primary"],
    ],
  });
}

// ---- Sheets ----

function openSheet(view) {
  sheetView = view;
  drawSheet();
}

function closeSheet() {
  sheetView = null;
  sheet.hidden = true;
  sheet.replaceChildren();
}

function drawSheet() {
  const view = sheetView;
  const draw = { confirm: confirmSheet, details: detailsSheet, proxy: proxySheet, new: newSheet }[view.kind];
  const { title, body, foot } = draw(view);
  sheet.replaceChildren(...[
    h("div", { class: "sheet-head" }, h("h2", {}, title),
      h("button", { class: "icon-btn small", type: "button", title: "Close", "aria-label": "Close", onclick: closeSheet }, icon("close"))),
    h("div", { class: "sheet-body" }, body),
    foot && h("div", { class: "sheet-foot" }, foot),
  ].filter(Boolean));
  sheet.hidden = false;
}

function confirmSheet(view) {
  return {
    title: view.title,
    body: h("p", {}, view.text),
    foot: view.buttons.map(([label, action, cls = ""]) => h("button", { type: "button", class: `text-btn ${cls}`, onclick: action }, label)),
  };
}

function openDetails(profileId) {
  run(async () => openSheet({ kind: "details", data: await call("details", { profileId }) }));
}

function detailsSheet({ data }) {
  const { profile, group, login, cookies, storage } = data;
  const line = loginLine(login);
  const names = [...new Set(cookies.map((c) => c.name))];
  const flags = (c) => [c.httpOnly && "HttpOnly", c.secure && "Secure", c.partitioned && "Partitioned", `path ${c.path}`].filter(Boolean).join(", ");
  return {
    title: profile.name,
    body: [
      h("p", {}, profile.active ? "Active: saved continuously while you use the site. " : `Last used ${relative(profile.lastUsed)}. `, `Last saved ${relative(profile.syncedAt)}.`),
      h("h3", {}, "login"),
      h("p", { class: line.kind === "bad" ? "bad" : "" }, line.long),
      h("label", { for: "login-cookie" }, h("p", {}, "Cookie that holds the login, for every profile of this site:")),
      h("select", {
        id: "login-cookie", class: "mini-sel",
        onchange: (e) => run(async () => {
          await call("login-cookie", { groupId: group.id, name: e.target.value });
          openSheet({ kind: "details", data: await call("details", { profileId: profile.id }) });
        }),
      },
        h("option", { value: "", selected: !group.loginCookie }, "pick automatically"),
        names.map((name) => h("option", { value: name, selected: group.loginCookie === name }, name))),
      h("h3", {}, `cookies (${cookies.length})`),
      cookies.length
        ? h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "name"), h("th", {}, "domain"), h("th", {}, "expires"))),
          h("tbody", {}, cookies.map((c) => h("tr", { class: c.name === login.name ? "login" : null },
            h("td", { class: "name-cell", title: flags(c) }, c.name),
            h("td", {}, c.domain),
            h("td", { title: c.expires ? absolute(c.expires) : "" }, c.expires ? relative(c.expires) : "end of session")))))
        : h("p", {}, "No cookies saved."),
      h("h3", {}, "page storage"),
      storage.length
        ? h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "origin"), h("th", {}, "items"), h("th", {}, "saved"))),
          h("tbody", {}, storage.map((s) => h("tr", {},
            h("td", { class: "name-cell" }, s.origin),
            h("td", {}, `${s.local} local, ${s.session} session${s.databases ? `, app data` : ""}`),
            h("td", {}, s.savedAt ? relative(s.savedAt) : "")))))
        : h("p", {}, "None saved yet."),
    ],
  };
}

function proxySheet({ profileId }) {
  const profile = state.profiles?.find((p) => p.id === profileId);
  if (!profile) return { title: "proxy", body: h("p", {}, "That profile no longer exists.") };
  const info = state.proxy;
  const current = profile.proxy;
  const choose = (proxy) => run(async () => {
    const status = (await call("proxy-profile", { profileId, proxy })).proxy;
    if (!proxy) toast(`${profile.name} uses your own connection now.`);
    else if (status?.ok) toast(`${site()} goes through ${proxy.country ? `a proxy in ${countryName(proxy.country)}` : "a proxy"} while ${profile.name} is active.`);
    else toast(`Saved, but the proxy can't be used yet, so ${site()} won't open while ${profile.name} is active: ${status?.reason}`, "warn");
  });
  const option = (label, proxy, detail) => {
    const selected = proxy ? current?.country === proxy.country : !current;
    return h("button", { type: "button", class: "option", "aria-pressed": String(!!selected), onclick: () => choose(proxy) },
      h("span", {}, label), detail && h("small", {}, detail));
  };
  const count = (n) => `${n} prox${n === 1 ? "y" : "ies"}`;
  const options = [option("no proxy", null, "your own connection")];
  if (info.hasKey && info.countries.length) {
    options.push(option("any country", { country: "" }, count(info.countries.reduce((n, c) => n + c.count, 0))));
    for (const c of info.countries) if (c.code) options.push(option(countryName(c.code), { country: c.code }, count(c.count)));
  }
  if (current?.country && !info.countries.some((c) => c.code === current.country)) {
    options.push(option(`${countryName(current.country)} (none on your account now)`, { country: current.country }));
  }
  return {
    title: `proxy for ${profile.name}`,
    body: [
      h("p", {}, `While ${profile.name} is active, ${site()} goes through this proxy and WebRTC is off on it. Other sites use your own connection. If the proxy can't be used, the site doesn't open.`),
      !info.hasKey && h("p", {}, "Add your Webshare API key in the proxy settings to pick a proxy."),
      info.problem && h("p", { class: "bad" }, info.problem),
      h("div", { class: "options" }, options),
    ],
    foot: h("button", { type: "button", class: "text-btn", onclick: () => openSettings("proxy") }, icon("gear"), "proxy settings"),
  };
}

// The connection for a new profile, chosen before anything happens to the page. One choice is on
// at a time, no proxy until another is picked; without a Webshare key it is the only one.
function newSheet(view) {
  const info = state.proxy;
  const count = (n) => `${n} prox${n === 1 ? "y" : "ies"}`;
  const choose = (proxy) => {
    view.proxy = proxy;
    drawSheet();
  };
  const start = () => {
    closeSheet();
    run(() => startNew(false, view.proxy));
  };
  const option = (label, proxy, detail) => {
    const on = proxy ? view.proxy?.country === proxy.country : !view.proxy;
    return h("button", { type: "button", class: "option", role: "switch", "aria-checked": String(on), onclick: () => choose(on ? null : proxy) },
      h("span", {}, label), h("span", { class: "option-end" }, detail && h("small", {}, detail), h("span", { class: "switch", "aria-checked": String(on) })));
  };
  const proxies = info?.hasKey && info.countries.length > 0;
  return {
    title: "new profile",
    body: [
      h("p", {}, `How should the new profile reach ${site()}? Nothing changes on the page until you start it; then ${site()} is logged out here and opens this way from its first request.`),
      !info?.hasKey && h("p", {}, "Add your Webshare API key in the proxy settings to send a profile through a proxy in a country you pick."),
      info?.problem && h("p", { class: "bad" }, info.problem),
      h("div", { class: "options" },
        option("no proxy", null, "your own connection"),
        proxies && option("any country", { country: "" }, count(info.countries.reduce((n, c) => n + c.count, 0))),
        proxies && info.countries.filter((c) => c.code).map((c) => option(countryName(c.code), { country: c.code }, count(c.count)))),
    ],
    foot: [
      // Profiles are logins: until a passphrase seals them, Drive backups leave them out.
      state.drive === false && h("div", { class: "ss-ask", id: "ssDriveNote" },
        h("p", {}, h("b", {}, "Drive backup"), " of profiles is off"),
        h("button", { type: "button", class: "ss-btn primary", onclick: () => openSettings("sessions") }, "Turn on"),
        h("p", { class: "ss-ask-hint" }, "Turn it on by adding a passphrase: your logins are encrypted before they go to Drive.")),
      !proxies && h("button", { type: "button", class: "text-btn", onclick: () => openSettings("proxy") }, icon("gear"), "proxy settings"),
      h("button", { type: "button", class: "text-btn primary", id: "ssStartBtn", onclick: start }, icon("plus"), "start profile"),
    ].filter(Boolean),
  };
}

function openSettings(section) {
  chrome.runtime.sendMessage({ type: "openSettings", section }).catch(() => {});
  closePopup();
}

// ---- Start ----

$("ssNewBtn").addEventListener("click", newProfile);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sheetView) {
    closeSheet();
    e.preventDefault();
  }
});

// Redraw when a profile changes in the background, for example when a login is saved.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "ss:changed" || tabId == null) return;
  if (busy || renaming) stale = true;
  else load();
});

// popup.js calls this for each tab the popup shows. The same tab again (its page changed, or a
// switch moved it) keeps what's open; another tab starts afresh, so nothing can act on one site's
// list while the popup already shows another tab.
window.initSessions = (next) => {
  if ((next?.id ?? null) !== tabId) {
    tabId = next?.id ?? null;
    state = null;
    renaming = null;
    armed = null;
    closeSheet();
    render();
  }
  if (tabId == null) return;
  if (busy || renaming) stale = true;
  else load();
};
})();
