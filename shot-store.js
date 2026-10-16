// Screenshot history: the last 10 screenshots, kept so they can be copied, uploaded or edited
// again later (popup → ⤢ next to screenshot). Used by the background worker (bg-capture.js
// records each shot, bg-backup.js backs them up) and the popup.
//
// The list is storage.local "shotHistory" (newest first, in backups):
//   [{ id, at, name, label, source, parts, names, w, h, bytes }] (names: each part's file name)
// The images themselves are in IndexedDB ("eg-shots", store "shots"):
//   { id, items: [{ name, blob }], thumb } — thumb is a small WebP for the list.
(() => {
  const KEEP = 10;
  const THUMB_W = 760; // twice the popup's width, for sharp thumbnails on high-density screens

  let dbOpen = null;
  function db() {
    dbOpen ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("eg-shots", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("shots", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => { dbOpen = null; throw err; });
    return dbOpen;
  }
  async function store(mode, fn) {
    const tx = (await db()).transaction("shots", mode);
    const req = fn(tx.objectStore("shots"));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  const get = (id) => store("readonly", (s) => s.get(id));
  const put = (rec) => store("readwrite", (s) => s.put(rec));
  const remove = (id) => store("readwrite", (s) => s.delete(id));
  const keys = () => store("readonly", (s) => s.getAllKeys());

  const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ext = (type) => (type === "image/jpeg" ? "jpg" : (type || "image/png").split("/")[1]);

  // A WebP of the shot's top, THUMB_W wide at most and no taller than it is wide × 1.25
  // (a full page would otherwise make a very long thumbnail).
  async function thumbOf(blob) {
    const bmp = await createImageBitmap(blob);
    const w = Math.min(THUMB_W, bmp.width), k = w / bmp.width;
    const h = Math.max(1, Math.min(Math.round(bmp.height * k), Math.round(w * 1.25)));
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d").drawImage(bmp, 0, 0, w / k, h / k, 0, 0, w, h);
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return { thumb: await c.convertToBlob({ type: "image/webp", quality: 0.8 }), ...size };
  }

  // A new shot ({ items: [{ name, dataUrl | blob }], label, source }) → its list entry.
  async function record({ items, label, source }, id = newId(), at = Date.now()) {
    const parts = await Promise.all(items.map(async (it) => ({ name: it.name, blob: it.blob || (await (await fetch(it.dataUrl)).blob()) })));
    const { thumb, w, h } = await thumbOf(parts[0].blob);
    await put({ id, items: parts, thumb });
    return {
      id, at, label: label || "", source: source || "",
      name: (items[0]?.name || "screenshot").split("/").pop(),
      parts: parts.length, names: parts.map((p) => p.name), w, h, bytes: parts.reduce((n, p) => n + p.blob.size, 0),
    };
  }

  const toDataUrl = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  // The shot as the screenshot code passes it around: [{ name, dataUrl }].
  async function itemsOf(id) {
    const rec = await get(id);
    if (!rec) throw new Error("That screenshot isn't on this computer any more");
    return Promise.all(rec.items.map(async (it) => ({ name: it.name, dataUrl: await toDataUrl(it.blob) })));
  }

  globalThis.SHOTS = { KEEP, get, put, remove, keys, newId, ext, record, itemsOf, thumbOf };
})();
