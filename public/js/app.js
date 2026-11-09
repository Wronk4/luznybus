import { createMap } from './map.js';
import {
  esc, hhmm, minutesLabel, durLabel, occPill, lineBadge, people, gauge, confBars, sourcesText, profileBars, norm,
  LEVEL_LABEL, LEVEL_COLOR, WALK_ICON, BACK_ICON, STOP_ICON, LOC_ICON, MAP_ICON, PLACE_ICON, CLOCK_ICON, SWAP_ICON, SPARK_ICON, FLAG_ICON,
} from './ui.js';

const $ = (sel, el = document) => el.querySelector(sel);
const phone = $('#phone');
const sheet = $('#sheet');
const head = $('#sheet-head');
const body = $('#sheet-body');

// ======================================================================= stan
const S = {
  cfg: null, stops: [], lines: [], map: null,
  vehicles: new Map(), showVehicles: true, focus: null,
  from: null, to: null, time: null, mode: localStorage.getItem('lb-mode') || 'comfort',
  overlays: [], stopMarkers: [], myPos: null, myMarker: null, pickMode: null,
  clock: { sim: 0, real: Date.now(), speed: 1 },
  userId: (() => {
    let id = null;
    try { id = localStorage.getItem('lb-user'); if (!id) { id = crypto.randomUUID(); localStorage.setItem('lb-user', id); } } catch { id = 'anon-' + Math.random().toString(36).slice(2); }
    return id;
  })(),
  lastJourneys: null,
};
const simNow = () => S.clock.sim + ((Date.now() - S.clock.real) / 1000) * S.clock.speed;

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { data: j });
  return j;
}

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.innerHTML = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ======================================================================= bottom sheet
const SHEET = { peek: 0.3, half: 0.52, full: 0.86 };
function setSheet(state) {
  sheet.dataset.state = state;
  phone.style.setProperty('--sheet-h', `${SHEET[state] * 100}%`);
}
(function sheetDrag() {
  const grip = $('#sheet-grip');
  let startY = 0, startH = 0, dragging = false;
  const avail = () => phone.clientHeight;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true; startY = e.clientY; startH = sheet.getBoundingClientRect().height;
    sheet.classList.add('dragging'); grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = Math.max(avail() * 0.18, Math.min(avail() * 0.9, startH + (startY - e.clientY)));
    phone.style.setProperty('--sheet-h', `${h}px`);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    const moved = Math.abs(e.clientY - startY) > 6;
    const f = sheet.getBoundingClientRect().height / avail();
    if (!moved) return setSheet(sheet.dataset.state === 'peek' ? 'half' : sheet.dataset.state === 'half' ? 'full' : 'peek');
    const best = Object.entries(SHEET).reduce((a, b) => (Math.abs(b[1] - f) < Math.abs(a[1] - f) ? b : a));
    setSheet(best[0]);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
})();
const sheetPx = () => Math.min(sheet.getBoundingClientRect().height + 70, phone.clientHeight - 200);

// ======================================================================= nawigacja
const nav = { tab: 'route', stack: [] };
let current = null;

function render() {
  const v = nav.stack[nav.stack.length - 1];
  if (current && current !== v) current.unmount?.();
  clearOverlays();
  current = v;
  const canBack = nav.stack.length > 1;
  head.innerHTML = v.head ? `<div class="view-head">${canBack ? `<button class="back" id="nav-back" aria-label="Wstecz">${BACK_ICON}</button>` : ''}${v.head()}</div>` : '';
  if (canBack) $('#nav-back').onclick = back;
  body.scrollTop = 0;
  v.mount(body);
  if (v.sheet) setSheet(v.sheet);
}
function push(v) { nav.stack.push(v); render(); }
function back() { if (nav.stack.length > 1) { nav.stack.pop(); render(); } }
function switchTab(tab) {
  nav.tab = tab;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  nav.stack = [ROOTS[tab]()];
  render();
}
document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

setInterval(() => { if (document.visibilityState === 'visible') current?.refresh?.(); }, 10000);

// ======================================================================= mapa: warstwy
function clearOverlays() {
  S.overlays.forEach((o) => o.remove());
  S.overlays = [];
  setFocus(null);
}
const overlay = (o) => (S.overlays.push(o), o);

function pinEl(kind) {
  const el = document.createElement('div');
  el.className = 'pinm';
  const fill = kind === 'to' ? '#F2A541' : '#13212E';
  el.innerHTML = `<svg viewBox="0 0 30 38"><path d="M15 37s13-12.4 13-22A13 13 0 0 0 2 15c0 9.6 13 22 13 22Z" fill="${fill}"/><circle cx="15" cy="15" r="5" fill="#fff"/></svg>`;
  return el;
}
function stopDot(big = false) {
  const el = document.createElement('div');
  el.className = 'sm' + (big ? ' big' : '');
  return el;
}

function drawStopMarkers() {
  S.stopMarkers.forEach((m) => m.remove());
  S.stopMarkers = [];
  if (S.map.getZoom() < 14) return;
  for (const s of S.stops) {
    S.stopMarkers.push(S.map.addMarker({ lat: s.lat, lng: s.lng, el: stopDot(), zIndex: 2, onClick: () => push(StopBoard(s.idx)) }));
  }
}

function vehicleEl(v) {
  const el = document.createElement('div');
  el.innerHTML = '<span class="arrow"></span><span class="t"></span>';
  updateVehicleEl(el, v);
  return el;
}
function updateVehicleEl(el, v) {
  el.className = `vm ${v.mode} l${v.level}`;
  el.style.background = v.color;
  el.querySelector('.t').textContent = v.line;
  const arrow = el.querySelector('.arrow');
  arrow.style.display = v.bearing == null ? 'none' : '';
  arrow.style.transform = `rotate(${v.bearing || 0}deg)`;
  el.title = `${v.line} → ${v.headsign} · ${LEVEL_LABEL[v.level]} (${Math.round(v.ratio * 100)}%)`;
  applyFocus(el, v);
}
function applyFocus(el, v) {
  const f = S.focus;
  el.classList.toggle('dim', !!f && !(f.trip === v.id || (f.line && f.line === v.line)));
  el.classList.toggle('focus', !!f && f.trip === v.id);
}
function setFocus(f) {
  S.focus = f;
  updateVehicles();
  for (const [, m] of S.vehicles) { applyFocus(m.el, m.v); m.setZ(f && f.trip === m.v.id ? 50 : 10); }
}
// Renderujemy tylko pojazdy w widoku mapy (z marginesem), maks. MAX_VEH najbliższych środka.
// Pojazd/linia w fokusie są zawsze widoczne. Dzięki temu na całym mieście nie ma setek markerów.
const MAX_VEH = 45;
function visibleVehicles(list) {
  const b = S.map.getBounds?.();
  const f = S.focus;
  const keep = (v) => f && (f.trip === v.id || (f.line && f.line === v.line));
  if (!b) return list.slice(0, MAX_VEH);
  const dLat = (b.n - b.s) * 0.15, dLng = (b.e - b.w) * 0.15;
  const cLat = (b.n + b.s) / 2, cLng = (b.e + b.w) / 2;
  const pinned = [], inView = [];
  for (const v of list) {
    if (keep(v)) pinned.push(v);
    else if (v.lat <= b.n + dLat && v.lat >= b.s - dLat && v.lng <= b.e + dLng && v.lng >= b.w - dLng) inView.push(v);
  }
  if (inView.length > MAX_VEH) {
    const d = (v) => (v.lat - cLat) ** 2 + ((v.lng - cLng) * 0.64) ** 2;
    inView.sort((a, c) => d(a) - d(c)).length = MAX_VEH;
  }
  return pinned.concat(inView);
}
function updateVehicles(data) {
  if (data) {
    S.clock = { sim: data.now, real: Date.now(), speed: S.cfg.speed };
    S.lastVehicles = data.vehicles;
  }
  if (!S.showVehicles || !S.lastVehicles) return;
  const seen = new Set();
  for (const v of visibleVehicles(S.lastVehicles)) {
    seen.add(v.id);
    let m = S.vehicles.get(v.id);
    if (!m) {
      m = S.map.addMarker({ lat: v.lat, lng: v.lng, el: vehicleEl(v), zIndex: 10, onClick: () => push(TripView(v.id)) });
      S.vehicles.set(v.id, m);
    } else {
      const o = m.v;
      if (o.lat !== v.lat || o.lng !== v.lng) m.setPosition(v.lat, v.lng);
      if (o.level !== v.level || o.bearing !== v.bearing || o.color !== v.color || Math.round(o.ratio * 100) !== Math.round(v.ratio * 100)) updateVehicleEl(m.el, v);
    }
    m.v = v;
  }
  for (const [id, m] of S.vehicles) if (!seen.has(id)) { m.remove(); S.vehicles.delete(id); }
}
function clearVehicles() { for (const [, m] of S.vehicles) m.remove(); S.vehicles.clear(); }

// ======================================================================= lokalizacja
// Domyślna pozycja, gdy urządzenie nie udostępnia lokalizacji: Politechnika Rzeszowska, budynek A (al. Powstańców Warszawy 12).
const HOME = { lat: 50.01915, lng: 21.98935, name: 'Politechnika Rzeszowska (bud. A)' };
function locate({ silent = false } = {}) {
  return new Promise((resolve) => {
    const fallback = () => resolve({ ...HOME, approx: true });
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pos = { lat: p.coords.latitude, lng: p.coords.longitude, name: 'Moja lokalizacja' };
        const c = S.cfg.city.center;
        const far = Math.hypot((pos.lat - c.lat) * 111, (pos.lng - c.lng) * 71) > 30;
        if (far) {
          if (!silent) toast('Jesteś poza Rzeszowem – pokazuję okolice Politechniki (bud. A).');
          return fallback();
        }
        resolve(pos);
      },
      () => { if (!silent) toast('Brak lokalizacji – pokazuję okolice Politechniki Rzeszowskiej (bud. A).'); fallback(); },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 },
    );
  }).then((pos) => {
    S.myPos = pos;
    S.myMarker?.remove();
    const el = document.createElement('div');
    el.className = 'me';
    S.myMarker = S.map.addMarker({ lat: pos.lat, lng: pos.lng, el, zIndex: 20 });
    return pos;
  });
}

// ======================================================================= widok: Trasa (wyszukiwarka)
// Godzina zawsze w formacie 24h (natywny <input type=time> pokazuje AM/PM wg języka systemu).
const pad2 = (n) => String(n).padStart(2, '0');
function timeSelects(t) {
  const [h, m] = t.split(':').map(Number);
  const opt = (n, cur) => `<option value="${pad2(n)}"${n === cur ? ' selected' : ''}>${pad2(n)}</option>`;
  return `<select id="in-h" aria-label="Godzina">${Array.from({ length: 24 }, (_, i) => opt(i, h)).join('')}</select>:<select id="in-m" aria-label="Minuty">${Array.from({ length: 60 }, (_, i) => opt(i, m)).join('')}</select>`;
}
const QUICK = [
  // sieć demo (id przystanków)
  ['BAR', 'SLO', 'Baranówka → Słocina'],
  ['DRA', 'DWG', 'Drabinianka → Dworzec'],
  ['STA', 'URR', 'Staromieście → Uniwersytet'],
  ['ZAL', 'POL', 'Załęże → Politechnika'],
  // prawdziwy GTFS Rzeszowa (początek nazwy przystanku)
  ['Dworzec Główny PKP', 'Powst. Warszawy politechnika', 'Dworzec → Politechnika'],
  ['Rejtana uniwersytet', 'Piłsudskiego U. Wojewódzki', 'Uniwersytet → Urząd Wojewódzki'],
  ['Krakowska galeria', 'Lubelska szpital', 'Krakowska galeria → Lubelska szpital'],
  ['Podkarpacka politechnika', 'Dworzec Lokalny', 'Podkarpacka → Dworzec Lokalny'],
];
const findStop = (key) => S.stops.find((s) => s.id === key) || S.stops.find((s) => s.name.startsWith(key));
const quickRoutes = () => QUICK.filter(([a, b]) => findStop(a) && findStop(b)).slice(0, 4);
const stopPlace = (s) => ({ lat: s.lat, lng: s.lng, name: s.name, stop: s.idx });

function RouteHome() {
  let active = null; // 'from' | 'to'
  return {
    head: () => `<h2>Dokąd jedziesz?</h2>`,
    mount(el) {
      el.innerHTML = `
        <div class="search-card">
          <label class="field"><span class="pin"></span><input id="in-from" placeholder="Skąd? (przystanek, adres)" autocomplete="off" value="${esc(S.from?.name || '')}"/></label>
          <label class="field"><span class="pin to"></span><input id="in-to" placeholder="Dokąd?" autocomplete="off" value="${esc(S.to?.name || '')}"/></label>
          <button class="swap" id="btn-swap" aria-label="Zamień">${SWAP_ICON}</button>
        </div>
        <div class="row-actions">
          <span class="pill-btn time-pill ${S.time ? 'on' : ''}" id="time-pill">${CLOCK_ICON}${timeSelects(S.time || hhmm(simNow()))}</span>
          <button class="pill-btn" id="btn-now">Teraz</button>
          <span style="flex:1"></span>
          <div class="seg" id="seg-mode"><button data-m="comfort" class="${S.mode === 'comfort' ? 'on' : ''}">Wygodnie</button><button data-m="fast" class="${S.mode === 'fast' ? 'on' : ''}">Szybko</button></div>
        </div>
        <div id="suggest-wrap"></div>
        <button class="primary" id="btn-search" ${S.from && S.to ? '' : 'disabled'}>Szukaj połączeń</button>
        <div id="home-extra"></div>`;
      const inFrom = $('#in-from', el), inTo = $('#in-to', el);
      const wrap = $('#suggest-wrap', el);
      const extra = $('#home-extra', el);
      const refreshBtn = () => ($('#btn-search', el).disabled = !(S.from && S.to));
      const showExtra = () => {
        extra.innerHTML = `
          <div class="section-title">Przykładowe trasy</div>
          <div class="quick">${quickRoutes().map(([a, b, l], i) => `<button data-q="${i}"><b>${esc(l)}</b><small>${esc(findStop(a)?.lines.slice(0, 4).join(', ') || '')}</small></button>`).join('')}</div>
          <div class="section-title">Jak to działa</div>
          <div class="card"><div class="how">Widzisz <b>przewidywane obłożenie</b> każdego kursu, zanim do niego wsiądziesz.
          W trybie <b>Wygodnie</b> podpowiemy, kiedy warto poczekać kilka minut na luźniejszy pojazd.
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${[0, 1, 2, 3].map((l) => occPill({ level: l, ratio: 0, confidence: 1 })).join('')}</div></div></div>`;
        extra.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
          const [a, c] = quickRoutes()[+b.dataset.q];
          S.from = stopPlace(findStop(a));
          S.to = stopPlace(findStop(c));
          search();
        }));
      };
      showExtra();

      const choose = (which, place) => {
        S[which] = place;
        (which === 'from' ? inFrom : inTo).value = place.name;
        wrap.innerHTML = '';
        active = null;
        showExtra();
        refreshBtn();
        drawEndpoints();
        if (S.from && S.to) search();
        else (which === 'from' ? inTo : inFrom).focus();
      };

      let seq = 0;
      const suggest = async (which, q) => {
        active = which;
        extra.innerHTML = '';
        const my = ++seq;
        const nq = norm(q.trim());
        const stops = nq ? S.stops.filter((s) => norm(s.name).includes(nq)).slice(0, 6) : [];
        const items = [];
        if (!nq) {
          items.push({ ico: LOC_ICON, name: 'Moja lokalizacja', sub: 'Użyj GPS', act: async () => choose(which, await locate()) });
          items.push({ ico: MAP_ICON, name: 'Wybierz na mapie', sub: 'Dotknij miejsca na mapie', act: () => { S.pickMode = which; setSheet('peek'); toast('Dotknij mapy, aby wybrać punkt'); } });
        }
        stops.forEach((s) => items.push({ ico: STOP_ICON, name: s.name, sub: `Przystanek · ${s.lines.join(', ')}`, act: () => choose(which, stopPlace(s)) }));
        const draw = () => {
          if (my !== seq) return;
          wrap.innerHTML = items.length ? `<div class="suggest">${items.map((it, i) => `<button data-i="${i}"><span class="ico">${it.ico}</span><span><b>${esc(it.name)}</b><small>${esc(it.sub)}</small></span></button>`).join('')}</div>` : '';
          wrap.querySelectorAll('[data-i]').forEach((b) => (b.onmousedown = b.onclick = (e) => { e.preventDefault(); items[+b.dataset.i].act(); }));
        };
        draw();
        if (nq.length >= 3) {
          const places = await S.map.searchPlaces(q, S.cfg.city.center);
          if (my !== seq) return;
          places.forEach((p) => items.push({ ico: PLACE_ICON, name: p.name, sub: p.secondary || 'Adres', act: async () => choose(which, await p.resolve()) }));
          draw();
        }
      };
      for (const [inp, which] of [[inFrom, 'from'], [inTo, 'to']]) {
        inp.onfocus = () => { setSheet('full'); suggest(which, inp.value === S[which]?.name ? '' : inp.value); };
        inp.oninput = () => { S[which] = null; refreshBtn(); suggest(which, inp.value); };
        inp.onkeydown = (e) => { if (e.key === 'Enter') { const b = wrap.querySelector('[data-i]'); if (b) b.click(); } };
      }
      $('#btn-swap', el).onclick = (e) => {
        e.preventDefault();
        [S.from, S.to] = [S.to, S.from];
        inFrom.value = S.from?.name || '';
        inTo.value = S.to?.name || '';
        drawEndpoints();
        refreshBtn();
      };
      const hSel = $('#in-h', el), mSel = $('#in-m', el);
      const setSel = (t) => { const [h, m] = t.split(':'); hSel.value = h; mSel.value = m; };
      hSel.onchange = mSel.onchange = () => { S.time = `${hSel.value}:${mSel.value}`; $('#time-pill', el).classList.add('on'); };
      $('#btn-now', el).onclick = () => { S.time = null; setSel(hhmm(simNow())); $('#time-pill', el).classList.remove('on'); };
      el.querySelectorAll('#seg-mode button').forEach((b) => (b.onclick = () => {
        S.mode = b.dataset.m;
        try { localStorage.setItem('lb-mode', S.mode); } catch { /* ignore */ }
        el.querySelectorAll('#seg-mode button').forEach((x) => x.classList.toggle('on', x === b));
      }));
      $('#btn-search', el).onclick = search;
      drawEndpoints();
    },
    sheet: 'half',
  };
}

function drawEndpoints() {
  S.endpointMarkers?.forEach((m) => m.remove());
  S.endpointMarkers = [];
  if (S.from) S.endpointMarkers.push(S.map.addMarker({ ...S.from, el: pinEl('from'), zIndex: 30 }));
  if (S.to) S.endpointMarkers.push(S.map.addMarker({ ...S.to, el: pinEl('to'), zIndex: 30 }));
}

async function search() {
  if (!S.from || !S.to) return;
  drawEndpoints();
  push(Results());
}

// ======================================================================= widok: wyniki
function Results() {
  let data = null;
  return {
    head: () => `<div style="flex:1;min-width:0"><h2>${esc(S.from.name)} → ${esc(S.to.name)}</h2><div class="sub">${S.time ? `Wyjazd ${S.time}` : 'Wyjazd teraz'} · ${S.mode === 'comfort' ? 'najwygodniejsze' : 'najszybsze'}</div></div>`,
    sheet: 'half',
    async mount(el) {
      el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      S.map.fitBounds([[S.from.lat, S.from.lng], [S.to.lat, S.to.lng]], { bottom: sheetPx() });
      try {
        const q = new URLSearchParams({ from: `${S.from.lat},${S.from.lng}`, to: `${S.to.lat},${S.to.lng}`, mode: S.mode });
        if (S.time) q.set('time', S.time);
        data = await api(`/api/plan?${q}`);
      } catch (e) {
        el.innerHTML = `<div class="empty">Nie udało się wyszukać połączeń.<br>${esc(e.message)}</div>`;
        return;
      }
      S.lastJourneys = data.journeys;
      if (!data.journeys.length) { el.innerHTML = '<div class="empty">Brak połączeń w najbliższym czasie.</div>'; return; }
      const best = data.journeys.find((j) => j.tags.includes('comfort'));
      el.innerHTML = `
        <div class="seg" style="margin-bottom:10px"><button data-m="comfort" class="${S.mode === 'comfort' ? 'on' : ''}">Wygodnie</button><button data-m="fast" class="${S.mode === 'fast' ? 'on' : ''}">Szybko</button></div>
        ${data.journeys.map((j, i) => journeyCard(j, i, data.now)).join('')}
        <p class="muted small" style="text-align:center">Obłożenie przewidywane na moment wejścia do pojazdu.</p>`;
      el.querySelectorAll('[data-j]').forEach((b) => (b.onclick = () => push(JourneyDetail(data.journeys[+b.dataset.j]))));
      el.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { S.mode = b.dataset.m; nav.stack.pop(); push(Results()); }));
      previewJourney(best || data.journeys[0]);
    },
  };
}

function journeyCard(j, i, now) {
  const rides = j.legs.filter((l) => l.type === 'ride');
  const first = rides[0];
  const legs = j.legs.map((l) => {
    if (l.type === 'walk') return l.dur > 90 ? `<span class="walk">${WALK_ICON}${Math.round(l.dur / 60)}</span>` : '';
    return `${lineBadge(l)}<span class="occ l${l.occupancy.level}" style="padding:2px 4px">${people(l.occupancy.level)}</span>`;
  }).filter(Boolean).join('<span class="sep">›</span>');
  const tags = [
    j.tags.includes('comfort') ? '<span class="tag comfort">Najwygodniejsze</span>' : '',
    j.tags.includes('fastest') ? '<span class="tag fastest">Najszybsze</span>' : '',
  ].join('');
  const leave = Math.round((j.dep - now) / 60);
  const hint = j.waitHint
    ? `<div class="hint">${SPARK_ICON}<span>Poczekaj <b>${j.waitHint.minutes} min</b> – następne <b>${esc(j.waitHint.line)}</b> jest luźniejsze (${Math.round(j.waitHint.ratioLater * 100)}% zamiast ${Math.round(j.waitHint.ratioNow * 100)}% zajętości).</span></div>`
    : '';
  return `<button class="card tap" data-j="${i}">
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    <div class="j-top"><span class="j-time">${hhmm(j.dep)} – ${hhmm(j.arr)}</span><span class="j-dur">${durLabel(j.duration)}</span></div>
    <div class="j-legs">${legs || `<span class="walk">${WALK_ICON} pieszo</span>`}</div>
    <div class="j-meta">
      ${first ? `${occPill(first.occupancy)}<span>Miejsce siedzące: <b>${Math.round(j.minSeatProb * 100)}%</b></span>` : ''}
      <span>${leave <= 0 ? 'Wyjdź teraz' : `Wyjdź za <b>${minutesLabel(leave)}</b>`}</span>
      ${first ? `<span>${first.realtime && Math.abs(first.delay) >= 60 ? `<span class="rt-ico"></span>${first.delay > 0 ? '+' : ''}${Math.round(first.delay / 60)} min` : first.realtime ? '<span class="rt-ico"></span>na czas' : 'wg rozkładu'}</span>` : ''}
    </div>
    ${hint}
  </button>`;
}

function previewJourney(j, { fit = true } = {}) {
  clearOverlaysKeepFocus();
  const pts = [];
  for (const l of j.legs) {
    if (l.type === 'walk') {
      const path = [[l.from.lat, l.from.lng], [l.to.lat, l.to.lng]];
      overlay(S.map.addPolyline({ path, color: '#6b7785', weight: 4, dashed: true }));
      pts.push(...path);
    } else {
      overlay(S.map.addPolyline({ path: l.path, color: l.color, weight: 6, casing: true, zIndex: 5 }));
      overlay(S.map.addMarker({ lat: l.from.lat, lng: l.from.lng, el: stopDot(true), zIndex: 25 }));
      overlay(S.map.addMarker({ lat: l.to.lat, lng: l.to.lng, el: stopDot(true), zIndex: 25 }));
      pts.push(...l.path);
    }
  }
  if (fit) S.map.fitBounds(pts, { bottom: sheetPx() });
}
function clearOverlaysKeepFocus() { S.overlays.forEach((o) => o.remove()); S.overlays = []; }

// ======================================================================= widok: szczegóły podróży
function JourneyDetail(j) {
  return {
    head: () => `<div style="flex:1"><h2>${hhmm(j.dep)} – ${hhmm(j.arr)}</h2><div class="sub">${Math.round(j.duration / 60)} min · ${j.transfers ? `${j.transfers} ${j.transfers === 1 ? 'przesiadka' : 'przesiadki'}` : 'bez przesiadek'} · ${Math.round(j.walkSec / 60)} min pieszo</div></div>`,
    sheet: 'half',
    mount(el) {
      previewJourney(j);
      const rides = j.legs.filter((l) => l.type === 'ride');
      if (rides[0]) setFocus({ trip: rides[0].tripId });
      const items = [];
      j.legs.forEach((l, i) => {
        const isLast = i === j.legs.length - 1;
        if (l.type === 'walk') {
          items.push(`<div class="tl-item${i === 0 ? ' first' : ''}"><div class="tl-time">${hhmm(l.dep)}</div><div class="tl-rail walk"><span class="node small" style="--c:#6b7785"></span></div>
            <div class="tl-body"><div class="t">${esc(l.from.name)}</div><div class="s">${WALK_ICON.replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px"')} Idź ${Math.round(l.dur / 60)} min (${Math.round(l.dist)} m)${l.to.stop != null ? ` do przystanku <b>${esc(l.to.name)}</b>` : ''}</div></div></div>`);
          if (isLast) items.push(`<div class="tl-item last"><div class="tl-time">${hhmm(l.arr)}</div><div class="tl-rail"><span class="node" style="--c:#F2A541"></span></div><div class="tl-body"><div class="t">${esc(l.to.name)}</div><div class="s">Cel podróży</div></div></div>`);
          return;
        }
        const o = l.occupancy;
        const delay = l.realtime && Math.abs(l.delay) >= 60 ? `<small style="color:${l.delay > 0 ? '#b02525' : '#1f7a44'}">${l.delay > 0 ? '+' : ''}${Math.round(l.delay / 60)} min</small>` : l.realtime ? '<small style="color:#1f7a44">na czas</small>' : '<small>rozkład</small>';
        items.push(`<div class="tl-item" style="--c:${esc(l.color)}"><div class="tl-time">${hhmm(l.dep)}${delay}</div><div class="tl-rail"><span class="node"></span></div>
          <div class="tl-body"><div class="t">${esc(l.from.name)}</div>
            <div class="s" style="display:flex;gap:8px;align-items:center;margin-top:6px">${lineBadge(l)} <span>→ ${esc(l.headsign)}</span></div>
            <div class="ride-box">
              <div class="row">${occPill(o)}<span>Miejsce siedzące <b>${Math.round(o.seatProb * 100)}%</b></span></div>
              <div class="row"><span class="muted small">Obłożenie po drodze (${l.stops.length - 1} ${l.stops.length - 1 === 1 ? 'przystanek' : 'przystanki'})</span><span class="small">max <b>${Math.round(o.maxRatio * 100)}%</b></span></div>
              ${profileBars(o.profile)}
              ${o.boardRisk > 0.15 ? `<div class="row" style="color:#b02525;font-weight:600">⚠ Ryzyko, że się nie zmieścisz: ${Math.round(o.boardRisk * 100)}%</div>` : ''}
              <div class="row"><span class="muted small">Pewność prognozy ${confBars(o.confidence).replace(/rgba\(255,255,255,.25\)/, '')}</span><button class="pill-btn" data-trip="${esc(l.tripId)}">Pokaż pojazd</button></div>
            </div>
          </div></div>`);
        items.push(`<div class="tl-item" style="--c:${esc(l.color)}"><div class="tl-time">${hhmm(l.arr)}</div><div class="tl-rail"><span class="node small"></span></div><div class="tl-body"><div class="t">${esc(l.to.name)}</div><div class="s">Wysiądź</div></div></div>`);
        if (isLast) items.push(`<div class="tl-item last"><div class="tl-time">${hhmm(l.arr)}</div><div class="tl-rail"><span class="node" style="--c:#F2A541"></span></div><div class="tl-body"><div class="t">${esc(S.to.name)}</div></div></div>`);
      });
      el.innerHTML = `${j.waitHint ? `<div class="hint" style="margin:0 0 12px">${SPARK_ICON}<span>Ten wariant startuje <b>${j.waitHint.minutes} min</b> później, ale pojedziesz luźniejszym pojazdem.</span></div>` : ''}
        <div class="card"><div class="timeline">${items.join('')}</div></div>`;
      el.querySelectorAll('[data-trip]').forEach((b) => (b.onclick = () => push(TripView(b.dataset.trip))));
    },
  };
}

// ======================================================================= widok: kurs (pojazd)
function TripView(tripId) {
  let data = null;
  let drawn = false;
  const view = {
    head: () => data
      ? `${lineBadge(data, { lg: true })}<div style="flex:1;min-width:0"><h2>→ ${esc(data.headsign)}</h2><div class="sub">${data.mode === 'tram' ? 'Tramwaj' : 'Autobus'} · ${data.capacity} miejsc (${data.seats} siedzących)</div></div>`
      : '<h2>Ładowanie…</h2>',
    sheet: 'half',
    async mount(el) {
      if (!data) el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
      try { data = await api(`/api/trips/${encodeURIComponent(tripId)}`); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      head.querySelector('.view-head').innerHTML = (nav.stack.length > 1 ? `<button class="back" id="nav-back">${BACK_ICON}</button>` : '') + view.head();
      if ($('#nav-back')) $('#nav-back').onclick = back;
      setFocus({ trip: data.tripId });
      if (!drawn) {
        overlay(S.map.addPolyline({ path: data.shape, color: data.color, weight: 6, casing: true, zIndex: 4 }));
        data.stops.forEach((s) => overlay(S.map.addMarker({ lat: s.lat, lng: s.lng, el: stopDot(), zIndex: 3, onClick: () => push(StopBoard(s.idx)) })));
        if (data.position) S.map.panTo(data.position.lat, data.position.lng, 15, sheetPx());
        else S.map.fitBounds(data.shape, { bottom: sheetPx() });
        drawn = true;
      }
      const k = data.progress;
      const running = k > 0 && k < data.stops.length && !(data.stops.at(-1).passed);
      const curIdx = Math.max(0, Math.min(data.stops.length - 2, k - 1));
      const cur = data.stops[curIdx].occupancy;
      const now = data.now;
      const delay = Math.round((data.stops[Math.min(k, data.stops.length - 1)].dep - data.stops[Math.min(k, data.stops.length - 1)].schedDep) / 60);
      el.innerHTML = `
        <div class="vehicle-hero">${gauge(cur)}
          <div style="min-width:0"><div class="lbl">${LEVEL_LABEL[cur.level]} ${confBars(cur.confidence)}</div>
          <div class="src">${running ? `Teraz w pojeździe ok. <b>${cur.load}</b> osób` : `Prognoza na start kursu: ok. <b>${cur.load}</b> osób`} · miejsce siedzące ${Math.round(cur.seatProb * 100)}%<br>${sourcesText(cur)}</div></div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          ${running ? `<button class="primary report-btn" id="btn-report" style="margin:0;flex:1">${FLAG_ICON} Zgłoś obłożenie</button>` : ''}
          ${data.nextTripId ? `<button class="secondary" id="btn-next" style="flex:1">Następny kurs</button>` : ''}
        </div>
        <div class="card"><div class="timeline">${data.stops.map((s, j) => {
          const o = s.occupancy;
          const c = o ? LEVEL_COLOR[o.level] : 'var(--sand)';
          const isNext = j === k;
          const t = s.passed ? s.dep : s.arr;
          const d = Math.round((t - (s.passed ? s.schedDep : s.schedArr)) / 60);
          return `<div class="tl-item${s.passed ? ' passed' : ''}${j === 0 ? ' first' : ''}${j === data.stops.length - 1 ? ' last' : ''}" style="--c:${c}">
            <div class="tl-time">${hhmm(t)}${!s.passed && data.realtime && d !== 0 ? `<small style="color:${d > 0 ? '#b02525' : '#1f7a44'}">${d > 0 ? '+' : ''}${d}</small>` : ''}</div>
            <div class="tl-rail"><span class="node ${isNext ? '' : 'small'}" style="--c:${isNext ? data.color : c}"></span></div>
            <div class="tl-body" style="padding-bottom:12px"><div class="t" style="font-size:14px;${isNext ? 'color:' + esc(data.color) : ''}">${esc(s.name)}${isNext && running ? ' <span class="small muted">· następny</span>' : ''}</div>
            ${o && !s.passed ? `<div class="s">${occPill(o, { short: true })} <span class="small">${Math.round(o.ratio * 100)}% · ${o.load} os.</span></div>` : ''}</div></div>`;
        }).join('')}</div></div>
        <p class="muted small" style="text-align:center">${data.realtime ? 'Czasy na żywo (GPS)' : 'Czasy wg rozkładu'} · kolor osi = przewidywane obłożenie po odjeździe z przystanku${delay ? ` · opóźnienie ${delay > 0 ? '+' : ''}${delay} min` : ''}</p>`;
      $('#btn-report', el)?.addEventListener('click', () => openReport(data));
      $('#btn-next', el)?.addEventListener('click', () => push(TripView(data.nextTripId)));
      void now;
    },
    refresh() { this.mount(body); },
  };
  return view;
}

// ======================================================================= zgłoszenie obłożenia
function openReport(trip) {
  const m = $('#modal');
  m.hidden = false;
  const desc = ['Wolne miejsca siedzące', 'Brak miejsc siedzących, swobodnie', 'Ciasno, trudno się ruszyć', 'Nie da się wsiąść'];
  m.innerHTML = `<div class="modal-card">
    <h3>Jak jest w ${trip.mode === 'tram' ? 'tramwaju' : 'autobusie'} ${esc(trip.line)}?</h3>
    <p>Twoje zgłoszenie od razu poprawia prognozę dla innych pasażerów. Zgłoszenia z GPS przy pojeździe mają większą wagę.</p>
    <div class="lvl-grid">${[0, 1, 2, 3].map((l) => `<button class="lvl" data-l="${l}">${occPill({ level: l, ratio: 0, confidence: 1 }, { label: false })}<b>${LEVEL_LABEL[l]}</b><small>${desc[l]}</small></button>`).join('')}</div>
    <button class="cancel" id="rep-cancel">Anuluj</button></div>`;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  m.onclick = (e) => { if (e.target === m) close(); };
  $('#rep-cancel', m).onclick = close;
  m.querySelectorAll('[data-l]').forEach((b) => (b.onclick = async () => {
    b.classList.add('sel');
    const pos = await new Promise((res) => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { timeout: 4000, maximumAge: 15000 });
    });
    try {
      const r = await api('/api/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId: trip.tripId, level: +b.dataset.l, userId: S.userId, lat: pos?.lat, lng: pos?.lng }),
      });
      close();
      toast(`${esc(r.message)}<br><span style="opacity:.8">Prognoza: ${LEVEL_LABEL[r.before.level]} → <b>${LEVEL_LABEL[r.after.level]}</b> · waga zgłoszenia ${Math.round(r.weight * 100)}%</span>`, 4500);
      current?.refresh?.();
    } catch (e) {
      close();
      toast(esc(e.message));
    }
  }));
}

// ======================================================================= widok: przystanki / odjazdy
function StopsHome() {
  return {
    head: () => '<h2>Odjazdy</h2>',
    sheet: 'half',
    async mount(el) {
      el.innerHTML = `<div class="search-card"><label class="field"><span class="pin"></span><input id="in-stop" placeholder="Szukaj przystanku" autocomplete="off"/></label></div>
        <div class="section-title" id="st-title">W pobliżu</div><div class="list-card" id="st-list"><div class="empty">Szukam przystanków…</div></div>`;
      const list = $('#st-list', el);
      const draw = (rows) => {
        list.innerHTML = rows.length ? rows.map((s) => `<button class="stop-row" data-s="${s.idx}"><span class="ico">${STOP_ICON}</span><span style="min-width:0"><div class="name">${esc(s.name)}</div><div class="lines">${s.lines.map((ln) => { const L = S.lines.find((x) => x.short === ln); return L ? lineBadge(L) : ''; }).join('')}</div></span>${s.dist != null ? `<span class="dist">${s.dist < 1000 ? `${s.dist} m` : `${(s.dist / 1000).toFixed(1)} km`}</span>` : ''}</button>`).join('') : '<div class="empty">Nic nie znaleziono</div>';
        list.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => push(StopBoard(+b.dataset.s))));
      };
      const pos = S.myPos || await locate({ silent: true });
      const near = await api(`/api/nearby?at=${pos.lat},${pos.lng}`);
      draw(near);
      $('#in-stop', el).oninput = (e) => {
        const q = norm(e.target.value.trim());
        $('#st-title', el).textContent = q ? 'Wyniki' : 'W pobliżu';
        draw(q ? S.stops.filter((s) => norm(s.name).includes(q)) : near);
      };
    },
  };
}

function StopBoard(stopIdx) {
  let drawn = false;
  const view = {
    head: () => `<h2 id="sb-name">${esc(S.stops[stopIdx]?.name || 'Przystanek')}</h2>`,
    sheet: 'half',
    async mount(el) {
      const s = S.stops[stopIdx];
      if (!drawn) {
        overlay(S.map.addMarker({ lat: s.lat, lng: s.lng, el: stopDot(true), zIndex: 30 }));
        S.map.panTo(s.lat, s.lng, 16, sheetPx());
        drawn = true;
        el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
      }
      let d;
      try { d = await api(`/api/stops/${stopIdx}/departures?limit=14`); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      const deps = d.departures;
      // ten sam kierunek: czy warto poczekać na luźniejszy?
      const tips = [];
      const seen = new Set();
      for (let i = 0; i < deps.length; i++) {
        const a = deps[i];
        const key = a.line + a.headsign;
        if (seen.has(key)) continue;
        seen.add(key);
        if (a.occupancy.level < 2 || a.minutes > 20) continue;
        const b = deps.slice(i + 1).find((x) => x.line === a.line && x.headsign === a.headsign && x.occupancy.level <= a.occupancy.level - 1 && x.minutes - a.minutes <= 15);
        if (b) tips.push(`<div class="hint" style="margin:0 0 10px">${SPARK_ICON}<span><b>${esc(a.line)}</b> za ${a.minutes} min będzie ${LEVEL_LABEL[a.occupancy.level].toLowerCase()} – następne za <b>${b.minutes} min</b> będzie ${LEVEL_LABEL[b.occupancy.level].toLowerCase()}.</span></div>`);
      }
      el.innerHTML = `${tips.slice(0, 2).join('')}<div class="list-card">${deps.length ? deps.map((x) => `
        <button class="dep" data-t="${esc(x.tripId)}">
          ${lineBadge(x)}
          <span class="hs">${esc(x.headsign)}</span>
          <span class="when ${x.realtime ? 'rt' : ''}">${x.minutes < 60 ? (x.minutes === 0 ? 'teraz' : `${x.minutes} min`) : hhmm(x.dep)}<small>${hhmm(x.dep)}${x.realtime && Math.abs(x.delay) >= 60 ? ` (${x.delay > 0 ? '+' : ''}${Math.round(x.delay / 60)})` : ''}</small></span>
          <span class="row2">${occPill(x.occupancy)}<span>${Math.round(x.occupancy.ratio * 100)}% · siedząco ${Math.round(x.occupancy.seatProb * 100)}%</span>${x.realtime ? '<span><span class="rt-ico"></span>na żywo</span>' : ''}</span>
        </button>`).join('') : '<div class="empty">Brak odjazdów w ciągu 90 minut</div>'}</div>
        <p class="muted small" style="text-align:center">Obłożenie = przewidywany stan po zabraniu pasażerów z tego przystanku.</p>`;
      el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => push(TripView(b.dataset.t))));
    },
    refresh() { this.mount(body); },
  };
  return view;
}

// ======================================================================= widok: linie
function LinesHome() {
  return {
    head: () => '<h2>Linie</h2>',
    sheet: 'half',
    mount(el) {
      const group = (mode, title) => `<div class="section-title">${title}</div><div class="list-card">${S.lines.filter((l) => l.mode === mode).map((l) => {
        const active = [...S.vehicles.values()].filter((m) => m.v.line === l.short);
        const avg = active.length ? active.reduce((a, m) => a + m.v.level, 0) / active.length : 0;
        return `<button class="stop-row" data-l="${esc(l.id)}">${lineBadge(l, { lg: true })}<span style="min-width:0"><div class="name">${esc(l.patterns[0].headsign)} ⇄ ${esc(l.patterns[1]?.headsign || '')}</div>
          <div class="small muted">${active.length} ${active.length === 1 ? 'pojazd' : 'pojazdów'} na trasie</div></span><span class="dist">${active.length ? occPill({ level: Math.round(avg), ratio: 0, confidence: 1 }, { label: false }) : ''}</span></button>`;
      }).join('')}</div>`;
      el.innerHTML = (S.lines.some((l) => l.mode === 'tram') ? group('tram', 'Tramwaje') : '') + group('bus', 'Autobusy');
      el.querySelectorAll('[data-l]').forEach((b) => (b.onclick = () => push(LineView(b.dataset.l))));
    },
  };
}

function LineView(routeId) {
  const L = S.lines.find((l) => l.id === routeId);
  let dir = 0;
  return {
    head: () => `${lineBadge(L, { lg: true })}<h2>Linia ${esc(L.short)}</h2>`,
    sheet: 'half',
    mount(el) {
      setFocus({ line: L.short });
      const p = L.patterns[dir];
      clearOverlaysKeepFocus();
      overlay(S.map.addPolyline({ path: p.shape, color: L.color, weight: 6, casing: true, zIndex: 4 }));
      S.map.fitBounds(p.shape, { bottom: sheetPx() });
      const vs = [...S.vehicles.values()].map((m) => m.v).filter((v) => v.line === L.short && v.headsign === p.headsign);
      el.innerHTML = `<div class="seg" style="margin-bottom:10px">${L.patterns.map((q, i) => `<button data-d="${i}" class="${i === dir ? 'on' : ''}">→ ${esc(q.headsign)}</button>`).join('')}</div>
        ${vs.length ? `<div class="section-title">Pojazdy w kierunku ${esc(p.headsign)}</div><div class="list-card">${vs.map((v) => `<button class="stop-row" data-t="${esc(v.id)}">${lineBadge(v)}<span style="min-width:0"><div class="name">Następny: ${esc(v.next)}</div><div class="small muted">${v.delay >= 60 ? `+${Math.round(v.delay / 60)} min` : 'na czas'}</div></span><span class="dist">${occPill({ level: v.level, ratio: v.ratio, confidence: 1 }, { short: true })}</span></button>`).join('')}</div>` : ''}
        <div class="section-title">Przystanki</div><div class="list-card">${p.stops.map((sid) => { const s = S.stops.find((x) => x.id === sid); return `<button class="stop-row" data-s="${s.idx}"><span class="ico" style="color:${esc(L.color)}">${STOP_ICON}</span><span class="name">${esc(s.name)}</span></button>`; }).join('')}</div>`;
      el.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { dir = +b.dataset.d; this.mount(el); }));
      el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => push(TripView(b.dataset.t))));
      el.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => push(StopBoard(+b.dataset.s))));
    },
    refresh() { this.mount(body); },
  };
}

// ======================================================================= widok: algorytm / statystyki
function AlgoView() {
  return {
    head: () => '<div style="flex:1"><h2>Jak liczymy obłożenie</h2><div class="sub">Jakość prognoz na żywo</div></div>',
    sheet: 'full',
    async mount(el) {
      let st;
      try { st = await api('/api/stats'); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      const f = st.forecast;
      if (st.live) return mountLiveStats(el, st);
      const bar = (label, v, max, color) => `<div class="bar-row"><span>${label}</span><div class="meter"><i style="width:${Math.min(100, (v / max) * 100)}%;background:${color}"></i></div><span class="num">${v}</span></div>`;
      el.innerHTML = `
        <div class="kpis">
          <div class="kpi hl"><div class="v">${f ? f.accFused : '–'}<small>%</small></div><div class="k">trafność poziomu obłożenia (prognoza 5–15 min)</div></div>
          <div class="kpi"><div class="v">${f ? Math.round((1 - f.maeFused / f.maeBaseline) * 100) : '–'}<small>%</small></div><div class="k">mniejszy błąd niż sama średnia historyczna</div></div>
          <div class="kpi"><div class="v">${f ? Math.round(f.etaErrorSec) : '–'}<small> s</small></div><div class="k">średni błąd czasu odjazdu</div></div>
          <div class="kpi"><div class="v">${st.fleet.active}</div><div class="k">pojazdów na trasach, ${st.fleet.withApc} z licznikiem pasażerów</div></div>
        </div>
        ${f ? `<div class="card"><div class="section-title" style="margin-top:0">Średni błąd (osoby) – mniej = lepiej</div><div class="bars">
          ${bar('LuźnyBus', f.maeFused, Math.max(f.maeBaseline, f.maeFused), '#2E9E5B')}
          ${bar('Średnia historyczna', f.maeBaseline, Math.max(f.maeBaseline, f.maeFused), '#c9d4de')}
          </div><div class="section-title">Trafny poziom (Luźno / Na stojąco / Tłok / Pełny)</div><div class="bars">
          ${bar('LuźnyBus', f.accFused, 100, '#2E9E5B')}
          ${bar('Średnia historyczna', f.accBaseline, 100, '#c9d4de')}
          </div><p class="muted small" style="margin:10px 0 0">Na ${f.samples.toLocaleString('pl')} prognozach dla pojazdów bez licznika, porównanych z faktycznym obłożeniem.${st.nowcast ? ` Szacunek „teraz” dla ${st.nowcast.vehicles} pojazdów bez czujnika: błąd ±${st.nowcast.mae} os.` : ''}</p></div>` : ''}
        <div class="card"><div class="section-title" style="margin-top:0">Dane wejściowe dzisiaj</div>
          <div class="j-meta" style="gap:14px"><span><b>${st.data.apc.toLocaleString('pl')}</b> odczytów liczników APC</span><span><b>${st.data.reports}</b> zgłoszeń pasażerów (${st.data.userReports} z tej aplikacji)</span>
          <span><b>${st.reputation.trusted}</b> zaufanych zgłaszających, <b>${st.reputation.untrusted}</b> odfiltrowanych</span><span>Historia: <b>${st.history.days}</b> dni</span></div>
          ${st.anomalies.length ? `<div class="hint" style="margin-top:10px">${SPARK_ICON}<span>Wykryto nietypowy ruch: ${st.anomalies.map((a) => `<b>${esc(a.stop)}</b> (×${a.factor})`).join(', ')} – prognozy na tych przystankach są już skorygowane.</span></div>` : ''}
          ${st.scenario.events.length ? `<p class="muted small" style="margin:8px 0 0">Symulacja dnia: wydarzenie przy ${st.scenario.events.map((e) => `${esc(e.stop)} ${e.from}–${e.to}`).join(', ')} (algorytm o nim nie wie – musi je wykryć z danych).</p>` : ''}
        </div>
        <div class="card how"><div class="section-title" style="margin-top:0">Algorytm krok po kroku</div><ol>
          <li><b>Model historyczny.</b> Z ${st.history.days} dni danych uczymy się, ile osób przychodzi na każdy przystanek w każdej półgodzinie, ilu wysiada i jak długo jedzie się każdym odcinkiem.</li>
          <li><b>Odstępy między pojazdami.</b> Pasażerowie zbierają się od odjazdu poprzedniego pojazdu. Spóźniony autobus zbiera więcej ludzi (i bardziej się spóźnia), a ten tuż za nim jedzie luźno. Dlatego „12 za 3 min” bywa pełne, a „12 za 9 min” luźne.</li>
          <li><b>Filtr Kalmana wzdłuż trasy.</b> Przystanek po przystanku liczymy rozkład liczby pasażerów: wysiadanie, wsiadanie, limit pojemności. Ci, którzy się nie zmieścili, czekają na następny kurs.</li>
          <li><b>Dane na żywo.</b> GPS (opóźnienia), liczniki pasażerów w części floty i zgłoszenia z aplikacji korygują prognozę. Zgłoszenie waży tyle, ile wynosi reputacja zgłaszającego i to, czy GPS potwierdza, że jest w pojeździe.</li>
          <li><b>Adaptacja.</b> Gdy dziś jest inaczej niż zwykle (mecz, deszcz), współczynniki popytu dla linii i przystanków uczą się na bieżąco.</li>
          <li><b>Planer RAPTOR.</b> Szukamy połączeń na czasach na żywo i oceniamy je czasem „odczuwanym”: jazda na stojąco w tłoku liczy się jak dłuższa.</li>
        </ol></div>
        <p class="muted small" style="text-align:center">Sieć: ${st.network.source === 'demo' ? esc(S.cfg.city.name) : 'GTFS'} · ${st.network.stops} przystanków · ${st.network.lines} linii · ${st.network.trips} kursów</p>`;
    },
    refresh() { this.mount(body); },
  };
}

function mountLiveStats(el, st) {
  const L = st.live;
  const ok = !L.lastError && L.feedAgeSec != null && L.feedAgeSec < 120;
  el.innerHTML = `
    <div class="kpis">
      <div class="kpi hl"><div class="v">${st.fleet.active}</div><div class="k">autobusów na żywo (GPS)</div></div>
      <div class="kpi"><div class="v">${L.avgDelaySec != null ? (L.avgDelaySec / 60).toFixed(1) : '–'}<small> min</small></div><div class="k">średnie opóźnienie teraz</div></div>
      <div class="kpi"><div class="v" style="color:${ok ? '#1f7a44' : '#b02525'}">${L.feedAgeSec != null ? L.feedAgeSec : '–'}<small> s</small></div><div class="k">od ostatniej aktualizacji danych</div></div>
      <div class="kpi"><div class="v">${L.matched ? Math.round((L.matched / (L.matched + L.unmatched)) * 100) : '–'}<small>%</small></div><div class="k">pozycji dopasowanych do rozkładu</div></div>
    </div>
    ${L.lastError ? `<div class="hint" style="background:#b02525;margin-bottom:10px"><span>Problem z danymi na żywo: ${esc(L.lastError)}</span></div>` : ''}
    <div class="card"><div class="section-title" style="margin-top:0">Skąd są dane</div>
      <div class="how">
        <p style="margin:0 0 8px"><b>Prawdziwe:</b> rozkład jazdy (${st.network.lines} linii, ${st.network.stops} przystanków, ${st.network.trips} kursów dziś), pozycje i opóźnienia autobusów (co ${Math.round(15)} s), odstępy między pojazdami, Twoje zgłoszenia (${st.data.userReports}).</p>
        <p style="margin:0 0 8px"><b>Modelowane:</b> przewoźnik nie publikuje liczby pasażerów, więc bazowy popyt pochodzi z modelu ruchu na prawdziwej sieci. Najbardziej informatywne są realne odstępy (spóźniony autobus zbiera więcej ludzi) i zgłoszenia pasażerów.</p>
        ${L.occupancy ? `<p style="margin:0">Przewoźnik podaje obłożenie dla części pojazdów: ${L.occupancy} odczytów.</p>` : ''}
      </div>
      <p class="muted small" style="margin:10px 0 0">${esc(L.attribution)} · <a href="https://kmrzeszow.live/otwartedane/" target="_blank" rel="noopener">kmrzeszow.live/otwartedane</a> · <a href="https://otwartedane.erzeszow.pl/dataset/rozklady-jazdy-gtfs" target="_blank" rel="noopener">Open Data Rzeszów</a></p>
    </div>
    <div class="card how"><div class="section-title" style="margin-top:0">Algorytm krok po kroku</div><ol>
      <li><b>GPS → opóźnienia.</b> Co kilkanaście sekund dostajemy pozycję każdego autobusu i przeliczamy prognozę przyjazdów na kolejne przystanki.</li>
      <li><b>Odstępy.</b> Pasażerowie zbierają się od odjazdu poprzedniego autobusu – spóźniony zbiera więcej, ten tuż za nim jedzie luźno.</li>
      <li><b>Filtr Kalmana wzdłuż trasy.</b> Wysiadanie, wsiadanie i limit pojemności liczone przystanek po przystanku.</li>
      <li><b>Zgłoszenia pasażerów</b> korygują prognozę; ich waga zależy od reputacji i potwierdzenia GPS.</li>
      <li><b>Planer RAPTOR</b> szuka połączeń na czasach na żywo i woli luźniejsze kursy w trybie „Wygodnie”.</li>
    </ol></div>`;
}

const ROOTS = { route: RouteHome, stops: StopsHome, lines: LinesHome, algo: AlgoView };

// ======================================================================= map popup (klik w mapę)
let popup = null;
function mapClick(lat, lng) {
  if (S.pickMode) {
    const which = S.pickMode;
    S.pickMode = null;
    S[which] = { lat, lng, name: 'Punkt na mapie' };
    switchTab('route');
    drawEndpoints();
    if (S.from && S.to) search();
    return;
  }
  popup?.remove();
  const el = document.createElement('div');
  el.className = 'map-pop';
  el.innerHTML = '<button data-w="from">Stąd</button><button class="to" data-w="to">Tutaj</button>';
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    popup?.remove(); popup = null;
    S[b.dataset.w] = { lat, lng, name: 'Punkt na mapie' };
    drawEndpoints();
    if (S.from && S.to) { switchTab('route'); search(); } else switchTab('route');
  }));
  popup = S.map.addMarker({ lat, lng, el, zIndex: 60 });
  clearTimeout(mapClick._t);
  mapClick._t = setTimeout(() => { popup?.remove(); popup = null; }, 5000);
}

// ======================================================================= start
async function boot() {
  S.cfg = await api('/api/config');
  S.clock = { sim: S.cfg.now, real: Date.now(), speed: S.cfg.speed };
  [S.stops, S.lines] = await Promise.all([api('/api/stops'), api('/api/lines')]);
  S.map = await createMap($('#map'), { center: S.cfg.city.center, zoom: 13, googleKey: S.cfg.googleMapsApiKey, mapId: S.cfg.googleMapId });
  S.map.onZoom(drawStopMarkers);
  S.map.onClick(mapClick);
  S.map.onIdle(() => updateVehicles());
  drawStopMarkers();
  setSheet('half');
  switchTab('route');

  const es = new EventSource('/api/stream');
  es.onmessage = (e) => updateVehicles(JSON.parse(e.data));
  es.onerror = () => $('#live-chip .dot').style.background = '#D63B3B';
  es.onopen = () => $('#live-chip .dot').style.background = '';

  const tickClock = () => {
    const t = hhmm(simNow());
    $('#clock').textContent = t;
    $('#sb-time').textContent = t;
  };
  tickClock();
  setInterval(tickClock, 1000);
  if (S.cfg.demoShift) toast('O tej porze komunikacja nie kursuje – demo działa na symulowanym poranku.', 4500);
  // start w okolicy użytkownika (albo Politechniki), żeby nie renderować całego miasta
  locate().then((p) => S.map.panTo(p.lat, p.lng, 15, sheetPx()));
  if (S.map.kind === 'leaflet' && !S.cfg.googleMapsApiKey) console.info('LuźnyBus: brak GOOGLE_MAPS_API_KEY – używam OpenStreetMap.');

  $('#btn-locate').onclick = async () => { const p = await locate(); S.map.panTo(p.lat, p.lng, 16, sheetPx()); };
  $('#btn-vehicles').onclick = (e) => {
    S.showVehicles = !S.showVehicles;
    e.currentTarget.setAttribute('aria-pressed', S.showVehicles);
    if (!S.showVehicles) clearVehicles();
    else api('/api/vehicles').then(updateVehicles);
  };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot().catch((e) => {
  console.error(e);
  body.innerHTML = `<div class="empty">Nie udało się uruchomić aplikacji.<br>${esc(e.message)}</div>`;
});
