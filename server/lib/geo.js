const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Skumulowane odległości wzdłuż linii łamanej [[lat,lng],...] */
export function cumulative(path) {
  const out = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) {
    out[i] = out[i - 1] + haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  }
  return out;
}

/** Punkt (i kierunek) w odległości d wzdłuż ścieżki. */
export function pointAlong(path, cum, d) {
  if (d <= 0) return { lat: path[0][0], lng: path[0][1], bearing: segBearing(path, 0) };
  const n = path.length;
  if (d >= cum[n - 1]) return { lat: path[n - 1][0], lng: path[n - 1][1], bearing: segBearing(path, n - 2) };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const f = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return {
    lat: path[lo][0] + f * (path[hi][0] - path[lo][0]),
    lng: path[lo][1] + f * (path[hi][1] - path[lo][1]),
    bearing: segBearing(path, lo),
  };
}

function segBearing(path, i) {
  i = Math.max(0, Math.min(path.length - 2, i));
  if (path.length < 2) return 0;
  return bearing(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
}

/** Najbliższy punkt na ścieżce (szukając od indeksu startowego) – do rzutowania przystanków na shape GTFS. */
export function projectOnPath(path, cum, lat, lng, fromIdx = 0) {
  let best = { d: Infinity, along: 0, idx: fromIdx };
  const kx = Math.cos(toRad(lat)) * 111320;
  const ky = 110540;
  for (let i = fromIdx; i < path.length - 1; i++) {
    const ax = path[i][1] * kx, ay = path[i][0] * ky;
    const bx = path[i + 1][1] * kx, by = path[i + 1][0] * ky;
    const px = lng * kx, py = lat * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const qx = ax + t * dx, qy = ay + t * dy;
    const dist = Math.hypot(px - qx, py - qy);
    if (dist < best.d) best = { d: dist, along: cum[i] + t * (cum[i + 1] - cum[i]), idx: i };
  }
  return best;
}
