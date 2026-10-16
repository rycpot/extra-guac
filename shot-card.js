// Screenshot card: a card at the bottom-right of the page (just above the image zoom
// controls when they're showing), injected by bg-capture.js after a screenshot.
//   preview   thumbnail with ↓ save, copy image, open in a tab, ☁ upload and ✕; nothing is
//             saved until one is picked (opening it in a tab doesn't save it either)
//   uploading while the shot goes to the image host (✕ only hides the card)
//   done      the link (already copied) with copy and open
//   failed    try again, the other host, or save locally; stays until closed
//   saved     where it went, briefly (always goes)
// It goes on its own a few seconds
// after it appears (not while uploading or after a failure), unless the pointer has
// been on it: then it stays until ✕. The shot itself lives here, in the page, until
// saved, uploaded or closed, so nothing is lost if the background worker sleeps.
(() => {
  if (window.__egShotCard) return;
  window.__egShotCard = true;

  const AUTO_HIDE_MS = 8000;
  const GAP = 16;
  const hostLabel = (h) => (h === "x02" ? "X02" : h); // how a host is written where it's shown
  let host = null, root = null, card = null;
  let shot = null; // { items: [{ name, dataUrl }], label, hosts, host, truncated, screens }
  let phase = "", links = [], error = "", savedAs = "", firstUpload = false;
  let pinned = false, hideTimer = 0, savedTimer = 0, observer = null;
  let shotFile = null; // the shot's first part as a File (for copying)

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "egShotCard" || !chrome.runtime?.id) return;
    reply(true);
    clearTimeout(savedTimer);
    shot = msg;
    links = []; error = ""; savedAs = ""; pinned = false;
    shotFile = null;
    show();
    if (msg.auto === "upload") upload(msg.host);
    else setPhase("preview");
    if (msg.auto === "pick") { pinned = true; clearTimeout(hideTimer); openPicker(); } // upload mode, both hosts: ask
  });

  const ICON = {
    save: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.2 4.7 4.7 0 0 0 7 18.5Z"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/>',
    open: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V7a1.5 1.5 0 0 1 1.5-1.5H10"/>',
    close: '<path d="M7 7l10 10M17 7 7 17"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    image: '<rect x="4" y="4.5" width="16" height="15" rx="2.5"/><circle cx="9.5" cy="10" r="1.6"/><path d="M20 15.5l-4.5-4.5L7 19.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;

  function show() {
    if (!host) {
      host = document.createElement("div");
      host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
      root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `
        <style>
          .card { position: relative; display: flex; align-items: center; gap: 8px; max-width: min(420px, calc(100vw - 32px)); padding: 6px;
            border-radius: 12px; background: rgb(22,22,22); color: #fff; font: 500 11.5px/1.35 system-ui, sans-serif;
            box-shadow: 0 8px 28px rgba(0,0,0,.45);
            outline: 1px solid rgba(255,255,255,.28); outline-offset: -1px; } /* the edge keeps it visible on dark pages */
          canvas { flex: none; width: 56px; height: 36px; border-radius: 7px; background: rgba(255,255,255,.08); cursor: pointer; }
          .text { flex: 1; min-width: 0; display: grid; gap: 1px; }
          .main, .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .sub { color: rgba(255,255,255,.6); font-weight: 400; font-size: 10.5px; }
          .main.wrap { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
          a { color: inherit; text-decoration: none; } a:hover { text-decoration: underline; }
          .btns { display: flex; align-items: center; gap: 2px; flex: none; }
          button { all: unset; height: 26px; min-width: 26px; display: grid; place-items: center; border-radius: 8px; cursor: pointer; }
          button.t { padding: 0 7px; font-size: 11px; }
          button:hover { background: rgba(255,255,255,.12); }
          button[disabled] { opacity: .4; cursor: default; background: none; }
          .pick { position: absolute; bottom: calc(100% + 6px); display: flex; gap: 2px; padding: 4px; border-radius: 10px;
            background: rgba(16,16,16,.92); outline: 1px solid rgba(255,255,255,.28); outline-offset: -1px; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
          .pick button { padding: 0 10px; font-size: 11.5px; }
          button.del.armed { color: #ff6b5e; background: rgba(255,69,58,.18); }
          svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
          .x svg { width: 11px; height: 11px; }
          .spin { width: 13px; height: 13px; margin: 0 6px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25);
            border-top-color: #fff; animation: spin .8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
        <div class="card"><canvas width="112" height="72"></canvas><div class="text"><div class="main"></div><div class="sub"></div></div><div class="btns"></div></div>`;
      card = root.querySelector(".card");
      // Pointed at: it stays until ✕.
      card.addEventListener("pointerenter", () => { pinned = true; clearTimeout(hideTimer); });
      // The thumbnail opens the shot in a new tab too.
      const thumb = root.querySelector("canvas");
      thumb.addEventListener("click", () => (shot?.kind === "qr" ? customize() : openInTab()));
      // Ctrl/⌘+C with the pointer on the card (and no text selected) copies the image.
      addEventListener("keydown", (e) => {
        if (!shot || !host?.isConnected || !card.matches(":hover")) return;
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "c" || String(getSelection() || "")) return;
        e.preventDefault();
        e.stopPropagation();
        copyImage(root.querySelector("button.img"));
      }, true);
    }
    const thumbEl = root.querySelector("canvas");
    const square = shot.kind === "qr";
    Object.assign(thumbEl, { width: square ? 72 : 112, height: 72 });
    thumbEl.style.width = square ? "36px" : "";
    thumbEl.title = square ? "Customize on the QR page" : "Open in a new tab (not saved)";
    document.documentElement.append(host);
    drawThumb();
    placeAboveZoom();
    observer?.disconnect();
    observer = new MutationObserver(placeAboveZoom);
    observer.observe(document.documentElement, { childList: true });
  }

  // The zoom controls (imgzoom.js) sit in the same corner: stand just above them.
  function placeAboveZoom() {
    const zoom = document.querySelector("[data-eg-zoom]");
    host.style.bottom = `${zoom?.isConnected ? GAP + zoom.getBoundingClientRect().height + 8 : GAP}px`;
  }

  function close() {
    clearTimeout(hideTimer);
    clearTimeout(savedTimer);
    observer?.disconnect();
    host?.remove();
    shot = null; // drops the image
  }

  function autoHide(ms = AUTO_HIDE_MS) {
    clearTimeout(hideTimer);
    if (!pinned) hideTimer = setTimeout(close, ms);
  }

  // Thumbnail of the (first part of the) shot; drawn on a canvas, so the page's own
  // image rules (CSP) don't matter.
  async function drawThumb() {
    const canvas = root.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try {
      const url = shot.items[0].dataUrl;
      const bin = atob(url.slice(url.indexOf(",") + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const type = url.slice(5, url.indexOf(";")) || "image/png";
      const name = (shot.items[0].name || "screenshot.png").split("/").pop();
      shotFile = new File([bytes], name, { type });
      const bmp = await createImageBitmap(new Blob([bytes]));
      // Cover the box, keeping the top of tall (full-page) shots.
      const s = Math.max(canvas.width / bmp.width, canvas.height / bmp.height);
      const w = bmp.width * s, h = bmp.height * s;
      ctx.drawImage(bmp, (canvas.width - w) / 2, 0, w, h);
      bmp.close();
    } catch {}
  }

  // The shot (its first part, for very long pages) as a PNG: what the clipboard takes.
  async function pngBlob() {
    if (shotFile?.type === "image/png") return shotFile;
    const bmp = await createImageBitmap(shotFile || await (await fetch(shot.items[0].dataUrl)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    return c.convertToBlob({ type: "image/png" });
  }

  // A new tab with the shot at full size (an extension page; nothing is saved). The image
  // goes through the background worker, which hands it to that tab once.
  function openInTab() {
    if (!shot) return;
    pinned = true;
    clearTimeout(hideTimer);
    send({ type: "shotView", items: shot.items, label: shot.label, historyId: shot.historyId }).catch((err) => {
      root.querySelector(".sub").textContent = `Couldn't open it: ${err.message}`;
    });
  }

  // A QR code: open it on the QR page, to change it, make it dynamic, or edit where it goes.
  function customize() {
    pinned = true;
    clearTimeout(hideTimer);
    send({ type: "qrOpenPage", open: { id: shot.qrId } }).catch((err) => {
      root.querySelector(".sub").textContent = `Couldn't open it: ${err.message}`;
    });
  }
  async function saveSvg() {
    try {
      const res = await send({ type: "shotSave", items: [shot.svg] });
      savedAs = res.files[0].split("/").pop();
      setPhase("saved");
    } catch (err) {
      error = `Couldn't save: ${err.message}`;
      setPhase("failed");
    }
  }

  async function copyImage(btn) {
    if (!shot) return;
    const sub = root.querySelector(".sub");
    let ok = false;
    try {
      // A promise inside the item keeps the click's permission while the PNG is made.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob() })]);
      ok = true;
    } catch {
      // No async clipboard here (http pages, or the page isn't focused): copy it as a
      // pasted picture from a hidden editable box instead.
      const box = document.createElement("div");
      box.contentEditable = "true";
      box.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
      const img = new Image();
      img.src = shot.items[0].dataUrl;
      box.append(img);
      document.documentElement.append(box);
      const range = document.createRange();
      range.selectNode(img);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { ok = document.execCommand("copy"); } catch {}
      sel.removeAllRanges();
      box.remove();
    }
    if (btn) {
      const icon = btn.dataset.icon || "image"; // back to the button's own icon after the ✓
      btn.innerHTML = svg(ok ? "check" : icon);
      setTimeout(() => btn.isConnected && (btn.innerHTML = svg(icon)), 1200);
    }
    const parts = shot.items.length;
    if (sub) sub.textContent = ok ? `Image copied${parts > 1 ? ` (part 1 of ${parts})` : ""}` : "Couldn't copy the image here";
  }

  const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) throw new Error(r?.error || "Something went wrong");
    return r;
  });

  async function upload(hostName) {
    shot.host = hostName;
    setPhase("uploading");
    try {
      const res = await send({ type: "shotUpload", items: shot.items, host: hostName, what: shot.kind === "qr" ? "QR code" : "" });
      links = res.links;
      firstUpload = !!res.first;
      shot.copied = res.copied;
      shot.deletable = !!res.deletable;
      setPhase("done");
    } catch (err) {
      error = err.message;
      setPhase("failed");
    }
  }

  async function save() {
    try {
      const res = await send({ type: "shotSave", items: shot.items });
      savedAs = res.files.length > 1 ? `${res.files.length} parts` : res.files[0].split("/").pop();
      setPhase("saved");
    } catch (err) {
      error = `Couldn't save: ${err.message}`;
      setPhase("failed");
    }
  }

  async function copyLinks(btn) {
    const text = links.join("\n");
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      root.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    setTimeout(() => (btn.innerHTML = svg("copy")), 1200);
  }

  // Host picker: a row of host names just above the card's ☁ button.
  function togglePicker() {
    if (root.querySelector(".pick")) return closePicker();
    openPicker();
  }
  function openPicker() {
    closePicker();
    const pick = document.createElement("div");
    pick.className = "pick";
    for (const h of shot.choices) {
      const b = document.createElement("button");
      b.textContent = hostLabel(h);
      b.title = `Upload to ${hostLabel(h)}`;
      b.onclick = () => { closePicker(); upload(h); };
      pick.append(b);
    }
    card.append(pick);
    const anchor = root.querySelector("button.cloud");
    if (anchor) pick.style.right = `${card.getBoundingClientRect().right - anchor.getBoundingClientRect().right}px`;
  }
  const closePicker = () => root.querySelector(".pick")?.remove();

  const copyTitle = () => `Copy image${shot.items.length > 1 ? ` (part 1 of ${shot.items.length})` : ""} · or Ctrl/⌘+C over the card`;

  function setPhase(p) {
    closePicker();
    if (!shot) return;
    phase = p;
    const main = root.querySelector(".main"), sub = root.querySelector(".sub"), btns = root.querySelector(".btns");
    main.className = "main";
    main.replaceChildren();
    sub.textContent = "";
    btns.replaceChildren();
    const button = (html, title, onClick, cls = "") => {
      const b = document.createElement("button");
      b.innerHTML = html;
      b.title = title;
      if (cls) b.className = cls;
      if (onClick) b.onclick = () => onClick(b); else b.disabled = true;
      btns.append(b);
      return b;
    };
    const other = shot.hosts.find((h) => h !== shot.host);

    if (p === "preview" && shot.kind === "qr") {
      main.textContent = shot.label;
      sub.textContent = shot.sub;
      sub.title = shot.sub;
      button(svg("save"), "Save as PNG in Downloads", save);
      button("SVG", "Save as SVG in Downloads (sharp at any size, for print)", saveSvg, "t");
      button(svg("copy"), "Copy image · or Ctrl/⌘+C over the card", copyImage, "img").dataset.icon = "copy";
      button(svg("open"), "Customize on the QR page", customize);
      const choices = shot.choices || [];
      const cloud = button(svg("cloud"), choices.length === 1 ? `Upload to ${hostLabel(choices[0])}` : choices.length ? "Upload to…" : "Turn on imglink or X02 in upload images to upload",
        choices.length === 1 ? () => upload(choices[0]) : choices.length ? () => togglePicker() : null);
      cloud.classList.add("cloud");
      autoHide();
    } else if (p === "preview") {
      main.textContent = shot.label;
      sub.textContent = shot.truncated ? `top ${shot.screens} screens only · not saved yet` : "not saved yet";
      button(svg("save"), "Save to Downloads", save);
      button(svg("copy"), copyTitle(), copyImage, "img").dataset.icon = "copy";
      button(svg("open"), "Open in a new tab (not saved)", openInTab);
      // ☁: one host offered → straight there; both → a small picker attached to it.
      const choices = shot.choices || [];
      const cloud = button(svg("cloud"), choices.length === 1 ? `Upload to ${hostLabel(choices[0])}` : choices.length ? "Upload to…" : "Turn on imglink or X02 in upload images to upload",
        choices.length === 1 ? () => upload(choices[0]) : choices.length ? () => togglePicker() : null);
      cloud.classList.add("cloud");
      autoHide();
    } else if (p === "uploading") {
      main.textContent = `Uploading to ${hostLabel(shot.host)}…`;
      sub.textContent = shot.items.length > 1 ? `${shot.items.length} parts` : shot.label;
      btns.insertAdjacentHTML("beforeend", '<i class="spin"></i>');
      clearTimeout(hideTimer);
    } else if (p === "done") {
      const a = document.createElement("a");
      a.href = links[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = links[0].replace(/^https?:\/\//, "");
      a.title = links.join("\n");
      main.append(a);
      if (links.length > 1) main.append(` +${links.length - 1} more`);
      sub.textContent = `${shot.copied ? "Link copied" : "Uploaded"} · ${hostLabel(shot.host)}${firstUpload ? " · anyone with the link can see it" : ""}`;
      button(svg("copy"), links.length > 1 ? "Copy all links" : "Copy link", copyLinks);
      button(svg("image"), copyTitle(), copyImage, "img");
      button(svg("open"), "Open", () => window.open(links[0], "_blank", "noopener"));
      // Delete from the host: a first click arms it (turns red), a second one deletes.
      if (shot.deletable) {
        const hostName = shot.host; // the card may have closed by the time the timer runs
        const del = button(svg("trash"), `Delete from ${hostLabel(hostName)}`, async (b) => {
          if (!b.classList.contains("armed")) {
            b.classList.add("armed");
            b.title = "Click again to delete";
            setTimeout(() => { b.classList.remove("armed"); b.title = `Delete from ${hostLabel(hostName)}`; }, 3000);
            return;
          }
          b.disabled = true;
          try {
            await send({ type: "deleteUploads", links });
            setPhase("deleted");
          } catch (err) {
            error = `Couldn't delete: ${err.message}`;
            b.disabled = false;
            root.querySelector(".sub").textContent = error;
          }
        });
        del.classList.add("del");
      }
      autoHide();
    } else if (p === "failed") {
      main.textContent = error;
      main.classList.add("wrap");
      main.title = error;
      if (shot.hosts.includes(shot.host)) button("try again", `Upload to ${hostLabel(shot.host)} again`, () => upload(shot.host), "t");
      if (other) button(`use ${hostLabel(other)}`, `Upload to ${hostLabel(other)} instead`, () => upload(other), "t");
      button("save", "Save to Downloads instead", save, "t");
      clearTimeout(hideTimer); // the shot would be lost: stays until closed
    } else if (p === "deleted") {
      main.textContent = `Deleted from ${hostLabel(shot.host)}`;
      sub.textContent = "the link no longer works";
      clearTimeout(hideTimer);
      clearTimeout(savedTimer);
      savedTimer = setTimeout(close, 2500);
    } else if (p === "saved") {
      main.textContent = `Saved ${savedAs}`;
      sub.textContent = "in Downloads";
      clearTimeout(hideTimer);
      clearTimeout(savedTimer);
      savedTimer = setTimeout(close, 2500); // nothing left to do here: goes even if pointed at
    }
    button(svg("close"), p === "uploading" ? "Hide (the upload carries on)" : "Close", close, "x");
  }
})();
