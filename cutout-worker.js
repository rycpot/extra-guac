// Remove background for the screenshot editor (shot-edit.js), off the page's own thread.
// Each part of the shot keeps what was worked out about it, so clicks of the clean-up tool
// don't start over. Messages ({ id, ... }; answered with the same id):
//   auto  { key, bitmap }             the background removed: { blob, quality } or { already }
//         (on a photo, the model, cutout-model.js, may take away part of what cutout.js kept:
//         then model: true; { note: "model" } is sent first, with the same id, when its file
//         has to be downloaded)
//   wand  { key, x, y, mode, bitmap? } a click (erase / restore): { blob }, { none }, or
//         { stale } when it hasn't seen this part (it's asked again with bitmap)
//         bitmap: the part as it shows now, when it's changed since this worker last saw it
//         (undo, redo, a blur): what's see-through in it is taken from there.
//   drop  { key }                     forget a part
importScripts("cutout.js", "cutout-net.js", "cutout-model.js");

const parts = new Map(); // key → { F, fg, base, out }

async function png(s) {
  const c = new OffscreenCanvas(s.F.fw, s.F.fh);
  c.getContext("2d").putImageData(s.out, 0, 0);
  return c.convertToBlob({ type: "image/png" });
}

self.onmessage = async ({ data: m }) => {
  const reply = (r) => self.postMessage({ id: m.id, ...r });
  try {
    if (m.type === "auto") {
      // base: the part's pixels before any cut (kept from an earlier one), for restoring.
      const base = parts.get(m.key)?.base || null;
      const F = EGCutout.prepare(m.bitmap, base), r = EGCutout.autoMask(F);
      if (r.already) return reply({ already: true });
      // On a photo, the model takes away what's well away from its subject (a shadow, a
      // haze), when it agrees with cutout.js's; the outline is still drawn by cutout.js.
      let model = false;
      if (F.feather) {
        const fg = await EGCutoutModel.subject(F, r.fg, () => self.postMessage({ id: m.id, note: "model" }), base ? null : m.bitmap);
        if (fg) { r.fg = fg; model = true; }
      }
      const s = { F, fg: r.fg, base: base || new Uint8ClampedArray(F.orig), out: new ImageData(new Uint8ClampedArray(F.orig), F.fw, F.fh) };
      EGCutout.render(F, s.fg, s.out);
      parts.set(m.key, s);
      return reply({ blob: await png(s), quality: r.quality, model });
    }
    if (m.type === "wand") {
      let s = parts.get(m.key);
      if (!s && !m.bitmap) return reply({ stale: true }); // not seen yet: it's sent again with the picture
      if (m.bitmap) {
        const base = s?.base || null;
        const F = EGCutout.prepare(m.bitmap, base);
        if (s?.F.T) F.T = s.F.T; // the picture's own limits, learned when its background was removed
        if (s?.F.feather) F.feather = s.F.feather; // and whether its outline follows its edges (a photo)
        s = { F, fg: EGCutout.fromAlpha(F), base: base || new Uint8ClampedArray(F.orig), out: new ImageData(new Uint8ClampedArray(F.orig), F.fw, F.fh) };
        EGCutout.render(s.F, s.fg, s.out);
        parts.set(m.key, s);
      }
      const idx = EGCutout.wand(s.F, s.fg, m.x, m.y, m.mode);
      if (!idx) return reply({ none: true });
      EGCutout.render(s.F, s.fg, s.out, EGCutout.boxOf(s.F, idx));
      return reply({ blob: await png(s) });
    }
    if (m.type === "drop") { parts.delete(m.key); return reply({}); }
  } catch (err) { reply({ error: err?.message || String(err) }); }
};
