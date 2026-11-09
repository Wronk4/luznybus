// Deterministyczny generator liczb losowych (mulberry32) + rozkłady.
// Deterministyczny = ten sam dzień symulacji daje te same wyniki (łatwiej debugować i testować).

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.a = (typeof seed === 'string' ? hashSeed(seed) : seed) >>> 0;
    this._spare = null;
  }

  next() {
    let t = (this.a = (this.a + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(a = 0, b = 1) {
    return a + (b - a) * this.next();
  }

  normal(mean = 0, sd = 1) {
    if (this._spare !== null) {
      const v = this._spare;
      this._spare = null;
      return mean + sd * v;
    }
    let u, v, s;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * m;
    return mean + sd * u * m;
  }

  lognormal(sigma) {
    // średnia = 1
    return Math.exp(this.normal(-0.5 * sigma * sigma, sigma));
  }

  exponential(mean) {
    return -Math.log(1 - this.next()) * mean;
  }

  poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const L = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.next();
      } while (p > L);
      return k - 1;
    }
    return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
  }

  binomial(n, p) {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (n < 40) {
      let k = 0;
      for (let i = 0; i < n; i++) if (this.next() < p) k++;
      return k;
    }
    const k = Math.round(this.normal(n * p, Math.sqrt(n * p * (1 - p))));
    return Math.min(n, Math.max(0, k));
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}
