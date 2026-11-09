// Ewaluacja algorytmu na symulowanym dniu: npm run evaluate [YYYY-MM-DD]
import { buildDemoNetwork } from '../server/network/build.js';
import { simulateDay, dayScenario } from '../server/sim/world.js';
import { trainHistory } from '../server/model/history.js';
import { LiveFeed } from '../server/sim/feed.js';
import { Predictor } from '../server/model/predictor.js';
import { levelOf } from '../server/model/occupancy.js';
const net = buildDemoNetwork('weekday');
const date = process.argv[2] || '2026-11-09';
const hist = trainHistory(net,{date, days:14});
const seed='day-'+date; const sc=dayScenario(net, seed, {forceEventAround: 16.5*3600});
const truth = simulateDay(net,{seed,...sc});
const pred = new Predictor(net, hist, new LiveFeed(net, truth));
const H=[5,10,20]; const S={};
for (const h of H) S[h]={n:0,ef:0,eb:0,af:0,ab:0, et:0};
let t0=Date.now(), ticks=0;
for (let t=6*3600; t<=20*3600; t+=60) {
  pred.update(t); ticks++;
  if (t % 600) continue;
  for (const tr of net.trips) {
    const pr = pred.fresh(tr.idx); if (!pr || truth.apc[tr.idx]) continue;
    const p = net.patterns[tr.pattern]; const cap = net.routes[p.route].capacity;
    for (let j=0;j<p.stops.length-1;j++) {
      const lead = pr.dep[j]-t;
      for (const h of H) if (lead > (h-2.5)*60 && lead <= (h+2.5)*60) {
        const tl = truth.load[tr.idx][j]; const base = hist.meanLoad(p.idx,j,tr.schedDep[j]);
        const s=S[h]; s.n++; s.ef+=Math.abs(pr.x[j]-tl); s.eb+=Math.abs(base-tl);
        s.af+= levelOf(pr.x[j]/cap)===levelOf(tl/cap); s.ab+= levelOf(base/cap)===levelOf(tl/cap);
        s.et += Math.abs(pr.dep[j]-truth.dep[tr.idx][j]);
      }
    }
  }
}
console.log('ticks',ticks,'ms/tick',((Date.now()-t0)/ticks).toFixed(2), pred.counters, pred.rep.summary());
for (const h of H){const s=S[h]; console.log(`h=${h}min n=${s.n} MAE fused=${(s.ef/s.n).toFixed(1)} base=${(s.eb/s.n).toFixed(1)} | acc fused=${(s.af/s.n*100).toFixed(1)}% base=${(s.ab/s.n*100).toFixed(1)}% | ETA err=${(s.et/s.n).toFixed(0)}s`);}
console.log('event', sc.events.map(e=>net.stops[e.stop].name), 'anomalies', pred.anomalies().slice(0,3).map(a=>[net.stops[a.stop].name,a.factor.toFixed(2)]));
