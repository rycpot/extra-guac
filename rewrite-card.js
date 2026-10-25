// Polish text card, at the bottom-right of the page like the text from image card (and just
// above the image zoom controls when they're showing). Injected by bg-rewrite.js with the text
// that was right-clicked; asks the background worker to rewrite it ("rewriteRun"). "fix"
// corrects mistakes only; "rephrase" rewrites it in the tone picked below it. Each result is
// kept, so switching back is instant, and ↻ asks again. The result can be edited before
// "replace" (only when the text came from a field) or copy. Stays until ✕ or Esc.
// It can be dragged by its top bar; where it's left is where it opens next time, on any page
// (storage.local "rewriteCardSpot": { right, bottom }), until a double-click on the bar puts it
// back in the corner.
(() => {
  if (window.__egRewriteCard) return;
  window.__egRewriteCard = true;

  const GAP = 16;
  const TONES = ["clearer", "shorter", "friendly", "formal", "casual"];
  let host = null, root = null, observer = null;
  let spot = null; // { right, bottom } once dragged; null = the corner
  chrome.storage.local.get("rewriteCardSpot").then(({ rewriteCardSpot: s }) => { if (s && !spot) { spot = s; if (host) place(); } }).catch(() => {});
  let source = "", frameId = 0, editable = false, mode = "rephrase", tone = "clearer", results = {}, busy = false;
  let seq = 0; // a new right-click while one is being rewritten: the old answer is dropped

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "egRewriteCard" || !chrome.runtime?.id) return;
    reply(true);
    source = msg.text || "";
    frameId = msg.frameId || 0;
    editable = !!msg.editable;
    mode = msg.mode === "fix" ? "fix" : "rephrase";
    tone = TONES.includes(msg.tone) ? msg.tone : "clearer";
    results = {};
    busy = false;
    seq++;
    show();
    root.querySelector("textarea").value = "";
    if (msg.error) return render({ error: msg.error });
    run();
  });

  const ICON = {
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    close: '<path d="M7 7l10 10M17 7 7 17"/>',
    again: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;
  const key = () => (mode === "fix" ? "fix" : `rephrase:${tone}`);

  function show() {
    if (!host) {
      host = document.createElement("div");
      host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
      root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `
        <style>
          .card { display: flex; flex-direction: column; gap: 8px; width: min(540px, calc(100vw - 32px)); padding: 10px 10px 9px;
            box-sizing: border-box; border-radius: 12px; background: rgb(22,22,22); color: #fff;
            font: 500 11.5px/1.35 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.45);
            outline: 1px solid rgba(255,255,255,.28); outline-offset: -1px; } /* the edge keeps it visible on dark pages */
          .head { display: flex; align-items: center; gap: 8px; cursor: grab; touch-action: none; user-select: none; }
          .head.dragging { cursor: grabbing; }
          .head a, .head button { cursor: pointer; }
          .titles { flex: 1; min-width: 0; display: grid; gap: 1px; }
          .main, .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .sub { color: rgba(255,255,255,.6); font-weight: 400; font-size: 10.5px; }
          .err { color: #ff8a80; white-space: normal; }
          .btns { display: flex; align-items: center; gap: 2px; flex: none; }
          /* "Powered by groq", with its wordmark, in Groq's own orange-red. */
          .by { display: flex; align-items: center; gap: 5px; margin-right: 6px; color: rgba(255,255,255,.55); font-weight: 400;
            font-size: 10.5px; text-decoration: none; white-space: nowrap; }
          .by:hover { color: rgba(255,255,255,.8); }
          .by svg.groq { width: 27.4px; height: 10px; fill: none; stroke: #f55036; stroke-width: 58; stroke-linecap: butt; stroke-linejoin: miter; }
          button { all: unset; height: 26px; min-width: 26px; display: grid; place-items: center; border-radius: 8px; cursor: pointer; }
          button:hover { background: rgba(255,255,255,.12); }
          button[disabled] { opacity: .4; cursor: default; background: none; }
          .modes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
          .seg { display: flex; flex: none; padding: 2px; border-radius: 8px; background: rgba(255,255,255,.08); }
          .seg button { height: 22px; padding: 0 9px; border-radius: 6px; font: 500 11px system-ui, sans-serif; color: rgba(255,255,255,.7); }
          .seg button[aria-pressed=true] { background: rgba(255,255,255,.18); color: #fff; cursor: default; }
          textarea { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 8px 10px; border-radius: 8px;
            background: rgba(255,255,255,.06); color: rgba(255,255,255,.95); font: 400 13px/1.5 system-ui, sans-serif;
            white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: none; cursor: text; }
          textarea:focus { outline: 1px solid rgba(255,255,255,.3); }
          textarea.dim { color: rgba(255,255,255,.4); cursor: default; }
          .foot { min-height: 26px; display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,.6); font-weight: 400; font-size: 10.5px; }
          .foot .why { flex: 1; min-width: 0; }
          .foot button { height: 26px; padding: 0 12px; font: 600 11.5px system-ui, sans-serif; }
          .replace { background: #3fa34d; color: #fff; }
          .replace:hover { background: #4bb85a; }
          .open { background: rgba(255,255,255,.12); }
          svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
          .x svg { width: 11px; height: 11px; }
          .again svg { width: 13px; height: 13px; }
          .spin { width: 13px; height: 13px; margin: 0 6px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25);
            border-top-color: #fff; animation: spin .8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
          [hidden] { display: none !important; }
        </style>
        <div class="card" role="dialog" aria-label="Polish text">
          <div class="head">
            <div class="titles"><div class="main">Polish text</div><div class="sub"></div></div>
            <div class="btns">
              <a class="by" href="https://console.groq.com/keys" target="_blank" rel="noopener" title="Groq polishes the text, with your own free key">Powered by
                <svg class="groq" viewBox="0 0 1280 468" role="img" aria-label="groq"><path d="M306 305V163A125 125 0 1 0 180 288H232M306 305A125 125 0 0 1 91.6 393.4M408 312V163A125 125 0 0 1 595.5 54.7M1226 450V163A125 125 0 1 0 1102 288H1155"/><circle cx="762" cy="163" r="125"/></svg></a>
              <i class="spin" hidden></i>
              <button class="again" title="Ask again">${svg("again")}</button>
              <button class="copy" title="Copy the text">${svg("copy")}</button>
              <button class="x" title="Close (Esc)">${svg("close")}</button>
            </div>
          </div>
          <div class="modes">
            <div class="seg mode" role="group" aria-label="Mode">
              <button data-mode="rephrase" title="Rewrite it to read better, in the tone picked">rephrase</button>
              <button data-mode="fix" title="Fix spelling, grammar and punctuation only">fix</button>
            </div>
            <div class="seg tone" role="group" aria-label="Tone">
              ${TONES.map((t) => `<button data-tone="${t}">${t}</button>`).join("")}
            </div>
          </div>
          <textarea spellcheck="false" aria-label="Rewritten text" hidden></textarea>
          <div class="foot">
            <span class="why"></span>
            <button class="open" hidden>open settings</button>
            <button class="replace" title="Put this in place of the text on the page">replace</button>
          </div>
        </div>`;
      root.querySelector(".x").onclick = close;
      root.querySelector(".copy").onclick = copy;
      root.querySelector(".again").onclick = () => { delete results[key()]; run(); };
      root.querySelector(".replace").onclick = replace;
      root.querySelector(".open").onclick = () => chrome.runtime.sendMessage({ type: "openSettings", section: "rewrite" }).catch(() => {});
      for (const b of root.querySelectorAll(".mode button")) b.onclick = () => b.dataset.mode !== mode && pick(b.dataset.mode, tone);
      for (const b of root.querySelectorAll(".tone button")) b.onclick = () => b.dataset.tone !== tone && pick("rephrase", b.dataset.tone);
      root.querySelector("textarea").addEventListener("input", fit);
      drag(root.querySelector(".head"));
      root.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
      addEventListener("keydown", onKey, true);
      addEventListener("resize", place);
    }
    document.documentElement.append(host);
    place();
    observer?.disconnect();
    observer = new MutationObserver(place);
    observer.observe(document.documentElement, { childList: true });
  }

  // Esc on the page closes it too, unless you're typing in a field of the page.
  function onKey(e) {
    if (e.key !== "Escape" || !host?.isConnected) return;
    const a = document.activeElement;
    if (a && a !== host && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    close();
  }

  // In the corner, the zoom controls (imgzoom.js) sit there too: stand just above them.
  // Dragged, where it was left, kept on screen (a smaller window pulls it back in).
  function place() {
    if (!host) return;
    if (spot) {
      const card = root.querySelector(".card").getBoundingClientRect();
      host.style.right = `${Math.round(Math.max(GAP, Math.min(spot.right, innerWidth - card.width - GAP)))}px`;
      host.style.bottom = `${Math.round(Math.max(GAP, Math.min(spot.bottom, innerHeight - Math.min(card.height, 160) - GAP)))}px`;
    } else {
      const zoom = document.querySelector("[data-eg-zoom]");
      host.style.right = `${GAP}px`;
      host.style.bottom = `${zoom?.isConnected ? GAP + zoom.getBoundingClientRect().height + 8 : GAP}px`;
    }
    fit();
  }

  // Dragged by the top bar (not its buttons or link); a double-click puts it back in the corner.
  function drag(bar) {
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, a")) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("dragging");
      const from = { x: e.clientX, y: e.clientY, right: parseFloat(host.style.right), bottom: parseFloat(host.style.bottom) };
      const move = (m) => {
        spot = { right: from.right - (m.clientX - from.x), bottom: from.bottom - (m.clientY - from.y) };
        place();
      };
      const up = () => {
        bar.classList.remove("dragging");
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        bar.removeEventListener("pointercancel", up);
        if (spot) {
          spot = { right: parseFloat(host.style.right), bottom: parseFloat(host.style.bottom) };
          chrome.storage.local.set({ rewriteCardSpot: spot }).catch(() => {});
        }
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
      bar.addEventListener("pointercancel", up);
    });
    bar.addEventListener("dblclick", (e) => {
      if (e.target.closest("button, a")) return;
      spot = null;
      chrome.storage.local.remove("rewriteCardSpot").catch(() => {});
      place();
    });
  }

  // The text box shows all of the text when it fits on screen, else as much as fits, and scrolls.
  function fit() {
    const ta = root?.querySelector("textarea");
    if (!ta || ta.hidden) return;
    const card = root.querySelector(".card");
    const others = card.getBoundingClientRect().height - ta.getBoundingClientRect().height;
    const room = innerHeight - parseFloat(host.style.bottom || GAP) - GAP - others;
    ta.style.height = "0px";
    ta.style.height = `${Math.max(48, Math.min(ta.scrollHeight + 2, room))}px`;
  }

  function close() {
    observer?.disconnect();
    removeEventListener("keydown", onKey, true);
    removeEventListener("resize", place);
    host?.remove();
    host = null; root = null;
    source = ""; results = {}; busy = false; seq++; // drops the text (the listener stays for the next one)
  }

  // A mode or tone picked on the card is the one it opens with next time.
  function pick(m, t) {
    if (busy) return;
    mode = m; tone = t;
    chrome.runtime.sendMessage({ type: "updateSettings", patch: { rewrite: { mode, tone } } }).catch(() => {});
    run();
  }

  async function run() {
    if (busy || !source) return;
    const k = key(), mine = ++seq;
    if (results[k]) return render(results[k]);
    busy = true;
    render({ working: true });
    let res;
    try {
      const r = await chrome.runtime.sendMessage({ type: "rewriteRun", text: source, mode, tone });
      if (!r?.ok) throw new Error(r?.error || "Something went wrong");
      res = { text: r.text };
    } catch (err) {
      res = { error: err.message };
    }
    if (mine !== seq) return;
    if (res.text) results[k] = res;
    busy = false;
    if (root) render(res);
  }

  function render({ working, text, error }) {
    const sub = root.querySelector(".sub"), ta = root.querySelector("textarea"), why = root.querySelector(".why");
    root.querySelector(".spin").hidden = !working;
    root.querySelector(".copy").hidden = root.querySelector(".again").hidden = !!working || !text;
    root.querySelector(".replace").hidden = !!working || !text || !editable;
    root.querySelector(".open").hidden = !/settings/.test(error || "");
    for (const b of root.querySelectorAll(".mode button")) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
      b.disabled = !!working || !source;
    }
    for (const b of root.querySelectorAll(".tone button")) {
      b.setAttribute("aria-pressed", String(b.dataset.tone === tone));
      b.disabled = !!working;
    }
    // Kept in place on fix (only not shown), so a narrow card where the tones wrap keeps its height.
    root.querySelector(".tone").style.visibility = mode === "rephrase" ? "" : "hidden";
    root.querySelector(".modes").hidden = !source;
    sub.classList.toggle("err", !!error);
    why.textContent = "";
    // While it's working the text box stays at its size, dimmed (the text being polished the
    // first time, the last result after), so the card doesn't shrink and grow back.
    ta.classList.toggle("dim", !!working);
    ta.readOnly = !!working;
    if (working) {
      sub.textContent = mode === "fix" ? "Fixing…" : `Rephrasing · ${tone}…`;
      if (ta.hidden || !ta.value) { ta.hidden = false; ta.value = source; fit(); }
      return;
    }
    if (error) {
      sub.textContent = error;
      ta.hidden = true;
      return;
    }
    const same = text.trim() === source.trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    sub.textContent = same ? "Nothing to change" : `${mode === "fix" ? "Fixed" : `Rephrased · ${tone}`} · ${words} word${words === 1 ? "" : "s"}`;
    ta.hidden = false;
    ta.value = text;
    ta.scrollTop = 0;
    why.textContent = editable ? "You can edit it here first." : "Selected text on the page can't be replaced; copy it instead.";
    fit();
  }

  async function copy() {
    const btn = root.querySelector(".copy");
    const text = root.querySelector("textarea").value;
    try { await navigator.clipboard.writeText(text); } catch {
      await chrome.runtime.sendMessage({ type: "rewriteCopy", text }).catch(() => {});
    }
    btn.innerHTML = svg("check");
    setTimeout(() => btn.isConnected && (btn.innerHTML = svg("copy")), 1200);
  }

  async function replace() {
    const text = root.querySelector("textarea").value;
    const r = await chrome.runtime.sendMessage({ type: "rewriteReplace", frameId, text }).catch(() => null);
    if (r?.ok && r.done) return close();
    // The field is gone or its text changed meanwhile: copied instead, to paste by hand.
    const c = await chrome.runtime.sendMessage({ type: "rewriteCopy", text }).catch(() => null);
    if (!root) return;
    const sub = root.querySelector(".sub");
    sub.classList.add("err");
    sub.textContent = `The text on the page changed, so it wasn't replaced${c?.copied ? "; it's copied, paste it there" : ""}`;
  }
})();
