// Runs in the page itself, before the site's own scripts, on sites that go through a proxy (the
// proxy's own sites and Session Switch profiles', registered by bg-proxy.js). WebRTC could show the
// site the user's own address past the proxy, so it is turned off on these pages only: creating a connection fails with an error that says why. Frames the page makes
// itself (a blank iframe, a window it opens) are covered as soon as the page reaches into them.
// What it puts in place passes for the browser's own functions and leaves no names on the page (the
// same way as warp.js, which can run next to it).
(() => {
  "use strict";
  const message = "WebRTC is turned off on this site while it goes through a proxy.";
  const names = ["RTCPeerConnection", "webkitRTCPeerConnection"];
  // Answers this key when asked for the source of Symbol.for(KEY): how a window already guarded is told.
  const KEY = "eg-webrtc-guard";

  // Errors passing through what's put in place lose the steps inside it (the extension's address).
  const here = /(chrome-extension:\/\/[^/]+\/)/.exec((new Error().stack || "").split("\n").slice(1).join("\n"));
  const mine = here?.[1] || null;
  const guarded = (run) => {
    try {
      return run();
    } catch (err) {
      try {
        if (mine && err && typeof err === "object" && typeof err.stack === "string") err.stack = err.stack.split("\n").filter((line) => !line.includes(mine)).join("\n");
      } catch {
        // a frozen error
      }
      throw err;
    }
  };

  // Shapes what's put in a window so it reads as the browser's own, one set per window.
  const made = new WeakMap();
  function native(win) {
    if (made.has(win)) return made.get(win);
    const shown = new WeakMap();
    const desc = Object.getOwnPropertyDescriptor(win.Function.prototype, "toString");
    const before = desc.value;
    const key = Symbol.for(KEY);
    const toString = { toString(...args) {
      if (this === key) return KEY;
      return shown.has(this) ? `function ${shown.get(this)}() { [native code] }` : guarded(() => Reflect.apply(before, this, args));
    } }.toString;
    shown.set(toString, "toString");
    Object.defineProperty(win.Function.prototype, "toString", { ...desc, value: toString });
    const show = (fn, name) => (shown.set(fn, name), fn);
    made.set(win, show);
    return show;
  }
  const done = (win) => {
    try {
      return Reflect.apply(win.Function.prototype.toString, Symbol.for(KEY), []) === KEY;
    } catch {
      return false;
    }
  };

  function guard(win) {
    try {
      if (!win || done(win)) return;
      const show = native(win);
      const refuse = () => guarded(() => { throw new win.DOMException(message, "NotAllowedError"); });
      const blocked = new Map(); // one for each original (the webkit name is the same function)
      for (const name of names) {
        const desc = Object.getOwnPropertyDescriptor(win, name);
        const original = desc?.value;
        if (typeof original !== "function") continue;
        if (!blocked.has(original)) {
          blocked.set(original, show(new Proxy(original, { apply: refuse, construct: refuse }), original.name));
          // Its prototype's constructor too, or that would still be the browser's own.
          const ctor = Object.getOwnPropertyDescriptor(original.prototype, "constructor");
          if (ctor) Object.defineProperty(original.prototype, "constructor", { ...ctor, value: blocked.get(original) });
        }
        Object.defineProperty(win, name, { ...desc, value: blocked.get(original) });
      }
    } catch {
      // A window of another origin: it isn't the page's to use.
    }
  }

  guard(window);

  // A frame the page adds starts with an untouched window of the same origin. Every way of adding
  // nodes guards the page's new frames as soon as it returns, and so do the ways of reaching a frame.
  // Only frames not seen before are looked at (a frame keeps its window when it's navigated, and
  // its new page gets this script by itself).
  const show = native(window);
  const seen = [];
  const guardFrames = () => {
    for (let i = 0; i < window.length; i++) {
      const win = window[i];
      if (win !== seen[i]) guard((seen[i] = win));
    }
    seen.length = window.length;
  };
  // proto's name (its function, getter or setter: kind) becomes one that calls make's.
  const swap = (proto, name, kind, make) => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    const fn = desc?.[kind];
    if (typeof fn !== "function") return;
    const impl = make(fn);
    const label = kind === "value" ? name : `${kind} ${name}`;
    const holder = kind === "value" ? { [name](...args) { return guarded(() => Reflect.apply(impl, this, args)); } }
      : kind === "get" ? { get [name]() { return guarded(() => Reflect.apply(impl, this, [])); } }
        : { set [name](v) { guarded(() => Reflect.apply(impl, this, [v])); } };
    const wrapped = kind === "value" ? holder[name] : Object.getOwnPropertyDescriptor(holder, name)[kind];
    Object.defineProperty(wrapped, "length", { ...Object.getOwnPropertyDescriptor(fn, "length") });
    Object.defineProperty(proto, name, { ...desc, [kind]: show(wrapped, label) });
  };
  const after = (proto, name, kind = "value") => swap(proto, name, kind, (fn) => function (...args) {
    const result = fn.apply(this, args);
    guardFrames();
    return result;
  });
  for (const name of ["appendChild", "insertBefore", "replaceChild"]) after(Node.prototype, name);
  for (const name of ["append", "prepend", "after", "before", "replaceWith", "replaceChildren", "insertAdjacentElement", "insertAdjacentHTML"]) after(Element.prototype, name);
  for (const name of ["innerHTML", "outerHTML"]) after(Element.prototype, name, "set");
  for (const name of ["write", "writeln"]) after(Document.prototype, name);
  for (const type of [HTMLIFrameElement, HTMLFrameElement, HTMLObjectElement]) {
    for (const prop of ["contentWindow", "contentDocument"]) {
      swap(type.prototype, prop, "get", (get) => function () {
        const value = get.call(this);
        guard(prop === "contentWindow" ? value : value?.defaultView);
        return value;
      });
    }
  }
  swap(window, "open", "value", (open) => function (...args) {
    const win = open.apply(this, args);
    guard(win);
    return win;
  });
})();
