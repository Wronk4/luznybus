// SYMULATOR "PRAWDZIWEGO ŚWIATA"
// Zastępuje rzeczywistość w demo: generuje ruch pojazdów (opóźnienia, zbijanie się w pary),
// pasażerów (popyt zależny od pory dnia, kierunku, wydarzeń), a z nich strumienie danych,
// które w prawdziwym wdrożeniu przychodziłyby z zewnątrz:
//   - AVL/GPS: położenie i czasy przyjazdów/odjazdów (wszystkie pojazdy),
//   - APC: liczniki pasażerów w drzwiach (tylko część floty),
//   - zgłoszenia pasażerów z aplikacji (crowdsourcing, z błędami i trollami).
// Algorytm predykcji NIE ma dostępu do tego modułu poza tymi strumieniami.
import { Rng } from '../lib/rng.js';
import { levelOf } from '../model/occupancy.js';

const H = (t) => t / 3600;
const gauss = (h, mu, sd) => Math.exp(-0.5 * ((h - mu) / sd) ** 2);

export function demandProfile(t, dayType) {
  const h = H(t);
  if (dayType === 'weekend') {
    // w weekend jeździ mniej ludzi (ok. 40–50% dnia roboczego), a rozkład jest rzadszy
    return { am: 0, pm: 0, base: 0.05 + 0.38 * gauss(h, 14, 3.5), eve: 0.15 * gauss(h, 21, 1.5) };
  }
  const day = 1 / (1 + Math.exp(-(h - 5.8) * 3)) / (1 + Math.exp((h - 20.5) * 1.5));
  return { am: gauss(h, 7.7, 0.85), pm: gauss(h, 16.4, 1.35), base: 0.07 + 0.3 * day, eve: 0.18 * gauss(h, 21.3, 1.2) };
}

const produce = (s, d) => s.w * (d.am * (1 - s.c) + d.pm * s.c + d.base + d.eve * s.c);
const attract = (s, d) => s.w * (d.am * s.c + d.pm * (1 - s.c) + d.base + d.eve * (1 - s.c));

/** Natężenie ruchu ulicznego (dla autobusów) */
function trafficTruth(mode, t, dayType) {
  if (dayType === 'weekend') return 1 + (mode === 'bus' ? 0.08 : 0.02) * gauss(H(t), 14, 3);
  const h = H(t);
  return 1 + (mode === 'bus' ? 0.4 : 0.1) * Math.max(gauss(h, 7.8, 0.9), gauss(h, 16.6, 1.2));
}

export const DEMAND_K = 0.026; // pasażerów / s na jednostkę "produkcji"
const A0 = 3; // nasycenie udziału celów w dół trasy

export function makeUsers(seed, n = 400) {
  const rng = new Rng(`users-${seed}`);
  return Array.from({ length: n }, (_, i) => {
    const r = rng.next();
    const kind = r < 0.85 ? 'good' : r < 0.95 ? 'sloppy' : 'troll';
    return { id: `sim-${String(i).padStart(3, '0')}`, kind, acc: kind === 'good' ? 0.85 : 0.55 };
  });
}

export function simulateDay(net, opts) {
  const {
    seed,
    dayType = net.dayType,
    demandMult = 1,
    trafficMult = 1,
    events = [],
    apcShare = 0.3,
    reportRate = 0.035,
    users = makeUsers(seed),
    withReports = true,
  } = opts;
  const rng = new Rng(seed);
  const { stops, patterns, trips, routes } = net;
  const nT = trips.length;
  const truth = {
    arr: new Array(nT), dep: new Array(nT), load: new Array(nT),
    board: new Array(nT), alight: new Array(nT), denied: new Array(nT),
    apc: new Uint8Array(nT), seed, demandMult, trafficMult, events,
  };
  const out = []; // strumień zdarzeń
  const eventMult = (si, t) => {
    let m = 1;
    for (const e of events) if (e.stop === si && t >= e.from && t <= e.to) m *= e.mult;
    return m;
  };
  // wspólne dla dnia: lekkie wahania popytu godzina po godzinie
  const hourly = Array.from({ length: 30 }, () => rng.lognormal(0.08));
  const share = serviceShare(net);
  const scale = net.demandScale ?? 1;

  for (const p of patterns) {
    const route = routes[p.route];
    const cap = route.capacity;
    const N = p.stops.length;
    const waiting = new Float64Array(N);
    const lastDep = new Float64Array(N).fill(NaN);
    const pStops = Array.from(p.stops, (si) => stops[si]);

    for (const ti of p.trips) {
      const tr = trips[ti];
      const arr = new Float64Array(N), dep = new Float64Array(N), load = new Float64Array(N);
      const board = new Float64Array(N), alight = new Float64Array(N), denied = new Float64Array(N);
      const hasApc = rng.next() < apcShare;
      truth.apc[ti] = hasApc ? 1 : 0;
      const incidentSeg = rng.next() < 0.03 ? Math.floor(rng.next() * (N - 1)) : -1;
      let x = 0;
      for (let j = 0; j < N; j++) {
        if (j === 0) {
          arr[0] = tr.schedDep[0] - 120;
        } else {
          const base = p.segDist[j - 1] / route.speed + route.fixed;
          let tt = base * trafficTruth(route.mode, dep[j - 1], dayType) * trafficMult * rng.lognormal(route.mode === 'tram' ? 0.07 : 0.13);
          if (j - 1 === incidentSeg) tt += rng.uniform(150, 480);
          arr[j] = dep[j - 1] + tt;
        }
        const t = arr[j];
        const d = demandProfile(t, dayType);
        const hm = hourly[Math.min(29, Math.floor(H(t)))];
        // wysiadający: każdy pasażer wybiera cel wśród dalszych przystanków proporcjonalnie do atrakcyjności
        let downstream = 0;
        for (let k = j + 1; k < N; k++) downstream += attract(pStops[k], d);
        const pAl = j === 0 ? 0 : j === N - 1 ? 1 : attract(pStops[j], d) / (attract(pStops[j], d) + downstream);
        const al = rng.binomial(Math.round(x), pAl);
        x -= al;
        // wsiadający: kolejka narasta od odjazdu poprzedniego pojazdu (gap) – dlatego spóźniony pojazd jest pełniejszy
        let bo = 0, de = 0;
        if (j < N - 1) {
          const gap = Number.isNaN(lastDep[j]) ? tr.schedHeadway : Math.max(0, t - lastDep[j]);
          // pasażerowie przystanku rozkładają się na linie proporcjonalnie do ich częstotliwości
          const lam = DEMAND_K * scale * route.k * demandMult * hm * eventMult(p.stops[j], t) * produce(pStops[j], d) * share[p.idx][j] * (downstream / (downstream + A0));
          waiting[j] += rng.poisson(lam * Math.min(gap, 3600));
          const room = Math.max(0, cap - x);
          bo = Math.min(waiting[j], room);
          de = waiting[j] - bo;
          waiting[j] = de * 0.7; // część zrezygnuje / pojedzie czymś innym
          x += bo;
        }
        // postój: wymiana pasażerów; brak odjazdów przed czasem
        const tram = route.mode === 'tram';
        const dwell = j === N - 1 ? 0 : Math.min(150, 8 + (tram ? 0.9 : 1.5) * bo + (tram ? 0.6 : 0.9) * al) * rng.lognormal(0.1);
        if (j === 0) {
          const late = rng.next() < 0.85 ? rng.uniform(0, 40) : rng.exponential(150);
          dep[0] = Math.max(tr.schedDep[0] + late, arr[0] + dwell);
        } else {
          dep[j] = Math.max(arr[j] + dwell, tr.schedDep[j] - 30);
        }
        lastDep[j] = Number.isNaN(lastDep[j]) ? dep[j] : Math.max(lastDep[j], dep[j]);
        load[j] = x; board[j] = bo; alight[j] = al; denied[j] = de;
      }
      truth.arr[ti] = arr; truth.dep[ti] = dep; truth.load[ti] = load;
      truth.board[ti] = board; truth.alight[ti] = alight; truth.denied[ti] = denied;

      // strumienie danych
      for (let j = 0; j < N; j++) {
        const ev = { t: dep[j], type: 'dep', trip: ti, j };
        if (hasApc) {
          // APC liczy wejścia/wyjścia z małym błędem
          const nb = Math.max(0, Math.round(board[j] + rng.normal(0, 0.03 * board[j] + 0.3)));
          const na = Math.max(0, Math.round(alight[j] + rng.normal(0, 0.03 * alight[j] + 0.3)));
          ev.apc = { board: nb, alight: na, load: Math.max(0, Math.round(load[j] + rng.normal(0, 1 + 0.02 * load[j]))) };
        }
        out.push(ev);
        if (j > 0) out.push({ t: arr[j], type: 'arr', trip: ti, j });
        if (withReports && j < N - 1) {
          const ratio = load[j] / cap;
          const pRep = reportRate * (0.25 + 1.6 * ratio) * Math.min(1, load[j] / 15 + 0.2);
          const nRep = rng.poisson(pRep * 2.2);
          for (let r = 0; r < nRep; r++) {
            const u = rng.pick(users);
            const trueLevel = levelOf(ratio);
            let level;
            if (u.kind === 'troll') level = rng.next() < 0.6 ? 3 : Math.floor(rng.next() * 4);
            else if (rng.next() < u.acc) level = trueLevel;
            else level = Math.max(0, Math.min(3, trueLevel + (rng.next() < 0.5 ? -1 : 1)));
            const span = Math.min(150, Math.max(20, arr[j + 1] - dep[j] - 5));
            out.push({ t: dep[j] + rng.uniform(5, span), type: 'report', trip: ti, j, level, user: u.id, sim: true });
          }
        }
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  truth.events = out;
  return truth;
}

/** Udział wariantu trasy w obsłudze przystanku (wg liczby kursów). */
export function serviceShare(net) {
  if (net._share) return net._share;
  const total = new Float64Array(net.stops.length);
  for (const p of net.patterns) p.stops.forEach((si, j) => { if (j < p.stops.length - 1) total[si] += p.trips.length; });
  net._share = net.patterns.map((p) => Float64Array.from(p.stops, (si) => (total[si] ? p.trips.length / total[si] : 1)));
  return net._share;
}

/**
 * Automatyczna kalibracja skali popytu symulatora do sieci (np. prawdziwego GTFS):
 * dobieramy mnożnik tak, by średnie maksymalne obłożenie kursu w dzień roboczy wynosiło `target`.
 */
// target = średnie MAKSYMALNE obłożenie kursu w dzień roboczy 6–20 (typowo 25–35% w mieście wielkości Rzeszowa)
export function calibrateDemand(net, { target = 0.3 } = {}) {
  const measure = (scale) => {
    net.demandScale = scale;
    const tr = simulateDay(net, { seed: 'calibration', dayType: 'weekday', withReports: false, apcShare: 0 });
    let sum = 0, n = 0;
    for (const t of net.trips) {
      const h = t.schedDep[0] / 3600;
      if (h < 6 || h > 20) continue;
      const cap = net.routes[net.patterns[t.pattern].route].capacity;
      let m = 0;
      for (const x of tr.load[t.idx]) if (x > m) m = x;
      sum += m / cap; n++;
    }
    return n ? sum / n : 0;
  };
  let lo = Math.log(0.05), hi = Math.log(40);
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (measure(Math.exp(mid)) < target) lo = mid; else hi = mid;
  }
  net.demandScale = Math.exp((lo + hi) / 2);
  return net.demandScale;
}

/** Losowe parametry dnia: pogoda, ruch, wydarzenia (mecz, koncert...). */
export function dayScenario(net, seed, { forceEventAround } = {}) {
  const rng = new Rng(`scenario-${seed}`);
  const demandMult = Math.min(1.35, Math.max(0.75, rng.normal(1, 0.1)));
  const trafficMult = Math.min(1.25, Math.max(0.9, rng.normal(1.02, 0.06)));
  const events = [];
  const big = net.stops.filter((s) => s.patterns.length >= 2);
  const nEv = forceEventAround != null ? 1 : rng.next() < 0.25 ? 1 : 0;
  for (let i = 0; i < nEv; i++) {
    const s = rng.pick(big.length ? big : net.stops);
    const from = forceEventAround != null ? forceEventAround - 20 * 60 : rng.uniform(10, 21) * 3600;
    events.push({ stop: s.idx, from, to: from + rng.uniform(50, 80) * 60, mult: forceEventAround != null ? rng.uniform(3, 5) : rng.uniform(2, 3.5), name: 'Wydarzenie' });
  }
  return { demandMult, trafficMult, events };
}
