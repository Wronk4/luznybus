import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeFeed, encodeForTest, occupancyStatusToLevel } from '../server/lib/gtfs-rt.js';
import { extractTxt } from '../server/lib/zip.js';
import { buildDemoNetwork } from '../server/network/build.js';
import { RealtimeFeed } from '../server/live/realtime-feed.js';
import { serviceDayEpoch } from '../server/lib/time.js';

const DATE = '2026-03-10';
const E0 = serviceDayEpoch(DATE);

function feedMsg(entities, ts) {
  return encodeForTest([
    [1, 'msg', [[1, 'string', '2.0'], [3, 'varint', ts]]],
    ...entities.map((e) => [2, 'msg', e]),
  ]);
}

test('dekoder GTFS-RT: pozycja, status, opóźnienie ujemne, obłożenie', () => {
  const buf = feedMsg([
    [[1, 'string', 'e1'], [4, 'msg', [
      [1, 'msg', [[1, 'string', 'TRIP_A']]],
      [2, 'msg', [[1, 'float', 50.04], [2, 'float', 22.01], [3, 'float', 90]]],
      [3, 'varint', 4], [4, 'varint', 1], [5, 'varint', E0 + 30000],
      [8, 'msg', [[1, 'string', 'V7'], [2, 'string', '107']]], [9, 'varint', 3],
    ]]],
    [[1, 'string', 'e2'], [3, 'msg', [
      [1, 'msg', [[1, 'string', 'TRIP_B']]],
      [2, 'msg', [[1, 'varint', 5], [3, 'msg', [[1, 'varint', -120]]]]],
      [5, 'varint', -60],
    ]]],
  ], E0 + 30010);
  const m = decodeFeed(buf);
  assert.equal(m.header.timestamp, E0 + 30010);
  const v = m.entities[0].vehicle;
  assert.equal(v.trip.tripId, 'TRIP_A');
  assert.ok(Math.abs(v.position.lat - 50.04) < 1e-4);
  assert.equal(v.currentStatus, 1);
  assert.equal(v.vehicle.label, '107');
  assert.equal(occupancyStatusToLevel(v.occupancyStatus), 2);
  const tu = m.entities[1].tripUpdate;
  assert.equal(tu.delay, -60);
  assert.equal(tu.stopTimeUpdates[0].departure.delay, -120);
});

test('ZIP: rozpakowuje tylko płaskie pliki .txt (bez ścieżek)', () => {
  // ręcznie zbudowany ZIP z dwoma wpisami: stops.txt i ../evil.txt
  const entries = [['stops.txt', 'stop_id\nA\n'], ['../evil.sh', 'rm -rf /']];
  const locals = [], central = [];
  let off = 0;
  for (const [name, text] of entries) {
    const data = zlib.deflateRawSync(Buffer.from(text));
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); central.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-zip-'));
  const files = extractTxt(Buffer.concat([...locals, cd, eocd]), path.join(dir, 'out'));
  assert.deepEqual(files, ['stops.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'stops.txt'), 'utf8'), 'stop_id\nA\n');
  assert.equal(fs.existsSync(path.join(dir, 'evil.sh')), false);
  fs.rmSync(dir, { recursive: true });
});

test('RealtimeFeed: postęp kursu, opóźnienie i pozycja z GTFS-RT', () => {
  const net = buildDemoNetwork('weekday');
  const tr = net.trips[100];
  const p = net.patterns[tr.pattern];
  const feed = new RealtimeFeed(net, { url: 'x', date: DATE });
  const now = tr.schedArr[3] + 240; // 4 min po rozkładowym przyjeździe na przystanek 3
  feed.ingest(decodeFeed(feedMsg([
    [[1, 'string', 'v'], [4, 'msg', [
      [1, 'msg', [[1, 'string', tr.id]]],
      [2, 'msg', [[1, 'float', net.stops[p.stops[3]].lat], [2, 'float', net.stops[p.stops[3]].lng]]],
      [3, 'varint', 4], [4, 'varint', 1], [5, 'varint', E0 + now],
    ]]],
  ], E0 + now)));
  // demo nie ma stop_sequence → dopasowanie po kolejności nie działa; użyjemy stop_id
  assert.equal(feed.departedCount(tr.idx, now), 0, 'bez stop_sequence/stop_id kurs nie jest dopasowany do przystanku');
  feed.ingest(decodeFeed(feedMsg([
    [[1, 'string', 'v'], [4, 'msg', [
      [1, 'msg', [[1, 'string', tr.id]]],
      [2, 'msg', [[1, 'float', 50.0], [2, 'float', 22.0]]],
      [4, 'varint', 1], [5, 'varint', E0 + now], [7, 'string', net.stops[p.stops[3]].id],
    ]]],
  ], E0 + now)));
  assert.equal(feed.departedCount(tr.idx, now), 3);
  assert.ok(feed.arrived(tr.idx, 3, now));
  assert.ok(Math.abs(feed.arr(tr.idx, 3) - now) < 1);
  assert.ok(Math.abs(feed.dep(tr.idx, 6) - (tr.schedDep[6] + 240)) < 1, 'przyszłe przystanki = rozkład + opóźnienie');
  assert.ok(feed.position(tr.idx, now));
  assert.equal(feed.isLive(tr.idx, now + 600), false, 'stare dane przestają być "na żywo"');
});
