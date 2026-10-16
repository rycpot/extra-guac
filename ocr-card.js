// Text from image card, at the bottom-right of the page like the screenshot card (and
// just above the image zoom controls when they're showing), but solid, so the text reads
// easily. Injected by bg-ocr.js with the selected area as an image; asks the background
// worker to read it ("ocrRead"), which also copies the text. The text box grows to show as
// much as fits on screen at once, then scrolls; it can be edited before copying again.
// At the bottom, "not right?" switches engine and reads the same image again (each
// engine's result is kept, so switching back is instant). Stays until ✕ or Esc.
(() => {
  if (window.__egOcrCard) return;
  window.__egOcrCard = true;

  const GAP = 16;
  const ENGINE = { 2: "fast, detects the language", 3: "better on handwriting, tables & 200+ languages; smaller monthly quota" };
  let host = null, root = null, observer = null;
  let image = "", engine = "2", results = {}, busy = false;

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "egOcrCard" || !chrome.runtime?.id) return;
    reply(true);
    image = msg.image || "";
    engine = msg.engine === "3" ? "3" : "2";
    results = {};
    show();
    if (msg.error) return render({ error: msg.error });
    read(engine);
  });

  const ICON = {
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
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
          .card { display: flex; flex-direction: column; gap: 8px; width: min(540px, calc(100vw - 32px)); padding: 10px 10px 9px;
            box-sizing: border-box; border-radius: 12px; background: rgb(22,22,22); color: #fff;
            font: 500 11.5px/1.35 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.45);
            outline: 1px solid rgba(255,255,255,.28); outline-offset: -1px; } /* the edge keeps it visible on dark pages */
          .head { display: flex; align-items: center; gap: 8px; }
          .titles { flex: 1; min-width: 0; display: grid; gap: 1px; }
          .main, .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .sub { color: rgba(255,255,255,.6); font-weight: 400; font-size: 10.5px; }
          .err { color: #ff8a80; white-space: normal; }
          .btns { display: flex; align-items: center; gap: 2px; flex: none; }
          /* "Powered by OCR.space", with its wordmark: a square with a notch, then OCR bold and Space light. */
          .by { display: flex; align-items: center; gap: 5px; margin-right: 6px; color: rgba(255,255,255,.55); font-weight: 400;
            font-size: 10.5px; text-decoration: none; white-space: nowrap; }
          /* In OCR.space's own navy, as its logo is. */
          .mark { display: flex; align-items: center; gap: 0; color: #053664; font-size: 12px; line-height: 1.2; letter-spacing: -.01em; }
          .by:hover .word { text-decoration: underline; }
          .word { font-weight: 300; white-space: nowrap; } .word b { font-weight: 800; }
          .by svg { width: 11px; height: 11px; margin-right: 3px; fill: currentColor; stroke: none; }
          button { all: unset; height: 26px; min-width: 26px; display: grid; place-items: center; border-radius: 8px; cursor: pointer; }
          button:hover { background: rgba(255,255,255,.12); }
          button[disabled] { opacity: .4; cursor: default; background: none; }
          textarea { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 8px 10px; border-radius: 8px;
            background: rgba(255,255,255,.06); color: rgba(255,255,255,.95); font: 400 13px/1.5 system-ui, sans-serif;
            white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; resize: none; cursor: text; }
          textarea:focus { outline: 1px solid rgba(255,255,255,.3); }
          textarea[hidden] { display: none; }
          .foot { display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,.6); font-weight: 400; font-size: 10.5px; }
          .foot .why { flex: 1; min-width: 0; }
          .seg { display: flex; flex: none; padding: 2px; border-radius: 8px; background: rgba(255,255,255,.08); }
          .seg button { height: 22px; padding: 0 9px; border-radius: 6px; font: 500 11px system-ui, sans-serif; color: rgba(255,255,255,.7); }
          .seg button[aria-pressed=true] { background: rgba(255,255,255,.18); color: #fff; cursor: default; }
          svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
          .x svg { width: 11px; height: 11px; }
          .spin { width: 13px; height: 13px; margin: 0 6px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25);
            border-top-color: #fff; animation: spin .8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
          [hidden] { display: none !important; }
        </style>
        <div class="card" role="dialog" aria-label="Text from image">
          <div class="head">
            <div class="titles"><div class="main">Text from image</div><div class="sub"></div></div>
            <div class="btns">
              <a class="by" href="https://ocr.space/ocrapi/freekey" target="_blank" rel="noopener" title="OCR.space reads the text: get a free key of your own">Powered by
                <span class="mark"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M5 0h5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V5h3a2 2 0 0 0 2-2Z"/></svg><span class="word"><b>OCR</b>Space</span></span></a>
              <i class="spin" hidden></i>
              <button class="copy" title="Copy the text">${svg("copy")}</button>
              <button class="x" title="Close (Esc)">${svg("close")}</button>
            </div>
          </div>
          <textarea spellcheck="false" aria-label="Text read from the image" hidden></textarea>
          <div class="foot">
            <span class="why"></span>
            <div class="seg" role="group" aria-label="OCR engine">
              <button data-engine="2" title="Engine 2: ${ENGINE[2]}">engine 2</button>
              <button data-engine="3" title="Engine 3: ${ENGINE[3]}">engine 3</button>
            </div>
          </div>
        </div>`;
      root.querySelector(".x").onclick = close;
      root.querySelector(".copy").onclick = copy;
      for (const b of root.querySelectorAll(".seg button")) b.onclick = () => b.dataset.engine !== engine && read(b.dataset.engine);
      root.querySelector("textarea").addEventListener("input", fit);
      root.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
      addEventListener("keydown", onKey, true);
      addEventListener("resize", fit);
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

  // The zoom controls (imgzoom.js) sit in the same corner: stand just above them.
  function place() {
    const zoom = document.querySelector("[data-eg-zoom]");
    host.style.bottom = `${zoom?.isConnected ? GAP + zoom.getBoundingClientRect().height + 8 : GAP}px`;
    fit();
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
    removeEventListener("resize", fit);
    host?.remove();
    host = null; root = null;
    image = ""; results = {}; // drops the image (the listener stays for the next one)
  }

  async function read(which) {
    if (busy || !image) return;
    engine = which;
    if (results[which]) return render(results[which]);
    busy = true;
    render({ reading: true });
    let res;
    try {
      const r = await chrome.runtime.sendMessage({ type: "ocrRead", image, engine: which });
      if (!r?.ok) throw new Error(r?.error || "Something went wrong");
      res = { text: r.text, copied: r.copied };
      results[which] = res;
    } catch (err) {
      res = { error: err.message };
    }
    busy = false;
    if (root) render(res);
  }

  function render({ reading, text, copied, error }) {
    const sub = root.querySelector(".sub"), ta = root.querySelector("textarea"), why = root.querySelector(".why");
    const other = engine === "2" ? "3" : "2";
    root.querySelector(".spin").hidden = !reading;
    root.querySelector(".copy").hidden = !!reading || !text;
    for (const b of root.querySelectorAll(".seg button")) {
      b.setAttribute("aria-pressed", String(b.dataset.engine === engine));
      b.disabled = !!reading || !image;
    }
    root.querySelector(".seg").hidden = !image;
    sub.classList.toggle("err", !!error);
    if (reading) {
      sub.textContent = `Reading with engine ${engine}…`;
      why.textContent = "";
      ta.hidden = true;
      return;
    }
    if (error) {
      // Setup problems (key, PRO server, limits) aren't helped by the other engine.
      const setup = /settings|key|limit|reach|too big/i.test(error);
      sub.textContent = error;
      ta.hidden = true;
      root.querySelector(".seg").hidden = !image || setup;
      why.textContent = image && !setup ? `Try engine ${other}?` : "";
      return;
    }
    if (!text) {
      sub.textContent = `No text found · engine ${engine}`;
      ta.hidden = true;
      why.textContent = `Not right? Read it again with engine ${other}:`;
      return;
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    sub.textContent = `${copied ? "Copied" : "Couldn't copy, use the copy button"} · engine ${engine} · ${words} word${words === 1 ? "" : "s"}`;
    ta.hidden = false;
    ta.value = text;
    ta.scrollTop = 0;
    why.textContent = results[other] ? `Compare with engine ${other}:` : `Not right? Read it again with engine ${other}:`;
    why.title = `Engine ${other}: ${ENGINE[other]}`;
    fit();
  }

  async function copy() {
    const btn = root.querySelector(".copy");
    const text = root.querySelector("textarea").value;
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = root.querySelector("textarea");
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.setSelectionRange(0, 0);
    }
    btn.innerHTML = svg("check");
    root.querySelector(".sub").textContent = root.querySelector(".sub").textContent.replace(/^Couldn't copy, use the copy button|^Copied/, "Copied");
    setTimeout(() => btn.isConnected && (btn.innerHTML = svg("copy")), 1200);
  }
})();
