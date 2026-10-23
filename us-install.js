// Install page: opening a .user.js link comes here (bg-userscripts.js redirects it), with the
// address after "#". It shows what the script is, where it runs and what it asks for, and
// installs it on a click. "#pending=<id>" shows an update that waits for an OK instead.
(() => {
  const $ = (id) => document.getElementById(id);
  const send = async (type, payload = {}) => {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (!res?.ok) throw new Error(res?.error || "Something went wrong");
    return res;
  };
  TT.applyTheme();
  // "#pending=<id>" for an update waiting for an OK; otherwise the script's address, as given.
  const hash = location.hash.slice(1);
  let pendingId = "";
  try { pendingId = decodeURIComponent(/^pending=(.+)$/.exec(hash)?.[1] || ""); } catch {}
  const RUN_AT = { document_start: "before the page loads", document_end: "once the page is there", document_idle: "after the page has loaded", context_menu: "when picked from the right-click menu" };
  let code = "", url = "", installedId = "", pendingAt = 0;

  function fail(text) {
    $("loading").hidden = true;
    $("notice").hidden = false;
    $("notice").className = "us-notice";
    $("notice").textContent = text;
  }
  // A link to a page about the file (GitHub, GitLab) rather than the file itself.
  const rawUrl = (u) => u.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/, "https://raw.githubusercontent.com/$1/$2/$3")
    .replace(/^(https:\/\/gitlab\.com\/.+?)\/-\/blob\//, "$1/-/raw/");

  async function start() {
    // Only as a page of its own: another site could show it in a frame and trick a click.
    if (window.top !== window) return fail("Open this page on its own to install the script.");
    const st = await send("usState").catch(() => ({}));
    let old = null;
    if (pendingId) {
      const { script } = await send("usGet", { id: pendingId });
      if (!script.pending) return fail("That update was already installed or skipped.");
      old = script;
      code = script.pending.code;
      pendingAt = script.pending.at;
      url = script.pending.source || "";
      $("kicker").textContent = "extra guac · update waiting for your OK";
    } else {
      url = rawUrl(hash);
      if (!/^https?:\/\//i.test(url)) return fail("There's no script address to install from.");
      try {
        const res = await fetch(url, { cache: "no-store", credentials: "omit" });
        if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
        code = await res.text();
      } catch (err) { return fail(`Couldn't download the script: ${err.message}`); }
    }
    const meta = USM.parseMeta(code);
    if (!meta || !meta.name) return fail("That file isn't a userscript: it has no “// ==UserScript==” block with a @name.");
    if (!st.available) {
      $("notice").hidden = false;
      $("notice").className = "us-notice";
      $("notice").innerHTML = `<div>Userscripts aren't set up yet, so this can't run until they are. <a href="userscripts.html" target="_blank">Set them up on the userscripts page</a>, then come back and install.</div>`;
    }
    if (!old) {
      const { scripts } = await send("usList").catch(() => ({ scripts: [] }));
      old = scripts.find((s) => USM.keyOf(s.meta) === USM.keyOf(meta)) || null;
    }
    installedId = old?.id || "";
    show(meta, old);
  }

  function show(meta, old) {
    $("loading").hidden = true;
    $("view").hidden = false;
    document.title = `${meta.name} · install · Extra Guac`;
    $("name").textContent = meta.name;
    $("version").textContent = meta.version ? `v${meta.version}` : "";
    let host = "";
    try { host = url ? new URL(url).host : ""; } catch {}
    $("from").textContent = [meta.author && `by ${meta.author}`, host && `from ${host}`].filter(Boolean).join(" · ");
    // Its homepage and support page, when it names them (web addresses only).
    for (const [href, label] of [[meta.homepage, "homepage"], [meta.supportURL, "support"]]) {
      try { if (!/^https?:$/.test(new URL(href).protocol)) continue; } catch { continue; }
      const a = Object.assign(document.createElement("a"), { href, textContent: label, target: "_blank", rel: "noopener noreferrer" });
      $("from").append($("from").textContent ? " · " : "", a);
    }
    $("desc").textContent = meta.description;
    if (/^data:image\//.test(meta.icon)) { const img = new Image(); img.alt = ""; img.src = meta.icon; img.onerror = () => img.remove(); $("ico").append(img); }
    else $("ico").textContent = (meta.name.trim()[0] || "?").toUpperCase();
    if (old) {
      const cmp = USM.compareVersions(meta.version, old.meta.version);
      $("change").hidden = false;
      $("change").textContent = cmp > 0 ? `Updates the installed version ${old.meta.version || "(none)"} to ${meta.version}.`
        : cmp < 0 ? `This is an older version than the one installed (${old.meta.version}).` : "This version is already installed; installing again replaces it.";
      if (USM.asksMore(old.meta, meta)) $("change").textContent += " It asks for more than the installed one: look over what it can do below.";
      $("install").textContent = cmp > 0 ? "update" : cmp < 0 ? "install older version" : "reinstall";
    }
    const pill = (t, cls = "mono") => { const s = document.createElement("span"); s.className = `pill ${cls}`; s.textContent = t; return s; };
    const ins = [...meta.matches, ...meta.includes];
    const everywhere = !ins.length || USM.sitesOf(meta)[0] === "all sites";
    $("runs").append(...(ins.length ? ins.slice(0, 12) : ["every site"]).map((p) => pill(p, everywhere ? "mono warn" : "mono")));
    if (ins.length > 12) $("runs").append(pill(`+${ins.length - 12} more`, ""));
    const when = document.createElement("span");
    when.className = "mut";
    when.textContent = `· ${RUN_AT[meta.runAt]}`;
    $("runs").append(when);
    const kinds = USM.kindsOf(meta);
    const can = $("can");
    const line = (title, sub = "") => {
      const d = document.createElement("div");
      d.innerHTML = `<span class="dot"></span><div><div></div><div class="mut"></div></div>`;
      d.querySelector(":scope > div > div").textContent = title;
      d.querySelector(".mut").textContent = sub;
      can.append(d);
    };
    if (!kinds.length) line("Nothing beyond the page itself", "it runs as part of the pages it names");
    for (const k of kinds) {
      if (k === "requests") line(USM.KIND_TEXT[k], meta.connects.length ? `only to ${meta.connects.join(", ")}` : "to any site");
      else line(USM.KIND_TEXT[k]);
    }
    for (const l of USM.limits(meta, code)) line("Limit", l);
    if (meta.updateURL || meta.downloadURL || url) {
      let from = "";
      try { from = new URL(meta.updateURL || meta.downloadURL || url).host; } catch {}
      if (from) line("Updates itself", `from ${from}; you're asked again if an update wants more access`);
    }
    $("srcSum").textContent = `view source (${code.split("\n").length} lines)`;
    $("code").textContent = code;
    $("srcBox").addEventListener("toggle", paint, { once: true });
  }

  async function paint() {
    if (code.length > 400000) return;
    const esc = (s) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
    let out = "";
    try {
      const m = await import("./vendor/speed-highlight/index.js");
      await m.tokenize(code, "js", (str, type) => { out += type ? `<span class="t-${type}">${esc(str)}</span>` : esc(str); });
      $("code").innerHTML = out;
    } catch {}
  }

  $("install").onclick = async () => {
    $("install").disabled = true;
    $("note").textContent = "installing…";
    try {
      if (pendingId) await send("usPending", { id: pendingId, install: true, at: pendingAt });
      else ({ id: installedId } = await send("usInstall", { code, source: url }));
      $("note").textContent = "Installed. Pages it runs on pick it up the next time they load.";
      $("install").textContent = "edit";
      $("install").disabled = false;
      // The editor opens in the userscripts tab. This tab goes back to the page the script came
      // from when it was opened over it, and closes only when it was opened on its own.
      $("install").onclick = () => send("usOpen", { hash: `edit=${encodeURIComponent(installedId || pendingId)}` })
        .then(() => (history.length > 1 ? history.back() : window.close()), (err) => ($("note").textContent = err.message));
      $("cancel").textContent = "close";
    } catch (err) {
      $("note").textContent = err.message;
      $("install").disabled = false;
    }
  };
  $("cancel").onclick = () => (history.length > 1 ? history.back() : window.close());
  start().catch((err) => fail(err.message));
})();
