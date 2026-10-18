// On sites going through a proxy (see warp.js): the page's dates and times follow the proxy's time
// zone. A date's local hours, days and offset, how it's written out, dates made from local parts or
// text without a zone, and every date format that doesn't name its own time zone. Scripts in the
// page's background workers aren't reached and still see the computer's own.
window.__egWarp?.patches.push((win, { zone }, h) => {
  const D = win.Date, P = D.prototype;
  const DTF = win.Intl.DateTimeFormat;
  const time = (d) => P.getTime.call(d); // throws for what isn't a date, as the browser's own do
  const scratch = new D(0);
  const ownOffset = P.getTimezoneOffset; // the computer's own, before it's replaced below

  // How far the zone's clock is ahead of UTC at t, in ms. Offsets only change on a quarter hour,
  // so one look-up does for each.
  const wall = new DTF("en-US", { timeZone: zone, hourCycle: "h23", era: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const offsets = new Map();
  const ahead = (t) => {
    const q = Math.floor(t / 9e5) * 9e5;
    let v = offsets.get(q);
    if (v === undefined) {
      const p = {};
      for (const part of wall.formatToParts(q)) p[part.type] = part.value;
      const year = /^B/.test(p.era) ? 1 - p.year : +p.year;
      scratch.setTime(0);
      scratch.setUTCFullYear(year, p.month - 1, p.day);
      scratch.setUTCHours(p.hour, p.minute, p.second, 0);
      v = scratch.getTime() - q;
      if (offsets.size > 5000) offsets.clear();
      offsets.set(q, v);
    }
    return v;
  };
  // The time whose clock in the zone reads local (local parts counted as if they were UTC), with
  // the offsets of the day before and after: a time that happens twice (clocks going back) is the
  // earlier one, and one that never happens (clocks going forward) counts on from before the change.
  const fromLocal = (local) => {
    if (Number.isNaN(local)) return NaN;
    const before = ahead(local - 864e5), after = ahead(local + 864e5);
    const fits = [local - before, local - after].filter((t) => t + ahead(t) === local);
    return fits.length ? Math.min(...fits) : local - before;
  };
  // The zone's clock at t, as a date whose UTC parts read it.
  const clock = (t) => new D(t + ahead(t));

  // Reading a date's local parts.
  const parts = { FullYear: 0, Month: 0, Date: 0, Day: 0, Hours: 0, Minutes: 0, Seconds: 0, Milliseconds: 0 };
  for (const part of Object.keys(parts)) {
    const utc = P[`getUTC${part}`];
    h.method(P, `get${part}`, () => function () {
      const t = time(this);
      return Number.isNaN(t) ? NaN : utc.call(clock(t));
    });
  }
  h.method(P, "getYear", () => function () {
    const t = time(this);
    return Number.isNaN(t) ? NaN : P.getUTCFullYear.call(clock(t)) - 1900;
  });
  h.method(P, "getTimezoneOffset", () => function () {
    const t = time(this);
    return Number.isNaN(t) ? NaN : -Math.round(ahead(t) / 6e4);
  });

  // Setting them.
  for (const part of ["FullYear", "Month", "Date", "Hours", "Minutes", "Seconds", "Milliseconds"]) {
    const utc = P[`setUTC${part}`];
    h.method(P, `set${part}`, () => function (...args) {
      const t = time(this);
      // An invalid date stays so, except that setting its year starts from 0:00 on Jan 1, 1970.
      const local = Number.isNaN(t) ? new D(part === "FullYear" ? 0 : NaN) : clock(t);
      utc.apply(local, args);
      return P.setTime.call(this, fromLocal(local.getTime()));
    });
  }
  h.method(P, "setYear", () => function (year) {
    const y = Math.trunc(Number(year));
    if (Number.isNaN(y)) return P.setTime.call(this, NaN);
    return P.setFullYear.call(this, y >= 0 && y <= 99 ? 1900 + y : y);
  });

  // Text without a time zone reads as local time; with one (or a date alone), as the browser does.
  const parse = D.parse;
  const zoned = /\d\d:\d\d(:\d\d(\.\d+)?)?\s*(z|[+-]\d\d:?\d\d)\b|\b(gmt|utc|ut|[ecmp][sd]t)\b|^\s*[+-]?\d{4,6}(-\d\d(-\d\d)?)?\s*$/i;
  const parseLocal = (text) => {
    const t = parse(text);
    if (Number.isNaN(t) || zoned.test(text)) return t;
    return fromLocal(t - ownOffset.call(new D(t)) * 6e4); // its parts, read in the computer's own zone
  };
  h.method(D, "parse", () => function (text) { return parseLocal(`${text}`); });

  // Writing a date out.
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const zoneName = new DTF(undefined, { timeZone: zone, timeZoneName: "long" });
  const dateText = (t) => {
    const c = clock(t);
    const y = c.getUTCFullYear();
    return `${DAYS[c.getUTCDay()]} ${MONTHS[c.getUTCMonth()]} ${pad(c.getUTCDate())} ${y < 0 ? `-${pad(-y, 4)}` : pad(y, 4)}`;
  };
  const timeText = (t) => {
    const c = clock(t);
    const m = Math.round(ahead(t) / 6e4);
    const name = zoneName.formatToParts(t).find((p) => p.type === "timeZoneName")?.value;
    return `${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}:${pad(c.getUTCSeconds())} GMT${m < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(m) / 60))}${pad(Math.abs(m) % 60)}${name ? ` (${name})` : ""}`;
  };
  const text = (write) => () => function () {
    const t = time(this);
    return Number.isNaN(t) ? "Invalid Date" : write(t);
  };
  h.method(P, "toString", text((t) => `${dateText(t)} ${timeText(t)}`));
  h.method(P, "toDateString", text(dateText));
  h.method(P, "toTimeString", text(timeText));

  // Date formats that don't name a time zone use the proxy's.
  const withZone = (options) => (options === undefined || (options !== null && typeof options === "object" && options.timeZone === undefined) ? { ...options, timeZone: zone } : options);
  for (const name of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
    h.method(P, name, (fn) => function (locales, options) { return fn.call(this, locales, withZone(options)); });
  }
  h.ctor(win.Intl, "DateTimeFormat", (orig, [locales, options], target) =>
    (target ? Reflect.construct(orig, [locales, withZone(options)], target) : orig(locales, withZone(options))));

  // Dates made from local parts, or from text without a zone; Date() alone writes now out.
  h.ctor(win, "Date", (orig, args, target) => {
    if (!target) return P.toString.call(new orig());
    // Years 0 to 99 mean 1900 to 1999, as Date.UTC has them already.
    if (args.length >= 2) return Reflect.construct(orig, [fromLocal(orig.UTC(...args))], target);
    if (args.length === 1 && typeof args[0] === "string") return Reflect.construct(orig, [parseLocal(args[0])], target);
    return Reflect.construct(orig, args, target);
  });

  // The newer date API, where the browser has it.
  const now = win.Temporal?.Now;
  if (now) {
    h.method(now, "timeZoneId", () => () => zone);
    for (const name of ["zonedDateTimeISO", "plainDateTimeISO", "plainDateISO", "plainTimeISO"]) {
      h.method(now, name, (fn) => function (tz = zone, ...rest) { return fn.call(this, tz, ...rest); });
    }
  }
});
