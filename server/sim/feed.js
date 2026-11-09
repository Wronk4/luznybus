// Strumień danych "na żywo" widziany przez algorytm: tylko to, co już się wydarzyło (t <= now).
export class LiveFeed {
  constructor(net, truth) {
    this.net = net;
    this.truth = truth;
    this.cursor = 0;
  }

  /** Ile przystanków kurs już opuścił do chwili now (dane AVL/GPS). */
  departedCount(ti, now) {
    const dep = this.truth.dep[ti];
    let lo = 0, hi = dep.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dep[mid] <= now) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  arrived(ti, j, now) {
    return this.truth.arr[ti][j] <= now;
  }

  arr(ti, j) {
    return this.truth.arr[ti][j];
  }

  dep(ti, j) {
    return this.truth.dep[ti][j];
  }

  hasApc(ti) {
    return this.truth.apc[ti] === 1;
  }

  /** Zdarzenia (odjazdy, APC, zgłoszenia) z przedziału (ostatnio pobrane, now]. */
  *pull(now) {
    const ev = this.truth.events;
    while (this.cursor < ev.length && ev[this.cursor].t <= now) yield ev[this.cursor++];
  }
}
