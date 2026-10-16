// Clipboard history, in the page: notices copies and cuts (keyboard, right-click menu, or
// a site's own copy button) and hands the text to the background (bg-clip.js), which
// decides whether to keep it. Text from password fields is never sent.
(() => {
  if (window.__ttClip) return;
  window.__ttClip = true;

  let last = "", lastAt = 0;
  function send(text) {
    if (!chrome.runtime?.id) return; // cut off by an extension reload or update
    text = String(text ?? "");
    if (!text.trim()) return;
    const now = Date.now();
    if (text === last && now - lastAt < 1500) return; // one copy reported twice
    last = text;
    lastAt = now;
    chrome.runtime.sendMessage({ type: "clipAdd", text }).catch(() => {});
  }

  // The focused element, looking inside open shadow roots too.
  function focused() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  const secret = (el) => el instanceof HTMLInputElement && (el.type === "password" || /one-time-code|cc-number|cc-csc/.test(el.autocomplete || ""));

  function selectedText() {
    const el = focused();
    if (secret(el)) return null;
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.selectionStart != null && el.selectionEnd > el.selectionStart) {
      return el.value.slice(el.selectionStart, el.selectionEnd);
    }
    return String(getSelection() || "");
  }

  // The page's own copy handler may replace what's copied (clipboardData.setData), so the
  // text is read after it, as the event bubbles back up to window. If the page stops the
  // event before that, the selection noted on the way down is used instead.
  let pending = null;
  function down(e) {
    const text = selectedText();
    if (text === null) return; // password field
    const mine = (pending = { text });
    setTimeout(() => { if (pending === mine) { pending = null; if (!e.defaultPrevented) send(mine.text); } }, 0);
  }
  function up(e) {
    if (!pending) return;
    const noted = pending.text;
    pending = null;
    let set = "";
    try { set = e.clipboardData?.getData("text/plain") || ""; } catch {}
    if (set) send(set);
    else if (!e.defaultPrevented) send(noted); // prevented without new text: nothing was copied
  }
  for (const type of ["copy", "cut"]) {
    addEventListener(type, down, true);
    addEventListener(type, up, false);
  }

  // A site's copy button (navigator.clipboard.writeText), seen by clip-main.js in the page's
  // own world. Only within a moment of a real click or key press (events the page can't
  // fake), so a page can't quietly add entries to the history.
  let lastInput = 0;
  for (const type of ["pointerup", "keydown"]) addEventListener(type, (e) => { if (e.isTrusted) lastInput = Date.now(); }, true);
  addEventListener("__tt_clip", (e) => {
    if (typeof e.detail === "string" && Date.now() - lastInput < 1500 && navigator.userActivation?.isActive !== false) send(e.detail);
  });
})();
