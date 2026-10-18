// Runs in the page itself, before the site's own scripts, on sites that go through a proxy, last of
// the scripts bg-proxy.js registers there: a place file (warp/, the proxy's time zone, a spot on the
// map and the language) and one script per thing matched to it (warp-time.js, warp-location.js,
// warp-language.js), each leaving a patch. This applies them to the page, and to every frame the
// page makes itself (a blank iframe, a window it opens) as soon as the page reaches into it, then
// takes away what they left. What it puts in place passes for the browser's own functions.
(() => {
  const warp = window.__egWarp;
  delete window.__egWarp;
  if (!warp?.patches?.length) return;
  const { patches, ...place } = warp;

  // A window that has them (a frame of this page whose own copy ran first, or the other way round).
  const MARK = "__egWarped";
  // This computer and its network never go through a proxy (as in bg-proxy.js's routing), even when
  // every site does: their pages are left alone.
  const local = (host) => !!host && (!host.includes(".") || host === "localhost" || host.includes(":") || host.startsWith("[")
    || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
  if (local(location.hostname)) return;

  function apply(win) {
    try {
      if (!win || Object.prototype.hasOwnProperty.call(win, MARK)) return;
      Object.defineProperty(win, MARK, { value: true });
      if (local(win.location.hostname)) return;
    } catch {
      return; // a window of another origin: it isn't the page's to use
    }
    const h = helpers(win);
    for (const patch of patches) {
      try {
        patch(win, place, h);
      } catch {
        // A browser without that part: the rest still apply.
      }
    }
  }

  // Ways of replacing the window's functions so they still read as built in, one set per window.
  const made = new WeakMap();
  function helpers(win) {
    if (!made.has(win)) made.set(win, makeHelpers(win));
    return made.get(win);
  }
  function makeHelpers(win) {
    const names = new WeakMap();
    const fnToString = win.Function.prototype.toString;
    const toString = { toString() { return names.has(this) ? `function ${names.get(this)}() { [native code] }` : fnToString.call(this); } }.toString;
    names.set(toString, "toString");
    Object.defineProperty(win.Function.prototype, "toString", { ...Object.getOwnPropertyDescriptor(win.Function.prototype, "toString"), value: toString });

    const shape = (fn, like, name) => {
      Object.defineProperty(fn, "length", { value: like.length });
      names.set(fn, name);
      return fn;
    };
    return {
      // obj[name] becomes make(the original).
      method(obj, name, make) {
        const desc = Object.getOwnPropertyDescriptor(obj, name);
        if (typeof desc?.value !== "function") return;
        const impl = make(desc.value);
        const fn = { [name](...args) { return impl.apply(this, args); } }[name];
        Object.defineProperty(obj, name, { ...desc, value: shape(fn, desc.value, name) });
      },
      // obj's getter for name becomes get (with the original's this).
      getter(obj, name, get) {
        const desc = Object.getOwnPropertyDescriptor(obj, name);
        if (typeof desc?.get !== "function") return;
        const fn = Object.getOwnPropertyDescriptor({ get [name]() { return get.call(this, desc.get); } }, name).get;
        Object.defineProperty(obj, name, { ...desc, get: shape(fn, desc.get, `get ${name}`) });
      },
      // obj's setter for name becomes set (with the original's this).
      setter(obj, name, set) {
        const desc = Object.getOwnPropertyDescriptor(obj, name);
        if (typeof desc?.set !== "function") return;
        const fn = Object.getOwnPropertyDescriptor({ set [name](v) { set.call(this, desc.set, v); } }, name).set;
        Object.defineProperty(obj, name, { ...desc, set: shape(fn, desc.set, `set ${name}`) });
      },
      // The constructor owner[name] becomes one that calls construct(the original, its arguments,
      // new.target), with the same prototype and static functions.
      ctor(owner, name, construct) {
        const desc = Object.getOwnPropertyDescriptor(owner, name);
        const orig = desc?.value;
        if (typeof orig !== "function") return;
        const fn = { [name]: function (...args) { return construct(orig, args, new.target); } }[name];
        Object.defineProperty(fn, "prototype", { value: orig.prototype, writable: false });
        for (const key of Reflect.ownKeys(orig)) {
          if (!["length", "name", "prototype"].includes(key)) Object.defineProperty(fn, key, Object.getOwnPropertyDescriptor(orig, key));
        }
        Object.defineProperty(orig.prototype, "constructor", { ...Object.getOwnPropertyDescriptor(orig.prototype, "constructor"), value: fn });
        Object.defineProperty(owner, name, { ...desc, value: shape(fn, orig, name) });
      },
    };
  }

  apply(window);

  // A frame the page adds starts with an untouched window of the same origin. Every way of adding
  // nodes covers the page's new frames as soon as it returns, and so do the ways of reaching a frame.
  // Only frames not seen before are looked at (a frame keeps its window when it's navigated, and
  // its new page gets these scripts by itself).
  const h = helpers(window);
  const seen = [];
  const frames = () => {
    for (let i = 0; i < window.length; i++) {
      const win = window[i];
      if (win !== seen[i]) apply((seen[i] = win));
    }
    seen.length = window.length;
  };
  const after = (proto, name) => h.method(proto, name, (fn) => function (...args) {
    const result = fn.apply(this, args);
    frames();
    return result;
  });
  for (const name of ["appendChild", "insertBefore", "replaceChild"]) after(Node.prototype, name);
  for (const name of ["append", "prepend", "after", "before", "replaceWith", "replaceChildren", "insertAdjacentElement", "insertAdjacentHTML"]) after(Element.prototype, name);
  for (const name of ["write", "writeln"]) after(Document.prototype, name);
  for (const name of ["innerHTML", "outerHTML"]) {
    h.setter(Element.prototype, name, function (set, value) {
      set.call(this, value);
      frames();
    });
  }
  for (const type of [HTMLIFrameElement, HTMLFrameElement, HTMLObjectElement]) {
    h.getter(type.prototype, "contentWindow", function (get) {
      const win = get.call(this);
      apply(win);
      return win;
    });
    h.getter(type.prototype, "contentDocument", function (get) {
      const doc = get.call(this);
      apply(doc?.defaultView);
      return doc;
    });
  }
  h.method(window, "open", (open) => function (...args) {
    const win = open.apply(this, args);
    apply(win);
    return win;
  });
})();
