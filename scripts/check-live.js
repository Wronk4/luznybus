// Diagnostyka danych na żywo: npm run check-live
import path from 'node:path';
import { ensureGtfs } from '../server/live/gtfs-source.js';
import { loadGtfs } from '../server/network/gtfs.js';
import { RealtimeFeed } from '../server/live/realtime-feed.js';
import { warsawParts, dayTypeOf } from '../server/lib/time.js';

const GTFS_URL = process.env.GTFS_URL || 'https://kmrzeszow.live/gtfs/latest.zip';
const RT_URL = process.env.GTFS_RT_URL || 'https://kmrzeszow.live/gtfs/rt/gtfsrt.pb';
const dir = path.resolve('data/gtfs-live');
const now = warsawParts();
let t = Date.now();
await ensureGtfs({ url: GTFS_URL, dir });
const net = loadGtfs(dir, { date: now.date, dayType: dayTypeOf(now.weekday) });
console.log(`GTFS: ${net.stops.length} przystanków, ${net.routes.length} linii, ${net.patterns.length} wariantów, ${net.trips.length} kursów dziś (${Date.now() - t} ms)`);
const feed = new RealtimeFeed(net, { url: RT_URL, date: now.date });
await feed.poll();
const st = feed.stats(now.seconds);
console.log('GTFS-RT:', st);
let shown = 0;
for (const [ti, s] of feed.state) {
  if (!s.pos || shown++ >= 5) continue;
  const tr = net.trips[ti], p = net.patterns[tr.pattern];
  console.log(` ${net.routes[p.route].short} → ${p.headsign}: przystanek ${s.k}/${p.stops.length}, opóźnienie ${Math.round(s.delay / 60)} min, poz. ${s.pos.lat.toFixed(4)},${s.pos.lng.toFixed(4)}, pojazd ${s.vehicle}`);
}
