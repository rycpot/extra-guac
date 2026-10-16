// Clipboard history, in the page's own world: site "copy" buttons usually call
// navigator.clipboard.writeText, which fires no copy event. This passes the text on to
// clip.js (which checks it came from a real click) and then copies as normal.
(() => {
  if (window.__ttClipMain) return;
  window.__ttClipMain = true;
  const clip = navigator.clipboard;
  if (!clip?.writeText) return;
  const writeText = clip.writeText.bind(clip);
  clip.writeText = function (text) {
    try { window.dispatchEvent(new CustomEvent("__tt_clip", { detail: String(text) })); } catch {}
    return writeText(text);
  };
})();
