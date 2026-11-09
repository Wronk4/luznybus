// Sieć demonstracyjna: RZESZÓW (MPK Rzeszów – same autobusy).
// Współrzędne przystanków przybliżone, trasy linii uproszczone (numeracja inspirowana MPK, nie 1:1).
// Prawdziwy rozkład można wczytać z GTFS (zmienna GTFS_DIR).
//
// w = "waga" przystanku (ile osób w okolicy), c = centralność (1 = centrum/uczelnie/biura, 0 = osiedle).
// Wagi i centralność używa wyłącznie symulator "prawdziwego świata" – algorytm predykcji ich nie zna,
// uczy się wszystkiego z danych historycznych.

export const CITY = {
  name: 'Rzeszów (demo)',
  center: { lat: 50.0360, lng: 22.0080 },
};

export const STOPS = [
  ['DWG', 'Dworzec Główny', 50.0428, 22.0075, 3.0, 1.0],
  ['GRU', 'Grunwaldzka – Urząd Wojewódzki', 50.0388, 22.0022, 2.5, 1.0],
  ['GAL', 'Galeria Rzeszów (Piłsudskiego)', 50.0362, 22.0118, 2.5, 1.0],
  ['WOL', 'Plac Wolności', 50.0335, 22.0055, 1.5, 0.9],
  ['LIS', 'Lisa-Kuli', 50.0405, 21.9985, 1.5, 0.8],
  ['POD', 'Podpromie', 50.0335, 22.0230, 1.0, 0.6],
  ['KOP', 'Millenium Hall (Kopisto)', 50.0255, 22.0140, 2.0, 0.8],
  ['URR', 'Uniwersytet Rzeszowski (Rejtana)', 50.0298, 22.0170, 2.5, 0.95],
  ['POL', 'Politechnika (Powstańców Warszawy)', 50.0195, 21.9895, 2.5, 0.95],
  ['HET', 'Hetmańska', 50.0245, 22.0035, 1.5, 0.6],
  ['PWR', 'Hetmańska – Zakłady lotnicze', 50.0140, 22.0000, 1.5, 0.7],
  ['SZW', 'Szpital Wojewódzki (Lwowska)', 50.0285, 22.0390, 2.0, 0.8],
  ['LWO', 'Rondo Pobitno', 50.0425, 22.0420, 1.5, 0.5],
  ['POB', 'Pobitno', 50.0470, 22.0480, 1.0, 0.2],
  ['NMI', 'Nowe Miasto', 50.0470, 22.0300, 2.0, 0.2],
  ['SLO', 'Słocina', 50.0430, 22.0720, 1.5, 0.0],
  ['ZAL', 'Załęże', 50.0640, 22.0380, 1.5, 0.0],
  ['TYS', 'Os. Tysiąclecia', 50.0490, 22.0130, 2.0, 0.1],
  ['MIE', 'Os. Mieszka I', 50.0480, 21.9950, 2.0, 0.1],
  ['STA', 'Staromieście', 50.0580, 21.9880, 1.5, 0.0],
  ['KRA', 'Krakowska', 50.0420, 21.9800, 1.5, 0.4],
  ['KWI', 'Kwiatkowskiego', 50.0365, 21.9880, 1.0, 0.4],
  ['BAR', 'Baranówka', 50.0330, 21.9730, 2.5, 0.0],
  ['PRZ', 'Przybyszówka', 50.0270, 21.9520, 1.5, 0.0],
  ['ZWI', 'Zwięczyca', 50.0150, 21.9600, 1.0, 0.0],
  ['DAB', 'Os. Dąbrowskiego', 50.0270, 21.9950, 2.0, 0.2],
  ['DRA', 'Drabinianka', 50.0100, 21.9850, 2.0, 0.0],
  ['BIA', 'Biała', 50.0050, 22.0080, 1.0, 0.0],
  ['BUD', 'Budziwój', 49.9940, 21.9990, 1.0, 0.0],
  ['ZAS', 'Zalesie', 50.0140, 22.0450, 1.5, 0.0],
  ['MAT', 'Matysówka', 50.0060, 22.0650, 1.0, 0.0],
].map(([id, name, lat, lng, w, c]) => ({ id, name, lat, lng, w, c }));

// vehicle: 'artic' = przegubowy 18 m, 'bus' = standardowy 12 m
// hw = takt [szczyt, poza szczytem, wieczór] w minutach; k = skala popytu (tylko symulator)
export const LINES = [
  { id: 'L1', short: '1', mode: 'bus', vehicle: 'artic', color: '#C0392B', k: 1.0, hw: [8, 12, 20],
    stops: ['BAR', 'KWI', 'LIS', 'DWG', 'GAL', 'POD', 'LWO', 'POB', 'SLO'] },
  { id: 'L2', short: '2', mode: 'bus', vehicle: 'artic', color: '#1D5FAF', k: 1.0, hw: [8, 12, 20],
    stops: ['DRA', 'POL', 'DAB', 'HET', 'WOL', 'GAL', 'DWG', 'TYS', 'NMI', 'ZAL'] },
  { id: 'L3', short: '3', mode: 'bus', vehicle: 'bus', color: '#2F855A', k: 0.7, hw: [12, 15, 30],
    stops: ['PRZ', 'BAR', 'KWI', 'LIS', 'GRU', 'DWG', 'TYS'] },
  { id: 'L4', short: '4', mode: 'bus', vehicle: 'bus', color: '#B7791F', k: 0.8, hw: [10, 15, 30],
    stops: ['BUD', 'BIA', 'PWR', 'HET', 'KOP', 'URR', 'POD', 'GAL', 'DWG', 'NMI'] },
  { id: 'L8', short: '8', mode: 'bus', vehicle: 'bus', color: '#6B46C1', k: 0.7, hw: [12, 20, 30],
    stops: ['ZWI', 'POL', 'DAB', 'HET', 'KOP', 'URR', 'SZW'] },
  { id: 'L14', short: '14', mode: 'bus', vehicle: 'artic', color: '#0E8C7F', k: 0.9, hw: [10, 15, 20],
    stops: ['STA', 'MIE', 'LIS', 'GRU', 'GAL', 'POD', 'SZW', 'ZAS', 'MAT'] },
  { id: 'L18', short: '18', mode: 'bus', vehicle: 'bus', color: '#97266D', k: 0.75, hw: [10, 15, 30],
    stops: ['ZAL', 'NMI', 'TYS', 'DWG', 'GRU', 'WOL', 'HET', 'DAB', 'POL'] },
  { id: 'L21', short: '21', mode: 'bus', vehicle: 'bus', color: '#C05621', k: 0.65, hw: [15, 20, 30],
    stops: ['SLO', 'LWO', 'SZW', 'URR', 'KOP', 'HET', 'DAB', 'BAR'] },
  { id: 'L26', short: '26', mode: 'bus', vehicle: 'bus', color: '#2B6CB0', k: 0.6, hw: [15, 20, 30],
    stops: ['MIE', 'KRA', 'LIS', 'DWG', 'GAL', 'URR', 'SZW', 'ZAS'] },
];

// capacity = praktyczna pojemność ("ścisk, ale wejdziesz"), a nie homologacyjna z tabliczki.
// Solaris Urbino 12 ma ~95 miejsc na papierze, ale przy ~70 osobach jest już pełny.
export const VEHICLES = {
  bus: { capacity: 70, seats: 30, speed: 7.2, fixed: 25 },
  artic: { capacity: 110, seats: 44, speed: 7.0, fixed: 25 },
  tram: { capacity: 170, seats: 54, speed: 6.4, fixed: 22 },
};

/** Takt (min) wg pory dnia – rozkład jazdy. */
export function headwayMin(line, h, dayType) {
  const [peak, off, eve] = line.hw || [8, 12, 20];
  if (dayType === 'weekend') {
    if (h < 8 || h >= 20) return Math.max(eve, 30);
    return Math.round(off * 1.4);
  }
  const isPeak = (h >= 6 && h < 9) || (h >= 14 && h < 18.5);
  if (h < 6) return eve;
  if (isPeak) return peak;
  if (h < 20) return off;
  return eve;
}

/** Szczyt komunikacyjny w rozkładzie (spowolnienie przejazdów). */
export function schedTrafficFactor(mode, h, dayType) {
  if (dayType === 'weekend') return 1;
  const am = Math.exp(-0.5 * ((h - 7.75) / 1) ** 2);
  const pm = Math.exp(-0.5 * ((h - 16.5) / 1.3) ** 2);
  return 1 + (mode === 'bus' ? 0.28 : 0.08) * Math.max(am, pm);
}
