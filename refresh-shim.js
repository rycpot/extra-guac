// Auto-refresh page shim (page world). Registered on every page while an auto-refresh
// with a keyword runs; it only acts in tabs marked for watching (sessionStorage).
//
// Chrome doesn't run requestAnimationFrame or IntersectionObserver callbacks in tabs
// that aren't in front, so pages that render through them stay empty in a background
// tab and the keyword is never there until you bring the tab forward. Here the page is
// told it's visible, and while the tab is really hidden those callbacks run from a timer
// and from the watcher's once-a-second pulse (timers in hidden tabs fire at most once a
// second, and Chrome slows long chains of them further after a few minutes).
(() => {
  try { if (!sessionStorage.getItem("__ttRefreshWatch")) return; } catch { return; }
  if (window.__ttRefreshShim) return;
  window.__ttRefreshShim = true;

  let on = true;
  const proto = Document.prototype;
  const realHidden = Object.getOwnPropertyDescriptor(proto, "hidden").get;
  const hidden = () => realHidden.call(document);
  const report = (err) => (self.reportError ? reportError(err) : console.error(err));

  for (const [name, fake] of [["visibilityState", "visible"], ["webkitVisibilityState", "visible"], ["hidden", false], ["webkitHidden", false]]) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d?.get) continue;
    Object.defineProperty(proto, name, { ...d, get() { return on ? fake : d.get.call(this); } });
  }
  addEventListener("visibilitychange", (e) => { if (on) e.stopImmediatePropagation(); }, true);

  // ---- requestAnimationFrame: the real one, or a timer while hidden, whichever comes first.
  const raf = requestAnimationFrame.bind(window), caf = cancelAnimationFrame.bind(window);
  const frames = new Map(); // our id -> { cb, real }
  let nextId = 1e9, timer = 0;

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    if (!on) return raf(cb);
    const id = nextId++;
    frames.set(id, { cb, real: raf((t) => runFrame(id, t)) });
    schedule();
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const f = frames.get(id);
    if (!f) return caf(id);
    caf(f.real);
    frames.delete(id);
  };

  function runFrame(id, t) {
    const f = frames.get(id);
    if (!f) return;
    frames.delete(id);
    caf(f.real);
    try { f.cb.call(window, t); } catch (err) { report(err); }
  }

  function schedule() {
    if (on && !timer && hidden()) timer = setTimeout(flush, 16);
  }

  function flush() {
    timer = 0;
    if (!on || !hidden()) return;
    const t = performance.now();
    for (const id of [...frames.keys()]) runFrame(id, t); // frames requested now wait for the next flush
    intersections();
  }

  // ---- IntersectionObserver: while hidden, work out each target's state from its box
  // (layout still works in hidden tabs) and report changes like the real one would.
  const observers = new Set();
  const RealIO = window.IntersectionObserver;
  if (RealIO) {
    window.IntersectionObserver = class IntersectionObserver extends RealIO {
      constructor(cb, options) {
        super(cb, options);
        this.__tt = { cb, last: new Map() };
        observers.add(this);
      }
      observe(target) {
        super.observe(target);
        if (!this.__tt.last.has(target)) this.__tt.last.set(target, null);
        schedule();
      }
      unobserve(target) {
        super.unobserve(target);
        this.__tt.last.delete(target);
      }
      disconnect() {
        super.disconnect();
        this.__tt.last.clear();
      }
    };
  }

  // rootMargin as the real observer normalizes it ("10px 0px 10px 0px"; % of the root).
  function margins(io, rb) {
    const parts = (io.rootMargin || "0px").split(/\s+/);
    const px = (v, size) => (v.endsWith("%") ? (parseFloat(v) / 100) * size : parseFloat(v) || 0);
    const [t, r = t, b = t, l = r] = parts;
    return { top: px(t, rb.height), right: px(r, rb.width), bottom: px(b, rb.height), left: px(l, rb.width) };
  }

  function intersections() {
    for (const io of observers) {
      const { cb, last } = io.__tt;
      if (!last.size) continue;
      const root = io.root?.nodeType === 1 ? io.root : null;
      const base = root ? root.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
      const m = margins(io, base);
      const rb = new DOMRect(base.left - m.left, base.top - m.top, base.width + m.left + m.right, base.height + m.top + m.bottom);
      const entries = [];
      for (const [target, was] of last) {
        const r = target.getBoundingClientRect();
        const x1 = Math.max(r.left, rb.left), y1 = Math.max(r.top, rb.top);
        const x2 = Math.min(r.right, rb.right), y2 = Math.min(r.bottom, rb.bottom);
        const isIntersecting = target.isConnected && target.getClientRects().length > 0 && x2 >= x1 && y2 >= y1;
        if (was === isIntersecting) continue;
        last.set(target, isIntersecting);
        const area = r.width * r.height;
        entries.push({
          target,
          time: performance.now(),
          isIntersecting,
          intersectionRatio: isIntersecting ? (area ? ((x2 - x1) * (y2 - y1)) / area : 1) : 0,
          boundingClientRect: r,
          intersectionRect: isIntersecting ? new DOMRect(x1, y1, x2 - x1, y2 - y1) : new DOMRect(),
          rootBounds: rb,
        });
      }
      if (entries.length) try { cb.call(io, entries, io); } catch (err) { report(err); }
    }
  }

  document.addEventListener("tt-refresh-pulse", () => { if (on && hidden()) flush(); });
  document.addEventListener("tt-refresh-off", () => { on = false; }); // pending frames still run once visible
})();
