import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDemoNetwork } from '../server/network/build.js';
import { exportGtfs, loadGtfs, parseCsv } from '../server/network/gtfs.js';

test('parser CSV obsługuje cudzysłowy i BOM', () => {
  const rows = parseCsv('﻿a,b\n"x, y","z ""q"""\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'z "q"' }]);
});

test('eksport sieci demo do GTFS i ponowny import', () => {
  const net = buildDemoNetwork('weekday');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-gtfs-'));
  exportGtfs(net, dir);
  const back = loadGtfs(dir, { date: '2026-03-10', dayType: 'weekday' });
  assert.equal(back.stops.length, net.stops.length);
  assert.equal(back.trips.length, net.trips.length);
  assert.equal(back.patterns.length, net.patterns.length);
  fs.rmSync(dir, { recursive: true });
});
