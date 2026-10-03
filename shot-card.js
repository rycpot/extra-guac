// Screenshot card: a faint card at the bottom-right of the page (just above the image
// zoom controls when they're showing), injected by bg-capture.js after a screenshot.
//   preview   thumbnail with ↓ save, ☁ upload and ✕; nothing is saved until one is picked
//   uploading while the shot goes to the image host (✕ only hides the card)
//   done      the link (already copied) with copy and open
//   failed    try again, the other host, or save locally; stays until closed
//   saved     where it went, briefly (always goes)
// Like the zoom controls it stays faint while used. It goes on its own a few seconds
// after it appears (not while uploading or after a failure), unless the pointer has
// been on it: then it stays until ✕. The shot itself lives here, in the page, until
// saved, uploaded or closed, so nothing is lost if the background worker sleeps.
(() => {
  if (window.__egShotCard) return;
  window.__egShotCard = true;

  const AUTO_HIDE_MS = 8000;
  const GAP = 16;
  let host = null, root = null, card = null;
  let shot = null; // { items: [{ name, dataUrl }], label, hosts, host, truncated, screens }
  let phase = "", links = [], error = "", savedAs = "", firstUpload = false;
  let pinned = false, hideTimer = 0, savedTimer = 0, observer = null;

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "egShotCard" || !chrome.runtime?.id) return;
    reply(true);
    clearTimeout(savedTimer);
    shot = msg;
    links = []; error = ""; savedAs = ""; pinned = false;
    show();
    if (msg.auto === "upload") upload(msg.host);
    else setPhase("preview");
  });

  const ICON = {
    save: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.2 4.7 4.7 0 0 0 7 18.5Z"/><path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/>',
    open: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V7a1.5 1.5 0 0 1 1.5-1.5H10"/>',
    close: '<path d="M7 7l10 10M17 7 7 17"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;

  function show() {
    if (!host) {
      host = document.createElement("div");
      host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
      root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `
        <style>
          .card { display: flex; align-items: center; gap: 8px; max-width: min(420px, calc(100vw - 32px)); padding: 6px;
            border-radius: 12px; background: rgba(16,16,16,.85); color: #fff; font: 500 11.5px/1.35 system-ui, sans-serif;
            opacity: .3; box-shadow: 0 4px 18px rgba(0,0,0,.3); }
          canvas { flex: none; width: 56px; height: 36px; border-radius: 7px; background: rgba(255,255,255,.08); }
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
          svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
          .x svg { width: 11px; height: 11px; }
          .spin { width: 13px; height: 13px; margin: 0 6px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25);
            border-top-color: #fff; animation: spin .8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
        <div class="card"><canvas width="112" height="72"></canvas><div class="text"><div class="main"></div><div class="sub"></div></div><div class="btns"></div></div>`;
      card = root.querySelector(".card");
      // Pointed at: it stays until ✕ (it doesn't brighten, like the zoom controls).
      card.addEventListener("pointerenter", () => { pinned = true; clearTimeout(hideTimer); });
    }
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
      const bmp = await createImageBitmap(new Blob([bytes]));
      // Cover the box, keeping the top of tall (full-page) shots.
      const s = Math.max(canvas.width / bmp.width, canvas.height / bmp.height);
      const w = bmp.width * s, h = bmp.height * s;
      ctx.drawImage(bmp, (canvas.width - w) / 2, 0, w, h);
      bmp.close();
    } catch {}
  }

  const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) throw new Error(r?.error || "Something went wrong");
    return r;
  });

  async function upload(hostName) {
    shot.host = hostName;
    setPhase("uploading");
    try {
      const res = await send({ type: "shotUpload", items: shot.items, host: hostName });
      links = res.links;
      firstUpload = !!res.first;
      shot.copied = res.copied;
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

  function setPhase(p) {
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

    if (p === "preview") {
      main.textContent = shot.label;
      sub.textContent = shot.truncated ? `top ${shot.screens} screens only · not saved yet` : "not saved yet";
      button(svg("save"), "Save to Downloads", save);
      const def = shot.hosts.includes(shot.host) ? shot.host : shot.hosts[0];
      button(svg("cloud"), def ? `Upload to ${def}` : "Turn on catbox or x02 in upload images to upload", def && (() => upload(def)));
      autoHide();
    } else if (p === "uploading") {
      main.textContent = `Uploading to ${shot.host}…`;
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
      sub.textContent = `${shot.copied ? "Link copied" : "Uploaded"} · ${shot.host}${firstUpload ? " · anyone with the link can see it" : ""}`;
      button(svg("copy"), links.length > 1 ? "Copy all links" : "Copy link", copyLinks);
      button(svg("open"), "Open", () => window.open(links[0], "_blank", "noopener"));
      autoHide();
    } else if (p === "failed") {
      main.textContent = error;
      main.classList.add("wrap");
      main.title = error;
      if (shot.hosts.includes(shot.host)) button("try again", `Upload to ${shot.host} again`, () => upload(shot.host), "t");
      if (other) button(`use ${other}`, `Upload to ${other} instead`, () => upload(other), "t");
      button("save", "Save to Downloads instead", save, "t");
      clearTimeout(hideTimer); // the shot would be lost: stays until closed
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
