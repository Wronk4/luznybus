import test from 'node:test';
import assert from 'node:assert/strict';
import { censoredMoments, levelOf, levelProbs, describe } from '../server/model/occupancy.js';
import { Rng } from '../server/lib/rng.js';

test('momenty rozkładu ocenzurowanego zgadzają się z Monte Carlo', () => {
  const rng = new Rng(1);
  for (const [mu, sd, cap] of [[50, 10, 90], [85, 15, 90], [120, 20, 90], [-5, 8, 90]]) {
    const c = censoredMoments(mu, sd * sd, 0, cap);
    let s = 0, s2 = 0, over = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const x = rng.normal(mu, sd);
      const y = Math.min(cap, Math.max(0, x));
      s += y; s2 += y * y; over += Math.max(0, x - cap);
    }
    const m = s / n;
    assert.ok(Math.abs(c.mean - m) < 0.15, `mean ${c.mean} vs ${m}`);
    assert.ok(Math.abs(Math.sqrt(c.var) - Math.sqrt(s2 / n - m * m)) < 0.15);
    assert.ok(Math.abs(c.over - over / n) < 0.15);
  }
});

test('poziomy i prawdopodobieństwa', () => {
  assert.equal(levelOf(0.1), 0);
  assert.equal(levelOf(0.4), 1);
  assert.equal(levelOf(0.7), 2);
  assert.equal(levelOf(0.95), 3);
  const p = levelProbs(45, 25, 90);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const d = describe(10, 4, 90, 30);
  assert.equal(d.level, 0);
  assert.ok(d.seatProb > 0.99);
});
