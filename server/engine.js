// Spina wszystko: sieć → model historyczny → świat (symulacja) → strumień na żywo → predykcja → API.
import fs from 'node:fs';
import { Clock, fmtHHMM, addDays, parseHHMM } from './lib/time.js';
import { haversine, pointAlong } from './lib/geo.js';
import { buildDemoNetwork, nearbyStops } from './network/build.js';
import { loadGtfs } from './network/gtfs.js';
import { trainHistory } from './model/history.js';
import { simulateDay, dayScenario } from './sim/world.js';
import { LiveFeed } from './sim/feed.js';
import { Predictor } from './model/predictor.js';
import { describe, levelOf, LEVELS } from './model/occupancy.js';
import { planJourneys } from './planner/raptor.js';
import { ensureGtfs } from './live/gtfs-source.js';
import { RealtimeFeed } from './live/realtime-feed.js';

export class Engine {
  constructor(opts = {}) {
    this.opts = opts;
    this.live = !!(opts.live && opts.live.rtUrl);
    this.clock = new Clock({ simTime: opts.simTime, speed: opts.speed || 1, live: this.live });
  }

  static async create(opts) {
    const e = new Engine(opts);
    await e.init(e.clock.date);
    return e;
  }

  async init(date) {
    if (this.live) return this.initLive(date);
    const t0 = Date.now();
    const dayType = this.clock.dayType;
    this.date = date;
    if (this.opts.gtfsDir && fs.existsSync(this.opts.gtfsDir)) {
      this.net = loadGtfs(this.opts.gtfsDir, { date, dayType });
    } else {
      this.net = buildDemoNetwork(dayType);
    }
    this.tripById = new Map(this.net.trips.map((t) => [t.id, t.idx]));
    this.hist = trainHistory(this.net, { date, days: this.opts.historyDays || 14 });
    const now = this.clock.now();
    const seed = `day-${date}`;
    // w demo zawsze jest jakieś "wydarzenie" niedługo po starcie – widać adaptację algorytmu
    this.scenario = dayScenario(this.net, seed, { forceEventAround: now + 25 * 60 });
    this.truth = simulateDay(this.net, { seed, ...this.scenario });
    this.feed = new LiveFeed(this.net, this.truth);
    this.predictor = new Predictor(this.net, this.hist, this.feed);
    this.evalState = { pending: new Map(), lastLog: 0, h: { n: 0, ef: 0, eb: 0, af: 0, ab: 0, eta: 0 }, recent: [] };
    // rozgrzewka: odtwarzamy ostatnie 3 h, żeby filtr i reputacja "znały" dzisiejszy dzień
    for (let t = Math.max(4.5 * 3600, now - 3 * 3600); t < now; t += 60) {
      this.predictor.update(t);
      this.evaluate(t);
    }
    this.tick();
    this.initMs = Date.now() - t0;
  }

  /** Tryb na żywo: prawdziwy rozkład GTFS + pozycje pojazdów z GTFS-Realtime. */
  async initLive(date) {
    const t0 = Date.now();
    const L = this.opts.live;
    this.date = date;
    if (L.gtfsUrl) {
      await ensureGtfs({ url: L.gtfsUrl, dir: L.gtfsDir });
      this.net = loadGtfs(L.gtfsDir, { date, dayType: this.clock.dayType });
    } else {
      this.net = loadGtfs(this.opts.gtfsDir, { date, dayType: this.clock.dayType });
    }
    if (L.cityName) this.net.city.name = L.cityName;
    this.tripById = new Map(this.net.trips.map((t) => [t.id, t.idx]));
    // Brak historycznych danych o pasażerach od przewoźnika → model "historyczny" z symulacji
    // na prawdziwej sieci i rozkładzie. Prawdziwe są: rozkład, opóźnienia, odstępy i zgłoszenia.
    this.hist = trainHistory(this.net, { date, days: this.opts.historyDays || 7 });
    this.truth = null;
    this.scenario = { demandMult: 1, events: [] };
    this.feed?.stop?.();
    this.feed = new RealtimeFeed(this.net, { url: L.rtUrl, date, intervalMs: L.intervalMs || 15000 });
    try { await this.feed.poll(); } catch (e) { console.warn('[GTFS-RT]', e.message); }
    this.feed.start();
    this.predictor = new Predictor(this.net, this.hist, this.feed);
    this.evalState = { pending: new Map(), lastLog: 0, h: { n: 0 } };
    this.tick();
    this.initMs = Date.now() - t0;
  }

  now() {
    return this.clock.now();
  }

  tick() {
    const now = this.now();
    if (this.reinitializing) return;
    if (now > 27 * 3600) {
      this.clock = new Clock({ simTime: 5 * 3600, speed: this.clock.speed, live: this.live });
      this.reinitializing = true;
      Promise.resolve(this.init(this.clock.date === this.date ? addDays(this.date, 1) : this.clock.date))
        .catch((e) => console.error(e))
        .finally(() => { this.reinitializing = false; });
      return;
    }
    this.predictor.update(now);
    this.evaluate(now);
  }

  // ------------------------------------------------------------ helpers
  pattern(ti) {
    return this.net.patterns[this.net.trips[ti].pattern];
  }

  route(ti) {
    return this.net.routes[this.pattern(ti).route];
  }

  times(ti) {
    const pr = this.predictor.fresh(ti);
    if (pr) return { arr: pr.arr, dep: pr.dep, realtime: this.live ? this.feed.isLive(ti, this.now()) : true };
    const tr = this.net.trips[ti];
    return { arr: tr.schedArr, dep: tr.schedDep, realtime: false };
  }

  occ(ti, j) {
    const pr = this.predictor.fresh(ti);
    if (pr) return { x: pr.x[j], P: pr.P[j], pOver: pr.pOver[j] };
    const p = this.pattern(ti);
    const t = this.net.trips[ti].schedDep[j];
    return { x: this.hist.meanLoad(p.idx, j, t), P: this.hist.sdLoad(p.idx, j, t) ** 2 + 4, pOver: 0 };
  }

  occupancy(ti, j) {
    const r = this.route(ti);
    const o = this.occ(ti, j);
    const pr = this.predictor.fresh(ti);
    const now = this.now();
    const sources = pr
      ? { apc: pr.hasApc, reports: pr.nRep, lastReportMin: pr.lastRep ? Math.round((now - pr.lastRep) / 60) : null, model: true }
      : { apc: false, reports: 0, lastReportMin: null, model: true, historicalOnly: true };
    return describe(o.x, o.P, r.capacity, r.seats, { boardRisk: Math.round((o.pOver || 0) * 100) / 100, sources });
  }

  vehiclePosition(ti, now) {
    if (this.live) {
      const pos = this.feed.position(ti, now);
      if (!pos || pos.k === 0 && !this.feed.arrived(ti, 0, now)) return pos ? { ...pos, k: Math.max(1, pos.k), atStop: null } : null;
      return { ...pos, atStop: null };
    }
    const p = this.pattern(ti);
    const k = this.feed.departedCount(ti, now);
    const N = p.stops.length;
    if (k === 0 || this.feed.arrived(ti, N - 1, now)) return null;
    let d;
    if (this.feed.arrived(ti, k, now)) d = p.stopDist[k];
    else {
      const t0 = this.feed.dep(ti, k - 1), t1 = this.feed.arr(ti, k);
      const f = Math.min(1, Math.max(0, (now - t0) / (t1 - t0 || 1)));
      d = p.stopDist[k - 1] + f * (p.stopDist[k] - p.stopDist[k - 1]);
    }
    const pos = pointAlong(p.shape, p.shapeCum, d);
    return { ...pos, k, atStop: this.feed.arrived(ti, k, now) ? k : null };
  }

  // ------------------------------------------------------------ API
  config() {
    return {
      city: this.net.city,
      source: this.net.source,
      dayType: this.net.dayType,
      date: this.date,
      now: this.now(),
      demoShift: this.clock.demoShift,
      live: this.live,
      attribution: this.live ? 'Dane: ZTM Rzeszów (rozkład) · kmrzeszow.live (GTFS / GTFS-Realtime)' : null,
      speed: this.clock.speed,
      levels: LEVELS,
    };
  }

  stops() {
    return this.net.stops.map((s) => ({ idx: s.idx, id: s.id, name: s.name, lat: s.lat, lng: s.lng, lines: s.lines }));
  }

  lines() {
    return this.net.routes.map((r) => ({
      id: r.id, short: r.short, mode: r.mode, color: r.color, textColor: r.textColor, capacity: r.capacity, seats: r.seats,
      patterns: this.net.patterns.filter((p) => p.route === r.idx).map((p) => ({
        id: p.id, headsign: p.headsign, stops: Array.from(p.stops, (s) => this.net.stops[s].id), shape: p.shape,
      })),
    }));
  }

  vehicles() {
    const now = this.now();
    const out = [];
    for (const tr of this.net.trips) {
      const pr = this.predictor.fresh(tr.idx);
      if (!pr || (pr.k === 0 && !this.live)) continue;
      const pos = this.vehiclePosition(tr.idx, now);
      if (!pos) continue;
      const r = this.route(tr.idx);
      const p = this.pattern(tr.idx);
      const j = Math.max(0, Math.min(p.stops.length - 2, pos.k - 1));
      const ratio = Math.min(1, pr.x[j] / r.capacity);
      out.push({
        id: tr.id, trip: tr.idx, line: r.short, mode: r.mode, color: r.color, headsign: p.headsign,
        lat: Math.round(pos.lat * 1e6) / 1e6, lng: Math.round(pos.lng * 1e6) / 1e6, bearing: Number.isFinite(pos.bearing) ? Math.round(pos.bearing) : null,
        ratio: Math.round(ratio * 100) / 100, level: describe(pr.x[j], pr.P[j], r.capacity, r.seats).level,
        delay: Math.round(this.feed.dep(tr.idx, j) - tr.schedDep[j]),
        next: this.net.stops[p.stops[Math.min(pos.k, p.stops.length - 1)]].name,
      });
    }
    return { now, vehicles: out };
  }

  departures(stopIdx, { limit = 12, horizon = 90 * 60 } = {}) {
    const now = this.now();
    const s = this.net.stops[stopIdx];
    if (!s) return null;
    const out = [];
    for (const { p: pi, j } of s.patterns) {
      const p = this.net.patterns[pi];
      if (j === p.stops.length - 1) continue; // przystanek końcowy – nikt tu nie wsiada
      for (const ti of p.trips) {
        const tr = this.net.trips[ti];
        if (tr.schedDep[j] < now - 3600) continue;
        if (tr.schedDep[j] > now + horizon + 1800) break;
        const t = this.times(ti);
        const dep = t.dep[j];
        if (dep < now - 20 || dep > now + horizon) continue;
        if (t.realtime && this.feed.departedCount(ti, now) > j) continue;
        out.push({ ti, j, dep, p, tr, realtime: t.realtime });
      }
    }
    out.sort((a, b) => a.dep - b.dep);
    return {
      now,
      stop: { idx: s.idx, id: s.id, name: s.name, lat: s.lat, lng: s.lng, lines: s.lines },
      departures: out.slice(0, limit).map((d) => {
        const r = this.net.routes[d.p.route];
        return {
          tripId: d.tr.id, trip: d.ti, line: r.short, mode: r.mode, color: r.color, textColor: r.textColor,
          headsign: d.p.headsign, dep: d.dep, schedDep: d.tr.schedDep[d.j], delay: Math.round(d.dep - d.tr.schedDep[d.j]),
          minutes: Math.max(0, Math.round((d.dep - now) / 60)), realtime: d.realtime,
          occupancy: this.occupancy(d.ti, d.j),
        };
      }),
    };
  }

  trip(tripId) {
    const ti = this.tripById.get(tripId);
    if (ti === undefined) return null;
    const now = this.now();
    const tr = this.net.trips[ti];
    const p = this.pattern(ti);
    const r = this.route(ti);
    const t = this.times(ti);
    const k = this.feed.departedCount(ti, now);
    const pos = this.vehiclePosition(ti, now);
    // następny kurs tej samej linii – do porównania "a może poczekać?"
    const nextTi = p.trips[tr.order + 1];
    return {
      now,
      tripId: tr.id, trip: ti, line: r.short, mode: r.mode, color: r.color, textColor: r.textColor,
      headsign: p.headsign, capacity: r.capacity, seats: r.seats, realtime: t.realtime,
      progress: k, position: pos,
      shape: p.shape,
      nextTripId: nextTi !== undefined ? this.net.trips[nextTi].id : null,
      stops: Array.from(p.stops, (si, j) => {
        const s = this.net.stops[si];
        return {
          idx: si, id: s.id, name: s.name, lat: s.lat, lng: s.lng,
          arr: t.arr[j], dep: t.dep[j], schedDep: tr.schedDep[j], schedArr: tr.schedArr[j],
          passed: j < k, occupancy: j < p.stops.length - 1 ? this.occupancy(ti, j) : null,
        };
      }),
    };
  }

  plan({ from, to, time, mode = 'comfort' }) {
    const now = this.now();
    const t = time != null ? (typeof time === 'number' ? time : parseHHMM(time) ?? now) : now;
    const journeys = planJourneys(this.net, { times: (ti) => this.times(ti), occ: (ti, j) => this.occ(ti, j) }, { from, to, time: Math.max(t, now - 60) });
    if (mode === 'fast') journeys.sort((a, b) => a.arr - b.arr);
    else journeys.sort((a, b) => a.cost - b.cost);
    return { now, time: t, mode, journeys };
  }

  nearby(lat, lng) {
    return nearbyStops(this.net, lat, lng, 800, 4).slice(0, 8).map((n) => {
      const s = this.net.stops[n.stop];
      return { idx: s.idx, id: s.id, name: s.name, lat: s.lat, lng: s.lng, dist: Math.round(n.dist), lines: s.lines };
    });
  }

  /** Zgłoszenie obłożenia od użytkownika aplikacji. */
  report({ tripId, level, lat, lng, userId }) {
    const ti = this.tripById.get(tripId);
    if (ti === undefined) return { ok: false, error: 'Nie znaleziono kursu' };
    level = Number(level);
    if (!(level >= 0 && level <= 3)) return { ok: false, error: 'Nieprawidłowy poziom' };
    if (!userId || String(userId).length > 64) return { ok: false, error: 'Brak identyfikatora' };
    const now = this.now();
    const k = this.feed.departedCount(ti, now);
    const p = this.pattern(ti);
    if (k === 0) return { ok: false, error: 'Ten pojazd jeszcze nie wyruszył' };
    if (this.feed.arrived(ti, p.stops.length - 1, now)) return { ok: false, error: 'Ten kurs już się zakończył' };
    let locFactor = 0.35, verified = false, distance = null;
    const pos = this.vehiclePosition(ti, now);
    if (pos && Number.isFinite(lat) && Number.isFinite(lng)) {
      distance = Math.round(haversine(lat, lng, pos.lat, pos.lng));
      if (distance < 250) { locFactor = 1; verified = true; }
      else if (distance < 800) locFactor = 0.6;
    }
    const before = this.occupancy(ti, k - 1);
    const res = this.predictor.addReport({ ti, j: k - 1, level, user: `app-${userId}`, t: now, locFactor });
    this.predictor.update(now);
    const after = this.occupancy(ti, k - 1);
    return {
      ok: true, verified, distance, trust: Math.round(res.trust * 100) / 100, weight: Math.round(res.weight * 100) / 100,
      before, after,
      message: verified ? 'Dzięki! Zgłoszenie potwierdzone lokalizacją.' : 'Dzięki! Bez potwierdzenia lokalizacji zgłoszenie ma mniejszą wagę.',
    };
  }

  // ------------------------------------------------------------ jakość predykcji (na żywo)
  evaluate(now) {
    if (!this.truth) return;
    const E = this.evalState;
    // rozlicz wcześniej zapisane prognozy, których moment już nastąpił
    for (const [key, v] of E.pending) {
      if (this.truth.dep[v.ti][v.j] > now) continue;
      E.pending.delete(key);
      const truthX = this.truth.load[v.ti][v.j];
      const h = E.h;
      h.n++;
      h.ef += Math.abs(v.x - truthX);
      h.eb += Math.abs(v.base - truthX);
      h.af += levelOf(v.x / v.cap) === levelOf(truthX / v.cap) ? 1 : 0;
      h.ab += levelOf(v.base / v.cap) === levelOf(truthX / v.cap) ? 1 : 0;
      h.eta += Math.abs(v.dep - this.truth.dep[v.ti][v.j]);
    }
    if (now - E.lastLog < 120) return;
    E.lastLog = now;
    // zapisz prognozy na 5–15 min do przodu (kursy bez licznika APC – uczciwy test)
    for (const tr of this.net.trips) {
      const pr = this.predictor.fresh(tr.idx);
      if (!pr || this.truth.apc[tr.idx]) continue;
      const p = this.net.patterns[tr.pattern];
      const cap = this.net.routes[p.route].capacity;
      for (let j = 0; j < p.stops.length - 1; j++) {
        const lead = pr.dep[j] - now;
        if (lead < 300 || lead > 900) continue;
        const key = tr.idx * 100 + j;
        if (E.pending.has(key)) continue;
        E.pending.set(key, { ti: tr.idx, j, x: pr.x[j], dep: pr.dep[j], base: this.hist.meanLoad(p.idx, j, tr.schedDep[j]), cap });
      }
    }
  }

  stats() {
    const h = this.evalState.h;
    const now = this.now();
    // "nowcast": ile wynosi błąd szacunku obłożenia jadących TERAZ pojazdów bez licznika
    let n = 0, e = 0;
    for (const tr of (this.truth ? this.net.trips : [])) {
      const pr = this.predictor.fresh(tr.idx);
      if (!pr || pr.k === 0 || this.truth.apc[tr.idx]) continue;
      if (this.feed.arrived(tr.idx, this.pattern(tr.idx).stops.length - 1, now)) continue;
      n++;
      e += Math.abs(pr.x[pr.k - 1] - this.truth.load[tr.idx][pr.k - 1]);
    }
    const veh = this.vehicles().vehicles;
    return {
      now,
      network: { stops: this.net.stops.length, lines: this.net.routes.length, trips: this.net.trips.length, source: this.net.source },
      history: { days: this.hist.days },
      fleet: { active: veh.length, withApc: this.truth ? veh.filter((v) => this.truth.apc[v.trip]).length : 0 },
      live: this.live ? {
        ...this.feed.stats(now),
        avgDelaySec: veh.length ? Math.round(veh.reduce((a, v) => a + v.delay, 0) / veh.length) : null,
        attribution: 'Rozkład: ZTM Rzeszów · GTFS i GTFS-Realtime: kmrzeszow.live',
      } : null,
      forecast: h.n
        ? {
            samples: h.n,
            maeFused: Math.round((h.ef / h.n) * 10) / 10,
            maeBaseline: Math.round((h.eb / h.n) * 10) / 10,
            accFused: Math.round((h.af / h.n) * 1000) / 10,
            accBaseline: Math.round((h.ab / h.n) * 1000) / 10,
            etaErrorSec: Math.round(h.eta / h.n),
          }
        : null,
      nowcast: n ? { vehicles: n, mae: Math.round((e / n) * 10) / 10 } : null,
      data: { ...this.predictor.counters },
      reputation: this.predictor.rep.summary(),
      anomalies: this.predictor.anomalies().slice(0, 5).map((a) => ({
        stop: this.net.stops[a.stop].name, factor: Math.round(a.factor * 100) / 100,
      })),
      scenario: {
        demand: Math.round(this.scenario.demandMult * 100) / 100,
        events: this.scenario.events.map((ev) => ({ stop: this.net.stops[ev.stop].name, from: fmtHHMM(ev.from), to: fmtHHMM(ev.to) })),
      },
      initMs: this.initMs,
    };
  }
}
