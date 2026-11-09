// Drobne komponenty UI (zwracają HTML jako string).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const LEVEL_LABEL = ['Dużo miejsc', 'Na stojąco', 'Tłok', 'Pełny'];
export const LEVEL_COLOR = ['#2E9E5B', '#E0B000', '#E8772E', '#D63B3B'];

export function hhmm(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function minutesLabel(min) {
  if (min <= 0) return 'teraz';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export const durLabel = (sec) => {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m}<small> min</small>` : `${Math.floor(m / 60)}<small> h </small>${m % 60}<small> min</small>`;
};

const PERSON = '<svg viewBox="0 0 12 14"><circle cx="6" cy="3" r="2.7"/><path d="M1.3 14v-3.1C1.3 8.4 3.4 7 6 7s4.7 1.4 4.7 3.9V14z"/></svg>';
const PERSON_OFF = PERSON.replace('<svg', '<svg class="off"');

export function people(level) {
  const n = Math.min(3, level + 1);
  return `<span class="people">${PERSON.repeat(n)}${PERSON_OFF.repeat(3 - n)}</span>`;
}

/** Pigułka obłożenia: ikony ludzików + etykieta. */
export function occPill(o, { label = true, short = false } = {}) {
  if (!o) return '';
  const unsure = o.confidence < 0.5 ? ' unsure' : '';
  const text = short ? ['Luźno', 'Średnio', 'Tłok', 'Pełny'][o.level] : LEVEL_LABEL[o.level];
  return `<span class="occ l${o.level}${unsure}" title="${Math.round(o.ratio * 100)}% pojemności">${people(o.level)}${label ? esc(text) : ''}</span>`;
}

export function lineBadge(l, { lg = false } = {}) {
  const icon = l.mode === 'tram'
    ? '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="12" height="13" rx="3"/><path d="M9 2h6M12 2v3M9 21l1-3M15 21l-1-3"/></svg>'
    : '';
  return `<span class="badge ${l.mode}${lg ? ' lg' : ''}" style="background:${esc(l.color)};color:${esc(l.textColor || '#fff')}">${icon}${esc(l.line ?? l.short)}</span>`;
}

export const WALK_ICON = '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="m9 21 2-6 3 3v3M7 12l2-4 4-1 3 4 3 1M11 15l-1-5"/></svg>';
export const BACK_ICON = '<svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"/></svg>';
export const STOP_ICON = '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></svg>';
export const LOC_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/></svg>';
export const MAP_ICON = '<svg viewBox="0 0 24 24"><path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2ZM9 4v14M15 6v14"/></svg>';
export const PLACE_ICON = '<svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6"/></svg>';
export const CLOCK_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
export const SWAP_ICON = '<svg viewBox="0 0 24 24"><path d="M7 4v16M7 4 4 7M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/></svg>';
export const SPARK_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>';
export const FLAG_ICON = '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>';

/** Okrągły wskaźnik obłożenia. */
export function gauge(o) {
  const r = 32, c = 2 * Math.PI * r;
  const v = Math.min(1, o.ratio);
  return `<div class="gauge"><svg viewBox="0 0 76 76"><circle cx="38" cy="38" r="${r}" stroke="rgba(255,255,255,.15)" stroke-width="8" fill="none"/>
    <circle cx="38" cy="38" r="${r}" stroke="${LEVEL_COLOR[o.level]}" stroke-width="8" fill="none" stroke-linecap="round" stroke-dasharray="${c * v} ${c}"/></svg>
    <div class="val"><div>${Math.round(v * 100)}%<small>zajęte</small></div></div></div>`;
}

export function confBars(conf) {
  const n = conf > 0.8 ? 3 : conf > 0.55 ? 2 : 1;
  return `<span class="conf" title="Pewność ${Math.round(conf * 100)}%">${[0, 1, 2].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
}

export function sourcesText(o) {
  const s = o?.sources;
  if (!s) return '';
  const parts = [];
  if (s.apc) parts.push('<b>licznik pasażerów</b> w pojeździe');
  if (s.reports) parts.push(`<b>${s.reports}</b> ${s.reports === 1 ? 'zgłoszenie' : s.reports < 5 ? 'zgłoszenia' : 'zgłoszeń'} pasażerów${s.lastReportMin != null ? ` (ost. ${s.lastReportMin} min temu)` : ''}`);
  parts.push(s.historicalOnly ? 'dane historyczne' : 'model ruchu (opóźnienia, odstępy)');
  return 'Na podstawie: ' + parts.join(', ');
}

export function profileBars(profile) {
  return `<div class="profile">${profile.map((r) => {
    const lvl = r >= 0.85 ? 3 : r >= 0.55 ? 2 : r >= 0.25 ? 1 : 0;
    return `<i style="height:${Math.max(10, Math.min(100, r * 100))}%;background:${LEVEL_COLOR[lvl]}"></i>`;
  }).join('')}</div>`;
}

export const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
