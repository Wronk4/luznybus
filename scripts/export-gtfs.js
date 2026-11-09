// Eksport sieci demo do GTFS: node scripts/export-gtfs.js [katalog]
import path from 'node:path';
import { buildDemoNetwork } from '../server/network/build.js';
import { exportGtfs } from '../server/network/gtfs.js';
const dir = path.resolve(process.argv[2] || 'data/gtfs-export');
exportGtfs(buildDemoNetwork('weekday'), dir);
console.log(`Zapisano GTFS do ${dir}`);
