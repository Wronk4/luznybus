// STRUMIEŃ NA ŻYWO z GTFS-Realtime (prawdziwe pozycje i opóźnienia autobusów).
// Ten sam interfejs co LiveFeed z symulatora, więc algorytm predykcji działa bez zmian:
//   departedCount / arrived / arr / dep / hasApc / pull  (+ position / isLive / stats)
//
// Dla każdego kursu trzymamy zaobserwowane czasy przyjazdu i odjazdu z przystanków.
// Czego nie widzieliśmy (np. przystanki sprzed startu serwera), szacujemy: rozkład + bieżące opóźnienie.
// Kursy bez danych na żywo traktujemy jako jadące wg rozkładu (z ostatnim znanym opóźnieniem).
import { decodeFeed, occupancyStatusToLevel, VehicleStopStatus } from '../lib/gtfs-rt.js';
import { serviceDayEpoch } from '../lib/time.js';

const FRESH = 180; // s – po tylu sekundach bez danych pozycja jest "nieaktualna"

export class RealtimeFeed {
  constructor(net, { url, date, intervalMs = 15000, fetchImpl = fetch } = {}) {
    this.net = net;
    this.url = url;
    this.intervalMs = intervalMs;
    this.fetch = fetchImpl;
    this.dayEpoch = serviceDayEpoch(date);
    this.tripIndex = new Map(net.trips.map((t) => [t.id, t.idx]));
    this.state = new Map(); // ti -> stan kursu
    this.queue = [];
    this.lastFetch = null;
    this.lastHeader = null;
    this.lastError = null;
    this.counters = { polls: 0, errors: 0, entities: 0, matched: 0, unmatched: 0, occupancy: 0 };
  }

  start() {
    const run = () => this.poll().catch((e) => {
      this.lastError = e.message;
      this.counters.errors++;
    });
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  async poll() {
    const res = await this.fetch(this.url, { headers: { 'User-Agent': 'LuznyBus/0.1 (projekt studencki)' } });
    if (!res.ok) throw new Error(`GTFS-RT HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    this.ingest(decodeFeed(buf));
    this.counters.polls++;
    this.lastError = null;
  }

  toDay(epoch) { return epoch - this.dayEpoch; }

  st(ti) {
    let s = this.state.get(ti);
    if (!s) {
      const N = this.net.trips[ti].schedDep.length;
      s = { arr: new Float64Array(N).fill(NaN), dep: new Float64Array(N).fill(NaN), k: 0, atStop: false, delay: 0, pos: null, seen: -Infinity, vehicle: null, occ: null };
      this.state.set(ti, s);
    }
    return s;
  }

  stopIndex(ti, seq, stopId) {
    const tr = this.net.trips[ti];
    if (seq != null && tr.seq) {
      const j = tr.seq.indexOf(seq);
      if (j >= 0) return j;
    }
    if (stopId != null) {
      const p = this.net.patterns[tr.pattern];
      const si = this.net.stopIndex.get(stopId);
      const j = p.stops.indexOf(si);
      if (j >= 0) return j;
    }
    return -1;
  }

  /** Przetwórz wiadomość GTFS-RT. */
  ingest(msg) {
    this.lastHeader = msg.header;
    const hdrT = msg.header.timestamp ? this.toDay(msg.header.timestamp) : Date.now() / 1000 - this.dayEpoch;
    this.lastFetch = hdrT;
    for (const e of msg.entities) {
      this.counters.entities++;
      const tu = e.tripUpdate, vp = e.vehicle;
      const tripId = tu?.trip?.tripId || vp?.trip?.tripId;
      const ti = tripId != null ? this.tripIndex.get(tripId) : undefined;
      if (ti === undefined) { this.counters.unmatched++; continue; }
      this.counters.matched++;
      const s = this.st(ti);
      if (tu) this.applyTripUpdate(ti, s, tu, hdrT);
      if (vp) this.applyVehicle(ti, s, vp, hdrT);
    }
  }

  applyTripUpdate(ti, s, tu, hdrT) {
    const tr = this.net.trips[ti];
    if (Number.isFinite(tu.delay)) s.delay = tu.delay;
    for (const u of tu.stopTimeUpdates) {
      const j = this.stopIndex(ti, u.stopSequence, u.stopId);
      if (j < 0) continue;
      const ev = u.departure || u.arrival;
      if (!ev) continue;
      const t = ev.time ? this.toDay(ev.time) : tr.schedDep[j] + (ev.delay || 0);
      if (j >= s.k) { s.delay = t - tr.schedDep[j]; break; }
    }
    s.seen = Math.max(s.seen, tu.timestamp ? this.toDay(tu.timestamp) : hdrT);
  }

  applyVehicle(ti, s, vp, hdrT) {
    const tr = this.net.trips[ti];
    const t = vp.timestamp ? this.toDay(vp.timestamp) : hdrT;
    if (vp.position && Number.isFinite(vp.position.lat)) {
      s.pos = { lat: vp.position.lat, lng: vp.position.lng, bearing: vp.position.bearing, speed: vp.position.speed, t };
    }
    if (vp.vehicle) s.vehicle = vp.vehicle.label || vp.vehicle.id || s.vehicle;
    s.seen = Math.max(s.seen, t);
    const j = this.stopIndex(ti, vp.currentStopSequence, vp.stopId);
    if (j >= 0) {
      const status = vp.currentStatus ?? VehicleStopStatus.IN_TRANSIT_TO;
      const atStop = status === VehicleStopStatus.STOPPED_AT;
      // stop j: STOPPED_AT → jest na j (odjechał z j-1); IN_TRANSIT/INCOMING → jedzie do j
      const newK = j; // liczba przystanków opuszczonych
      if (newK > s.k || (newK === s.k && atStop && !s.atStop)) {
        for (let i = s.k; i < newK; i++) {
          if (Number.isNaN(s.dep[i])) {
            // odjazd z przystanku, który widzieliśmy jako "na przystanku", to właśnie teraz
            s.dep[i] = i === s.k && s.atStop ? t : Math.min(t, tr.schedDep[i] + s.delay);
          }
          if (Number.isNaN(s.arr[i])) s.arr[i] = Math.min(s.dep[i], tr.schedArr[i] + s.delay);
        }
        // zdarzenia dla algorytmu: przejechany odcinek (czas przejazdu → współczynnik korków)
        if (newK > s.k && newK - 1 >= 1 && Number.isFinite(s.dep[newK - 2])) {
          this.queue.push({ t, type: 'arr', trip: ti, j: newK - 1 });
        }
        s.k = newK;
      }
      if (atStop && j === s.k && Number.isNaN(s.arr[j])) s.arr[j] = t;
      s.atStop = atStop && j === s.k;
      // opóźnienie z pozycji, jeśli nie ma TripUpdate
      if (atStop) s.delay = t - tr.schedArr[j];
      else if (j > 0 && t > tr.schedArr[j]) s.delay = Math.max(s.delay, t - tr.schedArr[j]);
    }
    const lvl = occupancyStatusToLevel(vp.occupancyStatus);
    if (lvl != null || vp.occupancyPercentage != null) {
      this.counters.occupancy++;
      const jj = Math.max(0, s.k - 1);
      this.queue.push({ t, type: 'occ', trip: ti, j: jj, level: lvl, percent: vp.occupancyPercentage });
    }
  }

  // ---------------------------------------------------------------- interfejs dla predyktora
  fresh(s, now) { return s && now - s.seen < FRESH; }

  isLive(ti, now = Date.now() / 1000 - this.dayEpoch) {
    return this.fresh(this.state.get(ti), now);
  }

  est(ti, j, kind) {
    const tr = this.net.trips[ti];
    const s = this.state.get(ti);
    const rec = s && (kind === 'arr' ? s.arr[j] : s.dep[j]);
    if (s && !Number.isNaN(rec)) return rec;
    return (kind === 'arr' ? tr.schedArr[j] : tr.schedDep[j]) + (s ? s.delay : 0);
  }

  departedCount(ti, now) {
    const s = this.state.get(ti);
    const N = this.net.trips[ti].schedDep.length;
    if (this.fresh(s, now)) {
      // na żywo: pozycja jest wiarygodna; dla ostatniego przystanku – jeśli minął czas, to dojechał
      if (s.k >= N - 1 && !s.atStop && this.est(ti, N - 1, 'arr') <= now) return N;
      return s.k;
    }
    let k = s ? s.k : 0;
    while (k < N && this.est(ti, k, 'dep') <= now) k++;
    return k;
  }

  arrived(ti, j, now) {
    const s = this.state.get(ti);
    if (this.fresh(s, now)) return j < s.k || (j === s.k && s.atStop) || (j === this.net.trips[ti].schedDep.length - 1 && this.est(ti, j, 'arr') <= now && s.k >= j);
    return this.est(ti, j, 'arr') <= now;
  }

  arr(ti, j) { return this.est(ti, j, 'arr'); }

  dep(ti, j) { return this.est(ti, j, 'dep'); }

  hasApc() { return false; }

  position(ti, now) {
    const s = this.state.get(ti);
    if (!this.fresh(s, now) || !s.pos) return null;
    return { ...s.pos, k: s.k, vehicle: s.vehicle };
  }

  *pull(now) {
    this.queue.sort((a, b) => a.t - b.t);
    while (this.queue.length && this.queue[0].t <= now + 5) yield this.queue.shift();
  }

  stats(now) {
    let live = 0;
    for (const [, s] of this.state) if (this.fresh(s, now)) live++;
    return { url: this.url, liveTrips: live, lastFetch: this.lastFetch, feedAgeSec: this.lastFetch != null ? Math.round(now - this.lastFetch) : null, lastError: this.lastError, ...this.counters };
  }
}
