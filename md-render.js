// Markdown → HTML for the scratch pad preview (scratch.js). Covers what notes use: headings,
// paragraphs, bold, italic, strikethrough, code (inline and fenced), links, lists (nested,
// numbered, task lists), quotes, rules and tables. Everything is escaped first; links go only
// to http(s), mailto and #anchors (other links show as their text), and images become links
// (the preview loads nothing from the web). Headings carry the slug a #anchor link names
// (data-slug, made the usual way: "## 7. The \"SOTA\" tricks" → 7-the-sota-tricks).
(() => {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  function safeUrl(u) {
    u = unesc(u.trim());
    if (/^(https?:|mailto:|#)/i.test(u)) return esc(u);
    return /^www\./i.test(u) ? esc(`https://${u}`) : null;
  }

  function inline(src) {
    const codes = [];
    let s = src.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, t, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*?&quot;)?\s*\)/g, (m, alt, url) => {
      const u = safeUrl(url);
      return u ? `<a href="${u}" class="img-link">🖼 ${alt || "image"}</a>` : `<span class="nolink" title="${url}">🖼 ${alt || "image"}</span>`;
    });
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*?)&quot;)?\s*\)/g, (m, text, url, title) => {
      const u = safeUrl(url);
      return u ? `<a href="${u}"${title ? ` title="${title}"` : ""}>${text}</a>` : `<span class="nolink" title="${url}">${text}</span>`;
    });
    s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (m, u) => `<a href="${u}">${u}</a>`);
    // Bare addresses, outside the links (and their attributes) made above.
    s = s.split(/(<a\b[^>]*>[\s\S]*?<\/a>|<[^>]*>)/).map((part, i) => (i % 2 ? part
      : part.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]])/g, (m, pre, u) => `${pre}<a href="${safeUrl(u)}">${u}</a>`))).join("");
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
    s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    s = s.replace(/(?: {2,}|\\)\n/g, "<br>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
  }

  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
  const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const blank = (l) => !l.trim();
  const tableAt = (lines, i) => lines[i].includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && (lines[i + 1] || "").includes("-");
  const startsBlock = (l) => FENCE.test(l) || RULE.test(l) || /^ {0,3}(#{1,6}(\s|$)|>)/.test(l) || (ITEM.test(l) && l.search(/\S/) <= 3);

  function list(lines, i, out) {
    const first = ITEM.exec(lines[i]);
    const indent = first[1].length, ordered = /\d/.test(first[2]);
    const items = [];
    while (i < lines.length) {
      const line = lines[i], m = ITEM.exec(line), at = line.search(/\S/);
      if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) { items.push([m[3]]); i++; continue; }
      if (blank(line)) {
        const next = lines[i + 1] ?? "";
        const nm = ITEM.exec(next);
        if (nm && nm[1].length === indent && /\d/.test(nm[2]) === ordered) { i++; continue; }
        if (!blank(next) && next.search(/\S/) > indent) { items.at(-1).push(""); i++; continue; }
        break;
      }
      if (at > indent) { items.at(-1).push(line.slice(Math.min(at, indent + 2))); i++; continue; }
      // A line carried on without indenting, unless it starts something of its own.
      if (!m && !startsBlock(line) && !tableAt(lines, i)) { items.at(-1).push(line.trim()); i++; continue; }
      break;
    }
    const lis = items.map(([first, ...rest]) => {
      // Lines that carry on the item's text belong with it (bold across a line break, say);
      // what follows a blank line or starts a block of its own is rendered after it.
      let k = 0;
      while (k < rest.length && !blank(rest[k]) && !startsBlock(rest[k])) k++;
      const head = [first, ...rest.slice(0, k)].join("\n"), more = rest.slice(k);
      const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(head);
      const box = task ? `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> ` : "";
      return `<li${task ? ' class="task"' : ""}>${box}${inline(task ? task[2] : head)}${more.length ? block(more.join("\n")) : ""}</li>`;
    });
    const start = ordered ? parseInt(first[2], 10) : 1;
    out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ""}>${lis.join("")}</ol>` : `<ul>${lis.join("")}</ul>`);
    return i;
  }

  let seen = new Map();
  function slug(html) {
    const base = unesc(html.replace(/<[^>]*>/g, "")).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  }

  function block(text) {
    const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
    const out = [];
    let i = 0, m;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) { i++; continue; }
      if ((m = FENCE.exec(line))) {
        const close = new RegExp(`^ {0,3}${m[1][0] === "`" ? "`" : "~"}{${m[1].length},}\\s*$`);
        const body = [];
        for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
        i++;
        out.push(`<pre><code${m[2] ? ` data-lang="${esc(m[2].toLowerCase())}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }
      if ((m = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line))) { // closing #s only after a space: "# C#"
        const h = inline(m[2] || "");
        out.push(`<h${m[1].length} data-slug="${esc(slug(h))}">${h}</h${m[1].length}>`);
        i++;
        continue;
      }
      if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^ {0,3}>/.test(line)) {
        const q = [];
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^ {0,3}> ?/, ""));
        out.push(`<blockquote>${block(q.join("\n"))}</blockquote>`);
        continue;
      }
      if (tableAt(lines, i)) {
        const cells = (l) => l.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes("|") && !blank(lines[i]); i++) rows.push(cells(lines[i]));
        const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c || "")}</${tag}>`;
        out.push(`<table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k], k)).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      if (ITEM.test(line) && line.search(/\S/) <= 3) { i = list(lines, i, out); continue; }
      const para = [line];
      for (i++; i < lines.length; i++) {
        const l = lines[i];
        if (blank(l) || startsBlock(l)) break;
        para.push(l);
      }
      out.push(`<p>${inline(para.join("\n"))}</p>`);
    }
    return out.join("\n");
  }

  function render(text) {
    seen = new Map();
    return block(text);
  }

  globalThis.MD = { render };
})();
