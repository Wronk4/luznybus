// PLANER PODRÓŻY – RAPTOR (Round-bAsed Public Transit Optimized Router, Delling et al. 2012)
// na czasach z predykcji na żywo (opóźnienia), z oceną komfortu wg przewidywanego obłożenia.
//
// 1. Kilka przebiegów RAPTOR-a dla kolejnych godzin wyjścia → zbiór alternatyw (w tym
//    "poczekaj na następny kurs").
// 2. Każdą alternatywę oceniamy kosztem uogólnionym (minuty "odczuwane"):
//      jazda × mnożnik_tłoku(obłożenie, szansa na miejsce)   – wg badań nad odczuwaniem tłoku
//      + przesiadki + dojścia + ryzyko, że pojazd przyjedzie pełny i nie wsiądziesz.
// 3. Tryb "szybko" sortuje po czasie dotarcia, "wygodnie" po koszcie uogólnionym.
import { haversine } from '../lib/geo.js';
import { nearbyStops, walkSeconds } from '../network/build.js';
import { describe, normCdf } from '../model/occupancy.js';

const MIN_TRANSFER = 60;
const INF = Infinity;

/**
 * tt: dostawca czasów i obłożenia kursów:
 *   times(ti) -> {arr: Float64Array, dep: Float64Array, realtime: bool}
 *   occ(ti, j) -> {x, P}
 */
export function planJourneys(net, tt, { from, to, time, maxTransfers = 3, alternatives = 6, horizon = 50 * 60 }) {
  const access = nearbyStops(net, from.lat, from.lng, 900, 3).map((a) => ({ ...a, sec: walkSeconds(a.dist) }));
  const egress = nearbyStops(net, to.lat, to.lng, 900, 3).map((a) => ({ ...a, sec: walkSeconds(a.dist) }));
  const direct = haversine(from.lat, from.lng, to.lat, to.lng);
  const results = [];
  const seen = new Set();
  if (direct < 1500) {
    results.push(walkOnly(from, to, time, direct));
  }
  let t = time;
  for (let iter = 0; iter < alternatives + 3 && t <= time + horizon; iter++) {
    const found = raptor(net, tt, access, egress, t, maxTransfers);
    if (!found.length) break;
    let nextT = INF;
    for (const j of found) {
      const rides = j.raw.filter((l) => l.type === 'ride');
      const sig = rides.map((l) => `${l.trip}:${l.boardIdx}:${l.alightIdx}`).join('|');
      const firstRide = rides[0];
      const accessDur = j.raw[0].type === 'access' ? j.raw[0].dur : 0;
      if (firstRide) nextT = Math.min(nextT, tt.times(firstRide.trip).dep[firstRide.boardIdx] - accessDur + 30);
      if (seen.has(sig)) continue;
      seen.add(sig);
      results.push(j);
    }
    if (nextT === INF || nextT <= t) break;
    t = nextT;
  }
  return finishJourneys(net, tt, results, { from, to, time });
}

function walkOnly(from, to, time, dist) {
  const dur = walkSeconds(dist);
  return { legs: [{ type: 'walk', from: { ...from }, to: { ...to }, dep: time, arr: time + dur, dur, dist }], arr: time + dur, dep: time };
}

function raptor(net, tt, access, egress, t0, maxTransfers) {
  const nS = net.stops.length;
  const K = maxTransfers + 1;
  const tau = [new Float64Array(nS).fill(INF)];
  const label = [new Array(nS)];
  const best = new Float64Array(nS).fill(INF);
  let marked = new Set();
  for (const a of access) {
    const at = t0 + a.sec;
    if (at < tau[0][a.stop]) {
      tau[0][a.stop] = at;
      best[a.stop] = at;
      label[0][a.stop] = { type: 'access', dur: a.sec, dist: a.dist };
      marked.add(a.stop);
    }
  }
  const egressMap = new Map(egress.map((e) => [e.stop, e]));
  let bestTarget = INF;
  const journeys = [];
  const tripCache = new Map();
  const times = (ti) => {
    let v = tripCache.get(ti);
    if (!v) tripCache.set(ti, (v = tt.times(ti)));
    return v;
  };

  for (let k = 1; k <= K && marked.size; k++) {
    tau[k] = Float64Array.from(tau[k - 1]);
    label[k] = new Array(nS);
    // kolejka wzorców tras do przejrzenia
    const Q = new Map();
    for (const s of marked) {
      for (const { p, j } of net.stops[s].patterns) {
        const cur = Q.get(p);
        if (cur === undefined || j < cur) Q.set(p, j);
      }
    }
    const newMarked = new Set();
    for (const [pi, j0] of Q) {
      const p = net.patterns[pi];
      const N = p.stops.length;
      let cur = -1, curT = null, boardIdx = -1;
      for (let j = j0; j < N; j++) {
        const s = p.stops[j];
        if (cur >= 0) {
          const at = curT.arr[j];
          if (at < Math.min(best[s], bestTarget)) {
            tau[k][s] = at;
            best[s] = at;
            label[k][s] = { type: 'ride', trip: cur, pattern: pi, boardIdx, alightIdx: j, boardStop: p.stops[boardIdx], dep: curT.dep[boardIdx], arr: at };
            newMarked.add(s);
          }
        }
        // czy da się złapać wcześniejszy kurs na tym przystanku?
        const ready = tau[k - 1][s] + (k > 1 ? MIN_TRANSFER : 0);
        if (ready < INF && j < N - 1 && (cur < 0 || ready <= curT.dep[j])) {
          const cand = earliestTrip(net, p, j, ready, times);
          if (cand && (cur < 0 || cand.t.dep[j] < curT.dep[j])) {
            cur = cand.ti; curT = cand.t; boardIdx = j;
          }
        }
      }
    }
    // przejścia piesze między przystankami (tylko z przystanków osiągniętych jazdą)
    const rideArr = [...newMarked].map((s) => [s, tau[k][s]]);
    for (const [s, at] of rideArr) {
      for (const f of net.footpaths[s]) {
        const wt = at + f.sec;
        if (wt < Math.min(tau[k][f.to], best[f.to], bestTarget)) {
          tau[k][f.to] = wt;
          best[f.to] = wt;
          label[k][f.to] = { type: 'walk', from: s, dur: f.sec, dist: f.dist, dep: at, arr: wt };
          newMarked.add(f.to);
        }
      }
    }
    // cel
    let bestE = null;
    for (const s of newMarked) {
      const e = egressMap.get(s);
      if (!e) continue;
      const at = tau[k][s] + e.sec;
      if (at < bestTarget) { bestTarget = at; bestE = e; }
    }
    if (bestE) {
      const legs = reconstruct(net, label, tau, k, bestE.stop);
      if (legs) {
        legs.push({ type: 'egress', stop: bestE.stop, dur: bestE.sec, dist: bestE.dist });
        journeys.push({ legs, rounds: k });
      }
    }
    marked = newMarked;
  }
  return journeys.map((j) => materialize(net, j, t0));
}

function earliestTrip(net, p, j, ready, times) {
  // kursy posortowane po rozkładzie; z opóźnieniami kolejność może się zmienić → skan z marginesem
  const trips = p.trips;
  let lo = 0, hi = trips.length;
  const lim = ready - 3600;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (net.trips[trips[mid]].schedDep[j] < lim) lo = mid + 1;
    else hi = mid;
  }
  let best = null;
  for (let n = lo; n < trips.length; n++) {
    const ti = trips[n];
    const tr = net.trips[ti];
    if (tr.schedDep[j] > ready + 3 * 3600) break;
    if (best && tr.schedDep[j] > best.t.dep[j] + 1800) break;
    const t = times(ti);
    if (t.dep[j] >= ready && (!best || t.dep[j] < best.t.dep[j])) best = { ti, t };
  }
  return best;
}

function reconstruct(net, label, tau, k, stop) {
  const legs = [];
  let r = k, s = stop;
  let guard = 0;
  while (guard++ < 20) {
    let rr = r;
    while (rr >= 0 && !label[rr][s]) rr--;
    if (rr < 0) return null;
    const L = label[rr][s];
    if (L.type === 'access') { legs.push({ type: 'access', stop: s, dur: L.dur, dist: L.dist }); break; }
    if (L.type === 'walk') { legs.push({ type: 'transfer', fromStop: L.from, toStop: s, dur: L.dur, dist: L.dist }); s = L.from; r = rr; continue; }
    legs.push({ type: 'ride', trip: L.trip, pattern: L.pattern, boardIdx: L.boardIdx, alightIdx: L.alightIdx });
    s = L.boardStop;
    r = rr - 1;
  }
  return legs.reverse();
}

/** Zamiana etykiet na pełne odcinki z czasami (dojścia "na styk" przed odjazdem). */
function materialize(net, j, t0) {
  return { raw: j.legs, t0 };
}

function finishJourneys(net, tt, list, { from, to, time }) {
  const out = [];
  for (const item of list) {
    if (item.legs && !item.raw) { out.push(scoreJourney(net, tt, item, time)); continue; }
    const legs = [];
    const raw = item.raw;
    // czasy jazdy
    const rides = raw.filter((l) => l.type === 'ride').map((l) => ({ ...l, t: tt.times(l.trip) }));
    if (!rides.length) continue;
    let ri = 0;
    for (let i = 0; i < raw.length; i++) {
      const l = raw[i];
      if (l.type === 'access') {
        const r = rides[0];
        const st = net.stops[l.stop];
        const dep = r.t.dep[r.boardIdx] - l.dur - 60; // wychodzisz z zapasem 1 min
        legs.push({ type: 'walk', from: { ...from }, to: stopRef(st), dep, arr: dep + l.dur, dur: l.dur, dist: l.dist });
      } else if (l.type === 'ride') {
        const r = rides[ri++];
        legs.push(rideLeg(net, tt, r));
      } else if (l.type === 'transfer') {
        const prev = legs[legs.length - 1];
        legs.push({ type: 'walk', from: stopRef(net.stops[l.fromStop]), to: stopRef(net.stops[l.toStop]), dep: prev.arr, arr: prev.arr + l.dur, dur: l.dur, dist: l.dist });
      } else if (l.type === 'egress') {
        const prev = legs[legs.length - 1];
        legs.push({ type: 'walk', from: stopRef(net.stops[l.stop]), to: { ...to }, dep: prev.arr, arr: prev.arr + l.dur, dur: l.dur, dist: l.dist });
      }
    }
    if (legs[0].dep < time) {
      // nie możemy wyjść przed "teraz" – przesuń pierwszy spacer
      const d = time - legs[0].dep;
      legs[0].dep += d; legs[0].arr += Math.min(d, 60);
    }
    out.push(scoreJourney(net, tt, { legs, dep: legs[0].dep, arr: legs[legs.length - 1].arr }, time));
  }
  // usuń zdominowane (później wyjście nic nie daje i jest mniej wygodne/wolniejsze z tą samą liczbą przesiadek)
  out.sort((a, b) => a.arr - b.arr);
  const filtered = out.filter((j, i) => !out.some((o, k) => k !== i && o.arr <= j.arr && o.dep >= j.dep && o.transfers <= j.transfers && o.cost < j.cost - 0.5));
  // różnorodność: max 3 warianty z tą samą sekwencją linii
  const perSig = new Map();
  const diverse = filtered.filter((j) => {
    const sig = j.legs.filter((l) => l.type === 'ride').map((l) => l.line).join('>') || 'walk';
    const n = perSig.get(sig) || 0;
    perSig.set(sig, n + 1);
    return n < 3;
  });
  return tag(diverse.slice(0, 8));
}

const stopRef = (s) => ({ stop: s.idx, id: s.id, name: s.name, lat: s.lat, lng: s.lng });

function rideLeg(net, tt, r) {
  const p = net.patterns[r.pattern];
  const route = net.routes[p.route];
  const tr = net.trips[r.trip];
  const stops = [];
  const profile = [];
  let crowdSec = 0, rideSec = 0, maxRatio = 0, sumRatio = 0;
  for (let j = r.boardIdx; j <= r.alightIdx; j++) {
    const s = net.stops[p.stops[j]];
    stops.push({ ...stopRef(s), arr: r.t.arr[j], dep: r.t.dep[j] });
    if (j < r.alightIdx) {
      const o = tt.occ(r.trip, j);
      const ratio = o.x / route.capacity;
      const seg = r.t.arr[j + 1] - r.t.dep[j];
      profile.push(Math.round(ratio * 100) / 100);
      maxRatio = Math.max(maxRatio, ratio);
      sumRatio += ratio * seg;
      rideSec += seg;
      crowdSec += seg * crowdMultiplier(o, route) ;
    }
  }
  const ob = tt.occ(r.trip, r.boardIdx);
  const atBoard = describe(ob.x, ob.P, route.capacity, route.seats, { boardRisk: Math.round((ob.pOver || 0) * 100) / 100 });
  return {
    type: 'ride',
    trip: r.trip,
    tripId: tr.id,
    line: route.short,
    routeId: route.id,
    mode: route.mode,
    color: route.color,
    textColor: route.textColor,
    headsign: p.headsign,
    from: stops[0],
    to: stops[stops.length - 1],
    dep: r.t.dep[r.boardIdx],
    arr: r.t.arr[r.alightIdx],
    schedDep: tr.schedDep[r.boardIdx],
    delay: Math.round(r.t.dep[r.boardIdx] - tr.schedDep[r.boardIdx]),
    realtime: r.t.realtime,
    stops,
    path: shapeBetween(p, r.boardIdx, r.alightIdx),
    occupancy: { ...atBoard, maxRatio: Math.round(maxRatio * 100) / 100, avgRatio: Math.round((sumRatio / (rideSec || 1)) * 100) / 100, profile },
    crowdSec,
    rideSec,
  };
}

/** Mnożnik odczuwanego czasu jazdy (≈ Wardman & Whelan: siedząc 1.0, stojąc 1.3–2.0+). */
export function crowdMultiplier(o, route) {
  const sd = Math.sqrt(Math.max(o.P, 1));
  const seat = normCdf((route.seats - o.x) / sd);
  const r = o.x / route.capacity;
  const standing = 1.25 + 1.4 * Math.max(0, r - 0.5) ** 1.5 / 0.35;
  return seat * 1.0 + (1 - seat) * standing;
}

function shapeBetween(p, a, b) {
  const da = p.stopDist[a], db = p.stopDist[b];
  const out = [];
  for (let i = 0; i < p.shape.length; i++) {
    const d = p.shapeCum[i];
    if (d >= da - 1 && d <= db + 1) out.push(p.shape[i]);
  }
  if (out.length < 2) return [p.shape[Math.min(a, p.shape.length - 1)], p.shape[Math.min(b, p.shape.length - 1)]];
  return out;
}

function scoreJourney(net, tt, j, time) {
  const rides = j.legs.filter((l) => l.type === 'ride');
  const walks = j.legs.filter((l) => l.type === 'walk');
  const walkSec = walks.reduce((s, l) => s + l.dur, 0);
  const transfers = Math.max(0, rides.length - 1);
  const rideSec = rides.reduce((s, l) => s + l.rideSec, 0);
  const crowdSec = rides.reduce((s, l) => s + l.crowdSec, 0);
  // czekanie na przystankach (w trakcie podróży)
  let waitSec = 0;
  for (let i = 1; i < j.legs.length; i++) waitSec += Math.max(0, j.legs[i].dep - j.legs[i - 1].arr);
  const risk = rides.reduce((s, l) => s + (l.occupancy.boardRisk || 0), 0);
  // koszt uogólniony [min]: czekanie w domu prawie nic nie kosztuje (wychodzisz później)
  const homeWait = Math.max(0, j.dep - time);
  const cost = (homeWait * 0.25 + walkSec * 1.6 + waitSec * 1.5 + crowdSec + transfers * 240 + risk * 600) / 60;
  return {
    ...j,
    duration: j.arr - j.dep,
    transfers,
    walkSec,
    rideSec,
    waitSec,
    cost: Math.round(cost * 10) / 10,
    comfort: rides.length ? Math.round((rideSec / Math.max(crowdSec, 1)) * 100) : 100,
    maxRatio: rides.length ? Math.max(...rides.map((l) => l.occupancy.maxRatio)) : 0,
    minSeatProb: rides.length ? Math.min(...rides.map((l) => l.occupancy.seatProb)) : 1,
    tags: [],
  };
}

function tag(list) {
  if (!list.length) return list;
  const fastest = list.reduce((a, b) => (b.arr < a.arr ? b : a));
  const comfy = list.reduce((a, b) => (b.cost < a.cost ? b : a));
  fastest.tags.push('fastest');
  if (comfy !== fastest) {
    comfy.tags.push('comfort');
    const firstRideF = fastest.legs.find((l) => l.type === 'ride');
    const firstRideC = comfy.legs.find((l) => l.type === 'ride');
    if (firstRideF && firstRideC && firstRideC.dep > firstRideF.dep && firstRideC.line === firstRideF.line && firstRideC.from.stop === firstRideF.from.stop) {
      comfy.waitHint = { minutes: Math.round((firstRideC.dep - firstRideF.dep) / 60), line: firstRideC.line, ratioNow: firstRideF.occupancy.ratio, ratioLater: firstRideC.occupancy.ratio };
    }
  } else comfy.tags.push('comfort');
  return list;
}
