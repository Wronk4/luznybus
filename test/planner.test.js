import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoNetwork } from '../server/network/build.js';
import { planJourneys } from '../server/planner/raptor.js';

const net = buildDemoNetwork('weekday');
const tt = {
  times: (ti) => ({ arr: net.trips[ti].schedArr, dep: net.trips[ti].schedDep, realtime: false }),
  occ: () => ({ x: 20, P: 25, pOver: 0 }),
};
const at = (id) => { const s = net.stops[net.stopIndex.get(id)]; return { lat: s.lat, lng: s.lng }; };

test('bezpośrednie połączenie jedną linią', () => {
  const js = planJourneys(net, tt, { from: at('BAR'), to: at('SLO'), time: 8 * 3600 });
  assert.ok(js.length > 0);
  const best = js.reduce((a, b) => (b.arr < a.arr ? b : a));
  const rides = best.legs.filter((l) => l.type === 'ride');
  assert.equal(rides.length, 1);
  assert.equal(rides[0].line, '1');
  assert.ok(best.dep >= 8 * 3600 - 60);
  for (let i = 1; i < best.legs.length; i++) assert.ok(best.legs[i].dep >= best.legs[i - 1].arr - 1, 'odcinki w kolejności');
});

test('połączenie z przesiadką', () => {
  // Przybyszówka (3) → Zalesie (14 / 26): wymaga przesiadki
  const js = planJourneys(net, tt, { from: at('PRZ'), to: at('MAT'), time: 9 * 3600 });
  assert.ok(js.length > 0);
  assert.ok(js.some((j) => j.transfers >= 1));
  assert.ok(js.some((j) => j.tags.includes('fastest')));
});

test('tłok zwiększa koszt podróży w trybie wygodnym', () => {
  const crowded = { ...tt, occ: () => ({ x: 85, P: 25, pOver: 0.3 }) };
  const a = planJourneys(net, tt, { from: at('BAR'), to: at('SLO'), time: 8 * 3600 });
  const b = planJourneys(net, crowded, { from: at('BAR'), to: at('SLO'), time: 8 * 3600 });
  assert.ok(Math.min(...b.map((j) => j.cost)) > Math.min(...a.map((j) => j.cost)));
});
