// Runs in the page itself, before the site's own scripts, on sites that go through a proxy (the
// proxy's own sites and Session Switch profiles', registered by bg-proxy.js). WebRTC could show the
// site the user's own address past the proxy, so it is turned off on these pages only: creating a connection fails with an error that says why. Frames the page makes
// itself (a blank iframe, a window it opens) are covered as soon as the page reaches into them.
(() => {
  const message = "WebRTC is turned off on this site while it goes through a proxy.";
  const names = ["RTCPeerConnection", "webkitRTCPeerConnection"];

  function guard(win) {
    try {
      if (!win || win.__sessionSwitchWebrtc) return;
      Object.defineProperty(win, "__sessionSwitchWebrtc", { value: true });
      for (const name of names) {
        const original = win[name];
        if (typeof original !== "function") continue;
        const blocked = function RTCPeerConnection() {
          throw new win.DOMException(message, "NotAllowedError");
        };
        blocked.prototype = original.prototype;
        Object.defineProperty(win, name, { value: blocked, writable: true, configurable: true });
      }
    } catch {
      // A window of another origin: it isn't the page's to use.
    }
  }

  guard(window);

  // A frame the page adds starts with an untouched window of the same origin. Every way of adding
  // nodes guards all the page's frames as soon as it returns, and so do the ways of reaching a frame.
  const guardFrames = () => {
    for (let i = 0; i < window.length; i++) guard(window[i]);
  };
  const after = (proto, name, kind = "value") => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    const fn = desc?.[kind];
    if (typeof fn !== "function") return;
    Object.defineProperty(proto, name, {
      ...desc,
      [kind]: function (...args) {
        const result = fn.apply(this, args);
        guardFrames();
        return result;
      },
    });
  };
  for (const name of ["appendChild", "insertBefore", "replaceChild"]) after(Node.prototype, name);
  for (const name of ["append", "prepend", "after", "before", "replaceWith", "replaceChildren", "insertAdjacentElement", "insertAdjacentHTML"]) after(Element.prototype, name);
  for (const name of ["innerHTML", "outerHTML"]) after(Element.prototype, name, "set");
  for (const name of ["write", "writeln"]) after(Document.prototype, name);
  for (const type of [HTMLIFrameElement, HTMLFrameElement, HTMLObjectElement]) {
    for (const prop of ["contentWindow", "contentDocument"]) {
      const desc = Object.getOwnPropertyDescriptor(type.prototype, prop);
      if (!desc?.get) continue;
      Object.defineProperty(type.prototype, prop, {
        ...desc,
        get() {
          const value = desc.get.call(this);
          guard(prop === "contentWindow" ? value : value?.defaultView);
          return value;
        },
      });
    }
  }
  const open = window.open;
  window.open = function (...args) {
    const win = open.apply(this, args);
    guard(win);
    return win;
  };
})();
