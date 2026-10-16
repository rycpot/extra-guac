// Scratch pads: what the pad page (scratch.js) and the background worker (bg-backup.js)
// both need. Six pads, each one storage.local key ("pad1" … "pad6") holding
//   { mode: "rich" | "plain", title, body, lang, langManual, wrap, preview, web, alt, updatedAt, writer }
// where body is HTML for a rich pad and text for a plain one, and alt { mode, body, text }
// is the version from before the last rich/plain switch. preview: a Markdown or HTML pad
// shown rendered (web: its HTML preview may load from the web). Older Markdown pads carry md
// (their body is Markdown text even when mode is "rich"). "padPrev1" … are the copies
// "Restore previous" puts back (kept on this device only, not in backups).
// Images in rich pads are stored apart from the text, in IndexedDB, named by their
// content (the first half of a SHA-256): the pad's HTML only says <img data-img="id">.
// Backups upload each image once, as its own file (see bg-backup.js).
(() => {
  const PAD_COUNT = 6;
  const IMG_LIMIT = 25 * 1024 * 1024; // all images in all pads (and their previous copies)
  const IMG_EDGE = 1600; // images are scaled down so their longest side is at most this
  const IMG_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/;
  const TEXT_MAX = 5 * 1024 * 1024; // bigger files don't open in a pad

  const padKey = (n) => `pad${n}`;
  const prevKey = (n) => `padPrev${n}`;
  const PAD_KEYS = Array.from({ length: PAD_COUNT }, (_, i) => padKey(i + 1));
  const PREV_KEYS = Array.from({ length: PAD_COUNT }, (_, i) => prevKey(i + 1));

  const IMG_ID = /^[0-9a-f]{32}$/;
  // The image ids a pad's HTML points at.
  // (Including the other version a pad keeps after switching rich/plain, see scratch.js.)
  function padRefs(pad) {
    const out = new Set();
    for (const v of [pad, pad?.alt]) {
      if (v?.mode !== "rich" || v.md || typeof v.body !== "string") continue;
      for (const m of v.body.matchAll(/data-img="([0-9a-f]{32})"/g)) out.add(m[1]);
    }
    return out;
  }
  // Rich: no text and no image. Plain: no characters at all.
  function padEmpty(pad) {
    if (!pad || typeof pad.body !== "string" || pad.body === "") return true;
    if (pad.mode === "plain" || pad.md) return false; // text (a Markdown pad keeps its Markdown)
    return !/<img\b/i.test(pad.body) && !pad.body.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "");
  }

  // Same content (mode and text; rich HTML compared without the spacing between tags), so
  // there's no point keeping one as the other's "Restore previous" copy.
  const squash = (pad) => (pad.mode === "rich" ? String(pad.body || "").replace(/>\s+</g, "><").replace(/\s+/g, " ").trim() : String(pad.body || ""));
  const sameContent = (a, b) => !!a && !!b && a.mode === b.mode && squash(a) === squash(b);

  // ---- Images (IndexedDB "eg-pads", store "images": { id, blob, type, size, at }) ----
  let dbOpen = null;
  function db() {
    dbOpen ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("eg-pads", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("images", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => { dbOpen = null; throw err; });
    return dbOpen;
  }
  async function store(mode, fn) {
    const tx = (await db()).transaction("images", mode);
    const req = fn(tx.objectStore("images"));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  const imgGet = (id) => store("readonly", (s) => s.get(id));
  const imgPut = (rec) => store("readwrite", (s) => s.put(rec));
  const imgDelete = (id) => store("readwrite", (s) => s.delete(id));
  const imgKeys = () => store("readonly", (s) => s.getAllKeys());

  async function imgId(blob) {
    const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(buf, 0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const imgExt = (type) => ({ "image/jpeg": "jpg", "image/svg+xml": "svg" })[type] || type.split("/")[1] || "png";

  globalThis.PADS = { PAD_COUNT, PAD_KEYS, PREV_KEYS, IMG_LIMIT, IMG_EDGE, IMG_TYPES, IMG_ID, TEXT_MAX, padKey, prevKey, padRefs, padEmpty, sameContent, imgGet, imgPut, imgDelete, imgKeys, imgId, imgExt };
})();
