// Import/eksport GTFS. Pozwala podmienić sieć demo na prawdziwy rozkład (np. ZTP Kraków, ZTM Warszawa).
import fs from 'node:fs';
import path from 'node:path';
import { finalize, makePattern } from './build.js';
import { weekdayOfDate } from '../lib/time.js';
import { haversine } from '../lib/geo.js';
import { VEHICLES } from './demo-network.js';

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function readTable(dir, name, required = true) {
  const f = path.join(dir, name);
  if (!fs.existsSync(f)) {
    if (required) throw new Error(`GTFS: brak pliku ${name}`);
    return [];
  }
  return parseCsv(fs.readFileSync(f, 'utf8'));
}

const toSec = (t) => {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

function activeServices(calendar, calendarDates, date) {
  const ymd = date.replaceAll('-', '');
  const wd = { Mon: 'monday', Tue: 'tuesday', Wed: 'wednesday', Thu: 'thursday', Fri: 'friday', Sat: 'saturday', Sun: 'sunday' }[weekdayOfDate(date)];
  const set = new Set();
  for (const c of calendar) if (c[wd] === '1' && c.start_date <= ymd && c.end_date >= ymd) set.add(c.service_id);
  for (const c of calendarDates) {
    if (c.date !== ymd) continue;
    if (c.exception_type === '1') set.add(c.service_id);
    if (c.exception_type === '2') set.delete(c.service_id);
  }
  // jeśli feed nie obejmuje tej daty – bierzemy wszystkie (lepsze to niż pusta mapa w demo)
  if (set.size === 0) for (const c of calendar) set.add(c.service_id);
  return set;
}

export function loadGtfs(dir, { date, dayType }) {
  const stopsRaw = readTable(dir, 'stops.txt');
  const routesRaw = readTable(dir, 'routes.txt');
  const tripsRaw = readTable(dir, 'trips.txt');
  const stRaw = readTable(dir, 'stop_times.txt');
  const services = activeServices(readTable(dir, 'calendar.txt', false), readTable(dir, 'calendar_dates.txt', false), date);
  const shapesRaw = readTable(dir, 'shapes.txt', false);
  const agency = readTable(dir, 'agency.txt', false)[0];

  const stops = [];
  const stopIndex = new Map();
  for (const s of stopsRaw) {
    if (s.location_type && s.location_type !== '0') continue;
    const st = { idx: stops.length, id: s.stop_id, name: s.stop_name, lat: +s.stop_lat, lng: +s.stop_lon, w: 1, c: 0.5 };
    stopIndex.set(st.id, st.idx);
    stops.push(st);
  }
  const routes = routesRaw.map((r, idx) => {
    const mode = ['0', '900'].includes(r.route_type) ? 'tram' : 'bus';
    return {
      idx, id: r.route_id, short: r.route_short_name || r.route_long_name, mode,
      color: r.route_color ? `#${r.route_color}` : mode === 'tram' ? '#1D5FAF' : '#2B6CB0',
      textColor: r.route_text_color ? `#${r.route_text_color}` : '#FFFFFF',
      capacity: VEHICLES[mode].capacity, seats: VEHICLES[mode].seats, speed: VEHICLES[mode].speed, fixed: VEHICLES[mode].fixed, k: 0.8,
    };
  });
  const routeIdx = new Map(routes.map((r) => [r.id, r.idx]));

  const shapes = new Map();
  for (const s of shapesRaw) {
    if (!shapes.has(s.shape_id)) shapes.set(s.shape_id, []);
    shapes.get(s.shape_id).push([+s.shape_pt_sequence, +s.shape_pt_lat, +s.shape_pt_lon]);
  }
  for (const [k, v] of shapes) shapes.set(k, v.sort((a, b) => a[0] - b[0]).map(([, la, lo]) => [la, lo]));

  const tripMeta = new Map();
  for (const t of tripsRaw) if (services.has(t.service_id) && routeIdx.has(t.route_id)) tripMeta.set(t.trip_id, t);

  const times = new Map();
  for (const st of stRaw) {
    if (!tripMeta.has(st.trip_id) || !stopIndex.has(st.stop_id)) continue;
    if (!times.has(st.trip_id)) times.set(st.trip_id, []);
    times.get(st.trip_id).push([+st.stop_sequence, stopIndex.get(st.stop_id), toSec(st.arrival_time || st.departure_time), toSec(st.departure_time || st.arrival_time)]);
  }

  const patterns = [];
  const patternKey = new Map();
  const trips = [];
  for (const [tripId, rows] of times) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a[0] - b[0]);
    const meta = tripMeta.get(tripId);
    const r = routes[routeIdx.get(meta.route_id)];
    const seq = rows.map((x) => x[1]);
    const key = `${r.idx}|${seq.join(',')}`;
    let p = patternKey.get(key);
    if (!p) {
      const shape = (meta.shape_id && shapes.get(meta.shape_id)) || seq.map((si) => [stops[si].lat, stops[si].lng]);
      p = makePattern(patterns.length, r, +meta.direction_id || 0, Int32Array.from(seq), shape, stops, meta.trip_headsign);
      p.id = `${r.id}_${patterns.length}`;
      patterns.push(p);
      patternKey.set(key, p);
    }
    trips.push({
      idx: trips.length, id: tripId, pattern: p.idx,
      schedArr: Float64Array.from(rows.map((x) => x[2])),
      schedDep: Float64Array.from(rows.map((x) => x[3])),
      seq: Int32Array.from(rows.map((x) => x[0])),
    });
  }
  // usuń przystanki bez kursów, przenumeruj
  const used = new Set();
  for (const p of patterns) p.stops.forEach((s) => used.add(s));
  const remap = new Map();
  const kept = stops.filter((s) => used.has(s.idx));
  kept.forEach((s, i) => { remap.set(s.idx, i); s.idx = i; });
  for (const p of patterns) p.stops = Int32Array.from(p.stops, (s) => remap.get(s));

  // heurystyczne wagi przystanków (tylko dla symulatora): liczba kursów + bliskość centrum
  const cnt = new Float64Array(kept.length);
  for (const t of trips) for (const s of patterns[t.pattern].stops) cnt[s]++;
  const lat0 = kept.reduce((a, s) => a + s.lat, 0) / kept.length;
  const lng0 = kept.reduce((a, s) => a + s.lng, 0) / kept.length;
  const maxD = Math.max(...kept.map((s) => haversine(lat0, lng0, s.lat, s.lng)));
  const meanCnt = cnt.reduce((a, b) => a + b, 0) / (cnt.length || 1);
  for (const s of kept) {
    s.w = Math.sqrt(cnt[s.idx] / meanCnt);
    s.c = 1 - haversine(lat0, lng0, s.lat, s.lng) / maxD;
  }
  return finalize({
    source: 'gtfs',
    city: { name: agency?.agency_name || 'GTFS', center: { lat: lat0, lng: lng0 } },
    stops: kept,
    stopIndex: new Map(kept.map((s) => [s.id, s.idx])),
    routes, patterns, trips, dayType,
  });
}

const fmt = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
};
const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : v)).join(',')).join('\n') + '\n';

/** Eksport sieci do GTFS (np. sieć demo → GTFS, przydatne do testów i narzędzi zewnętrznych). */
export function exportGtfs(net, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, rows) => fs.writeFileSync(path.join(dir, name), csv(rows));
  w('agency.txt', [['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], ['LB', net.city.name, 'https://example.com', 'Europe/Warsaw']]);
  w('stops.txt', [['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], ...net.stops.map((s) => [s.id, s.name, s.lat, s.lng])]);
  w('routes.txt', [['route_id', 'agency_id', 'route_short_name', 'route_type', 'route_color'],
    ...net.routes.map((r) => [r.id, 'LB', r.short, r.mode === 'tram' ? 0 : 3, r.color.slice(1)])]);
  w('calendar.txt', [['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    ['ALL', 1, 1, 1, 1, 1, 1, 1, '20200101', '20991231']]);
  w('trips.txt', [['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id'],
    ...net.trips.map((t) => { const p = net.patterns[t.pattern]; return [net.routes[p.route].id, 'ALL', t.id, p.headsign, p.dir]; })]);
  const st = [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence']];
  for (const t of net.trips) {
    const p = net.patterns[t.pattern];
    p.stops.forEach((si, j) => st.push([t.id, fmt(t.schedArr[j]), fmt(t.schedDep[j]), net.stops[si].id, j + 1]));
  }
  w('stop_times.txt', st);
}
