// Wspólny model sieci (z demo albo z GTFS):
//   stops[], routes[], patterns[] (linia + kierunek + kolejność przystanków), trips[] (kursy z rozkładem)
import { haversine, cumulative, projectOnPath } from '../lib/geo.js';
import { CITY, STOPS, LINES, VEHICLES, headwayMin, schedTrafficFactor } from './demo-network.js';

export const WALK_SPEED = 1.25; // m/s
export const WALK_DETOUR = 1.3; // ulice nie są w linii prostej
export const walkSeconds = (meters) => (meters * WALK_DETOUR) / WALK_SPEED;
const FOOTPATH_MAX = 400; // m – przesiadki piesze między przystankami

export function buildDemoNetwork(dayType = 'weekday') {
  const stops = STOPS.map((s, idx) => ({ ...s, idx }));
  const stopIndex = new Map(stops.map((s) => [s.id, s.idx]));
  const routes = LINES.map((l, idx) => ({
    idx,
    id: l.id,
    short: l.short,
    mode: l.mode,
    color: l.color,
    textColor: '#FFFFFF',
    capacity: VEHICLES[l.vehicle || l.mode].capacity,
    seats: VEHICLES[l.vehicle || l.mode].seats,
    speed: VEHICLES[l.vehicle || l.mode].speed,
    fixed: VEHICLES[l.vehicle || l.mode].fixed,
    k: l.k,
  }));
  const patterns = [];
  const trips = [];
  for (const line of LINES) {
    const route = routes.find((r) => r.id === line.id);
    const V = VEHICLES[line.vehicle || line.mode];
    for (const dir of [0, 1]) {
      const ids = dir === 0 ? line.stops : [...line.stops].reverse();
      const pStops = Int32Array.from(ids.map((id) => stopIndex.get(id)));
      const shape = Array.from(pStops, (si) => [stops[si].lat, stops[si].lng]);
      const p = makePattern(patterns.length, route, dir, pStops, shape, stops);
      patterns.push(p);
      // rozkład jazdy
      const offset = ((route.idx * 3 + dir * 5) % 7) * 60;
      let t = 5 * 3600 + offset;
      let n = 0;
      while (t <= 23 * 3600 + 30 * 60) {
        const h = t / 3600;
        const tf = schedTrafficFactor(line.mode, h, dayType);
        const N = pStops.length;
        const schedArr = new Float64Array(N);
        const schedDep = new Float64Array(N);
        let cur = t;
        for (let j = 0; j < N; j++) {
          if (j > 0) cur += (p.segDist[j - 1] / V.speed + V.fixed) * tf;
          schedArr[j] = Math.round(cur / 60) * 60;
          if (j > 0 && j < N - 1) cur += 20;
          schedDep[j] = Math.max(schedArr[j], Math.round(cur / 60) * 60);
        }
        schedArr[0] = schedDep[0] = t;
        trips.push({ idx: trips.length, id: `${p.id}_${String(++n).padStart(3, '0')}`, pattern: p.idx, schedArr, schedDep });
        t += headwayMin(line, h, dayType) * 60;
      }
    }
  }
  return finalize({ source: 'demo', city: CITY, stops, stopIndex, routes, patterns, trips, dayType });
}

export function makePattern(idx, route, dir, pStops, shape, stops, headsign) {
  const shapeCum = cumulative(shape);
  const stopDist = new Float64Array(pStops.length);
  let from = 0;
  for (let j = 0; j < pStops.length; j++) {
    const s = stops[pStops[j]];
    const pr = projectOnPath(shape, shapeCum, s.lat, s.lng, from);
    stopDist[j] = j === 0 ? pr.along : Math.max(stopDist[j - 1], pr.along);
    from = pr.idx;
  }
  const segDist = new Float64Array(Math.max(0, pStops.length - 1));
  for (let j = 0; j < segDist.length; j++) {
    const a = stops[pStops[j]], b = stops[pStops[j + 1]];
    segDist[j] = Math.max(stopDist[j + 1] - stopDist[j], haversine(a.lat, a.lng, b.lat, b.lng));
  }
  return {
    idx,
    id: `${route.id}_${dir}`,
    route: route.idx,
    dir,
    headsign: headsign || stops[pStops[pStops.length - 1]].name,
    stops: pStops,
    shape,
    shapeCum,
    stopDist,
    segDist,
    trips: [],
  };
}

export function finalize(net) {
  const { stops, patterns, trips } = net;
  for (const s of stops) s.patterns = [];
  for (const p of patterns) {
    p.stops.forEach((si, j) => stops[si].patterns.push({ p: p.idx, j }));
    p.trips = [];
  }
  for (const t of trips) patterns[t.pattern].trips.push(t.idx);
  for (const p of patterns) {
    p.trips.sort((a, b) => trips[a].schedDep[0] - trips[b].schedDep[0]);
    p.trips.forEach((ti, n) => {
      const prev = n > 0 ? trips[p.trips[n - 1]] : null;
      trips[ti].order = n;
      trips[ti].schedHeadway = prev ? Math.max(60, trips[ti].schedDep[0] - prev.schedDep[0]) : 900;
    });
  }
  for (const s of stops) {
    s.lines = [...new Set(s.patterns.map(({ p }) => net.routes[patterns[p].route].short))];
  }
  // przesiadki piesze
  net.footpaths = stops.map(() => []);
  for (let a = 0; a < stops.length; a++) {
    for (let b = a + 1; b < stops.length; b++) {
      const d = haversine(stops[a].lat, stops[a].lng, stops[b].lat, stops[b].lng);
      if (d <= FOOTPATH_MAX) {
        const sec = walkSeconds(d) + 30;
        net.footpaths[a].push({ to: b, sec, dist: d });
        net.footpaths[b].push({ to: a, sec, dist: d });
      }
    }
  }
  if (!net.city.center) {
    const lat = stops.reduce((s, x) => s + x.lat, 0) / stops.length;
    const lng = stops.reduce((s, x) => s + x.lng, 0) / stops.length;
    net.city.center = { lat, lng };
  }
  return net;
}

export function nearbyStops(net, lat, lng, maxDist = 1000, minCount = 3) {
  const all = net.stops
    .map((s) => ({ s, d: haversine(lat, lng, s.lat, s.lng) }))
    .sort((a, b) => a.d - b.d);
  const within = all.filter((x) => x.d <= maxDist);
  return (within.length >= minCount ? within : all.slice(0, minCount)).map((x) => ({ stop: x.s.idx, dist: x.d }));
}
