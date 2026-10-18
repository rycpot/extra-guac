// On sites going through a proxy (see warp.js): the page sees the proxy country's language, with
// English after it, as the browser's languages and as the default for formatting dates, numbers
// and lists. The language sites are sent with each request is set to match (bg-proxy.js).
window.__egWarp?.patches.push((win, { lang }, h) => {
  const base = lang.split("-")[0];
  const languages = Object.freeze([...new Set([lang, base, "en-US", "en"])]);
  h.getter(win.Navigator.prototype, "language", () => lang);
  h.getter(win.Navigator.prototype, "languages", () => languages);

  const locale = (locales) => (locales === undefined ? lang : locales);
  for (const name of ["DateTimeFormat", "NumberFormat", "Collator", "PluralRules", "RelativeTimeFormat", "ListFormat", "Segmenter", "DisplayNames", "DurationFormat"]) {
    h.ctor(win.Intl, name, (orig, [locales, ...rest], target) =>
      (target ? Reflect.construct(orig, [locale(locales), ...rest], target) : orig(locale(locales), ...rest)));
  }
  for (const [proto, names] of [
    [win.Date.prototype, ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]],
    [win.Number.prototype, ["toLocaleString"]],
    [win.BigInt?.prototype, ["toLocaleString"]],
    [win.String.prototype, ["toLocaleUpperCase", "toLocaleLowerCase"]],
  ]) {
    for (const name of names) if (proto) h.method(proto, name, (fn) => function (locales, ...rest) { return fn.call(this, locale(locales), ...rest); });
  }
  h.method(win.String.prototype, "localeCompare", (fn) => function (that, locales, ...rest) { return fn.call(this, that, locale(locales), ...rest); });
});
