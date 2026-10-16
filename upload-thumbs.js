// Thumbnails for the upload history (popup), kept on this computer only (IndexedDB
// "eg-upthumbs"; not in backups). Made from the image when it's uploaded; for an upload
// without one (made before thumbnails, restored from a backup, or sent to the host by its
// address), fetched once from its link. Needs shot-store.js (SHOTS.thumbOf).
//   { link, thumb: Blob | null, failed: true?, at }
(() => {
  let dbOpen = null;
  function db() {
    dbOpen ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("eg-upthumbs", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("thumbs", { keyPath: "link" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => { dbOpen = null; throw err; });
    return dbOpen;
  }
  async function store(mode, fn) {
    const tx = (await db()).transaction("thumbs", mode);
    const req = fn(tx.objectStore("thumbs"));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  const get = (link) => store("readonly", (s) => s.get(link));
  const put = (rec) => store("readwrite", (s) => s.put(rec));
  const remove = (link) => store("readwrite", (s) => s.delete(link));
  const keys = () => store("readonly", (s) => s.getAllKeys());
  const save = async (link, blob) => put({ link, thumb: (await SHOTS.thumbOf(blob)).thumb, at: Date.now() });

  globalThis.UPTHUMBS = { get, put, remove, keys, save };
})();
