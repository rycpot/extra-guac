// Find and replace for a code textarea (the scratch pads' plain editor, the userscript editor):
// a small panel at the top right of the editor, with every match lit up in a layer under the
// text and the current one brighter. Enter goes to the next match, Shift+Enter back, Esc
// closes and leaves the current match selected. Replacing goes through the editor's own
// editing, so undo takes it back (Replace all as one step; see beforeBig for very long ones).
// findBar({ ta, mount, layer, scroller, mirror, edit, beforeBig }):
//   ta       the textarea
//   mount    where the panel goes (positioned)
//   layer    where the highlight layer goes, under the textarea's text (positioned)
//   scroller () => the element that scrolls the text
//   mirror   true when the layer must follow the textarea's own scrolling
//   edit     (start, end, text) => replaces that part of the text, as typing would
//   beforeBig () => runs before a Replace all too long for edit(), which isn't undone by undo
// Returns { open(), close(), refresh() }; refresh() after the text is set by code.
(() => {
  const MAX = 10000; // matches counted and lit up
  const MAX_TEXT = 1_000_000; // characters; above this, matches aren't lit up
  const BIG = 200_000; // characters; a Replace all longer than this skips the editor's own editing
  const esc = (s) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  const MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || "");
  const ICON = {
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  const svg = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
  function defaultEdit(ta, start, end, text) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
    if (!document.execCommand("insertText", false, text)) {
      ta.setRangeText(text, start, end, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  globalThis.findBar = function findBar({ ta, mount, layer, scroller = () => ta, mirror = false, edit = null, beforeBig = () => {} }) {
    const box = document.createElement("div");
    box.className = "find-bar";
    box.hidden = true;
    box.innerHTML = `
      <div class="fb-row">
        <input class="fb-find" type="text" placeholder="Find" aria-label="Find" spellcheck="false" autocomplete="off">
        <span class="fb-count" aria-live="polite"></span>
        <button type="button" class="fb-ib fb-case" aria-pressed="false" title="Match case">Aa</button>
        <button type="button" class="fb-ib fb-prev" title="Previous (Shift+Enter)" aria-label="Previous match">${svg(ICON.up)}</button>
        <button type="button" class="fb-ib fb-next" title="Next (Enter)" aria-label="Next match">${svg(ICON.down)}</button>
        <button type="button" class="fb-ib fb-close" title="Close (Esc)" aria-label="Close find and replace">${svg(ICON.x)}</button>
      </div>
      <div class="fb-row">
        <input class="fb-rep" type="text" placeholder="Replace with" aria-label="Replace with" spellcheck="false" autocomplete="off">
        <button type="button" class="fb-btn fb-one" title="Replace this match (Enter)">Replace</button>
        <button type="button" class="fb-btn fb-all" title="Replace every match">All</button>
      </div>`;
    mount.append(box);
    const marks = document.createElement("pre");
    marks.className = "find-marks";
    marks.setAttribute("aria-hidden", "true");
    marks.hidden = true;
    layer.prepend(marks);
    const q = (s) => box.querySelector(s);
    const findIn = q(".fb-find"), repIn = q(".fb-rep"), count = q(".fb-count"), caseBtn = q(".fb-case");
    // The panel's own edits don't count as typing in the editor (that refreshes the matches).
    let own = false;
    const doEdit = (a, b, t) => { own = true; try { (edit || ((x, y, z) => defaultEdit(ta, x, y, z)))(a, b, t); } finally { own = false; } };
    const pattern = () => new RegExp(findIn.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
    // `left`: the user moved the caret in the editor since the last match was shown, so closing
    // leaves it there.
    let hits = [], cur = -1, matchCase = false, more = false, timer = 0, left = false;
    const later = (fn) => { clearTimeout(timer); if (ta.value.length <= 100000) fn(); else timer = setTimeout(fn, 150); };

    function search() {
      hits = [];
      more = false;
      if (!findIn.value) return;
      const re = pattern(), v = ta.value;
      for (let m; (m = re.exec(v)); ) {
        if (hits.length === MAX) { more = true; break; }
        hits.push([m.index, m.index + m[0].length]);
      }
    }
    // The current match: the first one from `from` on (wrapping around to the first).
    function pick(from) {
      if (!hits.length) return (cur = -1);
      const i = hits.findIndex(([a]) => a >= from);
      cur = i === -1 ? 0 : i;
    }
    function counter() {
      const n = hits.length;
      count.textContent = !findIn.value ? "" : n ? `${(cur + 1).toLocaleString()} of ${n.toLocaleString()}${more ? "+" : ""}` : "No results";
      count.classList.toggle("none", !!findIn.value && !n);
    }
    function paint() {
      counter();
      const n = hits.length;
      for (const b of [q(".fb-prev"), q(".fb-next"), q(".fb-one"), q(".fb-all")]) b.disabled = !n;
      const v = ta.value;
      if (!n || v.length > MAX_TEXT) { marks.hidden = true; marks.textContent = ""; return; }
      let out = "", at = 0;
      hits.forEach(([a, b], i) => {
        out += `${esc(v.slice(at, a))}<mark${i === cur ? ' class="on"' : ""}>${esc(v.slice(a, b))}</mark>`;
        at = b;
      });
      marks.innerHTML = `${out}${esc(v.slice(at))}\n`;
      marks.hidden = false;
      follow();
    }
    function follow() {
      if (!mirror) return;
      marks.scrollTop = ta.scrollTop;
      marks.scrollLeft = ta.scrollLeft;
    }
    // Brings the current match into view (and selects it, for when the editor gets focus back).
    function reveal() {
      if (cur < 0) return;
      const [a, b] = hits[cur];
      left = false;
      ta.setSelectionRange(a, b);
      const el = marks.hidden ? null : marks.children[cur], sc = scroller();
      if (!el) return void (sc && byRow(sc, a));
      const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
      if (r.top < s.top + 40 || r.bottom > s.bottom - 20) sc.scrollTop += r.top - s.top - sc.clientHeight / 2;
      if (r.left < s.left + 60 || r.right > s.right - 20) sc.scrollLeft = Math.max(0, sc.scrollLeft + r.left - s.left - sc.clientWidth / 3);
      follow();
    }
    // Without the lit-up layer (very long text): scrolled to the match's row and column, as
    // measured in the editor's font (approximate where lines wrap).
    let ruler = null;
    function byRow(sc, a) {
      const v = ta.value, cs = getComputedStyle(ta);
      let line = 0, start = 0;
      for (let i = v.indexOf("\n"); i !== -1 && i < a; i = v.indexOf("\n", i + 1)) { line++; start = i + 1; }
      const lh = parseFloat(cs.lineHeight) || 20;
      sc.scrollTop = Math.max(0, (parseFloat(cs.paddingTop) || 0) + line * lh + lh / 2 - sc.clientHeight / 2);
      if (cs.whiteSpace !== "pre") return;
      ruler ??= document.createElement("canvas").getContext("2d");
      ruler.font = cs.font;
      const x = (parseFloat(cs.paddingLeft) || 0) + ruler.measureText(v.slice(start, a)).width;
      if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 3);
    }
    function run(from = ta.selectionStart) {
      search();
      pick(from);
      paint();
    }
    function go(dir) {
      if (!hits.length) return;
      marks.children[cur]?.classList.remove("on");
      cur = (cur + dir + hits.length) % hits.length;
      marks.children[cur]?.classList.add("on");
      counter();
      reveal();
    }
    function replaceOne() {
      if (cur < 0) return;
      const [a, b] = hits[cur];
      const back = document.activeElement;
      doEdit(a, b, repIn.value);
      run(a + repIn.value.length);
      reveal();
      (back && box.contains(back) ? back : repIn).focus({ preventScroll: true });
    }
    // Every match, also past the ones counted, as one edit (one undo step).
    function replaceAll() {
      if (!hits.length) return;
      const v = ta.value, re = pattern();
      let n = 0, to = 0;
      for (let m; (m = re.exec(v)); ) { n++; to = m.index + m[0].length; }
      const from = hits[0][0], text = v.slice(from, to).replace(pattern(), () => repIn.value);
      if (to - from <= BIG) doEdit(from, to, text);
      else {
        // Too long to go through the editor's own editing (it takes seconds and more): swapped
        // in at once, after beforeBig() (which can keep the old text).
        beforeBig();
        own = true;
        ta.setRangeText(text, from, to, "start");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        own = false;
      }
      run(0);
      count.textContent = `${n.toLocaleString()} replaced${hits.length ? `, ${hits.length.toLocaleString()}${more ? "+" : ""} left` : ""}`;
      count.classList.remove("none");
      repIn.focus({ preventScroll: true });
    }

    findIn.addEventListener("input", () => later(() => { run(Math.min(ta.selectionStart, ta.selectionEnd)); reveal(); }));
    for (const input of [findIn, repIn]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          if (input === repIn && !e.shiftKey) {
            if (e.ctrlKey || e.metaKey) replaceAll();
            else replaceOne();
          } else go(e.shiftKey ? -1 : 1);
        }
      });
    }
    caseBtn.onclick = () => {
      matchCase = !matchCase;
      caseBtn.setAttribute("aria-pressed", String(matchCase));
      caseBtn.classList.toggle("on", matchCase);
      run(hits[cur]?.[0] ?? ta.selectionStart);
    };
    q(".fb-prev").onclick = () => go(-1);
    q(".fb-next").onclick = () => go(1);
    q(".fb-one").onclick = replaceOne;
    q(".fb-all").onclick = replaceAll;
    q(".fb-all").title = `Replace every match (${MAC ? "⌘" : "Ctrl+"}Enter)`;
    q(".fb-close").onclick = close;
    for (const b of box.querySelectorAll("button")) b.addEventListener("mousedown", (e) => e.preventDefault());
    // Typing in the editor while the panel is open keeps the matches up to date.
    ta.addEventListener("input", () => {
      if (box.hidden || own) return;
      later(() => run(hits[cur]?.[0] ?? ta.selectionStart));
    });
    for (const ev of ["mousedown", "keydown"]) ta.addEventListener(ev, () => { left = true; });
    if (mirror) ta.addEventListener("scroll", follow);

    function open() {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes("\n") && sel.length <= 200) findIn.value = sel;
      box.hidden = false;
      run(Math.min(ta.selectionStart, ta.selectionEnd));
      findIn.focus();
      findIn.select();
    }
    function close() {
      clearTimeout(timer);
      box.hidden = true;
      marks.hidden = true;
      marks.textContent = "";
      const [a, b] = !left && hits[cur] ? hits[cur] : [ta.selectionStart, ta.selectionEnd];
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(a, b);
    }
    return {
      open,
      close,
      refresh: () => { if (!box.hidden) run(hits[cur]?.[0] ?? ta.selectionStart); },
    };
  };
})();
