// Remove background's model for photos (used by cutout-worker.js): a small network that picks
// out a photo's subject, run on the graphics card (cutout-net.js). It only takes away: a piece
// cutout.js kept that's well away from the model's subject goes when it's a speck or looks like
// the background (a dark haze, a shadow), and only when the two mostly agree; a piece in the
// subject's own colors (a dim petal the model missed) stays. cutout.js still draws the outline. The
// model file (2.3 MB) is downloaded from Extra Guac's website the first time it's needed, then
// kept in the browser. Without a graphics card it can use, nothing is downloaded and the cutout
// is cutout.js's own, as it is for drawings, logos and screenshots.
//   const fg = await EGCutoutModel.subject(F, fg, onDownload, source)
//     F, fg: the picture and the subject from EGCutout.prepare / autoMask
//     source: the picture as drawn (an ImageBitmap) when its pixels are F's, else left out
//     onDownload: called when the model file has to be downloaded first
//     → the subject with what the model takes away gone (a mask like fg), or null when it
//       isn't used
(() => {
  if (self.EGCutoutModel) return;
  // The file's name changes with its contents, so a new model is a new download.
  const FILE = "https://rycpot.github.io/extra-guac/models/u2netp-1.bin";
  const SHA256 = "5b51dd87a4ffdfbb45fa1e2b4958854c89f799aab2f3db3656eca29e599b3aad";
  const CACHE = "cutout-model";
  const AGREE = 0.6; // share of the two subjects that must overlap (photos: 0.77 and up)
  const NEAR = 0.01; // what's within this share of the short side of the model's subject stays
                     // (thin parts it misses at its small size: antennae, stalks, a rim)
  const SPECK = 0.0005; // a piece further out goes when it's smaller than this share of the picture...
  const LIKE_BG = 30; // ...or its average color is within this many channel steps of the background's
  const RETRY = 60e3; // after a failed download, wait this long before trying again
  const IDLE = 60e3; // the graphics card is let go after this long without a picture
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

  let usable = null, file = null, net = null, failedAt = -Infinity, failures = 0;
  let idle = 0, waiting = 0, queue = Promise.resolve();

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  const sound = async (buf) => hex(await crypto.subtle.digest("SHA-256", buf)) === SHA256;

  // The model file: the kept copy, or a download (kept once it checks out).
  async function getFile(onDownload) {
    if (file) return file;
    const cache = await caches.open(CACHE).catch(() => null);
    const kept = await cache?.match(FILE).catch(() => null);
    if (kept) {
      const buf = await kept.arrayBuffer();
      if (await sound(buf)) return (file = buf);
      await cache.delete(FILE).catch(() => {});
    }
    onDownload?.();
    const res = await fetch(FILE, { signal: AbortSignal.timeout(60e3) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (!(await sound(buf))) throw new Error("The model file didn't check out");
    if (cache) {
      for (const req of await cache.keys().catch(() => [])) if (req.url !== FILE) await cache.delete(req).catch(() => {}); // an older model
      await cache.put(FILE, new Response(buf.slice(0))).catch(() => {});
    }
    return (file = buf);
  }

  // The picture as the model takes it: 320 × 320, scaled by its brightest channel value, then
  // normalized per channel. (A copy of F's pixels is drawn only when there's no source.)
  function input(F, S, source) {
    let big = source;
    if (!big) {
      big = new OffscreenCanvas(F.fw, F.fh);
      big.getContext("2d").putImageData(new ImageData(F.orig, F.fw, F.fh), 0, 0);
    }
    const g = new OffscreenCanvas(S, S).getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(big, 0, 0, S, S);
    const px = g.getImageData(0, 0, S, S).data, N = S * S, x = new Float32Array(3 * N);
    let mx = 1;
    for (let i = 0; i < px.length; i += 4) mx = Math.max(mx, px[i], px[i + 1], px[i + 2]);
    for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) x[k * N + i] = (px[i * 4 + k] / mx - MEAN[k]) / STD[k];
    return x;
  }

  // The model's output stretched to 0..1, sampled at the cutout's working size: over half is subject.
  function mask(out, S, F) {
    let lo = Infinity, hi = -Infinity;
    for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(hi - lo > 1e-6)) return null;
    const fg = new Uint8Array(F.N), span = hi - lo;
    for (let y = 0; y < F.H; y++) {
      const sy = Math.min(S - 1.001, Math.max(0, (y + 0.5) * S / F.H - 0.5)), y0 = sy | 0, ty = sy - y0;
      for (let x = 0; x < F.W; x++) {
        const sx = Math.min(S - 1.001, Math.max(0, (x + 0.5) * S / F.W - 0.5)), x0 = sx | 0, tx = sx - x0, i = y0 * S + x0;
        const v = (out[i] * (1 - tx) + out[i + 1] * tx) * (1 - ty) + (out[i + S] * (1 - tx) + out[i + S + 1] * tx) * ty;
        fg[y * F.W + x] = (v - lo) / span > 0.5 ? 1 : 0;
      }
    }
    return fg;
  }

  // The mask grown by r pixels (a square reach).
  function grown(m, W, H, r) {
    const a = new Uint8Array(m.length), b = new Uint8Array(m.length);
    for (let y = 0; y < H; y++) {
      let last = -Infinity; // the last subject pixel seen, then the next one ahead
      for (let x = 0; x < W; x++) { if (m[y * W + x]) last = x; if (x - last <= r) a[y * W + x] = 1; }
      last = Infinity;
      for (let x = W - 1; x >= 0; x--) { if (m[y * W + x]) last = x; if (last - x <= r) a[y * W + x] = 1; }
    }
    for (let x = 0; x < W; x++) {
      let last = -Infinity;
      for (let y = 0; y < H; y++) { if (a[y * W + x]) last = y; if (y - last <= r) b[y * W + x] = 1; }
      last = Infinity;
      for (let y = H - 1; y >= 0; y--) { if (a[y * W + x]) last = y; if (last - y <= r) b[y * W + x] = 1; }
    }
    return b;
  }

  // The subject without its pieces outside near that are specks or look like the background.
  function takeAway(F, fg, near) {
    const { N, W, R, G, B } = F, out = Uint8Array.from(fg), seen = new Uint8Array(N);
    let n = 0, br = 0, bgg = 0, bb = 0; // the background's average color
    for (let i = 0; i < N; i++) if (!fg[i]) { n++; br += R[i]; bgg += G[i]; bb += B[i]; }
    if (!n) return out;
    br /= n; bgg /= n; bb /= n;
    const away = (i) => fg[i] && !near[i] && !seen[i]; // outside near, not yet looked at
    for (let s = 0; s < N; s++) {
      if (!away(s)) continue;
      const piece = [], stack = [s];
      seen[s] = 1;
      let r = 0, g = 0, b = 0;
      while (stack.length) {
        const i = stack.pop(), x = i % W;
        piece.push(i); r += R[i]; g += G[i]; b += B[i];
        for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < N && away(j)) { seen[j] = 1; stack.push(j); }
      }
      const k = piece.length;
      if (k < SPECK * N || Math.hypot(r / k - br, g / k - bgg, b / k - bb) < LIKE_BG) for (const i of piece) out[i] = 0;
    }
    return out;
  }

  // How much two subjects overlap: shared / either.
  function overlap(a, b) {
    let both = 0, either = 0;
    for (let i = 0; i < a.length; i++) { both += a[i] & b[i]; either += a[i] | b[i]; }
    return either ? both / either : 0;
  }

  async function run(F, fg, onDownload, source) {
    if (usable === null) usable = await self.EGNet.usable();
    if (!usable || Date.now() - failedAt < RETRY) return null;
    try {
      const buf = await getFile(onDownload);
      net ||= await self.EGNet.load(buf);
      if (!net) { usable = false; return null; }
      const out = await net.run(input(F, net.size, source)), model = mask(out, net.size, F);
      if (!model || overlap(model, fg) < AGREE) return null;
      return takeAway(F, fg, grown(model, F.W, F.H, Math.max(1, Math.round(Math.min(F.W, F.H) * NEAR))));
    } catch (err) {
      // A download that failed is tried again later; a graphics card that failed is let go
      // (and after twice, not tried again).
      if (!file) failedAt = Date.now();
      else { net?.destroy?.(); net = null; if (++failures >= 2) usable = false; }
      return null;
    }
  }

  // One picture at a time; the graphics card is let go once pictures stop coming.
  function subject(F, fg, onDownload, source) {
    clearTimeout(idle);
    waiting++;
    const job = queue.then(() => run(F, fg, onDownload, source));
    queue = job.catch(() => {}).then(() => {
      if (--waiting) return;
      idle = setTimeout(() => { if (!waiting) { net?.destroy?.(); net = null; } }, IDLE);
    });
    return job;
  }

  self.EGCutoutModel = { subject, takeAway };
})();
