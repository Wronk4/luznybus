// Adapter mapy: Google Maps (gdy jest klucz API) albo Leaflet + OpenStreetMap (fallback do developmentu).
// Reszta aplikacji używa wyłącznie tego interfejsu.

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Nie udało się wczytać ${src}`));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

/** Kontener zerowego rozmiaru – punkt zaczepienia identyczny w obu silnikach. */
function anchor(el) {
  const a = document.createElement('div');
  a.style.cssText = 'width:0;height:0;position:relative;overflow:visible';
  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.top = '0';
  a.appendChild(el);
  return a;
}

export async function createMap(el, { center, zoom = 13, googleKey, mapId }) {
  if (googleKey) {
    try {
      return await createGoogle(el, { center, zoom, googleKey, mapId });
    } catch (e) {
      console.warn('Google Maps niedostępne, przełączam na OpenStreetMap', e);
    }
  }
  return createLeaflet(el, { center, zoom });
}

// ------------------------------------------------------------------ Google
async function createGoogle(el, { center, zoom, googleKey, mapId }) {
  await new Promise((resolve, reject) => {
    window.__lbGmapsReady = resolve;
    window.gm_authFailure = () => reject(new Error('Błędny klucz Google Maps'));
    loadScript(
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleKey)}&v=weekly&loading=async&language=pl&region=PL&callback=__lbGmapsReady`,
    ).catch(reject);
  });
  const { Map } = await google.maps.importLibrary('maps');
  const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
  const map = new Map(el, {
    center, zoom, mapId: mapId || 'DEMO_MAP_ID',
    disableDefaultUI: true, clickableIcons: false, gestureHandling: 'greedy',
  });
  let lastMarkerClick = 0;
  let places = null;
  try { places = await google.maps.importLibrary('places'); } catch { /* Places API (New) nie włączone */ }
  let token = null;

  return {
    kind: 'google',
    addMarker({ lat, lng, el: content, zIndex = 1, onClick }) {
      if (onClick) content.addEventListener('click', (e) => { e.stopPropagation(); lastMarkerClick = Date.now(); onClick(e); });
      const m = new AdvancedMarkerElement({ map, position: { lat, lng }, content: anchor(content), zIndex });
      return {
        el: content,
        setPosition(la, ln) { m.position = { lat: la, lng: ln }; },
        setZ(z) { m.zIndex = z; },
        remove() { m.map = null; },
      };
    },
    addPolyline({ path, color, weight = 5, dashed = false, opacity = 1, casing = false, zIndex = 1 }) {
      const pts = path.map(([la, ln]) => ({ lat: la, lng: ln }));
      const lines = [];
      if (casing) lines.push(new google.maps.Polyline({ map, path: pts, strokeColor: '#ffffff', strokeWeight: weight + 4, strokeOpacity: 1, zIndex }));
      lines.push(new google.maps.Polyline(dashed
        ? { map, path: pts, strokeOpacity: 0, zIndex: zIndex + 1, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: opacity, strokeColor: color, scale: weight * 0.7 }, offset: '0', repeat: `${weight * 3}px` }] }
        : { map, path: pts, strokeColor: color, strokeWeight: weight, strokeOpacity: opacity, zIndex: zIndex + 1 }));
      return { remove() { lines.forEach((l) => l.setMap(null)); } };
    },
    fitBounds(points, pad = {}) {
      if (!points.length) return;
      const b = new google.maps.LatLngBounds();
      points.forEach(([la, ln]) => b.extend({ lat: la, lng: ln }));
      map.fitBounds(b, { top: pad.top ?? 80, bottom: pad.bottom ?? 80, left: pad.left ?? 30, right: pad.right ?? 30 });
    },
    panTo(lat, lng, z, offsetY = 0) { if (z) map.setZoom(z); map.panTo({ lat, lng }); if (offsetY) map.panBy(0, offsetY / 2); },
    getZoom: () => map.getZoom(),
    getBounds() { const b = map.getBounds(); if (!b) return null; const ne = b.getNorthEast(), sw = b.getSouthWest(); return { n: ne.lat(), e: ne.lng(), s: sw.lat(), w: sw.lng() }; },
    onIdle(cb) { map.addListener('idle', cb); },
    onZoom(cb) { map.addListener('zoom_changed', () => cb(map.getZoom())); },
    onClick(cb) { map.addListener('click', (e) => { if (Date.now() - lastMarkerClick > 300 && e.latLng) cb(e.latLng.lat(), e.latLng.lng()); }); },
    onPan(cb) { map.addListener('dragstart', cb); },
    async searchPlaces(input, near) {
      if (!places?.AutocompleteSuggestion || input.length < 3) return [];
      token ||= new places.AutocompleteSessionToken();
      try {
        const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input, sessionToken: token, language: 'pl', region: 'pl',
          locationBias: { center: near, radius: 15000 },
        });
        return suggestions.filter((s) => s.placePrediction).slice(0, 5).map(({ placePrediction: p }) => ({
          name: p.mainText?.text || p.text.text,
          secondary: p.secondaryText?.text || '',
          async resolve() {
            const place = p.toPlace();
            await place.fetchFields({ fields: ['location', 'displayName'] });
            token = null;
            return { lat: place.location.lat(), lng: place.location.lng(), name: place.displayName || p.mainText?.text };
          },
        }));
      } catch (e) {
        console.warn('Places API:', e.message);
        return [];
      }
    },
  };
}

// ------------------------------------------------------------------ Leaflet / OSM
async function createLeaflet(el, { center, zoom }) {
  loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
  await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
  const L = window.L;
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  return {
    kind: 'leaflet',
    addMarker({ lat, lng, el: content, zIndex = 1, onClick }) {
      if (onClick) content.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
      const icon = L.divIcon({ html: anchor(content), className: 'lb-icon', iconSize: [0, 0], iconAnchor: [0, 0] });
      const m = L.marker([lat, lng], { icon, zIndexOffset: zIndex * 100, interactive: !!onClick, keyboard: false }).addTo(map);
      return {
        el: content,
        setPosition(la, ln) { m.setLatLng([la, ln]); },
        setZ(z) { m.setZIndexOffset(z * 100); },
        remove() { m.remove(); },
      };
    },
    addPolyline({ path, color, weight = 5, dashed = false, opacity = 1, casing = false }) {
      const layers = [];
      if (casing) layers.push(L.polyline(path, { color: '#fff', weight: weight + 4, opacity: 1, interactive: false }).addTo(map));
      layers.push(L.polyline(path, { color, weight, opacity, dashArray: dashed ? `${weight * 0.4} ${weight * 2}` : null, lineCap: 'round', interactive: false }).addTo(map));
      return { remove() { layers.forEach((l) => l.remove()); } };
    },
    fitBounds(points, pad = {}) {
      if (!points.length) return;
      map.fitBounds(points, { paddingTopLeft: [pad.left ?? 30, pad.top ?? 80], paddingBottomRight: [pad.right ?? 30, pad.bottom ?? 80], maxZoom: 16 });
    },
    panTo(lat, lng, z, offsetY = 0) {
      const zoom = z || map.getZoom();
      const pt = map.project([lat, lng], zoom).add([0, offsetY / 2]);
      map.setView(map.unproject(pt, zoom), zoom);
    },
    getZoom: () => map.getZoom(),
    getBounds() { const b = map.getBounds(); return { n: b.getNorth(), e: b.getEast(), s: b.getSouth(), w: b.getWest() }; },
    onIdle(cb) { map.on('moveend', cb); },
    onZoom(cb) { map.on('zoomend', () => cb(map.getZoom())); },
    onClick(cb) { map.on('click', (e) => cb(e.latlng.lat, e.latlng.lng)); },
    onPan(cb) { map.on('dragstart', cb); },
    async searchPlaces() { return []; },
  };
}
