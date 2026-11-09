import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoNetwork } from '../server/network/build.js';
import { simulateDay, dayScenario } from '../server/sim/world.js';
import { trainHistory } from '../server/model/history.js';
import { LiveFeed } from '../server/sim/feed.js';
import { Predictor } from '../server/model/predictor.js';
import { levelOf } from '../server/model/occupancy.js';

test('predykcja na 5–15 min jest lepsza od średniej historycznej', () => {
  const net = buildDemoNetwork('weekday');
  const date = '2026-03-10';
  const hist = trainHistory(net, { date, days: 10 });
  const seed = `day-${date}`;
  const truth = simulateDay(net, { seed, ...dayScenario(net, seed) });
  const pred = new Predictor(net, hist, new LiveFeed(net, truth));
  let n = 0, ef = 0, eb = 0, af = 0, ab = 0;
  for (let t = 6 * 3600; t <= 19 * 3600; t += 60) {
    pred.update(t);
    if (t % 900) continue;
    for (const tr of net.trips) {
      const pr = pred.fresh(tr.idx);
      if (!pr || truth.apc[tr.idx]) continue;
      const p = net.patterns[tr.pattern];
      const cap = net.routes[p.route].capacity;
      for (let j = 0; j < p.stops.length - 1; j++) {
        const lead = pr.dep[j] - t;
        if (lead < 300 || lead > 900) continue;
        const x = truth.load[tr.idx][j];
        const base = hist.meanLoad(p.idx, j, tr.schedDep[j]);
        n++;
        ef += Math.abs(pr.x[j] - x);
        eb += Math.abs(base - x);
        af += levelOf(pr.x[j] / cap) === levelOf(x / cap);
        ab += levelOf(base / cap) === levelOf(x / cap);
      }
    }
  }
  assert.ok(n > 1000, `za mało próbek: ${n}`);
  assert.ok(ef / n < 0.9 * (eb / n), `MAE fused ${ef / n} vs base ${eb / n}`);
  assert.ok(af >= ab, `trafność ${af / n} vs ${ab / n}`);
});

test('reputacja: trolle tracą zaufanie, rzetelni zyskują', () => {
  const net = buildDemoNetwork('weekday');
  const date = '2026-03-11';
  const hist = trainHistory(net, { date, days: 3 });
  const seed = `day-${date}`;
  const truth = simulateDay(net, { seed, ...dayScenario(net, seed), reportRate: 0.2 });
  const pred = new Predictor(net, hist, new LiveFeed(net, truth));
  for (let t = 5 * 3600; t <= 22 * 3600; t += 120) pred.update(t);
  const users = [...pred.rep.users.entries()].filter(([, u]) => u.n >= 5);
  assert.ok(users.length > 20);
  const s = pred.rep.summary();
  assert.ok(s.trusted > s.untrusted, JSON.stringify(s));
});
