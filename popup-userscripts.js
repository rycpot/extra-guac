// Userscripts in the popup (the "userscripts" section, tab 1 unless moved): the scripts for the
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
  let state = null, scripts = [], menus = [], on = true;

  function render() {
    setSwitch(master, on);
    master.hidden = !state?.available;
    $("usNewBtn").hidden = !state?.available || !/^https?:/i.test(url);
    const hint = $("usHint");
    hint.onclick = null;
    hint.classList.remove("link");
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
          h("span", { class: `us-name${s.enabled === false || !on ? " off" : ""}`, title: s.meta.description || s.meta.name }, s.meta.name,
            s.meta.version ? h("span", { class: "us-ver" }, ` ${s.meta.version}`) : null),
          h("span", { class: "actions" },
            h("button", { class: "icon-btn small", title: "Edit", "aria-label": `Edit ${s.meta.name}`, onclick: () => edit(`id=${encodeURIComponent(s.id)}`) }, icon("edit")),
            sw)),
        cmds.length ? h("div", { class: "us-cmds" }, cmds.map((m) => h("button", {
          class: "text-btn", title: m.title || m.name,
          onclick: () => send("usMenuRun", { us: m.us, cid: m.cid, frameId: m.frameId }).then(() => closePopup(), fail),
        }, m.name))) : null);
    }));
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function edit(query) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`us-edit.html?${query}`) }).then(() => closePopup(), fail);
  }

  async function load() {
    const key = `usMenus:${tab?.id}`;
    const [st, got, settings, sess] = await Promise.all([
      send("usState"), send("usList"), TT.getSettings(), tab?.id != null ? chrome.storage.session.get(key) : {},
    ]);
    if (live.aborted) return;
    state = st;
    scripts = got.scripts || [];
    on = settings.us?.enabled !== false;
    menus = sess[key] || [];
    render();
  }

  load().catch(fail);
  onStorage((c, area) => {
    if (area === "local" && (c.usScripts || c.tt)) load().catch(() => {});
    if (area === "session" && c[`usMenus:${tab?.id}`]) { menus = c[`usMenus:${tab?.id}`].newValue || []; render(); }
  }, live);
  master.onclick = () => TT.updateSettings({ us: { enabled: !on } }).catch(fail);
  $("usSettings").onclick = () => send("openSettings", { section: "userscripts" }).then(() => closePopup(), fail);
  $("usNewBtn").onclick = () => {
    let site = "";
    try { site = new URL(url).hostname; } catch {}
    edit(`new=1&site=${encodeURIComponent(site)}`);
  };
};
})();
