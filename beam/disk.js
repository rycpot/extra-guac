// Beam's disk writer: received files go into the browser's private storage for this site (the
// origin private file system) piece by piece, so a large file never has to fit in memory. Only a
// worker can write to a file there at any offset (createSyncAccessHandle), so this runs as one.
// Each request carries a number; the answer says whether it worked.
const open = new Map() // file key -> its access handle

async function folder(dir) {
  const root = await navigator.storage.getDirectory()
  return (await root.getDirectoryHandle('beam', {create: true})).getDirectoryHandle(dir, {create: true})
}

async function run(m) {
  switch (m.op) {
    case 'open': {
      const f = await (await folder(m.dir)).getFileHandle(m.key, {create: true})
      const h = await f.createSyncAccessHandle()
      h.truncate(0)
      open.set(m.key, h)
      return
    }
    case 'write': {
      const h = open.get(m.key)
      if (!h) throw new Error('not open')
      const data = new Uint8Array(m.data)
      for (let at = m.at, o = 0; o < data.length;) {
        const n = h.write(data.subarray(o), {at})
        if (!(n > 0)) throw new Error('nothing written')
        o += n; at += n
      }
      return
    }
    case 'close': {
      const h = open.get(m.key)
      open.delete(m.key)
      if (h) { h.flush(); h.close() }
      return
    }
    case 'remove': {
      const h = open.get(m.key)
      open.delete(m.key)
      if (h) { try { h.close() } catch (e) {} }
      try { await (await folder(m.dir)).removeEntry(m.key) } catch (e) {}
      return
    }
  }
}

self.onmessage = async ({data: m}) => {
  try { await run(m); self.postMessage({n: m.n, ok: true}) }
  catch (e) { self.postMessage({n: m.n, ok: false, quota: e && e.name === 'QuotaExceededError', error: String((e && e.message) || e)}) }
}
