// Remove elements: registered (bg-remove.js) at document_start for every site that has
// removed elements, top frame only. The page is kept fully transparent until the
// background has added the site's hiding rules as a browser-level stylesheet (which the
// page can't override or take out), so removed elements never show, not even for a
// frame on a slow load. Fails open: the page is revealed if the background never answers.
(() => {
  if (window.__ttRemoveApply) return;
  window.__ttRemoveApply = true;

  const root = document.documentElement;
  const prev = root.style.getPropertyValue("opacity");
  const prevPriority = root.style.getPropertyPriority("opacity");
  root.style.setProperty("opacity", "0", "important");

  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (prev) root.style.setProperty("opacity", prev, prevPriority);
    else root.style.removeProperty("opacity");
    if (!root.getAttribute("style")) root.removeAttribute("style");
  };

  chrome.runtime.sendMessage({ type: "removeAttach" }).then(reveal, reveal);
  setTimeout(reveal, 4000); // the worker should answer within milliseconds; never leave a blank page
})();
