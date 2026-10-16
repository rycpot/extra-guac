// Reads a font file's real names from its OpenType "name" table, for "what font?".
// Handles TTF/OTF (sfnt), font collections, WOFF (zlib) and WOFF2 (Brotli, decoded
// with the bundled decoder, loaded only when a WOFF2 file shows up).
// Also finds which @font-face file a CSS family uses. Runs in the offscreen document.

const NAME_IDS = { 1: "family", 2: "subfamily", 4: "fullName", 5: "version", 6: "postscript",
  8: "manufacturer", 9: "designer", 16: "typoFamily", 17: "typoSubfamily" };

// Table tags WOFF2 encodes as a 6-bit index (spec order).
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca",
  "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE",
  "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx",
  "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

const tagAt = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

// Returns { format, names: { family, subfamily, … } } for a font file's bytes.
export async function readFontNames(buffer) {
  const v = new DataView(buffer);
  const sig = tagAt(v, 0);
  if (sig === "wOF2") return { format: "WOFF2", names: parseName(await woff2NameTable(buffer)) };
  if (sig === "wOFF") return { format: "WOFF", names: parseName(await woffNameTable(buffer)) };
  if (sig === "ttcf") return { format: "TTC", names: parseName(sfntNameTable(buffer, v.getUint32(12))) };
  if (sig === "OTTO") return { format: "OTF", names: parseName(sfntNameTable(buffer, 0)) };
  if (v.getUint32(0) === 0x00010000 || sig === "true") return { format: "TTF", names: parseName(sfntNameTable(buffer, 0)) };
  throw new Error("Not a font file this tool can read");
}

function sfntNameTable(buffer, start) {
  const v = new DataView(buffer);
  const n = v.getUint16(start + 4);
  for (let i = 0; i < n; i++) {
    const rec = start + 12 + i * 16;
    if (tagAt(v, rec) === "name") return new DataView(buffer, v.getUint32(rec + 8), v.getUint32(rec + 12));
  }
  throw new Error("Font has no name table");
}

async function woffNameTable(buffer) {
  const v = new DataView(buffer);
  const n = v.getUint16(12);
  for (let i = 0; i < n; i++) {
    const rec = 44 + i * 20;
    if (tagAt(v, rec) !== "name") continue;
    const offset = v.getUint32(rec + 4), compLength = v.getUint32(rec + 8), origLength = v.getUint32(rec + 12);
    const bytes = new Uint8Array(buffer, offset, compLength);
    if (compLength >= origLength) return new DataView(bytes.slice().buffer);
    const inflated = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
    return new DataView(inflated);
  }
  throw new Error("Font has no name table");
}

let brotli = null;

async function woff2NameTable(buffer) {
  const v = new DataView(buffer);
  const numTables = v.getUint16(12);
  let p = 48;
  const readBase128 = () => {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      const b = v.getUint8(p++);
      result = result * 128 + (b & 0x7f);
      if (!(b & 0x80)) return result;
    }
    throw new Error("Bad WOFF2 table directory");
  };
  // The decompressed stream holds the tables back to back, in directory order.
  let nameOffset = -1, nameLength = 0, offset = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = v.getUint8(p++);
    let tag;
    if ((flags & 0x3f) === 63) { tag = tagAt(v, p); p += 4; } else tag = WOFF2_TAGS[flags & 0x3f];
    const origLength = readBase128();
    const version = flags >> 6;
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    const length = transformed ? readBase128() : origLength;
    if (tag === "name") { nameOffset = offset; nameLength = length; }
    offset += length;
  }
  if (nameOffset < 0) throw new Error("Font has no name table");
  if (tagAt(v, 4) === "ttcf") {
    // Collection directory: version, numFonts, then per font a table count and indices.
    p += 4;
    const numFonts = readUShortBase128();
    for (let f = 0; f < numFonts; f++) {
      const count = readUShortBase128();
      p += 4; // flavor
      for (let t = 0; t < count; t++) readUShortBase128();
    }
  }
  function readUShortBase128() {
    const code = v.getUint8(p++);
    if (code === 253) { const x = v.getUint16(p); p += 2; return x; }
    if (code === 254) return v.getUint8(p++) + 253 * 2;
    if (code === 255) return v.getUint8(p++) + 253;
    return code;
  }
  brotli ??= (await import("./vendor/brotli-decode.js")).BrotliDecode;
  const compressed = new Int8Array(buffer, p, v.getUint32(20));
  const out = brotli(compressed);
  return new DataView(out.buffer, out.byteOffset + nameOffset, nameLength);
}

// Prefers English Windows names, then Mac names, then any Unicode entry.
function parseName(t) {
  const count = t.getUint16(2), strings = t.getUint16(4);
  const best = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = t.getUint16(r), encoding = t.getUint16(r + 2), lang = t.getUint16(r + 4);
    const key = NAME_IDS[t.getUint16(r + 6)];
    if (!key) continue;
    const len = t.getUint16(r + 8), off = strings + t.getUint16(r + 10);
    if (off + len > t.byteLength) continue;
    const rank = platform === 3 && (lang & 0xff) === 0x09 ? 3 : platform === 3 ? 2 : platform === 1 && lang === 0 ? 1 : 0;
    if (best[key] && best[key].rank >= rank) continue;
    let text = "";
    if (platform === 1 && encoding === 0) {
      for (let k = 0; k < len; k++) text += String.fromCharCode(t.getUint8(off + k));
    } else {
      for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(t.getUint16(off + k));
    }
    best[key] = { rank, text: text.replace(/\0/g, "").trim() };
  }
  return Object.fromEntries(Object.entries(best).map(([k, x]) => [k, x.text]));
}

// ---- Finding the file behind a CSS family ----

const unquote = (s) => s.trim().replace(/^["']|["']$/g, "").trim();

// @font-face blocks from stylesheet text: [{ family, weight, style, src: [{ url, format }] }].
export function parseFontFaces(css, baseUrl) {
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/gi)) {
    const body = m[1];
    const prop = (name) => body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"))?.[1]?.trim();
    const family = prop("font-family");
    const src = prop("src");
    if (!family || !src) continue;
    faces.push({
      family: unquote(family),
      weight: prop("font-weight") || "400",
      style: prop("font-style") || "normal",
      src: [...src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)(?:\s*format\(\s*['"]?([\w-]+)['"]?\s*\))?/gi)].map((u) => ({
        url: resolve(u[2], baseUrl),
        format: (u[3] || "").toLowerCase(),
      })).filter((s) => s.url),
    });
  }
  return faces;
}

function resolve(url, base) {
  if (url.startsWith("data:")) return url;
  try { return new URL(url, base).href; } catch { return null; }
}

// Weight matching: an exact or range match beats the nearest weight.
function weightDistance(faceWeight, want) {
  const [lo, hi = lo] = String(faceWeight).split(/\s+/).map((w) => (w === "normal" ? 400 : w === "bold" ? 700 : +w));
  if (want >= lo && want <= hi) return 0;
  return Math.min(Math.abs(want - lo), Math.abs(want - hi));
}

export function pickFace(faces, family, weight, style) {
  const fam = family.toLowerCase();
  const candidates = faces.filter((f) => f.family.toLowerCase() === fam && f.src.length);
  candidates.sort((a, b) =>
    (a.style.startsWith(style) ? 0 : 1000) + weightDistance(a.weight, weight) -
    ((b.style.startsWith(style) ? 0 : 1000) + weightDistance(b.weight, weight)));
  return candidates[0] || null;
}

// What the offscreen document runs for a picked element.
// inline: [{ css, base }] from stylesheets the page could read; sheets: hrefs it couldn't.
export async function inspect({ family, weight, style, inline = [], sheets = [] }) {
  const all = inline.flatMap((i) => parseFontFaces(i.css, i.base));
  for (const href of sheets) {
    try {
      const css = await (await fetch(href)).text();
      all.push(...parseFontFaces(css, href));
      // One level of @import, which font services often use.
      for (const m of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/gi)) {
        const url = resolve(m[1], href);
        if (url) all.push(...parseFontFaces(await (await fetch(url)).text(), url));
      }
    } catch {}
  }
  const face = pickFace(all, family, weight, style);
  if (!face) return { file: null };
  const preferred = face.src.find((s) => /woff2|woff|truetype|opentype/.test(s.format)) || face.src[0];
  const res = await fetch(preferred.url);
  if (!res.ok) return { file: { url: preferred.url, error: `HTTP ${res.status}` } };
  const buffer = await res.arrayBuffer();
  try {
    const { format, names } = await readFontNames(buffer);
    return { file: { url: preferred.url, format, bytes: buffer.byteLength }, names };
  } catch (e) {
    return { file: { url: preferred.url, bytes: buffer.byteLength, error: e.message } };
  }
}
