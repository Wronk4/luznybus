import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.js';
import { parseHHMM } from './lib/time.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

// minimalny loader .env (bez zależności)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT || 3000);
const engine = await Engine.create({
  simTime: process.env.SIM_TIME ? parseHHMM(process.env.SIM_TIME) : undefined,
  speed: Number(process.env.SIM_SPEED || 1),
  gtfsDir: process.env.GTFS_DIR ? path.resolve(ROOT, process.env.GTFS_DIR) : undefined,
  live: process.env.GTFS_RT_URL
    ? {
        rtUrl: process.env.GTFS_RT_URL,
        gtfsUrl: process.env.GTFS_URL,
        gtfsDir: process.env.GTFS_URL ? path.join(ROOT, 'data', 'gtfs-live') : path.resolve(ROOT, process.env.GTFS_DIR || 'data/gtfs'),
        intervalMs: Number(process.env.GTFS_RT_INTERVAL || 15) * 1000,
        cityName: process.env.CITY_NAME || 'Rzeszów',
      }
    : null,
});
console.log(`[LuźnyBus] tryb: ${engine.live ? 'NA ŻYWO (GTFS-RT)' : 'symulacja'}, sieć: ${engine.net.source}, ${engine.net.stops.length} przystanków, ${engine.net.trips.length} kursów; start w ${engine.initMs} ms`);

const sseClients = new Set();
setInterval(() => {
  engine.tick();
  if (!sseClients.size) return;
  const payload = `data: ${JSON.stringify(engine.vehicles())}\n\n`;
  for (const res of sseClients) res.write(payload);
}, 2000);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });
}

const latLng = (s) => {
  const [lat, lng] = String(s || '').split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};

async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  if (p === '/api/config') {
    return send(res, 200, {
      ...engine.config(),
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      googleMapId: process.env.GOOGLE_MAP_ID || 'DEMO_MAP_ID',
    });
  }
  if (p === '/api/stops') return send(res, 200, engine.stops());
  if (p === '/api/lines') return send(res, 200, engine.lines());
  if (p === '/api/vehicles') return send(res, 200, engine.vehicles());
  if (p === '/api/stats') return send(res, 200, engine.stats());
  if (p === '/api/nearby') {
    const at = latLng(q.get('at'));
    return at ? send(res, 200, engine.nearby(at.lat, at.lng)) : send(res, 400, { error: 'at=lat,lng' });
  }
  let m;
  if ((m = /^\/api\/stops\/(\d+)\/departures$/.exec(p))) {
    const d = engine.departures(Number(m[1]), { limit: Math.min(30, Number(q.get('limit') || 12)) });
    return d ? send(res, 200, d) : send(res, 404, { error: 'Nie ma takiego przystanku' });
  }
  if ((m = /^\/api\/trips\/([^/]+)$/.exec(p))) {
    const t = engine.trip(decodeURIComponent(m[1]));
    return t ? send(res, 200, t) : send(res, 404, { error: 'Nie ma takiego kursu' });
  }
  if (p === '/api/plan') {
    const from = latLng(q.get('from')), to = latLng(q.get('to'));
    if (!from || !to) return send(res, 400, { error: 'from=lat,lng&to=lat,lng' });
    return send(res, 200, engine.plan({ from, to, time: q.get('time') || undefined, mode: q.get('mode') || 'comfort' }));
  }
  if (p === '/api/reports' && req.method === 'POST') {
    const body = await readBody(req);
    const r = engine.report({ ...body, lat: Number(body.lat), lng: Number(body.lng) });
    return send(res, r.ok ? 200 : 400, r);
  }
  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(engine.vehicles())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  send(res, 404, { error: 'Nie znaleziono' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Błąd serwera' });
  }
});

server.listen(PORT, () => console.log(`[LuźnyBus] http://localhost:${PORT}`));
