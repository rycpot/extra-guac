// Userscripts in the popup (the "userscripts" section, tab 3 unless moved): the scripts for the
// current page, each with its switch and the commands it added. The background side is
// bg-userscripts.js; popup.js calls initUserscripts for each tab the popup shows.
(() => {
const list = $("usList");
const master = $("usToggle");

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}

globalThis.initUserscripts = function (tab) {
  const live = scope.signal;
  const url = tab?.url || "";
  const isWeb = /^(https?|file):/i.test(url);
  let state = null, scripts = [], menus = [], on = false;
  const checking = new Set(); // ids whose update check is running

  function render() {
    setSwitch(master, on);
    $("usNewBtn").hidden = !on || !state?.available || !/^https?:/i.test(url);
    const hint = $("usHint");
    hint.onclick = null;
    hint.classList.remove("link");
    if (!on) {
      hint.textContent = "off";
      return list.replaceChildren();
    }
    if (!state?.available) {
      hint.textContent = state?.oldChrome ? "needs a newer Chrome" : "set up";
      hint.classList.add("link");
      hint.onclick = () => $("usSettings").click();
      return list.replaceChildren();
    }
    const here = isWeb ? scripts.filter((s) => USM.urlAllowed(s.meta, url)) : [];
    const running = here.filter((s) => s.enabled !== false).length;
    hint.textContent = !isWeb ? "" : !here.length ? "none on this page" : `${running} on this page`;
    list.replaceChildren(...here.map((s) => {
      const sw = h("button", { class: "switch", role: "switch", "aria-label": `${s.meta.name}, on or off` });
      setSwitch(sw, s.enabled !== false);
      sw.onclick = () => send("usToggle", { id: s.id, enabled: s.enabled === false }).catch(fail);
      const cmds = menus.filter((m) => m.us === s.id);
      return h("div", { class: "us-item" },
        h("div", { class: "row tight sub-row" },
          h("span", { class: `us-name${s.enabled === false || !on ? " off" : ""}`, title: s.meta.description || s.meta.name }, s.meta.name),
          // Always there, so the name gives way first; a script without @version shows a dash.
          h("span", { class: "us-ver", title: s.meta.version ? `Version ${s.meta.version}` : "No @version in this script" }, s.meta.version || "–"),
          h("span", { class: "actions" },
            updateBtn(s),
            h("button", { class: "icon-btn small", title: "Edit", "aria-label": `Edit ${s.meta.name}`, onclick: () => edit(`edit=${encodeURIComponent(s.id)}`) }, icon("edit")),
            sw)),
        cmds.length ? h("div", { class: "us-cmds" }, cmds.map((m) => h("button", {
          class: "text-btn", title: m.title || m.name,
          onclick: () => send("usMenuRun", { us: m.us, cid: m.cid, frameId: m.frameId }).then(() => closePopup(), fail),
        }, m.name))) : null);
    }));
  }

  // Looks for a newer version of this one script now and installs it (or leaves it waiting for
  // an OK on the userscripts page when it asks for more access, as automatic updates do).
  function updateBtn(s) {
    const from = s.meta.updateURL || s.meta.downloadURL || s.source || "";
    const can = /^https?:/i.test(from);
    const busy = checking.has(s.id);
    const b = h("button", {
      class: `icon-btn small us-update${busy ? " spin" : ""}`, disabled: !can || busy,
      title: !can ? "No update address (written or changed here)" : s.pending ? "An update is waiting for your OK: check again" : "Check for an update",
      "aria-label": `Check for an update to ${s.meta.name}`,
    }, icon("update"));
    b.onclick = () => checkOne(s);
    return b;
  }
  async function checkOne(s) {
    if (checking.has(s.id)) return;
    checking.add(s.id);
    render();
    try {
      const r = await send("usCheckUpdates", { ids: [s.id] });
      if (r.updated.length) toast(`Updated to ${r.updated[0]}`);
      else if (r.waiting.length) toast("The update asks for more access: it waits for your OK on the userscripts page");
      else if (r.failed.length) toast(r.failed[0], true);
      else toast(`${s.meta.name} is up to date`);
    } catch (err) { fail(err); }
    checking.delete(s.id);
    if (!live.aborted) render();
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  // The userscripts page, on the tab the hash names.
  const page = (hash = "") => send("usOpen", { hash }).then(() => closePopup(), fail);
  const edit = (hash) => page(hash);

  async function load() {
    const key = `usMenus:${tab?.id}`;
    const [st, got, settings, sess] = await Promise.all([
      send("usState"), send("usList"), TT.getSettings(), tab?.id != null ? chrome.storage.session.get(key) : {},
    ]);
    if (live.aborted) return;
    state = st;
    scripts = got.scripts || [];
    on = !!settings.us?.enabled;
    menus = sess[key] || [];
    render();
  }

  load().catch(fail);
  onStorage((c, area) => {
    if (area === "local" && (c.usScripts || c.tt)) load().catch(() => {});
    if (area === "session" && c[`usMenus:${tab?.id}`]) { menus = c[`usMenus:${tab?.id}`].newValue || []; render(); }
  }, live);
  // Turned on before Chrome lets Extra Guac run scripts: the page shows what's still needed.
  master.onclick = () => {
    const turningOn = !on;
    TT.updateSettings({ us: { enabled: turningOn } }).then(() => { if (turningOn && !state?.available) page(); }, fail);
  };
  $("usSettings").onclick = () => page();
  $("usNewBtn").onclick = () => {
    let site = "";
    try { site = new URL(url).hostname; } catch {}
    edit(`new=${encodeURIComponent(site)}`);
  };
};
})();
