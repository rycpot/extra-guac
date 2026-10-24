// QR code page: make a code from a link, text, phone number or email (up to 500 bytes),
// static (the content is in the code) or dynamic (a spoo.me or dub.sh link whose destination
// can be changed later), with the avocado, one of up to 5 icons of your own ("qrIcons") or none
// in the middle, fitted to its space or not; keep it in the history, save it as PNG or SVG, copy it or
// upload it.
// Every code is read back before it's offered (qr-render.js). Below: the history, static
// and dynamic side by side (bg-qr.js keeps the newest 50 of each); a dynamic code's
// destination can be edited there. The popup, the right-click menu and the page card open
// this page with something to show (storage.session "qrOpen").
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const send = async (type, payload = {}) => {
    const r = await chrome.runtime.sendMessage({ type, ...payload });
    if (!r?.ok) throw new Error(r?.error || "Something went wrong");
    return r;
  };
  const I = {
    url: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
    text: '<path d="M5 6h14M5 11h14M5 16h9"/>',
    phone: '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2Z"/>',
    email: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
    save: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/>',
    cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.2 4.7 4.7 0 0 0 7 18.5Z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    close: '<path d="M7 7l10 10M17 7 7 17"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    keep: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1Z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  const svgIcon = (k, cls = "") => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ""}>${I[k]}</svg>`;
  const KIND_LABEL = { url: "link", text: "text", phone: "phone", email: "email" };

  TT.applyTheme();
  let s = await TT.getSettings();
  let kind = "url", mode = "static"; // the page opens on static: dynamic is picked each time
  let current = null; // the history entry being shown (a dynamic code, or a static one opened from the history)
  let made = null; // { svg, payload, ok, iconScale }
  const MAX_ICONS = 5;
  const loadIcons = async () => { const { qrIcons } = await chrome.storage.local.get("qrIcons"); return Array.isArray(qrIcons) ? qrIcons : []; };
  let icons = await loadIcons(); // your own: [{ id, url (a PNG data URL) }]
  const knownIcon = (v) => v === "avocado" || v === "none" || icons.some((i) => i.id === v);
  let iconMode = knownIcon(s.qr.icon) ? s.qr.icon : "avocado"; // "avocado" | "none" | an icon's id
  const fields = { url: $("url"), text: $("text"), phone: $("phone"), to: $("to"), subject: $("subject"), body: $("body") };

  // The note under the buttons: done-messages go after a few seconds; errors, progress and
  // upload links stay until the next thing happens (another code, typing, another action).
  let noteTimer = 0;
  const sayNodes = (nodes, { bad = false, stay = false } = {}) => {
    clearTimeout(noteTimer);
    $("note").replaceChildren(...nodes);
    $("note").classList.toggle("bad", bad);
    if (!bad && !stay) noteTimer = setTimeout(() => $("note").replaceChildren(), 4000);
  };
  const sayText = (text, bad = false, stay = false) => sayNodes([text], { bad, stay });
  const clearNote = () => { clearTimeout(noteTimer); $("note").replaceChildren(); $("note").classList.remove("bad"); };
  const contentNow = () => ({ url: fields.url.value, text: fields.text.value, phone: fields.phone.value, to: fields.to.value, subject: fields.subject.value, body: fields.body.value });
  const payloadNow = () => EGQR.payload(kind, contentNow());
  const isWeb = (u) => /^https?:\/\/\S+$/i.test(u || "");
  // A dynamic code's short link: { service, id, short, url } (codes from before spoo.me kept
  // a dub.sh one as "dub", until bg-qr.js brings them up to date).
  const linkOf = (e) => e?.link || (e?.dub ? { service: "dub", ...e.dub } : null);

  // ---- Settings bits: the right-click menu, the mode, the icon ----
  $("menuToggle").checked = s.qr.menu === true;
  $("menuToggle").onchange = (e) => TT.updateSettings({ qr: { menu: e.target.checked } });

  function paintSeg(seg, value) {
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === value));
  }
  $("kindSeg").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    kind = b.dataset.v;
    if (kind !== "url" && mode === "dynamic") mode = "static";
    current = null;
    clearNote();
    paintForm();
    redraw();
    fields[kind === "email" ? "to" : kind]?.focus();
  };
  $("modeSeg").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || b.getAttribute("aria-disabled") === "true") return;
    mode = b.dataset.v;
    if (current && current.mode !== mode) current = null;
    clearNote();
    paintForm();
    redraw();
  };

  async function paintForm() {
    paintSeg($("kindSeg"), kind);
    for (const f of document.querySelectorAll(".hl-field[data-for]")) f.hidden = f.dataset.for !== kind;
    const dynOk = kind === "url";
    if (!dynOk && mode === "dynamic") mode = "static";
    paintSeg($("modeSeg"), mode);
    const dynBtn = $("modeSeg").querySelector('[data-v="dynamic"]');
    dynBtn.setAttribute("aria-disabled", String(!dynOk));
    dynBtn.title = dynOk ? "A short link in the code (spoo.me or dub.sh): change where it goes any time, the printed code stays the same" : "Dynamic codes are short links, so they hold a web address (Link)";
    $("modeHint").textContent = mode === "static"
      ? "the content is in the code itself: works offline, forever, can't be changed"
      : "the code holds a short link: change where it goes any time, even once printed";
    await paintDyn();
    paintCount();
  }

  // How much the code holds, out of 500, under the box being typed in (a link's only once
  // it's long). Accented letters and emoji take 2 to 4 each. A dynamic code holds its short
  // link instead, so the address it points to can be any length.
  const tooLong = () => mode === "static" && EGQR.size(payloadNow()) > EGQR.MAX;
  function paintCount() {
    const n = EGQR.size(payloadNow()), over = n > EGQR.MAX;
    const show = { url: kind === "url" && mode === "static" && n > 400, text: kind === "text", body: kind === "email" };
    for (const [k, id] of [["url", "urlCount"], ["text", "textCount"], ["body", "bodyCount"]]) {
      const box = $(id);
      box.hidden = !show[k];
      box.classList.toggle("bad", over);
      box.textContent = `${n} / ${EGQR.MAX}${over ? ` · ${n - EGQR.MAX} over: shorten it to make a code` : ""}`;
      box.title = "What the code holds, in bytes: accented letters and emoji take 2 to 4 each";
    }
  }

  // Dynamic: which service makes the link, spoo.me (the default) or dub.sh: the one picked
  // (qr.dynamic) when its key is there, else the other one linked. With neither, a box to
  // link one (an API key, kept with the URL shortener's); with both, a switch between them.
  const DYN = {
    spoo: { label: "spoo.me", need: "a key with shorten:create, urls:read and urls:manage (or admin:all)" },
    dub: { label: "dub.sh", need: "a key with all permissions (the default)" },
  };
  const hasKey = (id) => !!s.shortener.keys[id]?.trim();
  const dynService = () => (s.qr.dynamic === "dub" ? ["dub", "spoo"] : ["spoo", "dub"]).find(hasKey) || null;
  let linkTarget = "spoo"; // which one the link box is for, with neither linked
  // spoo.me's key form ticks only shorten:create, which can't change a code's destination.
  const spooTip = () => el("span", { className: "qr-key-tip", innerHTML: "<b>Making the key:</b> tick <b>admin:all</b> (full access). spoo.me ticks only shorten:create by default, which makes dynamic codes but can't change where they go later." });
  async function paintDyn() {
    const box = $("dubBox");
    box.hidden = mode !== "dynamic";
    if (box.hidden) return;
    s = await TT.getSettings();
    const service = dynService();
    if (!service) {
      const d = DYN[linkTarget], other = linkTarget === "spoo" ? "dub" : "spoo";
      const input = el("input", { type: "password", className: "text", placeholder: `${d.label} API key`, autocomplete: "off", spellcheck: false });
      const save = el("button", { type: "button", className: "btn", textContent: `link ${d.label}` });
      save.onclick = async () => {
        const v = input.value.trim();
        if (!v) return input.focus();
        await TT.updateSettings({ shortener: { keys: { [linkTarget]: v } }, qr: { dynamic: linkTarget } });
        await paintDyn();
        redraw();
      };
      input.onkeydown = (e) => { if (e.key === "Enter") save.click(); };
      const swap = el("a", { href: "#", textContent: `use ${DYN[other].label} instead` });
      swap.onclick = (e) => { e.preventDefault(); linkTarget = other; paintDyn(); };
      const help = linkTarget === "spoo"
        ? `<a href="${TT.SHORTENERS.spoo.keyHelp}" target="_blank" rel="noopener">Get a key at spoo.me ↗</a> (dashboard → developer); free, no monthly limit`
        : `<a href="${TT.SHORTENERS.dub.keyHelp}" target="_blank" rel="noopener">Get a key at dub.co ↗</a>: ${d.need}; free plan: ${TT.SHORTENERS.dub.freeLimit} new links a month`;
      box.replaceChildren(
        el("div", { className: "row" }, el("span", { innerHTML: `<b>Link your ${d.label} account</b> to make dynamic codes: paste an API key.` }), el("span", { className: "grow" }), swap),
        el("div", { className: "row" }, input, save),
        el("span", { className: "hint", innerHTML: `${help}. The key is kept with the URL shortener's, in this browser.` }));
      if (linkTarget === "spoo") box.append(spooTip());
      return;
    }
    const { shortCounts = {}, shortUsage = {} } = await chrome.storage.local.get(["shortCounts", "shortUsage"]);
    const q = TT.shortQuota(service, s, shortCounts, shortUsage);
    if (service === "dub") send("shortUsage", { services: ["dub"] }).catch(() => {}); // dub.sh's own numbers
    const settings = el("a", { href: "#", textContent: "keys" });
    settings.onclick = (e) => { e.preventDefault(); send("openSettings", { section: "shortener" }).catch((err) => sayText(err.message, true)); };
    // Only dub.sh's count, on its free plan (spoo.me has no limit).
    const links = q.showCount && q.left != null ? ` · <b>${q.left}</b> of ${q.limit} new links left${q.live ? "" : " this month"}` : "";
    const hint = service === "spoo"
      ? "no monthly limit; only you can see link analytics; changing where a code goes needs urls:read and urls:manage on the key (admin:all has them)"
      : !q.showCount ? "paid plan: no monthly limit to watch (its count is in settings → URL shortener)"
      : q.live
        ? `from dub.sh${q.resets ? ` · resets ${TT.shortDay(q.resets)}` : ""}; every dynamic code is one new link`
        : `counted in this browser${q.denied ? " (this key can't read dub.sh's usage: one with all permissions can)" : ""}; every dynamic code is one new link`;
    const row = el("div", { className: "row" });
    // Both linked: a switch for which one makes the next code.
    if (hasKey("spoo") && hasKey("dub")) {
      const seg = el("span", { className: "hl-seg", role: "radiogroup", ariaLabel: "Service for dynamic codes" });
      for (const id of ["spoo", "dub"]) {
        const b = el("button", { type: "button", textContent: DYN[id].label });
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(id === service));
        b.onclick = async () => { await TT.updateSettings({ qr: { dynamic: id } }); paintDyn(); paintActions(); };
        seg.append(b);
      }
      row.append(seg);
    }
    row.append(el("span", { innerHTML: `<span class="ok">✓</span> ${DYN[service].label} linked${links}` }), el("span", { className: "grow" }), settings);
    box.replaceChildren(row, el("span", { className: "hint", textContent: hint }));
    // Only dub.sh linked: spoo.me (no monthly limit) offered too, the same way as with neither.
    if (service === "dub" && !hasKey("spoo")) {
      const input = el("input", { type: "password", className: "text", placeholder: "spoo.me API key", autocomplete: "off", spellcheck: false });
      const save = el("button", { type: "button", className: "btn", textContent: "link spoo.me" });
      save.onclick = async () => {
        const v = input.value.trim();
        if (!v) return input.focus();
        await TT.updateSettings({ shortener: { keys: { spoo: v } }, qr: { dynamic: "spoo" } });
        await paintDyn();
        paintActions();
      };
      input.onkeydown = (e) => { if (e.key === "Enter") save.click(); };
      box.append(
        el("span", { className: "qr-dub-alt", innerHTML: "<b>Or link spoo.me</b>: no monthly limit, and only you can see link analytics." }),
        el("div", { className: "row" }, input, save),
        el("span", { className: "hint", innerHTML: `<a href="${TT.SHORTENERS.spoo.keyHelp}" target="_blank" rel="noopener">Get a key at spoo.me ↗</a> (dashboard → developer). With both linked, a switch here picks which one makes each code.` }),
        spooTip());
    }
  }

  // The icon in the middle: the avocado, one of yours (up to 5, uploaded once and kept, in
  // Drive backups too), or none; fitted to its space or not (fit to space).
  const pickIcon = (v) => {
    iconMode = v;
    TT.updateSettings({ qr: { icon: v } });
    paintIcons();
    redraw();
  };
  async function paintIcons() {
    const seg = $("iconSeg");
    const opt = (v, img, label, title) => {
      const b = el("button", { type: "button", className: "qr-icon", title });
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(iconMode === v));
      b.setAttribute("aria-label", title);
      b.append(img);
      if (label) b.append(label);
      b.onclick = () => pickIcon(v);
      return b;
    };
    const avo = opt("avocado", el("img", { src: "icons/icon128.png", alt: "" }), "", "The avocado");
    avo.classList.add("own");
    const kids = [avo];
    icons.forEach((icon, i) => {
      const b = opt(icon.id, el("img", { src: icon.url, alt: "" }), "", `Your icon ${i + 1}`);
      b.classList.add("own");
      const rm = el("button", { type: "button", className: "qr-icon-rm", title: "Remove this icon", innerHTML: svgIcon("close") });
      rm.onclick = async () => {
        icons = icons.filter((x) => x.id !== icon.id);
        await chrome.storage.local.set({ qrIcons: icons });
        if (iconMode === icon.id) pickIcon("avocado");
        else paintIcons();
      };
      kids.push(el("span", { className: "qr-own" }, b, rm));
    });
    kids.push(opt("none", el("span", { className: "none", textContent: "∅" }), "none", "No icon"));
    if (icons.length < MAX_ICONS) {
      const add = el("button", { type: "button", className: "qr-icon add", title: `Add an icon of your own (up to ${MAX_ICONS}, kept for next time)`, innerHTML: `<span class="none">${svgIcon("plus")}</span>` });
      add.title = `Add an icon of your own (up to ${MAX_ICONS}, kept for next time): pick one, or drop an image anywhere on this page`;
      add.append(el("span", { className: "label", textContent: icons.length ? "add" : "your icon" }), el("span", { className: "drop", textContent: "drop here" }));
      add.onclick = () => $("iconFile").click();
      kids.push(add);
    }
    seg.replaceChildren(...kids);
    paintFit();
  }
  // Fit to space (all icons): the icon's empty, transparent edges trimmed so it fills its space,
  // whole (qr-render.js, fitIcon).
  const fitNow = () => s.qr.fit !== false;
  // Remove background (your icons; the avocado has none): the icon cut out of its background
  // (cutout.js), the same way the screenshot editor does it.
  const ownIcon = () => icons.some((i) => i.id === iconMode);
  const cleanNow = () => s.qr.clean === true && ownIcon();
  function paintFit() {
    $("fitRow").hidden = iconMode === "none";
    $("fitToggle").checked = fitNow();
    $("cleanRow").hidden = !ownIcon();
    $("cleanToggle").checked = s.qr.clean === true;
  }
  $("fitToggle").onchange = async () => {
    s = await TT.updateSettings({ qr: { fit: $("fitToggle").checked } });
    redraw(true);
  };
  $("cleanToggle").onchange = async () => {
    s = await TT.updateSettings({ qr: { clean: $("cleanToggle").checked } });
    redraw(true);
  };
  // Your icon: any image, made a 256px PNG (it's drawn small) and kept for next time. Picked
  // with add, or dropped anywhere on the page (a file, or a picture dragged from a web page).
  $("iconFile").onchange = () => {
    const f = $("iconFile").files[0];
    $("iconFile").value = "";
    addIcon(f);
  };
  const dragsImage = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === "Files" || t === "text/uri-list");
  let dragDepth = 0;
  const dragging = (on) => document.body.classList.toggle("qr-dropping", on);
  addEventListener("dragenter", (e) => { if (dragsImage(e)) { dragDepth++; dragging(true); } });
  addEventListener("dragleave", () => { if (dragDepth && !--dragDepth) dragging(false); });
  addEventListener("dragover", (e) => { if (!dragsImage(e) || e.target.closest?.("input, textarea")) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  addEventListener("drop", async (e) => {
    dragDepth = 0; dragging(false);
    if (!dragsImage(e) || e.target.closest?.("input, textarea")) return;
    e.preventDefault();
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (file) return addIcon(file);
    if (e.dataTransfer.files.length) return sayText("That isn't an image", true);
    const url = (e.dataTransfer.getData("text/uri-list") || "").split("\n").find((u) => /^(https?|data):/i.test(u.trim()))?.trim();
    if (!url) return;
    try {
      const r = await fetch(url);
      const b = await r.blob();
      if (!r.ok || !b.type.startsWith("image/")) throw new Error();
      addIcon(b);
    } catch { sayText("Couldn't get that image", true); }
  });
  async function addIcon(f) {
    if (!f) return;
    if (icons.length >= MAX_ICONS) return sayText(`Up to ${MAX_ICONS} icons: remove one to add another`, true);
    try {
      const img = new Image();
      img.src = URL.createObjectURL(f);
      await img.decode();
      const c = el("canvas", { width: 256, height: 256 });
      const k = Math.min(256 / img.naturalWidth, 256 / img.naturalHeight);
      const w = img.naturalWidth * k, h = img.naturalHeight * k;
      c.getContext("2d").drawImage(img, (256 - w) / 2, (256 - h) / 2, w, h);
      URL.revokeObjectURL(img.src);
      const icon = { id: `i${Date.now().toString(36)}`, url: c.toDataURL("image/png") };
      icons = [...icons, icon];
      await chrome.storage.local.set({ qrIcons: icons });
      pickIcon(icon.id);
    } catch { sayText("Couldn't read that image", true); }
  }
  const iconData = async () => {
    if (iconMode === "none") return { icon: null, fit: false, clean: false };
    const own = icons.find((i) => i.id === iconMode);
    return { icon: own ? own.url : await EGQR.avocado(), fit: fitNow(), clean: cleanNow() };
  };

  // ---- The code ----
  // Static: what's typed, drawn as it's typed. Dynamic: the short link once it's made.
  let drawTimer = 0, drawRun = 0;
  function redraw(now = false) {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(draw, now ? 0 : 220);
  }
  async function draw() {
    const run = ++drawRun;
    const code = $("code"), check = $("check");
    $("dest").hidden = true;
    let text = "";
    if (mode === "dynamic") {
      if (current?.mode === "dynamic") text = current.payload;
    } else text = payloadNow();
    if (!text || tooLong()) {
      made = null;
      code.className = "qr-code empty";
      code.textContent = mode === "dynamic"
        ? (isWeb(payloadNow()) ? "Make the short link to see the code: it's what the code will hold." : "Type a web address: a dynamic code points to it through a short link.")
        : text ? `Shorten it to ${EGQR.MAX} or less to see its code (the count is under the box).` : "Type something to see its code.";
      check.textContent = "";
      $("holds").textContent = "";
      return paintActions();
    }
    const { icon, fit, clean } = await iconData();
    let m;
    try { m = await EGQR.make(text, { icon, fit, clean }); } catch (err) {
      if (run !== drawRun) return;
      made = null;
      code.className = "qr-code empty";
      code.textContent = err.message;
      check.textContent = "";
      return paintActions();
    }
    if (run !== drawRun) return;
    made = { ...m, payload: text };
    code.className = "qr-code";
    code.innerHTML = m.svg;
    check.innerHTML = !m.ok ? '<span class="bad">✗ didn\'t read back: try a shorter text</span>'
      : icon && m.iconScale < 1 ? `<span class="warn">✓ scans · the icon was ${m.iconScale ? "made smaller" : "left out"} so it does</span>`
        : ""; // it reads back: nothing to say
    // What's in it is already in the form; a dynamic code's short link isn't.
    $("holds").textContent = mode === "dynamic" ? `${linkOf(current).short.replace(/^https?:\/\//, "")} · ${TT.SHORTENER_LABEL(linkOf(current).service)}` : "";
    if (mode === "dynamic") paintDest();
    paintActions();
  }

  // A dynamic code's destination, changeable here.
  function paintDest() {
    const box = $("dest");
    box.hidden = false;
    const input = el("input", { type: "text", className: "text", value: linkOf(current).url, spellcheck: false });
    const save = el("button", { type: "button", className: "btn", textContent: "change" });
    save.onclick = async () => {
      const url = EGQR.payload("url", { url: input.value });
      if (url === linkOf(current).url) return;
      save.disabled = true;
      try {
        const { link } = await send("qrDynUpdate", { entryId: current.id, url });
        current = { ...current, link, content: { ...current.content, url: link.url } };
        fields.url.value = link.url;
        sayText(`Now goes to ${link.url} · the code stays the same`, false, true);
      } catch (err) { sayText(err.message, true); }
      save.disabled = false;
    };
    input.onkeydown = (e) => { if (e.key === "Enter") save.click(); };
    box.replaceChildren(el("span", { className: "hint", textContent: "goes to (change it any time):" }), el("div", { className: "row" }, input, save));
  }

  // ---- Save, copy, upload ----
  const btn = (icon, label, title, fn) => {
    const b = el("button", { type: "button", className: "btn", title, innerHTML: `${icon ? svgIcon(icon) : ""}${label}` });
    b.onclick = () => fn(b);
    return b;
  };
  // save: into the history below, nothing downloaded (dynamic codes are kept when made).
  function keepButton() {
    // Saved: this code, with this icon (and fit, and background removed or not), is in the history (a dynamic one is from the
    // moment it's made; saving it again keeps a changed icon or fit).
    const d = design();
    const kept = !!current && current.payload === made?.payload && (current.icon || "avocado") === d.icon && (current.fit !== false) === d.fit && (current.clean === true) === d.clean;
    const b = kept
      ? btn("check", "saved", "This design is in the history below", () => {})
      : btn("keep", "save", "Save the current QR design in the history below: what it holds, the icon and its fit (nothing is downloaded)", keepIt);
    b.classList.add("keep");
    b.disabled = !made?.ok || kept;
    return b;
  }
  function paintActions() {
    const box = $("actions");
    if (mode === "dynamic" && current?.mode !== "dynamic") {
      const url = payloadNow();
      const service = dynService();
      const b = btn("", "make dynamic code", service ? `Makes a ${DYN[service].label} link to this address and a code for it${service === "dub" ? " (one of this month's new links)" : ""}` : "", makeDynamic);
      b.disabled = !service || !isWeb(url);
      b.title = !service ? "Link spoo.me (or dub.sh) first" : !isWeb(url) ? "Type a web address (http or https)" : b.title;
      return box.replaceChildren(b);
    }
    const off = !made?.ok;
    const choices = TT.uploadChoices(s.upload);
    const kids = [
      keepButton(),
      btn("save", "PNG", "Save as PNG in Downloads", savePng),
      btn("save", "SVG", "Save as SVG in Downloads (sharp at any size, for print)", saveSvg),
      btn("copy", "copy", "Copy the image", copyPng),
      btn("cloud", "upload", choices.length === 1 ? `Upload to ${TT.hostName(choices[0])}` : choices.length ? "Upload to…" : "Turn on imglink or X02 in upload images to upload", (b) => uploadPick(b, choices)),
    ];
    kids.slice(1).forEach((k) => (k.disabled = off));
    if (!choices.length) kids[4].disabled = true;
    box.replaceChildren(...kids);
  }

  async function makeDynamic(b) {
    const url = payloadNow();
    b.disabled = true;
    const service = dynService();
    sayText(`Making the ${DYN[service]?.label || ""} link…`, false, true);
    try {
      const { link } = await send("qrDynCreate", { url, service });
      const { entry } = await send("qrRecord", { entry: { mode: "dynamic", kind: "url", content: { url }, payload: link.short, link, ...design() } });
      current = entry;
      sayText(`${link.short} → ${url}${link.service === "spoo" && !link.id ? " · this key can't read your links (urls:read), so changing where it goes may not work" : ""}`, false, !link.id);
      paintDyn();
      redraw(true);
    } catch (err) { sayText(err.message, true); b.disabled = false; }
  }

  // Each save, copy or upload of a static code keeps it in the history (the same content
  // again moves to the top).
  // The design kept with a code: its icon and whether it's fitted to its space.
  const design = () => ({ icon: iconMode, fit: fitNow(), clean: cleanNow() });
  async function remember() {
    if (mode !== "static" || !made) return;
    const { entry } = await send("qrRecord", { entry: { mode: "static", kind, content: contentNow(), payload: made.payload, ...design() } }).catch(() => ({}));
    if (entry) current = entry;
    $("actions").querySelector(".keep")?.replaceWith(keepButton());
  }
  async function keepIt() {
    if (mode === "dynamic" && current?.mode === "dynamic") {
      const { entry } = await send("qrRecord", { entry: { ...current, ...design() } }).catch(() => ({}));
      if (entry) current = entry;
      $("actions").querySelector(".keep")?.replaceWith(keepButton());
    } else await remember();
    if (current) sayText("Saved in the history below");
  }
  function fileBase() {
    const folder = TT.cleanFolder(s.shot.folder);
    const what = (mode === "dynamic" ? linkOf(current).url : made.payload).replace(/^(tel|mailto):/i, "").replace(/^https?:\/\//i, "");
    const slug = what.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "code";
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    return `${folder ? `${folder}/` : ""}qr-${slug}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  const flash = (b, text) => { const was = b.innerHTML; b.innerHTML = `${svgIcon("check")}${text}`; setTimeout(() => b.isConnected && (b.innerHTML = was), 1300); };
  async function savePng(b) {
    try {
      const dataUrl = await EGQR.png(made.svg, 1024);
      const r = await send("shotSave", { items: [{ name: `${fileBase()}.png`, dataUrl }] });
      flash(b, "saved");
      sayText(`Saved ${r.files[0].split("/").pop()} in Downloads`);
      remember();
    } catch (err) { sayText(`Couldn't save: ${err.message}`, true); }
  }
  async function saveSvg(b) {
    try {
      const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(made.svg)))}`;
      const r = await send("shotSave", { items: [{ name: `${fileBase()}.svg`, dataUrl }] });
      flash(b, "saved");
      sayText(`Saved ${r.files[0].split("/").pop()} in Downloads`);
      remember();
    } catch (err) { sayText(`Couldn't save: ${err.message}`, true); }
  }
  async function copyPng(b) {
    try {
      const blob = fetch(await EGQR.png(made.svg, 1024)).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash(b, "copied");
      sayText("Image copied");
      remember();
    } catch (err) { sayText(`Couldn't copy: ${err.message}`, true); }
  }
  // Two hosts: a small picker under ☁, closed by ☁ again, a click elsewhere or Esc.
  function uploadPick(b, choices) {
    const open = $("actions").querySelector(".pick");
    open?.remove();
    if (open) return;
    if (choices.length === 1) return upload(choices[0]);
    const pick = el("div", { className: "pick" }, ...choices.map((h) => {
      const x = el("button", { type: "button", className: "btn", textContent: TT.hostName(h) });
      x.onclick = () => { pick.remove(); upload(h); };
      return x;
    }));
    $("actions").append(pick);
  }
  async function upload(host) {
    sayText(`Uploading to ${TT.hostName(host)}…`, false, true);
    try {
      const dataUrl = await EGQR.png(made.svg, 1024);
      const r = await send("shotUpload", { items: [{ name: `${fileBase().split("/").pop()}.png`, dataUrl }], host, what: "QR code" });
      const a = el("a", { href: r.links[0], target: "_blank", rel: "noopener", textContent: r.links[0].replace(/^https?:\/\//, "") });
      sayNodes([a, ` · ${r.copied ? "link copied" : "uploaded"}${r.first ? " · anyone with the link can see it" : ""}`], { stay: true });
      remember();
    } catch (err) { sayText(err.message, true); }
  }

  // ---- History: static and dynamic side by side ----
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const titleOf = (e) => {
    const p = e.mode === "dynamic" ? linkOf(e).url : e.payload;
    const t = p.replace(/^(tel|mailto):/i, "").replace(/^https?:\/\//i, "");
    return /^mailto:/i.test(p) ? t.replace(/\?.*$/s, "") : t;
  };
  async function paintHistory() {
    const { qrHistory = {} } = await chrome.storage.local.get("qrHistory");
    for (const [m, box, label] of [["static", $("histStatic"), "Static"], ["dynamic", $("histDynamic"), "Dynamic"]]) {
      const list = qrHistory[m] || [];
      const clear = el("button", { type: "button", className: "btn", textContent: "clear", title: m === "dynamic" ? "Clear this list (the short links keep working)" : "Clear this list" });
      clear.hidden = !list.length;
      clear.onclick = async () => { if (confirm(`Clear all ${list.length} ${m} codes from the history?${m === "dynamic" ? " Their short links keep working." : ""}`)) await send("qrClear", { mode: m }); };
      const head = el("h2", {}, `${label} `, el("span", { className: "hint", textContent: `${list.length} / 50` }), el("span", { className: "grow" }), clear);
      const rows = list.map((e) => {
        const k = e.kind || EGQR.kindOf(e.payload);
        const ln = m === "dynamic" ? linkOf(e) : null;
        const row = el("div", { className: `qr-row${current?.id === e.id ? " sel" : ""}`, tabIndex: 0, title: ln ? `${ln.short} → ${ln.url} (${TT.SHORTENER_LABEL(ln.service)})` : e.payload });
        const sub = ln ? `${ln.short.replace(/^https?:\/\//, "")} · ${ago(e.edited || e.at)}${e.edited ? " (destination changed)" : ""}` : `${KIND_LABEL[k]} · ${ago(e.at)}`;
        const del = el("button", { type: "button", className: "ib del", title: ln ? `Remove from the history (the ${TT.SHORTENER_LABEL(ln.service)} link keeps working)` : "Remove from the history", innerHTML: svgIcon("close") });
        del.onclick = (ev) => { ev.stopPropagation(); send("qrDelete", { id: e.id }); };
        const acts = el("span", { className: "acts" });
        if (m === "dynamic") {
          const cp = el("button", { type: "button", className: "ib", title: `Copy ${ln.short}`, innerHTML: svgIcon("copy") });
          cp.onclick = async (ev) => { ev.stopPropagation(); await navigator.clipboard.writeText(ln.short); cp.innerHTML = svgIcon("check"); setTimeout(() => (cp.innerHTML = svgIcon("copy")), 1200); };
          const ed = el("button", { type: "button", className: "ib", title: "Change where it goes", innerHTML: svgIcon("edit") });
          ed.onclick = (ev) => { ev.stopPropagation(); open(e); setTimeout(() => $("dest").querySelector("input")?.select(), 400); };
          acts.append(cp, ed);
        }
        acts.append(del);
        row.append(el("span", { className: "kicon", innerHTML: svgIcon(k) }), el("span", { className: "what" }, el("b", { textContent: titleOf(e) }), el("span", { textContent: sub })), acts);
        row.onclick = () => open(e);
        row.onkeydown = (ev) => { if (ev.key === "Enter" && ev.target === row) open(e); };
        return row;
      });
      box.replaceChildren(head, rows.length ? el("div", { className: "qr-list" }, ...rows) : el("p", { className: "qr-empty", textContent: m === "dynamic" ? "None yet: dynamic codes you make appear here, to change where they go." : "None yet: codes you save, copy or upload appear here." }));
    }
  }
  // Shows a history entry: its content in the form, its code on the right, with the icon (and
  // fit) it was saved with, while that icon is still there.
  function open(e) {
    if (e.icon && knownIcon(e.icon) && e.icon !== iconMode) {
      iconMode = e.icon;
      TT.updateSettings({ qr: { icon: iconMode } });
    }
    if (typeof e.fit === "boolean" && e.fit !== fitNow()) {
      s = { ...s, qr: { ...s.qr, fit: e.fit } };
      TT.updateSettings({ qr: { fit: e.fit } });
    }
    if (typeof e.clean === "boolean" && e.clean !== (s.qr.clean === true) && knownIcon(e.icon) && e.icon !== "avocado") {
      s = { ...s, qr: { ...s.qr, clean: e.clean } };
      TT.updateSettings({ qr: { clean: e.clean } });
    }
    paintIcons();
    kind = e.kind || EGQR.kindOf(e.payload);
    mode = e.mode;
    current = e;
    for (const [k, f] of Object.entries(fields)) f.value = e.content?.[k] ?? "";
    if (e.mode === "dynamic") fields.url.value = linkOf(e).url;
    clearNote();
    paintForm();
    redraw(true);
    paintHistory();
    scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---- Handed over by the popup, right-click menu or card ----
  let seenOpen = 0;
  async function takeOpen() {
    const { qrOpen } = await chrome.storage.session.get("qrOpen");
    if (!qrOpen || qrOpen.at <= seenOpen) return;
    seenOpen = qrOpen.at;
    // Used once: reloading the page, or opening it again later, doesn't bring it back over
    // what's been typed since.
    await chrome.storage.session.remove("qrOpen");
    if (qrOpen.id) {
      const { qrHistory = {} } = await chrome.storage.local.get("qrHistory");
      const e = [...(qrHistory.static || []), ...(qrHistory.dynamic || [])].find((x) => x.id === qrOpen.id);
      if (e) return open(e);
    }
    kind = qrOpen.kind || "url";
    mode = qrOpen.mode === "dynamic" && kind === "url" ? "dynamic" : "static";
    current = null;
    for (const [k, f] of Object.entries(fields)) f.value = qrOpen.content?.[k] ?? "";
    await paintForm();
    redraw(true);
    clearNote();
    if (qrOpen.note === "link") sayText("Link your spoo.me (or dub.sh) account to make this a dynamic code, or switch to static.", false, true);
  }

  // Typing makes a new code: a static one opened from the history is left as it was, and a
  // new address for a dynamic one means a new short link (its own destination is changed
  // under the code instead).
  for (const f of Object.values(fields)) f.addEventListener("input", () => {
    if (current?.mode === "static") current = null;
    if (current?.mode === "dynamic" && f === fields.url && fields.url.value !== linkOf(current).url) current = null;
    if ($("note").classList.contains("bad")) clearNote();
    paintForm();
    redraw();
  });

  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "session" && c.qrOpen) takeOpen();
    if (area !== "local") return;
    if (c.qrHistory) paintHistory();
    if (c.shortCounts || c.shortUsage) paintDyn();
    if (c.tt) TT.getSettings().then((n) => { s = n; $("menuToggle").checked = s.qr.menu === true; paintActions(); paintDyn(); });
    if (c.qrIcons) loadIcons().then((list) => {
      icons = list;
      if (!knownIcon(iconMode)) iconMode = "avocado";
      paintIcons();
      redraw();
    });
  });
  addEventListener("click", (e) => { if (!e.target.closest(".qr-actions")) $("actions").querySelector(".pick")?.remove(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") $("actions").querySelector(".pick")?.remove(); });

  await paintForm();
  paintIcons();
  paintHistory();
  await takeOpen();
  redraw(true);
})();
