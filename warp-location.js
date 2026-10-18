// On sites going through a proxy (see warp.js): a site asking where the user is gets the proxy's
// place instead. The browser still asks the user first, as it always does, and a site that's told
// no gets nothing; once allowed, the answer is the proxy's place, even where the computer can't
// tell its own.
window.__egWarp?.patches.push((win, { lat, lon }, h) => {
  const Geo = win.Geolocation, Position = win.GeolocationPosition, Coords = win.GeolocationCoordinates;
  if (!Geo || !Position || !Coords) return;
  const made = new WeakMap(); // the answers given here, with what they say

  const answer = () => {
    const coords = Object.create(Coords.prototype);
    made.set(coords, { latitude: lat, longitude: lon, altitude: null, accuracy: 35, altitudeAccuracy: null, heading: null, speed: null });
    const position = Object.create(Position.prototype);
    made.set(position, { coords, timestamp: Date.now() });
    return position;
  };
  for (const [type, keys] of [[Coords, ["latitude", "longitude", "altitude", "accuracy", "altitudeAccuracy", "heading", "speed"]], [Position, ["coords", "timestamp"]]]) {
    for (const key of keys) h.getter(type.prototype, key, function (get) { return made.has(this) ? made.get(this)[key] : get.call(this); });
    h.method(type.prototype, "toJSON", (fn) => function () {
      if (!made.has(this)) return fn.call(this);
      const out = {};
      for (const key of keys) out[key] = key === "coords" ? this.coords.toJSON() : made.get(this)[key];
      return out;
    });
  }

  // The browser's own answer is asked for (that's what asks the user) and replaced. Turned down
  // by the user, the site hears so; the computer not knowing where it is doesn't matter.
  const wrap = (fn) => function (success, error, options) {
    if (typeof success !== "function" || (error != null && typeof error !== "function")) return fn.call(this, success, error, options);
    return fn.call(this,
      () => success(answer()),
      (err) => (err.code === err.PERMISSION_DENIED ? error?.(err) : success(answer())),
      options);
  };
  h.method(Geo.prototype, "getCurrentPosition", wrap);
  h.method(Geo.prototype, "watchPosition", wrap);
});
