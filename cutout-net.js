// The engine that runs remove background's model (cutout-model.js) on the graphics card:
// through WebGPU where the browser offers it, else through WebGL2 (which older Macs keep when
// WebGPU is held back). The model is a packed file: a u32 length, a JSON list of steps, the
// float32 scales and biases, then int16 weights with one scale per output channel. Its steps
// are convolutions (with ReLU), 2×2 max pools, bilinear resizes, joins along channels, sums and
// sigmoids. Tensors are float32, channels × height × width.
//   await EGNet.usable()                       (whether either path is there)
//   const net = await EGNet.load(arrayBuffer)  (null when neither path is there)
//   const out = await net.run(float32Input)    (the last step's output; net.kind: "webgpu" or "webgl")
(() => {
  if (self.EGNet) return;

  function unpack(buf) {
    const dv = new DataView(buf), hl = dv.getUint32(0, true);
    const spec = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    const fl = new Float32Array(buf, 4 + hl, spec.floats), raw = new Int16Array(buf, 4 + hl + spec.floats * 4);
    return { spec, fl, raw, S: spec.size };
  }

  // ---- WebGPU ----------------------------------------------------------------------------
  const CONV = /* wgsl */ `
struct P { cin: u32, cout: u32, h: u32, w: u32, ih: u32, iw: u32, k: u32, dil: u32, pad: u32, relu: u32, wt: u32, bias: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> wt: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = p.h * p.w;
  if (id.x >= n) { return; }
  let oy = i32(id.x / p.w); let ox = i32(id.x % p.w);
  let kk = p.k * p.k; let plane = p.ih * p.iw;
  var acc = wt[p.bias + id.y];
  var base = p.wt + id.y * p.cin * kk;
  for (var ci = 0u; ci < p.cin; ci++) {
    for (var ky = 0u; ky < p.k; ky++) {
      let iy = oy - i32(p.pad) + i32(ky * p.dil);
      if (iy >= 0 && iy < i32(p.ih)) {
        let row = ci * plane + u32(iy) * p.iw;
        for (var kx = 0u; kx < p.k; kx++) {
          let ix = ox - i32(p.pad) + i32(kx * p.dil);
          if (ix >= 0 && ix < i32(p.iw)) { acc += x[row + u32(ix)] * wt[base + ky * p.k + kx]; }
        }
      }
    }
    base += kk;
  }
  if (p.relu == 1u) { acc = max(acc, vec4<f32>(0.0)); }
  let c = id.y * 4u;
  for (var j = 0u; j < 4u; j++) { if (c + j < p.cout) { y[(c + j) * n + id.x] = acc[j]; } }
}`;
  const POOL = /* wgsl */ `
struct P { c: u32, h: u32, w: u32, ih: u32, iw: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = p.h * p.w;
  if (id.x >= n) { return; }
  let oy = id.x / p.w; let ox = id.x % p.w; let src = id.y * p.ih * p.iw;
  var m = -3.4e38;
  for (var dy = 0u; dy < 2u; dy++) { for (var dx = 0u; dx < 2u; dx++) {
    let iy = oy * 2u + dy; let ix = ox * 2u + dx;
    if (iy < p.ih && ix < p.iw) { m = max(m, x[src + iy * p.iw + ix]); }
  } }
  y[id.y * n + id.x] = m;
}`;
  const UP = /* wgsl */ `
struct P { c: u32, h: u32, w: u32, ih: u32, iw: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
fn at(o: u32, size: u32, inSize: u32) -> vec3<f32> { // first, second, weight of the second
  var s = 0.0;
  if (size > 1u) { s = max(0.0, (f32(o) + 0.5) * f32(inSize) / f32(size) - 0.5); }
  let a = min(u32(floor(s)), inSize - 1u);
  let b = min(a + 1u, inSize - 1u);
  return vec3<f32>(f32(a), f32(b), s - f32(a));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = p.h * p.w;
  if (id.x >= n) { return; }
  let ty = at(id.x / p.w, p.h, p.ih); let tx = at(id.x % p.w, p.w, p.iw);
  let src = id.y * p.ih * p.iw;
  let r0 = src + u32(ty.x) * p.iw; let r1 = src + u32(ty.y) * p.iw;
  let top = mix(x[r0 + u32(tx.x)], x[r0 + u32(tx.y)], tx.z);
  let bot = mix(x[r1 + u32(tx.x)], x[r1 + u32(tx.y)], tx.z);
  y[id.y * n + id.x] = mix(top, bot, ty.z);
}`;
  const ADD = /* wgsl */ `
struct P { n: u32, sig: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * 65535u * 64u;
  if (i >= p.n) { return; }
  if (p.sig == 1u) { y[i] = 1.0 / (1.0 + exp(-a[i])); } else { y[i] = a[i] + b[i]; }
}`;

  async function loadGPU(buf) {
    const gpu = self.navigator?.gpu, adapter = gpu && await gpu.requestAdapter();
    if (!adapter) return null;
    const { spec, fl, raw, S } = unpack(buf);
    // The weights, each convolution's laid out four output channels at a time.
    const parts = [];
    let total = 0;
    for (const op of spec.ops) {
      if (op.op !== "conv") continue;
      const g = Math.ceil(op.cout / 4), kk = op.k * op.k, w = new Float32Array(g * op.cin * kk * 4 + g * 4);
      for (let co = 0; co < op.cout; co++) for (let ci = 0; ci < op.cin; ci++) for (let t = 0; t < kk; t++)
        w[((((co >> 2) * op.cin + ci) * kk + t) << 2) + (co & 3)] = raw[op.w + (co * op.cin + ci) * kk + t] * fl[op.s + co];
      const b0 = g * op.cin * kk * 4;
      for (let co = 0; co < op.cout; co++) w[b0 + co] = fl[op.s + op.cout + co];
      op.wt = total / 4; op.bias = (total + b0) / 4;
      parts.push(w); total += w.length;
    }
    const need = Math.max(256 << 20, total * 4, ...spec.ops.map((o) => o.shape[0] * o.shape[1] * o.shape[2] * 4));
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Math.min(need, adapter.limits.maxStorageBufferBindingSize), maxBufferSize: Math.min(need, adapter.limits.maxBufferSize) } });
    const U = GPUBufferUsage;
    const weights = device.createBuffer({ size: total * 4, usage: U.STORAGE | U.COPY_DST });
    let o = 0;
    for (const w of parts) { device.queue.writeBuffer(weights, o * 4, w); o += w.length; }
    const pipe = (code) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    const P = { conv: pipe(CONV), pool: pipe(POOL), up: pipe(UP), add: pipe(ADD) };

    // Buffers: each tensor gets one when it's made, handed back once its last reader has run.
    const size = { 0: 3 * S * S * 4 }, last = {};
    spec.ops.forEach((op, i) => { size[op.y] = op.shape[0] * op.shape[1] * op.shape[2] * 4; for (const t of op.xs || [op.x]) last[t] = i; });
    last[spec.out] = Infinity;
    const free = new Map(), buffers = {}, shapes = { 0: [3, S, S] };
    const take = (t) => {
      const list = free.get(size[t]);
      buffers[t] = list?.length ? list.pop() : device.createBuffer({ size: size[t], usage: U.STORAGE | U.COPY_SRC | U.COPY_DST });
    };
    take(0);
    const steps = [];
    const uni = (vals) => { const b = device.createBuffer({ size: Math.ceil(vals.length / 4) * 16, usage: U.UNIFORM | U.COPY_DST }); device.queue.writeBuffer(b, 0, new Uint32Array(vals)); return b; };
    const bind = (pl, bufs) => device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: bufs.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    spec.ops.forEach((op, i) => {
      const [c, h, w] = op.shape, n = h * w;
      shapes[op.y] = op.shape;
      take(op.y);
      if (op.op === "cat") {
        let at = 0;
        const copies = op.xs.map((t) => { const c = [buffers[t], at, size[t]]; at += size[t]; return c; });
        steps.push({ copies, y: buffers[op.y] });
      } else if (op.op === "conv") {
        const [, ih, iw] = shapes[op.x];
        steps.push({ p: P.conv, g: bind(P.conv, [uni([op.cin, op.cout, h, w, ih, iw, op.k, op.dil, op.pad, op.relu, op.wt, op.bias]), buffers[op.x], weights, buffers[op.y]]), d: [Math.ceil(n / 64), Math.ceil(op.cout / 4)] });
      } else if (op.op === "pool" || op.op === "up") {
        const [, ih, iw] = shapes[op.x];
        steps.push({ p: P[op.op], g: bind(P[op.op], [uni([c, h, w, ih, iw]), buffers[op.x], buffers[op.y]]), d: [Math.ceil(n / 64), c] });
      } else {
        const all = c * n, a = buffers[op.xs ? op.xs[0] : op.x], b = op.xs ? buffers[op.xs[1]] : a;
        const groups = Math.ceil(all / 64);
        steps.push({ p: P.add, g: bind(P.add, [uni([all, op.op === "sig" ? 1 : 0]), a, b, buffers[op.y]]), d: [Math.min(groups, 65535), Math.ceil(groups / 65535)] });
      }
      for (const t of op.xs || [op.x]) if (last[t] === i) { const l = free.get(size[t]) || []; l.push(buffers[t]); free.set(size[t], l); }
    });
    const outSize = size[spec.out], read = device.createBuffer({ size: outSize, usage: U.MAP_READ | U.COPY_DST });

    let lost = false;
    device.lost.then(() => { lost = true; });
    async function run(input) {
      if (lost) throw new Error("The graphics card was let go");
      device.queue.writeBuffer(buffers[0], 0, input);
      const enc = device.createCommandEncoder();
      for (const s of steps) {
        if (s.copies) { for (const [src, at, len] of s.copies) enc.copyBufferToBuffer(src, 0, s.y, at, len); continue; }
        const pass = enc.beginComputePass();
        pass.setPipeline(s.p); pass.setBindGroup(0, s.g); pass.dispatchWorkgroups(...s.d); pass.end();
      }
      enc.copyBufferToBuffer(buffers[spec.out], 0, read, 0, outSize);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      return out;
    }
    return { size: S, run, destroy: () => device.destroy() };
  }

  // ---- WebGL2 ----------------------------------------------------------------------------
  // Tensors live in float textures, four channels a pixel; a tensor's channel groups are laid
  // out as tiles in a grid. Each step draws one pass.
  const GL_VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
  const GL_HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform ivec4 osz; // out: width, height, groups, grid columns
uniform ivec4 isz; // in: the same
out vec4 o;
ivec2 at(ivec4 s, int g, int x, int y) { return ivec2((g % s.w) * s.x + x, (g / s.w) * s.y + y); }
`;
  // Where this pixel is in the output: its group and position (or none).
  const GL_WHERE = `
  ivec2 f = ivec2(gl_FragCoord.xy);
  int col = f.x / osz.x, row = f.y / osz.y, g = row * osz.w + col;
  if (col >= osz.w || g >= osz.z) { o = vec4(0.0); return; }
  int x = f.x - col * osz.x, y = f.y - row * osz.y;`;
  const GL_CONV = GL_HEAD + `
uniform sampler2D X; uniform sampler2D Wt;
uniform ivec4 cv; // kernel, dilation, padding, relu
uniform ivec2 wt; // first weight, weight texture width
vec4 w(int i) { return texelFetch(Wt, ivec2(i % wt.y, i / wt.y), 0); }
void main() {` + GL_WHERE + `
  int k = cv.x, kk = k * k, base = wt.x + g * (isz.z * kk * 4 + 1);
  vec4 acc = w(base); base += 1;
  for (int gi = 0; gi < isz.z; gi++) {
    for (int ky = 0; ky < k; ky++) {
      int iy = y - cv.z + ky * cv.y;
      if (iy < 0 || iy >= isz.y) continue;
      for (int kx = 0; kx < k; kx++) {
        int ix = x - cv.z + kx * cv.y;
        if (ix < 0 || ix >= isz.x) continue;
        vec4 v = texelFetch(X, at(isz, gi, ix, iy), 0);
        int i = base + (gi * kk + ky * k + kx) * 4;
        acc += v.x * w(i) + v.y * w(i + 1) + v.z * w(i + 2) + v.w * w(i + 3);
      }
    }
  }
  o = cv.w == 1 ? max(acc, vec4(0.0)) : acc;
}`;
  const GL_POOL = GL_HEAD + `
uniform sampler2D X;
void main() {` + GL_WHERE + `
  vec4 m = vec4(-3.4e38);
  for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
    int iy = y * 2 + dy, ix = x * 2 + dx;
    if (iy < isz.y && ix < isz.x) m = max(m, texelFetch(X, at(isz, g, ix, iy), 0));
  }
  o = m;
}`;
  const GL_UP = GL_HEAD + `
uniform sampler2D X;
vec3 pick(int o, int size, int inSize) {
  float s = size > 1 ? max(0.0, (float(o) + 0.5) * float(inSize) / float(size) - 0.5) : 0.0;
  int a = min(int(floor(s)), inSize - 1);
  return vec3(float(a), float(min(a + 1, inSize - 1)), s - float(a));
}
void main() {` + GL_WHERE + `
  vec3 ty = pick(y, osz.y, isz.y), tx = pick(x, osz.x, isz.x);
  vec4 a = texelFetch(X, at(isz, g, int(tx.x), int(ty.x)), 0), b = texelFetch(X, at(isz, g, int(tx.y), int(ty.x)), 0);
  vec4 c = texelFetch(X, at(isz, g, int(tx.x), int(ty.y)), 0), d = texelFetch(X, at(isz, g, int(tx.y), int(ty.y)), 0);
  o = mix(mix(a, b, tx.z), mix(c, d, tx.z), ty.z);
}`;
  const GL_ADD = GL_HEAD + `
uniform sampler2D X; uniform sampler2D Y; uniform int sig;
void main() {` + GL_WHERE + `
  vec4 a = texelFetch(X, at(isz, g, x, y), 0);
  o = sig == 1 ? 1.0 / (1.0 + exp(-a)) : a + texelFetch(Y, at(isz, g, x, y), 0);
}`;
  // Joining along channels: whole groups when they line up, else one channel at a time
  // (written through a color mask, so the other three channels of that group stay).
  const GL_COPY = GL_HEAD + `
uniform sampler2D X; uniform ivec3 cp; // first output group, source channel (or -1: whole groups), output channel
void main() {` + GL_WHERE + `
  if (cp.y < 0) { int s = g - cp.x; if (s < 0 || s >= isz.z) discard; o = texelFetch(X, at(isz, s, x, y), 0); return; }
  if (g != cp.z / 4) discard;
  vec4 v = texelFetch(X, at(isz, cp.y / 4, x, y), 0);
  o = vec4(v[cp.y % 4]);
}`;

  function loadGL(buf) {
    let gl;
    try { gl = new OffscreenCanvas(1, 1).getContext("webgl2", { antialias: false, depth: false, powerPreference: "high-performance" }); } catch { return null; }
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) return null;
    const { spec, fl, raw, S } = unpack(buf);
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const layout = ([c, h, w]) => { const g = Math.ceil(c / 4), cols = Math.ceil(Math.sqrt(g)); return { c, h, w, g, cols, tw: w * cols, th: h * Math.ceil(g / cols) }; };

    // Weights: per convolution and output group, its bias, then for each input group and
    // tap four columns (one per input channel) of the four outputs' weights.
    const parts = []; let total = 0;
    for (const op of spec.ops) {
      if (op.op !== "conv") continue;
      const go = Math.ceil(op.cout / 4), gi = Math.ceil(op.cin / 4), kk = op.k * op.k, per = gi * kk * 4 + 1, w = new Float32Array(go * per * 4);
      for (let co = 0; co < op.cout; co++) {
        const g = co >> 2, lane = co & 3;
        w[(g * per) * 4 + lane] = fl[op.s + op.cout + co];
        for (let ci = 0; ci < op.cin; ci++) for (let t = 0; t < kk; t++)
          w[(g * per + 1 + ((ci >> 2) * kk + t) * 4 + (ci & 3)) * 4 + lane] = raw[op.w + (co * op.cin + ci) * kk + t] * fl[op.s + co];
      }
      op.wt = total; parts.push(w); total += w.length / 4;
    }
    const WW = Math.min(4096, maxTex), WH = Math.ceil(total / WW);
    const all = new Float32Array(WW * WH * 4); let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    const tex = (w, h, data = null) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    const weights = tex(WW, WH, all);

    const prog = (fs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, GL_VS], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.bindAttribLocation(p, 0, "p"); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
      return { p, u };
    };
    const P = { conv: prog(GL_CONV), pool: prog(GL_POOL), up: prog(GL_UP), add: prog(GL_ADD), copy: prog(GL_COPY) };
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Textures: each tensor gets one when it's made, handed back after its last reader.
    const L = { 0: layout([3, S, S]) }, last = {};
    spec.ops.forEach((op, i) => { L[op.y] = layout(op.shape); for (const t of op.xs || [op.x]) last[t] = i; });
    last[spec.out] = Infinity;
    if (Object.values(L).some((l) => l.tw > maxTex || l.th > maxTex)) return null;
    const free = new Map(), T = {};
    const key = (t) => L[t].tw + "x" + L[t].th;
    const take = (t) => {
      const list = free.get(key(t));
      if (list?.length) { T[t] = list.pop(); return; }
      const texture = tex(L[t].tw, L[t].th), fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      T[t] = { texture, fb };
    };
    take(0);
    const steps = [];
    spec.ops.forEach((op, i) => {
      take(op.y);
      const out = T[op.y], ol = L[op.y];
      if (op.op === "cat") {
        let ch = 0;
        for (const t of op.xs) {
          const il = L[t], src = T[t];
          if (ch % 4 === 0 && il.c % 4 === 0) steps.push({ prog: P.copy, out, ol, il, tex: [src.texture], cp: [ch / 4, -1, 0] });
          else for (let c = 0; c < il.c; c++) steps.push({ prog: P.copy, out, ol, il, tex: [src.texture], cp: [0, c, ch + c], mask: (ch + c) % 4 });
          ch += il.c;
        }
      } else if (op.op === "conv") steps.push({ prog: P.conv, out, ol, il: L[op.x], tex: [T[op.x].texture, weights], cv: [op.k, op.dil, op.pad, op.relu], wt: [op.wt, WW] });
      else if (op.op === "pool" || op.op === "up") steps.push({ prog: P[op.op], out, ol, il: L[op.x], tex: [T[op.x].texture] });
      else steps.push({ prog: P.add, out, ol, il: L[op.y], tex: op.xs ? [T[op.xs[0]].texture, T[op.xs[1]].texture] : [T[op.x].texture, T[op.x].texture], sig: op.op === "sig" ? 1 : 0 });
      for (const t of op.xs || [op.x]) if (last[t] === i) { const l = free.get(key(t)) || []; l.push(T[t]); free.set(key(t), l); }
    });
    const OL = L[spec.out], outT = T[spec.out];

    async function run(input) {
      // The input, four channels a pixel (its three, then zero), one tile.
      const n = S * S, px = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { px[i * 4] = input[i]; px[i * 4 + 1] = input[n + i]; px[i * 4 + 2] = input[2 * n + i]; }
      gl.bindTexture(gl.TEXTURE_2D, T[0].texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, S, S, gl.RGBA, gl.FLOAT, px);
      for (const s of steps) {
        const { p, u } = s.prog;
        gl.useProgram(p);
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.out.fb);
        gl.viewport(0, 0, s.ol.tw, s.ol.th);
        gl.uniform4i(u.osz, s.ol.w, s.ol.h, s.ol.g, s.ol.cols);
        gl.uniform4i(u.isz, s.il.w, s.il.h, s.il.g, s.il.cols);
        s.tex.forEach((t, k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t); });
        if (u.X) gl.uniform1i(u.X, 0);
        if (u.Y) gl.uniform1i(u.Y, 1);
        if (u.Wt) gl.uniform1i(u.Wt, 1);
        if (s.cv) { gl.uniform4i(u.cv, ...s.cv); gl.uniform2i(u.wt, ...s.wt); }
        if (u.sig) gl.uniform1i(u.sig, s.sig);
        if (s.cp) gl.uniform3i(u.cp, ...s.cp);
        if (s.mask !== undefined) gl.colorMask(s.mask === 0, s.mask === 1, s.mask === 2, s.mask === 3);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (s.mask !== undefined) gl.colorMask(true, true, true, true);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, outT.fb);
      const back = new Float32Array(OL.tw * OL.th * 4);
      gl.readPixels(0, 0, OL.tw, OL.th, gl.RGBA, gl.FLOAT, back);
      if (gl.isContextLost()) throw new Error("The graphics card was let go");
      const out = new Float32Array(OL.w * OL.h);
      for (let i = 0; i < out.length; i++) out[i] = back[i * 4];
      return out;
    }
    return { size: S, run, destroy: () => gl.getExtension("WEBGL_lose_context")?.loseContext() };
  }

  // Whether either path is there (before downloading a model for it).
  async function usable() {
    try { if (await self.navigator?.gpu?.requestAdapter()) return true; } catch {}
    try {
      const gl = new OffscreenCanvas(1, 1).getContext("webgl2"), ok = !!gl?.getExtension("EXT_color_buffer_float");
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return ok;
    } catch { return false; }
  }

  async function load(buf) {
    try { const net = await loadGPU(buf); if (net) return Object.assign(net, { kind: "webgpu" }); } catch {}
    const net = loadGL(buf);
    return net && Object.assign(net, { kind: "webgl" });
  }

  self.EGNet = { usable, load };
})();
