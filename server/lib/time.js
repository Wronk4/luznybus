// Czas w całej aplikacji = sekundy od północy dnia kursowania (mogą przekraczać 86400, jak w GTFS).

export const TZ = 'Europe/Warsaw';

export function warsawParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    seconds: +parts.hour * 3600 + +parts.minute * 60 + +parts.second,
    weekday: parts.weekday, // Mon..Sun
  };
}

export function dayTypeOf(weekday) {
  return weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'weekday';
}

export function weekdayOfDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0);
}

export function fmtHHMM(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Zegar symulacji. Domyślnie = czas rzeczywisty w Warszawie.
 * Jeśli teraz nie kursuje komunikacja (noc), demo startuje o 07:45, żeby było co pokazać.
 */
export class Clock {
  constructor({ simTime, speed = 1, live = false, serviceStart = 5 * 3600 + 15 * 60, serviceEnd = 23 * 3600 } = {}) {
    const real = warsawParts();
    this.date = real.date;
    this.speed = live ? 1 : speed;
    let start = simTime != null && !live ? simTime : real.seconds;
    this.demoShift = false;
    if (live && real.seconds < 3 * 3600) {
      // po północy wciąż trwa poprzedni dzień kursowania (czasy GTFS > 24:00)
      this.date = addDays(real.date, -1);
      start += 86400;
    }
    if (!live && simTime == null && (real.seconds < serviceStart || real.seconds > serviceEnd)) {
      start = 7 * 3600 + 45 * 60;
      this.demoShift = true;
    }
    this.startSim = start;
    this.startReal = Date.now();
    this.dayType = dayTypeOf(weekdayOfDate(this.date));
  }

  now() {
    return this.startSim + ((Date.now() - this.startReal) / 1000) * this.speed;
  }
}

/** Epoch (s) północy dnia kursowania w Warszawie – do zamiany czasów GTFS-RT na sekundy dnia. */
export function serviceDayEpoch(dateStr) {
  const noonUtc = Date.parse(`${dateStr}T12:00:00Z`) / 1000;
  const p = warsawParts(new Date(noonUtc * 1000));
  // o 12:00 UTC w Warszawie jest 13:00 albo 14:00 – stąd przesunięcie strefy
  const offset = p.seconds - 12 * 3600;
  return noonUtc - 12 * 3600 - offset;
}
