// Dark mode inside frames embedded in a page (posts, comments, forms, ads): the page's
// filter already draws the whole frame inverted, so nothing is inverted here; only the
// frame's own pictures and videos are flipped back (dark-frame.css, while
// data-tt-dark-frame is set), the same way dark.css does it in the page. Whether the
// page is inverted is asked of the page's dark.js through the background, and it tells
// the frames when that changes.
(() => {
  if (window === top || window.__ttDarkFrame) return;
  window.__ttDarkFrame = true;
  const root = document.documentElement;

  // Frames the page flips back as a whole (video and map players, captchas; the iframe
  // list in dark.css and dark-frame.css), and every frame inside one, show their own
  // colors already.
  const WHOLE = /youtube\.|youtube-nocookie\.|vimeo\.|maps\.|\/maps|twitch\.|dailymotion\.|player\.|spotify\.|soundcloud\.|google\.com\/recaptcha|recaptcha\.net|hcaptcha\./;
  if (WHOLE.test(location.href) || [...(location.ancestorOrigins || [])].slice(0, -1).some((o) => WHOLE.test(o))) return;

  let pictures = null;
  function set(on) {
    if (!chrome.runtime?.id) return; // cut off by an extension update: leave the frame as it is
    root.toggleAttribute("data-tt-dark-frame", on);
    if (!on || pictures) return;
    pictures = window.__ttDarkPictures?.(); // dark-pictures.js
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => pictures?.start(), { once: true });
    else pictures?.start();
    addEventListener("load", () => pictures?.again(), { once: true });
  }
  let told = false; // a change heard of is newer than the answer to the first question
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "darkFrameState") { told = true; set(!!msg.inverted); }
  });
  chrome.runtime.sendMessage({ type: "darkFrame" }).then((r) => told || set(!!r?.inverted), () => {});
})();
