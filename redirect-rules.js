// Auto-redirect rules, shared by the background worker and the settings window.
// A rule is { domain, find, replace, auto, on }:
// - domain: where it applies. Empty = everywhere; "reddit.com" = that host and its
//   subdomains; contains "/" = URL contains it; looks like a regex (\ ( * …) = regex test.
// - find: plain text, a template with {line} {word} {number} {[chars]}, or /regex/flags.
// - replace: plain text; {1} {2}… insert template placeholders, $1 $<name> regex groups.
(() => {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const PLACEHOLDER = /\{(line|word|number|\[(?:\\.|[^\]\\])+\])\}/g;
  const PART = { line: ".*", word: "[^/?#&=]+", number: "\\d+" };

  function compileFind(find) {
    const raw = find.match(/^\/(.+)\/([a-z]*)$/);
    if (raw) return new RegExp(raw[1], raw[2]);
    if (find.match(PLACEHOLDER)) {
      let src = "", last = 0;
      for (const m of find.matchAll(PLACEHOLDER)) {
        src += esc(find.slice(last, m.index)) + `(${PART[m[1]] ?? m[1] + "+"})`;
        last = m.index + m[0].length;
      }
      return new RegExp(src + esc(find.slice(last)));
    }
    return new RegExp(esc(find));
  }

  function inScope(url, domain = "") {
    const d = domain.trim();
    if (!d) return true;
    if (/[\\()*+?[\]^$|]/.test(d)) {
      try { return new RegExp(d, "i").test(url); } catch { return false; }
    }
    if (d.includes("/")) return url.toLowerCase().includes(d.toLowerCase());
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    const want = d.toLowerCase().replace(/^\*\./, "");
    return host === want || host.endsWith(`.${want}`);
  }

  // Error message for a rule, or "" if it's fine.
  function check(rule) {
    if (!rule.find) return "";
    try { compileFind(rule.find); } catch (e) { return e.message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, "Invalid regex: "); }
    return "";
  }

  // Applies the matching rules in order. Returns { url, rules } where rules are the
  // ones that changed something; url is unchanged when none did.
  function apply(url, rules, { autoOnly = false } = {}) {
    const used = [];
    for (const rule of rules) {
      if (rule.on === false || !rule.find || (autoOnly && !rule.auto) || !inScope(url, rule.domain)) continue;
      let re;
      try { re = compileFind(rule.find); } catch { continue; }
      const target = (rule.replace || "").replace(/\{(\d+)\}/g, "$$$1");
      const next = url.replace(re, target);
      if (next !== url) {
        used.push(rule);
        url = next;
      }
    }
    return { url, rules: used };
  }

  globalThis.Redirects = { apply, check, inScope };
})();
