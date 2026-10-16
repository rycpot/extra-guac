// Remove background, without a model (EGCutout): used by the screenshot editor (through
// cutout-worker.js) and the QR page's icon. It learns the background's light and color from
// the picture's edges (light that changes across the picture included), then grows the
// background inward over everything that's that background in that light, or that background
// darkened (a shadow), and stops at sharp changes in brightness or color: the subject's
// outline. The outline is then worked out at full size, pixel by pixel, as a blend of the
// background and the subject there, so no rim of background is left. A picture whose edges
// are see-through already is taken as cut out.
//
// The steps are separate so the editor can keep a picture between clicks: prepare() (the
// pixels and what each is judged by), autoMask() (which pixels are the subject), render()
// (the cut-out picture from a mask) and wand() (a click that takes away, or brings back, the
// part under it and everything connected that looks like it).
(() => {
  if (self.EGCutout) return;
  const WORK = 720; // longest side the mask is worked out at
  const SMALL = 480; // small pictures (icons) are worked out at up to 4× this side, so gaps a
                     // few pixels wide between their parts aren't smoothed shut
  const DEFAULT_T = { step: 0.045, cstep: 0.012 }; // sharp-change limits until the picture's own are known

  // The picture's pixels at full size (base: the pixels from before an earlier cut, which
  // fill in what's see-through now, so a click can bring them back) and at working size,
  // with the features: smoothed color, and as it is for sharp changes.
  function prepare(source, base = null) {
    const fw = source.naturalWidth || source.width, fh = source.naturalHeight || source.height;
    const big = new OffscreenCanvas(fw, fh).getContext("2d", { willReadFrequently: true });
    big.drawImage(source, 0, 0);
    const img = big.getImageData(0, 0, fw, fh), orig = img.data;
    const k = Math.min(WORK / Math.max(fw, fh), Math.max(1, Math.min(4, SMALL / Math.max(fw, fh))));
    const W = Math.max(8, Math.round(fw * k)), H = Math.max(8, Math.round(fh * k)), N = W * H;
    const small = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
    small.imageSmoothingQuality = "high";
    small.drawImage(source, 0, 0, W, H);
    const A = new Uint8Array(N), now = small.getImageData(0, 0, W, H).data;
    for (let i = 0; i < N; i++) A[i] = now[i * 4 + 3];
    if (base && base.length === orig.length) {
      for (let o = 0; o < orig.length; o += 4) if (orig[o + 3] < 255) { orig[o] = base[o]; orig[o + 1] = base[o + 1]; orig[o + 2] = base[o + 2]; }
      big.putImageData(img, 0, 0);
      small.clearRect(0, 0, W, H);
      small.drawImage(big.canvas, 0, 0, W, H);
    }
    const px = small.getImageData(0, 0, W, H).data;
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    for (let i = 0; i < N; i++) { R[i] = px[i * 4]; G[i] = px[i * 4 + 1]; B[i] = px[i * 4 + 2]; }
    // Sharp changes are looked for in the picture as it is (a thin dark rim must stop the
    // background); everything else on the smoothed copy.
    const eL = new Float32Array(N), eR = new Float32Array(N), eG = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = R[i] + G[i] + B[i];
      eL[i] = Math.log((s + 3) / 3); eR[i] = (R[i] + 8) / (s + 24); eG[i] = (G[i] + 8) / (s + 24);
    }
    blur(R, W, H, 1); blur(G, W, H, 1); blur(B, W, H, 1);
    const logL = new Float32Array(N), cr = new Float32Array(N), cg = new Float32Array(N);
    const K = 8; // keeps the color of dark pixels from swinging on noise
    for (let i = 0; i < N; i++) {
      const s = R[i] + G[i] + B[i];
      logL[i] = Math.log((s + 3) / 3); cr[i] = (R[i] + K) / (s + 3 * K); cg[i] = (G[i] + K) / (s + 3 * K);
    }
    return { fw, fh, W, H, N, orig: new Uint8ClampedArray(orig), A, R, G, B, eL, eR, eG, logL, cr, cg, T: { ...DEFAULT_T } };
  }

  // The mask as the picture shows it now: what isn't see-through is the subject.
  const fromAlpha = (F) => Uint8Array.from(F.A, (a) => (a > 127 ? 1 : 0));
  // Cut out already: most of its edge is see-through.
  function seeThrough(F) {
    const { W, H, A } = F;
    let n = 0, clear = 0;
    for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { n++; if (A[y * W + x] < 40) clear++; }
    for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { n++; if (A[y * W + x] < 40) clear++; }
    return clear / n >= 0.4;
  }

  // Which pixels are the subject (1) and which the background (0), at working size; and how
  // well it went (quality: busy scenes give a ragged outline and little background).
  function autoMask(F) {
    if (seeThrough(F)) return { fg: fromAlpha(F), already: true };
    const { W, H, N, eL, eR, eG, logL, cr, cg } = F;
    let samples = borderSeeds(W, H, logL, cr, cg);
    const rl = new Float32Array(N), rc = new Float32Array(N); // brightness (log) and color off the model
    const fit = () => {
      let model;
      for (let round = 0; round < 4; round++) {
        model = fitModel(samples, W, H, logL, cr, cg);
        const res = samples.map((i) => residual(model, i, W, H, logL, cr, cg));
        const ml = mad(res.map((r) => r.l)), mc = mad(res.map((r) => r.c));
        const keep = samples.filter((_, j) => Math.abs(res[j].l) <= 3 * ml + 0.02 && res[j].c <= 3 * mc + 0.004);
        if (keep.length < 50 || keep.length === samples.length) break;
        samples = keep;
      }
      fillResiduals(model, W, H, logL, cr, cg, rl, rc);
      return model;
    };
    let model = fit();
    const seeds = samples.slice();

    // How much the background varies by itself: the yardstick for everything below.
    const sigL = Math.max(0.015, 1.4826 * median(seeds.map((i) => Math.abs(rl[i]))));
    const sigC = Math.max(0.0025, 1.4826 * median(seeds.map((i) => rc[i])));
    const stepsL = [], stepsC = [];
    for (const i of seeds) {
      if (i % W + 1 >= W) continue;
      stepsL.push(Math.abs(eL[i + 1] - eL[i]));
      stepsC.push(Math.abs(eR[i + 1] - eR[i]) + Math.abs(eG[i + 1] - eG[i]));
    }
    const T = {
      up: Math.max(0.4, 5 * sigL),         // brighter than the model: uneven light, a sheen
      down: Math.log(0.18),                // darker: shadows, down to under a fifth of the light
      chroma: Math.max(0.014, 4.5 * sigC), // color off the background's, in full light
      step: Math.max(0.045, 6 * 1.4826 * median(stepsL)),   // a sharp change in brightness...
      cstep: Math.max(0.012, 6 * 1.4826 * median(stepsC)),  // ...or in color, between neighbors, stops it
    };

    // Grown, then the light learned again from all the background found (which reaches
    // further than the edge did), and grown again, until it stops finding more.
    let bg, found = 0;
    for (let pass = 0; pass < 4; pass++) {
      bg = grow(seeds, T, W, H, eL, eR, eG, rl, rc);
      let n = 0;
      for (let i = 0; i < N; i++) n += bg[i];
      if (pass && n < found * 1.01) break;
      found = n;
      samples = [];
      for (let i = 0; i < N; i += 2) if (bg[i] === 1 && rl[i] > -3 * sigL) samples.push(i);
      if (samples.length > 200) model = fit(); else break;
    }

    // ---- clean up: the subject is what's left; specks of it go, and small pinholes of
    // background inside it are filled
    // What's see-through already is background too. On a flat background all round the
    // edge (a logo, an icon) small parts are kept: they're the picture's own dots, not the
    // grain of a photo. (Flat bars along a photo's edges don't count.)
    const fg = new Uint8Array(N);
    for (let i = 0; i < N; i++) fg[i] = bg[i] || F.A[i] < 40 ? 0 : 1;
    let ring = 0, ringBg = 0;
    for (let x = 0; x < W; x++) for (const y of [1, H - 2]) { ring++; ringBg += fg[y * W + x] ? 0 : 1; }
    for (let y = 0; y < H; y++) for (const x of [1, W - 2]) { ring++; ringBg += fg[y * W + x] ? 0 : 1; }
    const flat = sigL <= 0.02 && sigC <= 0.004 && ringBg >= 0.95 * ring;
    keepBig(fg, W, H, flat ? 0.001 : 0.03);
    const inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) inv[i] = fg[i] ? 0 : 1;
    keepBig(inv, W, H, 0.0004, true);
    for (let i = 0; i < N; i++) fg[i] = inv[i] ? 0 : 1;
    if (flat) holes(F, fg, model, sigL, sigC);

    F.T = T;
    let bgN = 0, fgN = 0, rim = 0;
    for (let i = 0; i < N; i++) {
      if (fg[i]) { fgN++; const x = i % W; if ((x > 0 && !fg[i - 1]) || (x < W - 1 && !fg[i + 1]) || (i >= W && !fg[i - W]) || (i < N - W && !fg[i + W])) rim++; } else bgN++;
    }
    let edge = 0, edgeBg = 0;
    for (let x = 0; x < W; x++) for (const y of [1, H - 2]) { edge++; edgeBg += fg[y * W + x] ? 0 : 1; }
    for (let y = 0; y < H; y++) for (const x of [1, W - 2]) { edge++; edgeBg += fg[y * W + x] ? 0 : 1; }
    const quality = { edgeShare: edgeBg / edge, bgShare: bgN / N, ragged: rim / Math.sqrt(Math.max(1, fgN)) };
    quality.plain = !(quality.edgeShare < 0.75 || quality.bgShare < 0.15 || quality.ragged > 11);
    return { fg, quality };
  }

  // The cut-out picture from a mask, into out (an ImageData the picture's size), within box
  // ([x0, y0, x1, y1] at full size; all of it when left out).
  function render(F, fg, out, box = [0, 0, F.fw, F.fh]) {
    matte(F.orig, out.data, F.fw, F.fh, fg, F.W, F.H, F.R, F.G, F.B, box);
  }

  // A click at (fx, fy) (full-size pixels): "erase" takes away the shown part under it,
  // "restore" brings back the taken-away part under it, with everything connected that looks
  // like it, stopping at sharp changes. Changes fg; returns the pixels changed (working size),
  // or null when there's nothing of that kind there.
  function wand(F, fg, fx, fy, mode) {
    const { W, H, N, fw, fh, logL, cr, cg, T } = F;
    const want = mode === "erase" ? 1 : 0;
    let s = -1;
    const cx = Math.min(W - 1, Math.max(0, Math.floor(fx * W / fw))), cy = Math.min(H - 1, Math.max(0, Math.floor(fy * H / fh)));
    for (let r = 0; r <= 3 && s < 0; r++) { // right on the edge of it: the nearest pixel of it
      for (let dy = -r; dy <= r && s < 0; dy++) for (let dx = -r; dx <= r && s < 0; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < W && y < H && fg[y * W + x] === want) s = y * W + x;
      }
    }
    if (s < 0) return null;
    // Sharp changes judged on the smoothed copy, against the grain around the click (a dark
    // part's noise is large next to its light).
    const sx = s % W, sy = (s / W) | 0, gl = [], gc = [];
    for (let y = Math.max(0, sy - 6); y <= Math.min(H - 1, sy + 6); y++) for (let x = Math.max(0, sx - 6); x < Math.min(W - 1, sx + 6); x++) {
      const i = y * W + x;
      if (fg[i] !== want || fg[i + 1] !== want) continue;
      gl.push(Math.abs(logL[i + 1] - logL[i])); gc.push(Math.abs(cr[i + 1] - cr[i]) + Math.abs(cg[i + 1] - cg[i]));
    }
    const stepL = Math.max(T.step * 0.6, 6 * 1.4826 * median(gl)), stepC = Math.max(T.cstep * 0.6, 6 * 1.4826 * median(gc));
    const farL = want ? 0.5 : 0.35, farC = 0.06; // and not too far from what was clicked
    const L0 = logL[s], r0 = cr[s], g0 = cg[s], seen = new Uint8Array(N), q = new Int32Array(N);
    let head = 0, tail = 0;
    seen[s] = 1; q[tail++] = s;
    while (head < tail) {
      const i = q[head++], x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1]) {
        if (j < 0 || seen[j] || fg[j] !== want) continue;
        if (Math.abs(logL[j] - logL[i]) > stepL || Math.abs(cr[j] - cr[i]) + Math.abs(cg[j] - cg[i]) > stepC) continue;
        if (Math.abs(logL[j] - L0) > farL || Math.abs(cr[j] - r0) + Math.abs(cg[j] - g0) > farC) continue;
        seen[j] = 1; q[tail++] = j;
      }
    }
    const idx = q.slice(0, tail);
    for (const i of idx) fg[i] = 1 - want;
    return idx;
  }
  // The full-size box around changed pixels, with room for the outline's blur.
  function boxOf(F, idx) {
    const { W, H, fw, fh } = F;
    let ax = W, ay = H, bx = 0, by = 0;
    for (const i of idx) { const x = i % W, y = (i / W) | 0; if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y; }
    const m = 6;
    return [Math.max(0, Math.floor((ax - m) * fw / W)), Math.max(0, Math.floor((ay - m) * fh / H)), Math.min(fw, Math.ceil((bx + 1 + m) * fw / W)), Math.min(fh, Math.ceil((by + 1 + m) * fh / H))];
  }

  // The whole job on one picture: an OffscreenCanvas of it cut out, or already: true.
  function remove(source) {
    const F = prepare(source), r = autoMask(F);
    if (r.already) return { already: true, F, fg: r.fg };
    const out = new ImageData(new Uint8ClampedArray(F.orig), F.fw, F.fh);
    render(F, r.fg, out);
    const canvas = new OffscreenCanvas(F.fw, F.fh);
    canvas.getContext("2d").putImageData(out, 0, 0);
    return { canvas, quality: r.quality, F, fg: r.fg, out };
  }

  // A picture's address → the same picture cut out, as a PNG data URL (kept for next time).
  const cleaned = new Map();
  function cleanUrl(url) {
    if (!cleaned.has(url)) cleaned.set(url, (async () => {
      // createImageBitmap rather than an <img>: it decodes in a hidden page too (the offscreen
      // one draws the popup's and the menu's codes), where an image's decode() can wait for ever.
      const r = remove(await createImageBitmap(await (await fetch(url)).blob()));
      if (r.already) return url;
      const blob = await r.canvas.convertToBlob({ type: "image/png" });
      return new Promise((ok, fail) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => fail(fr.error); fr.readAsDataURL(blob); });
    })().catch((err) => { cleaned.delete(url); throw err; }));
    return cleaned.get(url);
  }

  // How far a pixel's color may be from the background's: a little in full light, more the
  // darker it is (a shadow picks up the subject's color, or a bluer sky light), up to a cap.
  // On a flat background, parts of it closed in by the subject (inside an O, a gap a pixel or
  // two wide between a ring and its middle) can't be reached from the edge. They're found in
  // the picture's own pixels: a patch of exactly the background's color with a crisp outline
  // all round goes, and so do the blended pixels next to it that are more background than
  // subject. A light part of the subject that happens to match fades into the rest instead.
  function holes(F, fg, model, sigL, sigC) {
    const { W, H, fw, fh, orig } = F, n = fw * fh;
    if (n > 4e6) return;
    const K = 8, tl = Math.max(0.05, 4 * sigL), tc = Math.max(0.01, 4 * sigC);
    const wi = (x, y) => Math.min(H - 1, (y * H / fh) | 0) * W + Math.min(W - 1, (x * W / fw) | 0);
    const L = new Float32Array(n), cR = new Float32Array(n), cG = new Float32Array(n);
    const bgc = new Float32Array(n * 3), on = new Uint8Array(n), like = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const o = p * 4, x = p % fw, y = (p / fw) | 0;
      if (orig[o + 3] < 128 || !fg[wi(x, y)]) continue;
      on[p] = 1;
      const sum = orig[o] + orig[o + 1] + orig[o + 2];
      L[p] = Math.log((sum + 3) / 3); cR[p] = (orig[o] + K) / (sum + 3 * K); cG[p] = (orig[o + 1] + K) / (sum + 3 * K);
      const f = basis(x, y, fw, fh);
      let l = 0, r = 0, g = 0;
      for (let a = 0; a < 6; a++) { l += model.l[a] * f[a]; r += model.r[a] * f[a]; g += model.g[a] * f[a]; }
      const bs = 3 * Math.exp(l) - 3;
      bgc[p * 3] = r * (bs + 3 * K) - K; bgc[p * 3 + 1] = g * (bs + 3 * K) - K; bgc[p * 3 + 2] = bs - bgc[p * 3] - bgc[p * 3 + 1];
      like[p] = Math.abs(L[p] - l) <= tl && Math.hypot(cR[p] - r, cG[p] - g) <= tc ? 1 : 0;
    }
    const gone = new Uint8Array(n), q = new Int32Array(n), D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    let tail = 0;
    for (let s = 0; s < n; s++) {
      if (!like[s] || gone[s]) continue;
      const from = tail;
      let head = tail, rim = 0, crisp = 0;
      gone[s] = 1; q[tail++] = s;
      while (head < tail) {
        const i = q[head++], x = i % fw, y = (i / fw) | 0;
        for (const [dx, dy] of D) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= fw || ny >= fh) continue;
          const j = ny * fw + nx;
          if (like[j]) { if (!gone[j]) { gone[j] = 1; q[tail++] = j; } continue; }
          if (!on[j]) continue; // the background found already
          // Across the outline, two pixels on: past any blending.
          rim++;
          const fx = Math.min(fw - 1, Math.max(0, x + 2 * dx)), fy = Math.min(fh - 1, Math.max(0, y + 2 * dy)), k = fy * fw + fx;
          if (Math.abs(L[k] - L[i]) > 0.25 || Math.abs(cR[k] - cR[i]) + Math.abs(cG[k] - cG[i]) > 0.05) crisp++;
        }
      }
      if (crisp < 0.9 * rim) { for (let m = from; m < tail; m++) gone[q[m]] = 2; tail = from; } // kept
    }
    for (let m = 0; m < tail; m++) gone[q[m]] = 1;
    if (!tail) return;
    // The blended pixels around: nearer the background's color than the subject's beside them.
    let head = 0;
    while (head < tail) {
      const i = q[head++], x = i % fw, y = (i / fw) | 0;
      for (const [dx, dy] of D) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= fw || ny >= fh) continue;
        const j = ny * fw + nx;
        if (gone[j] || !on[j]) continue;
        const b0 = bgc[j * 3], b1 = bgc[j * 3 + 1], b2 = bgc[j * 3 + 2], o = j * 4;
        let far = 0, f0 = 0, f1 = 0, f2 = 0; // the subject's color here: the pixel nearby least like the background
        for (let yy = Math.max(0, ny - 2); yy <= Math.min(fh - 1, ny + 2); yy++) for (let xx = Math.max(0, nx - 2); xx <= Math.min(fw - 1, nx + 2); xx++) {
          const u = (yy * fw + xx) * 4, d = Math.hypot(orig[u] - b0, orig[u + 1] - b1, orig[u + 2] - b2);
          if (d > far) { far = d; f0 = orig[u]; f1 = orig[u + 1]; f2 = orig[u + 2]; }
        }
        const v0 = f0 - b0, v1 = f1 - b1, v2 = f2 - b2, len = v0 * v0 + v1 * v1 + v2 * v2;
        if (len < 900) continue;
        const t = ((orig[o] - b0) * v0 + (orig[o + 1] - b1) * v1 + (orig[o + 2] - b2) * v2) / len;
        if (t < 0.5) { gone[j] = 1; q[tail++] = j; }
      }
    }
    for (let m = 0; m < tail; m++) {
      const i = q[m], x = i % fw, y = (i / fw) | 0;
      for (let wy = (y * H / fh) | 0; wy < Math.max(((y + 1) * H / fh) | 0, ((y * H / fh) | 0) + 1); wy++)
        for (let wx = (x * W / fw) | 0; wx < Math.max(((x + 1) * W / fw) | 0, ((x * W / fw) | 0) + 1); wx++)
          if (wx < W && wy < H) fg[wy * W + wx] = 0;
    }
  }

  const shadeLeeway = (T, l) => Math.min(0.12, T.chroma * (1 + 6 * Math.max(0, -l)));

  // Grows the background from the seeds: a neighbor joins if its color is the background's
  // there, its brightness is the background's (or a shadow of it), and neither brightness nor
  // color changes sharply between them.
  function grow(seeds, T, W, H, logL, cr, cg, rl, rc) {
    const N = W * H, bg = new Uint8Array(N), q = new Int32Array(N);
    let head = 0, tail = 0;
    // The sharp-change test is what keeps it out of a dark subject.
    const ok = (i) => rl[i] <= T.up && rl[i] >= T.down && rc[i] <= shadeLeeway(T, rl[i]);
    for (const i of seeds) if (!bg[i] && ok(i)) { bg[i] = 1; q[tail++] = i; }
    const tryN = (i, j) => {
      if (bg[j] || !ok(j)) return;
      if (Math.abs(logL[j] - logL[i]) > T.step) return;
      if (Math.abs(cr[j] - cr[i]) + Math.abs(cg[j] - cg[i]) > T.cstep) return;
      bg[j] = 1; q[tail++] = j;
    };
    while (head < tail) {
      const i = q[head++], x = i % W;
      if (x > 0) tryN(i, i - 1);
      if (x < W - 1) tryN(i, i + 1);
      if (i >= W) tryN(i, i - W);
      if (i < N - W) tryN(i, i + W);
    }
    return bg;
  }

  // Alpha at full size. Away from the outline it's the mask; near it, each pixel is taken as
  // a blend of the background there and the subject there (each the average of its side of
  // the mask nearby), so no rim of background color is left around the subject.
  function matte(src, d, fw, fh, fg, W, H, R, G, B, box) {
    const N = W * H, [bx0, by0, bx1, by1] = box;
    const up = Math.max(1, Math.round(W / fw)); // a picture worked out bigger than it is: its pixels' size
    // Each side's color nearby (normalized box averages of the mask's two sides).
    const avg = (side) => {
      const w = new Float32Array(N), r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
      for (let i = 0; i < N; i++) { const m = (fg[i] === side) ? 1 : 0; w[i] = m; r[i] = R[i] * m; g[i] = G[i] * m; b[i] = B[i] * m; }
      for (const a of [w, r, g, b]) blur(a, W, H, 3 * up);
      for (let i = 0; i < N; i++) { const s = w[i] || 1e-6; r[i] /= s; g[i] /= s; b[i] /= s; }
      return { w, r, g, b };
    };
    const F = avg(1), Bk = avg(0);
    const soft = new Float32Array(N);
    for (let i = 0; i < N; i++) soft[i] = fg[i];
    blur(soft, W, H, up);
    const sample = (a, sx, sy) => {
      const x0 = sx | 0, y0 = sy | 0, tx = sx - x0, ty = sy - y0, i = y0 * W + x0;
      return (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + W] * (1 - tx) + a[i + W + 1] * tx) * ty;
    };
    for (let y = by0; y < by1; y++) {
      const sy = Math.min(H - 1.001, Math.max(0, (y + 0.5) * H / fh - 0.5));
      for (let x = bx0; x < bx1; x++) {
        const sx = Math.min(W - 1.001, Math.max(0, (x + 0.5) * W / fw - 0.5));
        const m = sample(soft, sx, sy), o = (y * fw + x) * 4;
        d[o] = src[o]; d[o + 1] = src[o + 1]; d[o + 2] = src[o + 2];
        if (m <= 0.02) { d[o + 3] = 0; continue; }
        if (m >= 0.98) { d[o + 3] = src[o + 3]; continue; }
        // Near the outline: where the pixel sits between the two colors.
        const br = sample(Bk.r, sx, sy), bgg = sample(Bk.g, sx, sy), bb = sample(Bk.b, sx, sy);
        const fr = sample(F.r, sx, sy), fgg = sample(F.g, sx, sy), fb = sample(F.b, sx, sy);
        const dr = fr - br, dg = fgg - bgg, db = fb - bb, len = dr * dr + dg * dg + db * db;
        let a;
        if (len < 900) a = m; // the two sides look alike here: the mask decides
        else {
          const ir = src[o] - br, ig = src[o + 1] - bgg, ib = src[o + 2] - bb;
          const t = (ir * dr + ig * dg + ib * db) / len;
          a = Math.min(1, Math.max(0, (t - 0.1) / 0.8)); // a little firmer at both ends
          // A third color (a white rim on a pink box): far from the background, and not on the
          // way from it to the subject's color. It's the subject's, as the mask says.
          const fromBg = Math.hypot(ir, ig, ib), off = Math.hypot(ir - t * dr, ig - t * dg, ib - t * db);
          if (fromBg > 30 && off > 0.45 * fromBg) a = Math.max(a, Math.min(1, (m - 0.25) * 2));
          a = Math.min(a, Math.min(1, m * 2)); // never solid where the mask says background
        }
        d[o + 3] = Math.round(a * src[o + 3]); // a picture already see-through in places stays so
        if (a > 0.02 && a < 1) { // the subject's own color, without the background mixed in
          d[o] = clamp(br + (src[o] - br) / a); d[o + 1] = clamp(bgg + (src[o + 1] - bgg) / a); d[o + 2] = clamp(bb + (src[o + 2] - bb) / a);
        }
      }
    }
  }
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // Where the background starts: a ring just inside the image's edge, walked around once and
  // split wherever it changes sharply (a subject running off the edge, or touching it). The
  // longest stretch is background; the other stretches are too if they fit the light and
  // color learned from it (light changes along the edge, but gradually).
  function borderSeeds(W, H, logL, cr, cg) {
    const b = Math.max(1, Math.round(Math.min(W, H) * 0.01)), ring = [];
    for (let x = b; x < W - b; x++) ring.push(b * W + x);
    for (let y = b + 1; y < H - b; y++) ring.push(y * W + W - 1 - b);
    for (let x = W - 2 - b; x >= b; x--) ring.push((H - 1 - b) * W + x);
    for (let y = H - 2 - b; y > b; y--) ring.push(y * W + b);
    const n = ring.length, span = 3; // compared a few pixels apart: soft edges count too
    const dL = [], dC = [];
    for (let k = 0; k < n; k++) {
      const i = ring[k], j = ring[(k + span) % n];
      dL.push(Math.abs(logL[j] - logL[i])); dC.push(Math.abs(cr[j] - cr[i]) + Math.abs(cg[j] - cg[i]));
    }
    const tL = Math.max(0.06, 8 * median(dL)), tC = Math.max(0.015, 8 * median(dC));
    const cut = dL.map((v, k) => v > tL || dC[k] > tC);
    // Stretches between cuts (the ring is a loop: start just after a cut, if there is one).
    const start = Math.max(0, cut.indexOf(true) + 1) % n, runs = [];
    let run = [];
    for (let m = 0; m < n; m++) {
      const k = (start + m) % n;
      if (cut[k]) { if (run.length) runs.push(run); run = []; continue; }
      run.push(ring[k]);
    }
    if (run.length) runs.push(run);
    if (runs.length <= 1) return runs[0] || ring;
    runs.sort((a, c) => c.length - a.length);
    const ref = runs[0], model = fitModel(ref, W, H, logL, cr, cg);
    const res = ref.map((i) => residual(model, i, W, H, logL, cr, cg));
    const sL = Math.max(0.03, 1.4826 * median(res.map((r) => Math.abs(r.l)))), sC = Math.max(0.004, 1.4826 * median(res.map((r) => r.c)));
    const seeds = ref.slice();
    for (const r of runs.slice(1)) {
      if (r.length < 4) continue;
      const rr = r.map((i) => residual(model, i, W, H, logL, cr, cg));
      if (Math.abs(median(rr.map((v) => v.l))) <= Math.max(0.08, 4 * sL) && median(rr.map((v) => v.c)) <= Math.max(0.015, 4 * sC)) seeds.push(...r);
    }
    return seeds;
  }

  // ---- the model: a quadratic surface in x, y for log brightness and each color share
  const basis = (x, y, W, H) => { const u = (2 * x) / (W - 1) - 1, v = (2 * y) / (H - 1) - 1; return [1, u, v, u * u, u * v, v * v]; };
  function fitModel(samples, W, H, logL, cr, cg) {
    const A = Array.from({ length: 6 }, () => new Float64Array(6)), bl = new Float64Array(6), br = new Float64Array(6), bgc = new Float64Array(6);
    for (const i of samples) {
      const f = basis(i % W, (i / W) | 0, W, H);
      for (let a = 0; a < 6; a++) {
        for (let b = 0; b < 6; b++) A[a][b] += f[a] * f[b];
        bl[a] += f[a] * logL[i]; br[a] += f[a] * cr[i]; bgc[a] += f[a] * cg[i];
      }
    }
    // Held toward flat: where the samples don't reach (only one side of the image, say),
    // the light is taken as level rather than bending away.
    const ridge = 0.02 * samples.length;
    A[0][0] += 1e-6;
    for (let a = 1; a < 6; a++) A[a][a] += ridge;
    return { l: solve(A, bl), r: solve(A, br), g: solve(A, bgc) };
  }
  function residual(m, i, W, H, logL, cr, cg) {
    const f = basis(i % W, (i / W) | 0, W, H);
    let l = 0, r = 0, g = 0;
    for (let a = 0; a < 6; a++) { l += m.l[a] * f[a]; r += m.r[a] * f[a]; g += m.g[a] * f[a]; }
    return { l: logL[i] - l, c: Math.hypot(cr[i] - r, cg[i] - g) };
  }
  function fillResiduals(m, W, H, logL, cr, cg, rl, rc) {
    for (let y = 0, i = 0; y < H; y++) {
      const v = (2 * y) / (H - 1) - 1;
      for (let x = 0; x < W; x++, i++) {
        const u = (2 * x) / (W - 1) - 1, f = [1, u, v, u * u, u * v, v * v];
        let l = 0, r = 0, g = 0;
        for (let a = 0; a < 6; a++) { l += m.l[a] * f[a]; r += m.r[a] * f[a]; g += m.g[a] * f[a]; }
        rl[i] = logL[i] - l; rc[i] = Math.hypot(cr[i] - r, cg[i] - g);
      }
    }
  }
  function solve(A0, b0) {
    const n = b0.length, A = A0.map((r) => Float64Array.from(r)), b = Float64Array.from(b0);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  // ---- helpers
  function median(a) { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; }
  function mad(a) { const m = median(a); return median(a.map((v) => Math.abs(v - m))); }
  // Box blur of radius r, both directions, with running sums.
  function blur(a, W, H, r) {
    const t = new Float32Array(a.length);
    for (let y = 0; y < H; y++) {
      const o = y * W;
      let s = 0, n = 0;
      for (let x = 0; x <= Math.min(r, W - 1); x++) { s += a[o + x]; n++; }
      for (let x = 0; x < W; x++) {
        t[o + x] = s / n;
        const add = x + r + 1, sub = x - r;
        if (add < W) { s += a[o + add]; n++; }
        if (sub >= 0) { s -= a[o + sub]; n--; }
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let y = 0; y <= Math.min(r, H - 1); y++) { s += t[y * W + x]; n++; }
      for (let y = 0; y < H; y++) {
        a[y * W + x] = s / n;
        const add = y + r + 1, sub = y - r;
        if (add < H) { s += t[add * W + x]; n++; }
        if (sub >= 0) { s -= t[sub * W + x]; n--; }
      }
    }
  }
  // Keeps the connected parts (4-neighbors) of m at least `share` of the biggest; with
  // `edgesToo`, `share` is of the whole image and parts touching the image edge always stay.
  function keepBig(m, W, H, share, edgesToo = false) {
    const N = W * H, lab = new Int32Array(N).fill(-1), sizes = [], edge = [], q = new Int32Array(N);
    for (let s = 0; s < N; s++) {
      if (!m[s] || lab[s] >= 0) continue;
      const id = sizes.length;
      let head = 0, tail = 0, touches = false;
      lab[s] = id; q[tail++] = s;
      while (head < tail) {
        const i = q[head++], x = i % W, y = (i / W) | 0;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
        if (x > 0 && m[i - 1] && lab[i - 1] < 0) { lab[i - 1] = id; q[tail++] = i - 1; }
        if (x < W - 1 && m[i + 1] && lab[i + 1] < 0) { lab[i + 1] = id; q[tail++] = i + 1; }
        if (y > 0 && m[i - W] && lab[i - W] < 0) { lab[i - W] = id; q[tail++] = i - W; }
        if (y < H - 1 && m[i + W] && lab[i + W] < 0) { lab[i + W] = id; q[tail++] = i + W; }
      }
      sizes.push(tail); edge.push(touches);
    }
    if (!sizes.length) return;
    const big = Math.max(...sizes), min = edgesToo ? share * N : share * big;
    for (let i = 0; i < N; i++) if (m[i] && sizes[lab[i]] < min && !(edgesToo && edge[lab[i]])) m[i] = 0;
  }

  self.EGCutout = { prepare, autoMask, fromAlpha, render, wand, boxOf, remove, cleanUrl };
})();
