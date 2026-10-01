// Shared by the background worker, the content script and the settings page.
(() => {
  const DEFAULTS = {
    enabled: false,
    style: "blur", // "blur" | "bars" | "mask"
    blurPx: 8,
    barColor: "#000000",
    maskChar: "×",
    hideUntilScanned: true,
    detectors: {
      email: true, card: true, iban: true, mac: true, tokens: true,
      urlCreds: true, ipv4: true, ipv6: true, ssn: true,
    },
    rules: "",
    excludedSites: "",
  };

  const DETECTORS = {
    email: {
      label: "Email addresses", example: "jane@site.com",
      re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    },
    card: {
      label: "Card numbers", example: "4111 1111 1111 1111",
      re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
      validate: luhn,
    },
    iban: {
      label: "IBANs", example: "DE89 3704 0044 0532 0130 00",
      re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
      validate: ibanOk,
    },
    mac: {
      label: "MAC addresses", example: "a4:83:e7:1f:00:2b",
      re: /\b[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}\b/g,
    },
    tokens: {
      label: "API keys & tokens", example: "ghp_…, AKIA…, sk_live_…, JWTs",
      re: /\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35})\b/g,
    },
    urlCreds: {
      label: "Passwords in URLs", example: "https://user:pass@host",
      re: /\b[a-z][a-z0-9+.-]*:\/\/(?<blur>[^\s/?#@:]+:[^\s/?#@]+)@/gid,
    },
    ipv4: {
      label: "IPv4 addresses", example: "192.168.1.10",
      re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\.?\d)/g,
    },
    ipv6: {
      label: "IPv6 addresses", example: "2001:db8::8a2e:370:7334",
      re: /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g,
      validate: ipv6Ok,
    },
    ssn: {
      label: "US SSNs (dashed)", example: "123-45-6789",
      re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    },
  };

  function luhn(s) {
    const d = s.replace(/\D/g, "");
    if (d.length < 13 || d.length > 19 || !/^[3-6]/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = +d[d.length - 1 - i];
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }

  function ibanOk(s) {
    const v = s.replace(/ /g, "");
    if (v.length < 15 || v.length > 34) return false;
    let rem = 0;
    for (const ch of v.slice(4) + v.slice(0, 4)) {
      const n = parseInt(ch, 36);
      rem = (n > 9 ? rem * 100 + n : rem * 10 + n) % 97;
    }
    return rem === 1;
  }

  function ipv6Ok(s) {
    if ((s.match(/[0-9a-f]+/gi) || []).length < 3) return false;
    try { new URL(`http://[${s}]/`); return true; } catch { return false; }
  }

  // ---- Custom rules -------------------------------------------------------

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Literal label text: any whitespace (or none, since page markup may drop it) matches.
  const literal = (s) => s.split(/\s+/).map(esc).join("\\s*");

  const PLACEHOLDER = /\{(number|word|line|\[(?:\\.|[^\]\\])+\])\}/g;
  const PLACEHOLDER_SRC = {
    number: "[+(]?\\d(?:[\\d().\\-]|\\s+(?=[\\d(+]))*\\d",
    word: "\\S+",
    line: "[\\s\\S]+",
  };
  const MIN_NUMBER_DIGITS = 4;

  function parseRule(line) {
    const raw = line.match(/^\/(.+)\/([a-z]*)$/);
    if (raw) {
      const flags = [...new Set(raw[2] + "gd")].join("");
      return { re: new RegExp(raw[1], flags), mode: /\(\?<blur>/.test(raw[1]) ? "named" : "whole" };
    }
    if (line.match(PLACEHOLDER)) {
      let src = "", last = 0;
      const kinds = [null];
      for (const m of line.matchAll(PLACEHOLDER)) {
        src += literal(line.slice(last, m.index));
        src += `(${PLACEHOLDER_SRC[m[1]] ?? m[1] + "+"})`;
        kinds.push(m[1]);
        last = m.index + m[0].length;
      }
      src += literal(line.slice(last));
      return { re: new RegExp(src, "gid"), mode: "groups", kinds };
    }
    const w = "[\\p{L}\\p{N}_]";
    const pre = /^[\p{L}\p{N}_]/u.test(line) ? `(?<!${w})` : "";
    const post = /[\p{L}\p{N}_]$/u.test(line) ? `(?!${w})` : "";
    return { re: new RegExp(pre + literal(line) + post, "giu"), mode: "whole" };
  }

  function parseRules(text = "") {
    const rules = [], errors = [];
    text.split("\n").forEach((rawLine, i) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) return;
      try { rules.push(parseRule(line)); }
      catch (e) { errors.push({ line: i + 1, message: e.message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, "Invalid regex: ") }); }
    });
    return { rules, errors };
  }

  function compile(settings) {
    const s = withDefaults(settings);
    const out = [];
    for (const [key, d] of Object.entries(DETECTORS)) {
      if (s.detectors[key]) out.push({ re: d.re, mode: d.re.hasIndices ? "named" : "whole", validate: d.validate });
    }
    return out.concat(parseRules(s.rules).rules);
  }

  // Returns merged [start, end) spans of `text` to hide.
  function findMatches(text, compiled) {
    const spans = [];
    for (const c of compiled) {
      c.re.lastIndex = 0;
      let m, guard = 0;
      while ((m = c.re.exec(text)) && guard++ < 1000) {
        if (!m[0]) { c.re.lastIndex++; continue; }
        if (c.validate && !c.validate(m[0])) continue;
        if (c.mode === "whole") spans.push([m.index, m.index + m[0].length]);
        else if (c.mode === "named") { if (m.indices.groups?.blur) spans.push([...m.indices.groups.blur]); }
        else {
          for (let g = 1; g < m.length; g++) {
            if (!m.indices[g]) continue;
            if (c.kinds[g] === "number" && m[g].replace(/\D/g, "").length < MIN_NUMBER_DIGITS) continue;
            spans.push([...m.indices[g]]);
          }
        }
      }
    }
    const trimmed = spans
      .map(([s, e]) => {
        while (s < e && /\s/.test(text[s])) s++;
        while (e > s && /\s/.test(text[e - 1])) e--;
        return [s, e];
      })
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const sp of trimmed) {
      const last = merged[merged.length - 1];
      if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
      else merged.push(sp);
    }
    return merged;
  }

  // ---- Excluded sites -----------------------------------------------------

  function parseSites(text = "") {
    const sites = [], errors = [];
    text.split("\n").forEach((rawLine, i) => {
      let h = rawLine.trim().toLowerCase();
      if (!h || h.startsWith("#")) return;
      try { if (h.includes("://")) h = new URL(h).hostname; } catch {}
      h = h.split("/")[0].split(":")[0].replace(/^\*\./, "");
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h)) sites.push(h);
      else errors.push({ line: i + 1, message: `"${rawLine.trim()}" is not a valid site` });
    });
    return { sites, errors };
  }

  const sitePatterns = (text) =>
    parseSites(text).sites.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]);

  const isExcluded = (host, text) =>
    parseSites(text).sites.some((h) => host === h || host.endsWith("." + h));

  function withDefaults(s = {}) {
    return { ...DEFAULTS, ...s, detectors: { ...DEFAULTS.detectors, ...s.detectors } };
  }

  globalThis.PIIRules = {
    DEFAULTS, DETECTORS, compile, parseRules, findMatches, parseSites, sitePatterns, isExcluded, withDefaults,
  };
})();
