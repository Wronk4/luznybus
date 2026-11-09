// ============================================================================
//  ALGORYTM PRZEWIDYWANIA OBŁOŻENIA  (serce LuźnyBusa)
// ============================================================================
//
//  Dla każdego kursu (linia + kierunek) liczymy przystanek po przystanku rozkład
//  liczby pasażerów X_j ~ N(x_j, P_j) — filtr Kalmana "wzdłuż trasy":
//
//   1. WYSIADANIE   x' = x·(1−p_j),   P' = P·(1−p_j)² + x·p_j·(1−p_j)         (dwumianowe)
//   2. WSIADANIE    W  = λ_j·φ·gap_j + niezabrani_z_poprzedniego_pojazdu          (Poisson)
//                   gap_j = przyjazd TEGO pojazdu − odjazd POPRZEDNIEGO z tego przystanku.
//                   → spóźniony pojazd (duży gap) zbiera więcej ludzi, a ten tuż za nim jest luźny.
//                     Tak powstaje efekt "12 za 3 min – tłok, 12 za 9 min – luźno".
//   3. POJEMNOŚĆ    X = min(x' + W, pojemność) → momenty rozkładu ocenzurowanego;
//                   nadmiar E[max(X−cap,0)] = ludzie, którzy się nie zmieścili → czekają na kolejny.
//   4. OBSERWACJE   aktualizacja Kalmana pomiarami:
//                     - licznik APC w drzwiach (mały szum),
//                     - zgłoszenia pasażerów: szum zależny od poziomu i REPUTACJI zgłaszającego,
//                       odporne bramkowanie (zgłoszenie sprzeczne z resztą danych traci wagę).
//   5. CZASY        przyjazdy w przyszłości = AVL (gdzie jest teraz) + historyczne czasy przejazdu
//                   × bieżący współczynnik korków + postój zależny od liczby wsiadających.
//
//  Parametry λ (napływ pasażerów), p (wysiadanie), czasy przejazdu – z modelu historycznego.
//  Adaptacja na żywo (dzisiaj jest inaczej niż zwykle: deszcz, mecz, koncert):
//   φ_linia, φ_przystanek – współczynniki popytu, rozkład Gamma (sprzężony z Poissonem),
//   aktualizowane wejściami z APC, z zapominaniem (okres półtrwania 40 min).
//   Gdy pojazd był pełny, wejścia są ocenzurowane i NIE są używane do uczenia.
//
//  Kursy jednej linii liczone są po kolei, bo każdy zależy od poprzedniego (gap, niezabrani).
// ============================================================================

import { censoredMoments, levelObservation, levelOf, describe } from './occupancy.js';
import { Reputation } from './reputation.js';

const WINDOW_PAST = 3 * 3600;
const WINDOW_FUTURE = 3 * 3600;
const PHI_HALF_LIFE = 40 * 60;
const TT_HALF_LIFE = 15 * 60;
const GATE = 2.5;

function decayGamma(g, t, prior, halfLife) {
  if (g.t === 0) { g.t = t; return; }
  const f = Math.pow(0.5, Math.max(0, t - g.t) / halfLife);
  g.a = prior + (g.a - prior) * f;
  g.b = prior + (g.b - prior) * f;
  g.t = t;
}

export class Predictor {
  constructor(net, hist, feed) {
    this.net = net;
    this.hist = hist;
    this.feed = feed;
    this.obs = new Map(); // ti -> [{j, z, R, src, t, user, level}]
    this.PRIOR_P = 40;
    this.PRIOR_S = 25;
    this.phiP = net.patterns.map(() => ({ a: this.PRIOR_P, b: this.PRIOR_P, t: 0 }));
    this.phiS = net.stops.map(() => ({ a: this.PRIOR_S, b: this.PRIOR_S, t: 0 }));
    this.ttF = net.patterns.map(() => ({ num: 5, den: 5, t: 0 }));
    this.rep = new Reputation();
    this.pred = new Array(net.trips.length);
    this.tick = 0;
    this.now = 0;
    this.counters = { apc: 0, reports: 0, simReports: 0, userReports: 0, gated: 0 };
  }

  phi(pi, si) {
    const a = this.phiP[pi], b = this.phiS[si];
    return (a.a / a.b) * (b.a / b.b);
  }

  travelFactor(pi, now) {
    const g = this.ttF[pi];
    const f = Math.pow(0.5, Math.max(0, now - g.t) / TT_HALF_LIFE);
    const num = 5 + (g.num - 5) * f, den = 5 + (g.den - 5) * f;
    return num / den;
  }

  // ---------------------------------------------------------------- ingestion
  ingest(now) {
    const { net, feed, hist } = this;
    for (const ev of feed.pull(now)) {
      const tr = net.trips[ev.trip];
      const p = net.patterns[tr.pattern];
      if (ev.type === 'arr') {
        const actual = feed.arr(ev.trip, ev.j) - feed.dep(ev.trip, ev.j - 1);
        const exp = hist.travel(p.idx, ev.j - 1, feed.dep(ev.trip, ev.j - 1));
        const g = this.ttF[p.idx];
        const f = g.t ? Math.pow(0.5, Math.max(0, ev.t - g.t) / TT_HALF_LIFE) : 1;
        g.num = 5 + (g.num - 5) * f + Math.min(actual, exp * 4);
        g.den = 5 + (g.den - 5) * f + exp;
        g.t = ev.t;
      } else if (ev.type === 'dep' && ev.apc) {
        this.ingestApc(ev, tr, p);
      } else if (ev.type === 'report') {
        this.addReport({ ti: ev.trip, j: ev.j, level: ev.level, user: ev.user, t: ev.t, sim: true });
      } else if (ev.type === 'occ') {
        // obłożenie podane przez przewoźnika w GTFS-RT (occupancy_status / occupancy_percentage)
        const cap = net.routes[p.route].capacity;
        let z, R;
        if (ev.percent != null) { z = (ev.percent / 100) * cap; R = (0.08 * cap) ** 2; }
        else { const o = levelObservation(ev.level); z = o.mid * cap; R = (o.half * cap) ** 2 / 0.7; }
        this.pushObs(ev.trip, { j: ev.j, z, R, src: 'operator', t: ev.t });
        this.counters.operator = (this.counters.operator || 0) + 1;
      }
    }
  }

  ingestApc(ev, tr, p) {
    const { net, feed, hist } = this;
    const route = net.routes[p.route];
    const { load, board } = ev.apc;
    this.counters.apc++;
    this.pushObs(ev.trip, { j: ev.j, z: load, R: (1 + 0.02 * load) ** 2 + 1, src: 'apc', t: ev.t });
    // uczenie współczynników popytu φ (tylko gdy pojazd nie był pełny – inaczej dane ocenzurowane)
    const N = p.stops.length;
    if (ev.j >= N - 1 || load >= 0.95 * route.capacity || tr.order === 0) return;
    const prevTi = p.trips[tr.order - 1];
    if (feed.departedCount(prevTi, ev.t) <= ev.j) return;
    const gap = Math.min(3600, Math.max(0, feed.arr(ev.trip, ev.j) - feed.dep(prevTi, ev.j)));
    if (gap < 30) return;
    const si = p.stops[ev.j];
    const base = hist.lambda(p.idx, ev.j, feed.arr(ev.trip, ev.j)) * gap;
    if (base < 0.5) return;
    const gp = this.phiP[p.idx], gs = this.phiS[si];
    decayGamma(gp, ev.t, this.PRIOR_P, PHI_HALF_LIFE);
    decayGamma(gs, ev.t, this.PRIOR_S, PHI_HALF_LIFE);
    const fS = gs.a / gs.b, fP = gp.a / gp.b;
    gp.a += board; gp.b += base * fS;
    gs.a += board; gs.b += base * fP;
  }

  pushObs(ti, o) {
    let arr = this.obs.get(ti);
    if (!arr) this.obs.set(ti, (arr = []));
    arr.push(o);
    arr.sort((a, b) => a.j - b.j || a.t - b.t);
  }

  /**
   * Zgłoszenie obłożenia przez pasażera.
   * locFactor: 1 = GPS potwierdza, że jest w pojeździe; mniej = brak weryfikacji.
   */
  addReport({ ti, j, level, user, t, sim = false, locFactor = 1 }) {
    const tr = this.net.trips[ti];
    const route = this.net.routes[this.net.patterns[tr.pattern].route];
    const cap = route.capacity;
    // weryfikacja reputacji: porównanie z licznikiem APC (jeśli jest) albo z bieżącą pewną predykcją
    const apc = (this.obs.get(ti) || []).find((o) => o.src === 'apc' && o.j === j);
    if (apc) this.rep.update(user, level, levelOf(apc.z / cap), 1);
    else {
      const pr = this.pred[ti];
      if (pr && pr.tick === this.tick) {
        const d = describe(pr.x[j], pr.P[j], cap, route.seats);
        if (d.confidence > 0.7) this.rep.update(user, level, d.level, 0.3);
      }
    }
    const trust = this.rep.trust(user);
    const { mid, half } = levelObservation(level);
    const w = Math.max(0.02, trust * trust * locFactor);
    const R = (half * cap) ** 2 / w;
    this.pushObs(ti, { j, z: mid * cap, R, src: 'report', t, user, level, sim });
    this.counters.reports++;
    if (sim) this.counters.simReports++;
    else this.counters.userReports++;
    return { trust, weight: w };
  }

  // ---------------------------------------------------------------- prediction
  update(now) {
    this.ingest(now);
    this.now = now;
    this.tick++;
    const { net } = this;
    for (const p of net.patterns) {
      const N = p.stops.length;
      const carry = new Float64Array(N);
      const carryVar = new Float64Array(N);
      const prevDep = new Float64Array(N).fill(NaN);
      const trips = p.trips;
      let lo = 0, hi = trips.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (net.trips[trips[mid]].schedDep[0] < now - WINDOW_PAST) lo = mid + 1;
        else hi = mid;
      }
      for (let n = lo; n < trips.length; n++) {
        const tr = net.trips[trips[n]];
        if (tr.schedDep[0] > now + WINDOW_FUTURE) break;
        this.predictTrip(tr, p, now, prevDep, carry, carryVar);
      }
    }
  }

  predictTrip(tr, p, now, prevDep, carry, carryVar) {
    const { net, feed, hist } = this;
    const ti = tr.idx;
    const N = p.stops.length;
    const route = net.routes[p.route];
    const cap = route.capacity;
    const dw = hist.dwell[route.mode];
    let pr = this.pred[ti];
    if (!pr) {
      const z = () => new Float64Array(N);
      pr = this.pred[ti] = { arr: z(), dep: z(), x: z(), P: z(), pOver: z(), denied: z(), base: z(), k: 0, tick: 0 };
    }
    const k = feed.departedCount(ti, now);
    const tf = this.travelFactor(p.idx, now);
    const obs = this.obs.get(ti);
    let oi = 0;
    let nApc = 0, nRep = 0, lastRep = 0;
    let x = 0, P = 0;

    for (let j = 0; j < N; j++) {
      // --- czas przyjazdu
      let a;
      if (j < k || feed.arrived(ti, j, now)) a = feed.arr(ti, j);
      else if (j === 0) a = tr.schedDep[0] - 120;
      else {
        const horizon = Math.max(0, pr.dep[j - 1] - now);
        const f = 1 + (tf - 1) * Math.exp(-horizon / 2400);
        a = pr.dep[j - 1] + hist.travel(p.idx, j - 1, pr.dep[j - 1]) * f;
        if (j === k) a = Math.max(a, now + 5);
      }
      pr.arr[j] = a;

      // --- wysiadanie
      const pa = j === 0 ? 0 : j === N - 1 ? 1 : hist.pAlight(p.idx, j, a);
      const alightE = x * pa;
      const xa = x * (1 - pa);
      const Pa = P * (1 - pa) ** 2 + x * pa * (1 - pa);

      // --- wsiadanie
      let denied = 0, pOver = 0;
      if (j < N - 1) {
        const gapRaw = Number.isNaN(prevDep[j]) ? tr.schedHeadway : a - prevDep[j];
        const gap = Math.min(3600, Math.max(0, gapRaw));
        const lam = hist.lambda(p.idx, j, a) * this.phi(p.idx, p.stops[j]);
        const Wm = lam * gap + carry[j];
        const Wv = lam * gap + (0.22 * lam * gap) ** 2 + carryVar[j];
        const c = censoredMoments(xa + Wm, Pa + Wv, 0, cap);
        x = c.mean; P = c.var; denied = c.over; pOver = c.pOver;
      } else {
        x = xa; P = Pa;
      }
      pr.base[j] = x;

      // --- obserwacje (APC, zgłoszenia) – aktualizacja Kalmana
      while (obs && oi < obs.length && obs[oi].j < j) oi++;
      while (obs && oi < obs.length && obs[oi].j === j) {
        const o = obs[oi++];
        if (o.t > now) continue;
        const S = P + o.R;
        const nu = o.z - x;
        const m = Math.abs(nu) / Math.sqrt(S);
        let R = o.R;
        if (m > GATE && o.src !== 'apc') { R *= (m / GATE) ** 2;}
        const K = P / (P + R);
        x = Math.min(cap, Math.max(0, x + K * nu));
        P = Math.max(0.25, (1 - K) * P);
        if (o.src === 'apc' || o.src === 'operator') {
          nApc++;
          if (o.z < 0.95 * cap) { denied = 0; pOver = 0; }
        } else { nRep++; lastRep = Math.max(lastRep, o.t); }
      }

      carry[j] = denied;
      carryVar[j] = denied;

      // --- odjazd
      let d;
      if (j < k) d = feed.dep(ti, j);
      else if (j === N - 1) d = a;
      else {
        const boardE = Math.max(0, x - xa);
        const dwell = Math.min(150, dw.a + dw.b * (boardE + alightE));
        if (j === 0) d = now >= tr.schedDep[0] ? Math.max(now + 20, a + dwell) : Math.max(tr.schedDep[0] + 20, a + dwell);
        else d = Math.max(a + dwell, tr.schedDep[j] - 30);
      }
      pr.dep[j] = d;
      prevDep[j] = d;
      pr.x[j] = x; pr.P[j] = P; pr.pOver[j] = pOver; pr.denied[j] = denied;
    }
    pr.k = k;
    pr.tick = this.tick;
    pr.nApc = nApc;
    pr.nRep = nRep;
    pr.lastRep = lastRep;
    pr.hasApc = (feed.hasApc(ti) && k > 0) || nApc > 0;
  }

  /** Czy kurs ma świeżą predykcję w tym cyklu. */
  fresh(ti) {
    const pr = this.pred[ti];
    return pr && pr.tick === this.tick ? pr : null;
  }

  anomalies(minEvidence = 30) {
    const out = [];
    this.net.stops.forEach((s, i) => {
      const g = { ...this.phiS[i] };
      decayGamma(g, this.now, this.PRIOR_S, PHI_HALF_LIFE);
      const f = g.a / g.b;
      if (g.b - this.PRIOR_S > minEvidence * 0.2 && (f > 1.4 || f < 0.6)) out.push({ stop: i, factor: f });
    });
    return out.sort((a, b) => b.factor - a.factor);
  }
}
