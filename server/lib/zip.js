// Minimalne rozpakowywanie ZIP (bez zależności) – wystarcza do feedów GTFS.
// Archiwum to dane z zewnątrz: zapisujemy WYŁĄCZNIE płaskie pliki *.txt (bez ścieżek),
// więc nazwa w ZIP nie może wyjść poza katalog docelowy.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SAFE_NAME = /^[A-Za-z0-9_.-]+\.txt$/;
const MAX_FILE = 512 * 1024 * 1024;

export function listZip(buf) {
  // End Of Central Directory (szukamy od końca, komentarz max 64 KB)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: brak katalogu centralnego');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: uszkodzony katalog');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readEntry(buf, e) {
  if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('ZIP: zły nagłówek lokalny');
  const nameLen = buf.readUInt16LE(e.local + 26);
  const extraLen = buf.readUInt16LE(e.local + 28);
  const start = e.local + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_FILE });
  throw new Error(`ZIP: nieobsługiwana kompresja ${e.method}`);
}

/** Rozpakuj pliki *.txt z archiwum do katalogu; zwraca listę zapisanych nazw. */
export function extractTxt(buf, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const e of listZip(buf)) {
    const base = path.posix.basename(e.name.replaceAll('\\', '/'));
    if (!SAFE_NAME.test(base) || e.size > MAX_FILE) continue;
    fs.writeFileSync(path.join(dir, base), readEntry(buf, e));
    out.push(base);
  }
  return out;
}
