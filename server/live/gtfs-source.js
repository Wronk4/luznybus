// Pobieranie statycznego rozkładu GTFS z URL (raz na dobę) i rozpakowanie do data/gtfs-live/.
import fs from 'node:fs';
import path from 'node:path';
import { extractTxt } from '../lib/zip.js';

const MAX_ZIP = 200 * 1024 * 1024;

export async function ensureGtfs({ url, dir, maxAgeHours = 24, fetchImpl = fetch, log = console.log }) {
  const metaFile = path.join(dir, 'meta.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* brak */ }
  const fresh = meta && meta.url === url && Date.now() - meta.downloadedAt < maxAgeHours * 3600e3 && fs.existsSync(path.join(dir, 'stop_times.txt'));
  if (fresh) return { dir, meta, cached: true };
  try {
    log(`[GTFS] pobieram rozkład: ${url}`);
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'LuznyBus/0.1 (projekt studencki)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_ZIP) throw new Error(`plik za duży (${len} B)`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ZIP) throw new Error('plik za duży');
    const tmp = `${dir}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    const files = extractTxt(buf, tmp);
    for (const req of ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']) {
      if (!files.includes(req)) throw new Error(`w archiwum brakuje ${req}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    meta = { url, downloadedAt: Date.now(), bytes: buf.length, files };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    log(`[GTFS] zapisano ${files.length} plików (${(buf.length / 1e6).toFixed(1)} MB)`);
    return { dir, meta, cached: false };
  } catch (e) {
    if (meta && fs.existsSync(path.join(dir, 'stop_times.txt'))) {
      log(`[GTFS] nie udało się odświeżyć (${e.message}) – używam poprzedniej wersji`);
      return { dir, meta, cached: true, stale: true };
    }
    throw new Error(`Nie udało się pobrać GTFS: ${e.message}`);
  }
}
