// The color menu, shared by the screenshot editor (shot-edit.js) and settings → highlight
// words: preset colors, nine of your own ("My colors": kept in storage as "myColors", the
// same nine in both places; right-click one to remove it, and once all nine are full a new one
// replaces the oldest), and beside them the picker: a shade square, hue and (where it applies)
// opacity sliders, a hex code and an eyedropper. Styles: color-menu.css.
(() => {
  const MINE_MAX = 9;
  const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
  // Colors are "#rrggbb", or "#rrggbbaa" when see-through.
  const alphaOf = (c) => (c.length === 9 ? parseInt(c.slice(7), 16) / 255 : 1);
  const withAlpha = (hex, a) => (a >= 1 ? hex : hex + Math.round(a * 255).toString(16).padStart(2, "0"));
  // What's typed (with or without #, 3, 6 or 8 digits) or rgb(…) from an eyedropper.
  function toHex(t) {
    t = String(t).trim().toLowerCase();
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(t);
    if (rgb) return `#${rgb.slice(1, 4).map((n) => Math.min(255, +n).toString(16).padStart(2, "0")).join("")}`;
    t = t.replace(/^#/, "");
    if (/^[0-9a-f]{3}$/.test(t)) t = [...t].map((c) => c + c).join("");
    if (/^[0-9a-f]{8}$/.test(t) && t.endsWith("ff")) t = t.slice(0, 6);
    return /^([0-9a-f]{6}|[0-9a-f]{8})$/.test(t) ? `#${t}` : null;
  }
  // Hue (0–360), saturation and value (0–1); a gray keeps the hue it had.
  function hsvOf(c, keepHue = 0) {
    const n = parseInt(c.slice(1, 7), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    let h = keepHue;
    if (d) h = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
    return [h % 360, max ? d / max : 0, max];
  }
  function hsvHex(h, s, v) {
    const f = (k) => { const x = (k + h / 60) % 6; return v - v * s * Math.max(0, Math.min(x, 4 - x, 1)); };
    return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
  }

  // My colors: read once (from the editor's older prefs if there's no list of their own yet)
  // and kept in step with the other places that show them.
  let mine = [];
  const clean = (list) => [...new Set((Array.isArray(list) ? list : []).filter((c) => HEX.test(c)))].slice(-MINE_MAX);
  const ready = chrome.storage.local.get(["myColors", "shotEdit"]).then(({ myColors, shotEdit }) => {
    mine = clean(Array.isArray(myColors) ? myColors : shotEdit?.mine);
    if (!Array.isArray(myColors) && mine.length) chrome.storage.local.set({ myColors: mine }).catch(() => {});
  }).catch(() => {});
  const open = new Set(); // weak refs to the menus made, to show a change made elsewhere
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local" || !c.myColors) return;
    mine = clean(c.myColors.newValue);
    for (const ref of open) {
      const m = ref.deref();
      if (!m) open.delete(ref);
      else if (m.isConnected) m.refill();
    }
  });
  const saveMine = () => chrome.storage.local.set({ myColors: mine }).catch(() => {});

  const el = (tag, cls, props) => Object.assign(document.createElement(tag), { className: cls, ...props });
  const EYEDROP = '<svg class="i" viewBox="0 0 24 24"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4z"/></svg>';
  const PLUS = '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';

  // The menu's contents (the host places it and closes it):
  //   value     the color now
  //   presets   the preset colors
  //   alpha     false: no opacity slider, and colors always come out as "#rrggbb"
  //   onPick(c, live)  a color was picked; live: still being tried (dragging, typing), a
  //             final call without live follows
  //   onDone()  a swatch was clicked, or Enter / Esc in the hex box: the host closes the menu
  //   eyedrop(alpha)   the eyedropper was clicked (none: no eyedropper); the host picks a
  //             color and calls back with set(c), or reopens the menu
  //   say(text) a short message; without one it shows under the hex code for a moment
  function build({ value, presets, alpha = true, onPick, onDone, eyedrop, say }) {
    const root = el("div", "cm");
    const pal = el("div", "cm-palette");
    let cur = value;
    const swatch = (c, fn) => {
      const b = el("button", "cm-sw", { type: "button", title: c });
      b.style.setProperty("--c", c);
      b.setAttribute("aria-pressed", String(c === cur));
      b.onclick = fn;
      return b;
    };
    const pickNow = (c) => { cur = c; onPick(c, false); onDone?.(); };
    function fill() {
      const pre = el("div", "cm-col"), own = el("div", "cm-col");
      for (const c of presets) pre.append(swatch(c, () => pickNow(c)));
      for (let k = 0; k < MINE_MAX; k++) {
        const c = mine[k];
        if (!c) { own.append(el("span", "cm-sw empty", { title: "Empty: pick a color, then Add to My colors" })); continue; }
        const shown = alpha ? c : c.slice(0, 7);
        const b = swatch(shown, () => pickNow(shown));
        b.title = `${c} · right-click to remove`;
        b.oncontextmenu = (e) => { e.preventDefault(); mine.splice(k, 1); saveMine(); fill(); };
        own.append(b);
      }
      pal.replaceChildren(pre, own);
    }

    const box = el("div", "cm-picker");
    const sv = el("div", "cm-sv"), knob = el("span", "cm-knob");
    sv.append(knob);
    const hue = el("input", "cm-hue", { type: "range", min: 0, max: 360, step: 1, title: "Hue" });
    const op = el("input", "cm-alpha", { type: "range", min: 0, max: 100, step: 1, title: "Opacity" });
    const preview = el("span", "cm-preview");
    const sliders = el("div", "cm-sliders");
    sliders.append(hue, ...(alpha ? [op] : []));
    const row1 = el("div", "cm-row");
    row1.append(sliders, preview);
    const hex = el("input", "cm-hex", { type: "text", maxLength: alpha ? 9 : 7, spellcheck: false, title: "Hex code" });
    hex.setAttribute("aria-label", "Hex code");
    const row2 = el("div", "cm-row");
    row2.append(hex);
    if (eyedrop) {
      const drop = el("button", "cm-eyedrop", { type: "button", title: "Pick a color from the screen", innerHTML: EYEDROP });
      drop.onclick = () => eyedrop(a);
      row2.append(drop);
    }
    const cap = el("div", "cm-cap");
    const add = el("button", "cm-add", { type: "button", innerHTML: `${PLUS}Add to My colors` });
    box.append(sv, row1, row2, cap, add);
    root.append(pal, box);

    // exact: the color as given (a hex code, the eyedropper, a swatch) until it's moved, so
    // it doesn't drift through the hue/shade numbers.
    let h = 0, s = 1, v = 1, a = 1, exact = null, note = "";
    const set = (c) => { [h, s, v] = hsvOf(c, h); exact = c.slice(0, 7); };
    const out = () => withAlpha(exact ?? hsvHex(h, s, v), alpha ? a : 1);
    function paint() {
      const base = exact ?? hsvHex(h, s, v);
      sv.style.setProperty("--hue", `hsl(${h} 100% 50%)`);
      Object.assign(knob.style, { left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: base });
      hue.value = h;
      op.value = Math.round(a * 100);
      hue.style.setProperty("--thumb", `hsl(${h} 100% 50%)`);
      op.style.setProperty("--to", base);
      op.style.setProperty("--thumb", out());
      preview.style.setProperty("--c", out());
      if (document.activeElement !== hex) { hex.value = base.slice(1).toUpperCase(); hex.classList.remove("bad"); }
      cap.textContent = note || (alpha && a < 1 ? `Hex · ${Math.round(a * 100)}% opacity` : "Hex");
    }
    function emit(live) {
      cur = out();
      onPick(cur, live);
      paint();
      if (!live) fill();
    }
    sv.onpointerdown = (e) => {
      sv.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = sv.getBoundingClientRect();
        s = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        v = 1 - Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
        exact = null;
        emit(true);
      };
      move(e);
      sv.onpointermove = move;
      sv.onpointerup = sv.onpointercancel = () => { sv.onpointermove = sv.onpointerup = null; emit(false); };
    };
    hue.oninput = () => { h = +hue.value; exact = null; emit(true); };
    op.oninput = () => { a = +op.value / 100; emit(true); };
    hue.onchange = op.onchange = () => emit(false);
    hex.oninput = () => {
      const c = toHex(hex.value);
      hex.classList.toggle("bad", !c);
      if (!c) return;
      set(c);
      if (c.length === 9) a = alphaOf(c);
      emit(true); // tried while typing ("fff" on the way to "ff0000"); kept on Enter or leaving
    };
    hex.onchange = () => emit(false);
    hex.onblur = paint;
    hex.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") onDone?.(); };
    const tell = (text) => {
      if (say) return say(text);
      note = text;
      paint();
      setTimeout(() => { note = ""; if (root.isConnected) paint(); }, 1600);
    };
    add.onclick = () => {
      const c = out();
      if (mine.includes(c)) return tell("Already in My colors");
      mine.push(c);
      if (mine.length > MINE_MAX) mine.shift(); // full: the oldest makes room
      saveMine();
      fill();
    };

    const show = (c) => { set(c); a = alphaOf(c); paint(); };
    fill();
    show(value);
    ready.then(fill); // My colors, if they weren't read yet
    open.add(new WeakRef(root));
    return Object.assign(root, {
      refill: fill,
      // A color from outside (the eyedropper): shown and picked.
      setColor(c) { show(c); emit(false); },
    });
  }

  globalThis.ColorMenu = { build, ready, toHex, alphaOf, withAlpha, hsvOf, hsvHex, MINE_MAX };
})();
