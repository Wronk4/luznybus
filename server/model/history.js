// MODEL HISTORYCZNY – uczony z danych z poprzednich dni (w demo: z symulacji, w realu: z APC + AVL).
// Dla każdej linii/kierunku, przystanku i półgodzinnego okna uczy się:
//   λ  – natężenia przychodzenia pasażerów [os/s]  (z wejść APC / czasu od poprzedniego pojazdu,
//        tylko gdy pojazd NIE był pełny – przy pełnym dane są ocenzurowane)
//   p  – prawdopodobieństwa wysiadania (wysiadający / jadący),
//   tt – czasu przejazdu odcinka,
//   load – średniego obłożenia i rozrzutu (baseline do porównań).
// Do tego regresja czasu postoju od liczby wymienianych pasażerów.
import { simulateDay, dayScenario, calibrateDemand } from '../sim/world.js';
import { addDays } from '../lib/time.js';

export const BUCKET = 1800;
export const NB = 56; // 0:00 – 28:00

export const bucketOf = (t) => Math.max(0, Math.min(NB - 1, Math.floor(t / BUCKET)));

function smooth(sum, cnt, N) {
  // wygładzanie sąsiednimi oknami 0.25/0.5/0.25
  const s2 = new Float64Array(sum.length), c2 = new Float64Array(cnt.length);
  for (let j = 0; j < N; j++) {
    for (let b = 0; b < NB; b++) {
      const i = j * NB + b;
      let s = sum[i] * 0.5, c = cnt[i] * 0.5;
      if (b > 0) { s += sum[i - 1] * 0.25; c += cnt[i - 1] * 0.25; }
      if (b < NB - 1) { s += sum[i + 1] * 0.25; c += cnt[i + 1] * 0.25; }
      s2[i] = s; c2[i] = c;
    }
  }
  return [s2, c2];
}

export class HistoryModel {
  constructor(net) {
    this.net = net;
    this.days = 0;
    this.p = net.patterns.map((p) => {
      const N = p.stops.length;
      const z = () => new Float64Array(N * NB);
      return { N, bSum: z(), gSum: z(), aSum: z(), xSum: z(), ttSum: z(), ttN: z(), lSum: z(), l2Sum: z(), lN: z() };
    });
    this.dw = { tram: [0, 0, 0, 0, 0], bus: [0, 0, 0, 0, 0] }; // n, Σx, Σy, Σxy, Σxx
  }

  addDay(truth) {
    const { net } = this;
    this.days++;
    for (const p of net.patterns) {
      const A = this.p[p.idx];
      const N = p.stops.length;
      const route = net.routes[p.route];
      const cap = route.capacity;
      const dw = this.dw[route.mode];
      const lastDep = new Float64Array(N).fill(NaN);
      for (const ti of p.trips) {
        const arr = truth.arr[ti], dep = truth.dep[ti], load = truth.load[ti];
        const board = truth.board[ti], alight = truth.alight[ti];
        let before = 0;
        for (let j = 0; j < N; j++) {
          const b = j * NB + bucketOf(arr[j]);
          if (j > 0) {
            A.aSum[b] += alight[j];
            A.xSum[b] += before;
            const bs = (j - 1) * NB + bucketOf(dep[j - 1]);
            A.ttSum[bs] += arr[j] - dep[j - 1];
            A.ttN[bs] += 1;
          }
          if (j < N - 1) {
            const gap = Number.isNaN(lastDep[j]) ? 0 : Math.min(3600, Math.max(0, arr[j] - lastDep[j]));
            if (gap > 0 && load[j] < 0.95 * cap) {
              A.bSum[b] += board[j];
              A.gSum[b] += gap;
            }
            const bl = j * NB + bucketOf(dep[j]);
            A.lSum[bl] += load[j]; A.l2Sum[bl] += load[j] ** 2; A.lN[bl] += 1;
            if (j > 0) {
              const x = board[j] + alight[j], y = dep[j] - arr[j];
              if (y < 140) { dw[0]++; dw[1] += x; dw[2] += y; dw[3] += x * y; dw[4] += x * x; }
            }
          }
          lastDep[j] = dep[j];
          before = load[j];
        }
      }
    }
  }

  /** Po wczytaniu dni: wygładzanie i "shrinkage" w stronę średniej przystanku (empirical Bayes). */
  finalize() {
    this.m = this.net.patterns.map((p) => {
      const A = this.p[p.idx];
      const N = A.N;
      const [bS, gS] = smooth(A.bSum, A.gSum, N);
      const [aS, xS] = smooth(A.aSum, A.xSum, N);
      const [tS, tN] = smooth(A.ttSum, A.ttN, N);
      const lam = new Float64Array(N * NB), pal = new Float64Array(N * NB), tt = new Float64Array(N * NB);
      const lm = new Float64Array(N * NB), lsd = new Float64Array(N * NB);
      for (let j = 0; j < N; j++) {
        let B = 0, G = 0, Aa = 0, X = 0, T = 0, Tn = 0;
        for (let b = 0; b < NB; b++) {
          const i = j * NB + b;
          B += A.bSum[i]; G += A.gSum[i]; Aa += A.aSum[i]; X += A.xSum[i]; T += A.ttSum[i]; Tn += A.ttN[i];
        }
        const lamAll = G > 0 ? B / G : 0.002;
        const palAll = X > 0 ? Aa / X : 0.2;
        const ttAll = Tn > 0 ? T / Tn : (p.segDist[j] || 300) / 6 + 25;
        for (let b = 0; b < NB; b++) {
          const i = j * NB + b;
          lam[i] = (bS[i] + 600 * lamAll) / (gS[i] + 600);
          pal[i] = (aS[i] + 20 * palAll) / (xS[i] + 20);
          tt[i] = (tS[i] + 2 * ttAll) / (tN[i] + 2);
          const n = A.lN[i];
          lm[i] = n > 0 ? A.lSum[i] / n : 0;
          lsd[i] = n > 1 ? Math.sqrt(Math.max(0, A.l2Sum[i] / n - lm[i] ** 2)) : 10;
        }
        if (j === N - 1) for (let b = 0; b < NB; b++) pal[j * NB + b] = 1;
      }
      return { lam, pal, tt, lm, lsd, N };
    });
    this.dwell = {};
    for (const mode of ['tram', 'bus']) {
      const [n, sx, sy, sxy, sxx] = this.dw[mode];
      const den = n * sxx - sx * sx;
      const b = n > 10 && den > 0 ? (n * sxy - sx * sy) / den : 1.6;
      const a = n > 10 ? (sy - b * sx) / n : 10;
      this.dwell[mode] = { a: Math.max(3, a), b: Math.max(0.5, b) };
    }
    delete this.p;
    return this;
  }

  lambda(p, j, t) { return this.m[p].lam[j * NB + bucketOf(t)]; }
  pAlight(p, j, t) { return this.m[p].pal[j * NB + bucketOf(t)]; }
  travel(p, j, t) { return this.m[p].tt[j * NB + bucketOf(t)]; }
  meanLoad(p, j, t) { return this.m[p].lm[j * NB + bucketOf(t)]; }
  sdLoad(p, j, t) { return this.m[p].lsd[j * NB + bucketOf(t)]; }
}

export function trainHistory(net, { date, days = 14 } = {}) {
  if (net.demandScale == null) calibrateDemand(net);
  const h = new HistoryModel(net);
  for (let d = 1; d <= days; d++) {
    const seed = `day-${addDays(date, -d)}`;
    const sc = dayScenario(net, seed);
    h.addDay(simulateDay(net, { seed, ...sc, withReports: false }));
  }
  return h.finalize();
}
