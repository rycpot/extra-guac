// Session Switch: IndexedDB snapshots, for sites whose profiles include IndexedDB. Injected into a
// page of the site, or into a parked blank page of it, which reaches the same databases. Values are turned into a
// JSON-safe form so they can be kept in extension storage.
self.__sessionSwitchIdb ??= (() => {
  const VIEWS = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView,
  };

  const toBase64 = (bytes) => {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const fromBase64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

  // A stored value in JSON-safe form. Blobs can only be read asynchronously, so they are collected in
  // blobs and filled in afterwards.
  function encode(value, blobs, seen) {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value) && !Object.is(value, -0)) return value;
      return { $t: "num", v: Object.is(value, -0) ? "-0" : String(value) };
    }
    if (value === undefined) return { $t: "undef" };
    if (typeof value === "bigint") return { $t: "bigint", v: String(value) };
    if (typeof value !== "object") throw new Error(`it holds a ${typeof value}`);
    if (seen.has(value)) throw new Error("a value in it refers to itself");
    seen.add(value);
    try {
      if (value instanceof Date) return { $t: "date", v: String(value.getTime()) };
      if (value instanceof RegExp) return { $t: "regexp", s: value.source, f: value.flags };
      if (value instanceof ArrayBuffer) return { $t: "buffer", v: toBase64(new Uint8Array(value)) };
      if (ArrayBuffer.isView(value)) {
        return { $t: "view", k: value.constructor.name, v: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
      }
      if (value instanceof Blob) {
        const out = { $t: "blob", type: value.type, v: "" };
        if (value instanceof File) Object.assign(out, { name: value.name, modified: value.lastModified });
        blobs.push([out, value]);
        return out;
      }
      if (value instanceof Map) return { $t: "map", v: [...value].map(([k, x]) => [encode(k, blobs, seen), encode(x, blobs, seen)]) };
      if (value instanceof Set) return { $t: "set", v: [...value].map((x) => encode(x, blobs, seen)) };
      if (Array.isArray(value)) return Array.from(value, (x) => encode(x, blobs, seen));
      if (value instanceof Error) return { $t: "error", n: value.name, m: value.message };
      if (value instanceof Boolean || value instanceof Number || value instanceof String) {
        return { $t: "boxed", v: encode(value.valueOf(), blobs, seen) };
      }
      const proto = Object.getPrototypeOf(value);
      // Anything else (a CryptoKey, say) can't be copied out of the browser.
      if (proto !== Object.prototype && proto !== null) throw new Error(`it holds a ${value.constructor?.name || "value"} that can't be copied`);
      const out = {};
      for (const key of Object.keys(value)) out[key] = encode(value[key], blobs, seen);
      return "$t" in out ? { $t: "object", v: out } : out;
    } finally {
      seen.delete(value);
    }
  }

  function decode(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(decode);
    const plain = (source) => {
      const out = {};
      for (const key of Object.keys(source)) out[key] = decode(source[key]);
      return out;
    };
    if (!("$t" in value)) return plain(value);
    switch (value.$t) {
      case "num": return Number(value.v);
      case "undef": return undefined;
      case "bigint": return BigInt(value.v);
      case "date": return new Date(Number(value.v));
      case "regexp": return new RegExp(value.s, value.f);
      case "buffer": return fromBase64(value.v).buffer;
      case "view": {
        const buffer = fromBase64(value.v).buffer;
        const View = VIEWS[value.k] || Uint8Array;
        return View === DataView ? new DataView(buffer) : new View(buffer);
      }
      case "blob": {
        const bytes = fromBase64(value.v);
        return "name" in value ? new File([bytes], value.name, { type: value.type, lastModified: value.modified }) : new Blob([bytes], { type: value.type });
      }
      case "map": return new Map(value.v.map(([k, x]) => [decode(k), decode(x)]));
      case "set": return new Set(value.v.map(decode));
      case "error": return Object.assign(new Error(value.m), { name: value.n });
      case "boxed": return Object(decode(value.v));
      case "object": return plain(value.v);
      default: return plain(value);
    }
  }

  const settle = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const finish = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("it was stopped"));
  });

  function open(name, version, create) {
    return new Promise((resolve, reject) => {
      const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
      request.onupgradeneeded = () => create?.(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("it is open somewhere else"));
    });
  }

  function remove(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      const timer = setTimeout(() => reject(new Error("it is still open somewhere else")), 5000);
      request.onsuccess = () => { clearTimeout(timer); resolve(); };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
  }

  async function dumpOne(db) {
    const names = [...db.objectStoreNames];
    const snap = { name: db.name, version: db.version, stores: [] };
    if (!names.length) return snap;
    const tx = db.transaction(names, "readonly");
    const finished = finish(tx);
    const reads = names.map((name) => {
      const store = tx.objectStore(name);
      const shape = {
        name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((i) => {
          const index = store.index(i);
          return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }),
      };
      return Promise.all([settle(store.getAllKeys()), settle(store.getAll())]).then(([keys, values]) => ({ shape, keys, values }));
    });
    const results = await Promise.all(reads);
    await finished;
    const blobs = [];
    for (const { shape, keys, values } of results) {
      snap.stores.push({ ...shape, keys: keys.map((k) => encode(k, blobs, new Set())), values: values.map((v) => encode(v, blobs, new Set())) });
    }
    for (const [out, blob] of blobs) out.v = toBase64(new Uint8Array(await blob.arrayBuffer()));
    return snap;
  }

  // Every database of the origin, up to maxBytes in all.
  async function dump(maxBytes) {
    const dbs = [], problems = [];
    let total = 0;
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      let db;
      try {
        db = await open(name);
        const snap = await dumpOne(db);
        const size = JSON.stringify(snap).length;
        if (total + size > maxBytes) {
          problems.push(`IndexedDB "${name}" was left out: it is too large (${Math.ceil(size / 1e6)} MB)`);
          continue;
        }
        total += size;
        dbs.push(snap);
      } catch (e) {
        problems.push(`IndexedDB "${name}" was left out: ${e.message}`);
      } finally {
        db?.close();
      }
    }
    return { dbs, problems };
  }

  // Deletes the origin's databases and puts the saved ones in their place. A database that can't be
  // deleted is left as it is rather than filled with the other profile's records.
  async function load(dbs) {
    const problems = [], stuck = new Set();
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      try {
        await remove(name);
      } catch (e) {
        stuck.add(name);
        problems.push(`IndexedDB "${name}" could not be cleared, so it was left as it was: ${e.message}`);
      }
    }
    for (const snap of dbs) {
      if (stuck.has(snap.name)) continue;
      let db;
      try {
        db = await open(snap.name, snap.version, (created) => {
          for (const s of snap.stores) {
            const options = s.keyPath === null ? { autoIncrement: s.autoIncrement } : { keyPath: s.keyPath, autoIncrement: s.autoIncrement };
            const store = created.createObjectStore(s.name, options);
            for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
          }
        });
        const names = snap.stores.map((s) => s.name);
        if (!names.length) continue;
        const tx = db.transaction(names, "readwrite");
        const finished = finish(tx);
        for (const s of snap.stores) {
          const store = tx.objectStore(s.name);
          s.values.forEach((v, i) => (s.keyPath === null ? store.put(decode(v), decode(s.keys[i])) : store.put(decode(v))));
        }
        await finished;
      } catch (e) {
        problems.push(`IndexedDB "${snap.name}" could not be restored: ${e.message}`);
      } finally {
        db?.close();
      }
    }
    return { problems };
  }

  return { dump, load };
})();
