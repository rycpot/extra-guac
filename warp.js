// Runs in the page itself, before the site's own scripts, on sites that go through a proxy, last of
// the scripts bg-proxy.js registers there: a place file (warp/, the proxy's time zone, a spot on the
// map and the language) and one script per thing matched to it (warp-time.js, warp-location.js,
// warp-language.js), each leaving a patch. This applies them to the page, to every frame the page
// makes itself (a blank iframe, a window it opens) as soon as the page reaches into it, and to the
// workers it starts, then takes away what they left. What it puts in place passes for the browser's
// own functions, and leaves no names of its own on the page.
(() => {
  const warp = window.__egWarp;
  delete window.__egWarp;
  if (!warp?.patches?.length) return;
  const { patches, ...place } = warp;

  const realm = warpRealm(self, place, patches, null);
  if (!realm) return; // this computer's own pages

  // A frame the page adds starts with an untouched window of the same origin. Every way of adding
  // nodes covers the page's new frames as soon as it returns, and so do the ways of reaching a frame.
  // Only frames not seen before are looked at (a frame keeps its window when it's navigated, and
  // its new page gets these scripts by itself).
  const { h, apply } = realm;
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

  // Everything below also runs on its own at the start of each worker the page starts (its source
  // goes into the worker, with the patches'), so it uses nothing from outside itself. self: the
  // page's window or the worker's global; base: in a worker, the address of the page's own worker
  // script, which the worker is made to see as its own. Returns { h, apply } for the page, null on
  // this computer's own pages.
  function warpRealm(self, place, patches, base) {
    "use strict";
    // Answers this key when asked for the source of Symbol.for(KEY): how a window already done is
    // told (a frame whose own copy ran first, or the other way round), with no name on the window.
    const KEY = "eg-warp-realm";
    const sourceOf = self.Function.prototype.toString;
    const source = (fn) => Reflect.apply(sourceOf, fn, []);
    // This, the patches and the place, as the start of a worker's script; the worker's address
    // follows. Written when the first worker starts (most pages start none).
    let kitText = null;
    const kit = () => (kitText ??= `(${source(warpRealm)})(self, ${JSON.stringify(place)}, [${patches.map(source).join(",\n")}], `);

    // This computer and its network never go through a proxy (as in bg-proxy.js's routing), even
    // when every site does: their pages are left alone.
    const local = (host) => !!host && (!host.includes(".") || host === "localhost" || host.includes(":") || host.startsWith("[")
      || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
    if (!base && local(self.location.hostname)) return null;

    // Errors passing through what's put in place lose the steps inside it, which would show where it
    // comes from: the extension's own address, or in a worker the address its start was given.
    const where = (new Error().stack || "").split("\n")[1] || "";
    const mine = /chrome-extension:\/\/[^/]+\//.exec(where)?.[0] || /(blob:\S+?):\d+:\d+\)?$/.exec(where)?.[1] || null;
    const scrub = (err) => {
      try {
        if (mine && err && typeof err === "object" && typeof err.stack === "string" && err.stack.includes(mine)) {
          err.stack = err.stack.split("\n").filter((line) => !line.includes(mine)).join("\n");
        }
      } catch {
        // a frozen error: left as it is
      }
      return err;
    };
    const guarded = (run) => {
      try {
        return run();
      } catch (err) {
        throw scrub(err);
      }
    };

    // Ways of replacing a window's functions so they still read as built in, one set per window.
    const made = new WeakMap();
    function helpers(win) {
      if (!made.has(win)) made.set(win, makeHelpers(win));
      return made.get(win);
    }
    function makeHelpers(win) {
      const names = new WeakMap();
      const desc = Object.getOwnPropertyDescriptor(win.Function.prototype, "toString");
      const before = desc.value;
      const key = Symbol.for(KEY);
      const toString = { toString(...args) {
        if (this === key) return KEY;
        if (this === blobsKey) return blobsAllowed ? "yes" : "no";
        return names.has(this) ? `function ${names.get(this)}() { [native code] }` : guarded(() => Reflect.apply(before, this, args));
      } }.toString;
      names.set(toString, "toString");
      Object.defineProperty(win.Function.prototype, "toString", { ...desc, value: toString });

      const shape = (fn, like, name) => {
        Object.defineProperty(fn, "length", { ...Object.getOwnPropertyDescriptor(like, "length") });
        Object.defineProperty(fn, "name", { ...Object.getOwnPropertyDescriptor(like, "name") });
        names.set(fn, name);
        return fn;
      };
      return {
        // obj[name] becomes make(the original).
        method(obj, name, make) {
          const d = Object.getOwnPropertyDescriptor(obj, name);
          if (typeof d?.value !== "function") return;
          const impl = make(d.value);
          const fn = { [name](...args) { return guarded(() => Reflect.apply(impl, this, args)); } }[name];
          Object.defineProperty(obj, name, { ...d, value: shape(fn, d.value, name) });
        },
        // obj's getter for name becomes get (with the original's this).
        getter(obj, name, get) {
          const d = Object.getOwnPropertyDescriptor(obj, name);
          if (typeof d?.get !== "function") return;
          const fn = Object.getOwnPropertyDescriptor({ get [name]() { return guarded(() => get.call(this, d.get)); } }, name).get;
          Object.defineProperty(obj, name, { ...d, get: shape(fn, d.get, `get ${name}`) });
        },
        // obj's setter for name becomes set (with the original's this).
        setter(obj, name, set) {
          const d = Object.getOwnPropertyDescriptor(obj, name);
          if (typeof d?.set !== "function") return;
          const fn = Object.getOwnPropertyDescriptor({ set [name](v) { guarded(() => set.call(this, d.set, v)); } }, name).set;
          Object.defineProperty(obj, name, { ...d, set: shape(fn, d.set, `set ${name}`) });
        },
        // The constructor owner[name] becomes one that calls construct(the original, its arguments,
        // new.target), undefined when called without new. It wraps the original, so it has the same
        // prototype, static functions and everything else a function has.
        ctor(owner, name, construct) {
          const d = Object.getOwnPropertyDescriptor(owner, name);
          const orig = d?.value;
          if (typeof orig !== "function") return;
          const fn = new Proxy(orig, {
            apply: (target, that, args) => guarded(() => construct(orig, args, undefined)),
            construct: (target, args, newTarget) => guarded(() => construct(orig, args, newTarget)),
          });
          names.set(fn, name);
          Object.defineProperty(orig.prototype, "constructor", { ...Object.getOwnPropertyDescriptor(orig.prototype, "constructor"), value: fn });
          Object.defineProperty(owner, name, { ...d, value: fn });
        },
      };
    }

    // A blank frame's rules are its page's: its own copy of this asks the page's (under this key)
    // whether blob workers are allowed, instead of trying one and starting its first workers as
    // they are meanwhile.
    const blobsKey = Symbol.for(`${KEY}:blobs`);
    let blobsAllowed = !!base, probed = false;
    if (!base && self.location.protocol === "about:") {
      try {
        if (Reflect.apply(self.parent.Function.prototype.toString, blobsKey, []) === "yes") blobsAllowed = probed = true;
      } catch {
        // no page above, or one of another origin
      }
    }
    const done = (win) => {
      try {
        return Reflect.apply(win.Function.prototype.toString, Symbol.for(KEY), []) === KEY;
      } catch {
        return false;
      }
    };
    function apply(win) {
      try {
        if (!win || done(win) || (!base && local(win.location.hostname))) return;
      } catch {
        return; // a window of another origin: it isn't the page's to use
      }
      const h = helpers(win);
      let reach = false; // a patch that workers must have too (time zone, language)
      for (const patch of patches) {
        try {
          if (patch(win, place, h) === "workers") reach = true;
        } catch {
          // A browser without that part: the rest still apply (and workers get what this one did).
          reach = true;
        }
      }
      if (!reach) return;
      try {
        workers(win, h);
      } catch {
        // no workers here
      }
    }

    // Workers start through a small script of their own: this, then the page's worker script. The
    // page's script is the same file (or the same blob) as before, so it runs as it would have; only
    // the worker's own address is a blob's, and it's shown the page's instead (located below). Left
    // alone, so they run as before: workers from another origin or a data: address (which can't
    // start from a blob), blobs made outside this window, and pages whose rules forbid blob workers.
    // A shared worker is shared by the window's own scripts, but no longer with the site's other
    // tabs or frames (each window's blob is its own). Service workers are the site's own script
    // installed in the browser, which nothing here can reach: they keep the computer's own.
    function workers(win, h) {
      const Native = win.Worker;
      if (typeof Native !== "function" || typeof win.Blob !== "function") return;
      const { createObjectURL: create, revokeObjectURL: revoke } = win.URL;
      const later = win.setTimeout.bind(win);
      const tag = (obj) => Object.prototype.toString.call(obj);
      // The blobs behind the page's own blob: addresses, so their workers can be started though the
      // page may let go of the address as soon as the worker is made.
      const blobs = new Map();
      h.method(win.URL, "createObjectURL", (fn) => function (obj) {
        const url = fn.call(this, obj);
        if (tag(obj) === "[object Blob]" || tag(obj) === "[object File]") blobs.set(url, obj);
        return url;
      });
      h.method(win.URL, "revokeObjectURL", (fn) => function (url) {
        blobs.delete(`${url}`);
        return fn.call(this, url);
      });
      let refused = false; // a page whose rules turned a blob worker away

      // keep: for a shared worker, whose start is looked for again (and a module's imports reread).
      const blobURL = (text, keep = false) => {
        const url = create(new win.Blob([text], { type: "text/javascript" }));
        if (!keep) later(() => revoke(url), 60e3); // the worker has long since read it
        return url;
      };
      // Whether the page's rules let a blob start a worker, which it only says by turning one away
      // later: a small one is tried, and until it has started the page's workers run as they are.
      // On a tab's own page that's at once; in a frame (often an ad, never starting a worker) only
      // when it starts its first. A worker's own rules are its page's, so there it's known already.
      const probe = () => {
        if (probed || base) return;
        probed = true;
        try {
          // It loads a second (empty) blob the way a worker's start loads the page's script: a
          // page can allow blob workers but not scripts loaded into them (its script rules, as on
          // many challenge pages), and then a wrapped worker would never run.
          const test = Reflect.construct(Native, [blobURL(`importScripts(${JSON.stringify(blobURL(""))});postMessage(0)`)]);
          test.onmessage = () => {
            blobsAllowed = true;
            test.terminate();
          };
          test.onerror = () => test.terminate();
        } catch {
          // turned away at once
        }
      };
      if (win === win.top) probe();
      // A shared worker's start is kept for the page's lifetime, so each new one for the same script
      // finds the one already running, as it would have.
      const kept = new Map();
      const start = (args, shared) => {
        const [script, options] = args;
        const module = options !== null && typeof options === "object" && options.type === "module";
        const own = new win.URL(`${script}`, base || win.document.baseURI);
        const origin = win.origin; // the window's or worker's own (a blank frame's address has none)
        const keep = `${module}|${own.href}`;
        // (Before the blob check: a running shared worker is found by its address even after the
        // page lets go of it, as it would have been.)
        if (shared && kept.has(keep)) return [kept.get(keep), ...args.slice(1)];
        let from;
        if (own.protocol === "blob:") {
          const blob = blobs.get(own.href);
          if (!blob) return null;
          from = create(blob); // the page's blob, under an address of ours that stays until it's read
          if (!shared) later(() => revoke(from), 60e3);
        } else if (/^https?:$/.test(own.protocol) && own.origin === origin && origin !== "null") {
          from = own.href;
        } else {
          return null;
        }
        const head = `${kit()}${JSON.stringify(own.href)});\n`;
        const text = module ? `import ${JSON.stringify(blobURL(head, shared))};\nimport ${JSON.stringify(from)};\n` : `${head}importScripts(${JSON.stringify(from)});\n`;
        const url = blobURL(text, shared);
        if (shared) kept.set(keep, url);
        return [url, ...args.slice(1)];
      };
      const wrap = (name, shared) => h.ctor(win, name, (orig, args, target) => {
        if (!target) return Reflect.apply(orig, undefined, args); // throws, as it must be called with new
        probe();
        let wrapped = null;
        if (blobsAllowed && !refused) {
          try {
            wrapped = start(args, shared);
          } catch {
            wrapped = null;
          }
        }
        if (wrapped) {
          try {
            return Reflect.construct(orig, wrapped, target);
          } catch (err) {
            // Turned away (or a page that only takes trusted addresses): started as it is, which
            // gives the page the browser's own answer.
            if (err?.name === "SecurityError") refused = true;
          }
        }
        return Reflect.construct(orig, args, target);
      });
      wrap("Worker", false);
      if (typeof win.SharedWorker === "function") wrap("SharedWorker", true);
    }

    // In a worker started above: its address, and what's found from it, are those of the page's
    // own script, as they would have been.
    function located(win, h) {
      const url = new win.URL(base);
      const resolve = (input) => {
        if (typeof input !== "string" && !(input instanceof win.URL)) return input;
        try {
          return new win.URL(`${input}`, base).href;
        } catch {
          return input;
        }
      };
      const Loc = win.WorkerLocation?.prototype;
      if (Loc) {
        for (const key of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
          h.getter(Loc, key, () => url[key]);
        }
        h.method(Loc, "toString", () => () => url.href);
      }
      // The global's functions live along its prototypes.
      const owner = (name) => {
        for (let o = win; o; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, name)) return o;
        return null;
      };
      if (owner("fetch")) h.method(owner("fetch"), "fetch", (fn) => function (input, ...rest) { return fn.call(this, resolve(input), ...rest); });
      if (owner("importScripts")) h.method(owner("importScripts"), "importScripts", (fn) => function (...urls) { return fn.apply(this, urls.map(resolve)); });
      if (win.XMLHttpRequest) h.method(win.XMLHttpRequest.prototype, "open", (fn) => function (method, input, ...rest) { return fn.call(this, method, resolve(input), ...rest); });
      for (const name of ["Request", "WebSocket", "EventSource", "SharedWorker"]) {
        h.ctor(win, name, (orig, [input, ...rest], target) =>
          (target ? Reflect.construct(orig, [resolve(input), ...rest], target) : Reflect.apply(orig, undefined, [input, ...rest])));
      }
    }

    if (base) {
      apply(self);
      try {
        located(self, helpers(self));
      } catch {
        // an older browser: relative addresses then count from the blob
      }
      return null;
    }
    apply(self);
    return { h: helpers(self), apply };
  }
})();
