// Poziomy obłożenia i matematyka rozkładów (normalny ocenzurowany do [0, pojemność]).

/** Progi jako ułamek pojemności pojazdu (miejsca siedzące to ok. 25–32% pojemności). */
export const LEVELS = [
  { id: 0, key: 'empty', label: 'Dużo miejsc', short: 'Luźno', lo: 0.0, hi: 0.25, color: '#2E9E5B' },
  { id: 1, key: 'standing', label: 'Na stojąco', short: 'Średnio', lo: 0.25, hi: 0.55, color: '#E0B000' },
  { id: 2, key: 'crowded', label: 'Tłok', short: 'Tłok', lo: 0.55, hi: 0.85, color: '#E8772E' },
  { id: 3, key: 'full', label: 'Pełny', short: 'Pełny', lo: 0.85, hi: 1.0, color: '#D63B3B' },
];

export function levelOf(ratio) {
  for (let i = LEVELS.length - 1; i >= 0; i--) if (ratio >= LEVELS[i].lo) return i;
  return 0;
}

/** Środek i niepewność zgłoszenia pasażera danego poziomu (jako ułamek pojemności). */
export function levelObservation(level) {
  const L = LEVELS[level];
  const hi = level === 3 ? 1.05 : L.hi;
  return { mid: (L.lo + hi) / 2, half: (hi - L.lo) / 2 };
}

const SQRT2 = Math.SQRT2;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

export function erf(x) {
  // Abramowitz–Stegun 7.1.26 (błąd < 1.5e-7)
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

export const normCdf = (z) => 0.5 * (1 + erf(z / SQRT2));
export const normPdf = (z) => INV_SQRT_2PI * Math.exp(-0.5 * z * z);

/**
 * Momenty zmiennej Y = min(max(X, lo), hi), X ~ N(mu, v).
 * Do tego oczekiwany nadmiar E[max(X - hi, 0)] = pasażerowie, którzy się nie zmieścili,
 * oraz P(X > hi) = ryzyko, że pojazd przyjedzie pełny.
 */
export function censoredMoments(mu, v, lo, hi) {
  if (v <= 1e-9) {
    const y = Math.min(hi, Math.max(lo, mu));
    return { mean: y, var: 0, over: Math.max(0, mu - hi), pOver: mu > hi ? 1 : 0 };
  }
  const s = Math.sqrt(v);
  const a = (lo - mu) / s;
  const b = (hi - mu) / s;
  const Fa = normCdf(a), Fb = normCdf(b);
  const fa = normPdf(a), fb = normPdf(b);
  const mid = Fb - Fa;
  const mean = lo * Fa + hi * (1 - Fb) + mu * mid + s * (fa - fb);
  const inner = (mu * mu + v) * mid + 2 * mu * s * (fa - fb) + v * (a * fa - b * fb);
  const ey2 = lo * lo * Fa + hi * hi * (1 - Fb) + inner;
  const variance = Math.max(0, ey2 - mean * mean);
  const over = Math.max(0, (mu - hi) * (1 - Fb) + s * fb);
  return { mean, var: variance, over, pOver: 1 - Fb };
}

/** Rozkład prawdopodobieństwa poziomów dla N(x, P) ocenzurowanego do [0, cap]. */
export function levelProbs(x, P, cap) {
  const s = Math.sqrt(Math.max(P, 1e-6));
  const probs = LEVELS.map((L, i) => {
    const lo = i === 0 ? -Infinity : (L.lo * cap - x) / s;
    const hi = i === LEVELS.length - 1 ? Infinity : (L.hi * cap - x) / s;
    return normCdf(hi) - normCdf(lo);
  });
  return probs;
}

/** Pełny opis obłożenia do API. */
export function describe(x, P, cap, seats, extra = {}) {
  x = Math.max(0, Math.min(cap, x));
  const sd = Math.sqrt(Math.max(P, 0));
  const ratio = x / cap;
  const probs = levelProbs(x, P, cap);
  let level = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[level]) level = i;
  const seatProb = normCdf((seats - x) / Math.max(sd, 1));
  // pewność: jak bardzo rozkład jest skupiony na jednym poziomie
  const confidence = probs[level];
  return {
    load: Math.round(x),
    sd: Math.round(sd * 10) / 10,
    capacity: cap,
    seats,
    ratio: Math.round(ratio * 1000) / 1000,
    level,
    probs: probs.map((p) => Math.round(p * 1000) / 1000),
    seatProb: Math.round(seatProb * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    ...extra,
  };
}
