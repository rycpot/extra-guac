// Userscripts: .zip files for export and import (the userscripts page → settings). Written uncompressed
// (scripts are small); read when stored or deflated, the two ways .zip files hold files.
(() => {
  const CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  // files: [{ name, text }] -> Blob
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); // UTF-8 names
      head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, crc, true);
      head.setUint32(18, data.length, true); head.setUint32(22, data.length, true); head.setUint16(26, name.length, true);
      parts.push(head, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(c, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  // Blob -> [{ name, text }] (folders skipped). Read from the central directory, so sizes are
  // known even when the local headers leave them out.
  async function unzip(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(buf.buffer);
    let end = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error("That isn't a .zip file");
    const count = view.getUint16(end + 10, true);
    let p = view.getUint32(end + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error("The .zip file is damaged");
      const method = view.getUint16(p + 10, true), csize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extra + comment;
      if (name.endsWith("/")) continue;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = buf.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      else continue;
      out.push({ name, text: dec.decode(data) });
    }
    return out;
  }

  globalThis.USZIP = { zip, unzip };
})();
