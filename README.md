# LuźnyBus 🚌

**Nie wsiadaj do pierwszego. Wsiądź do luźnego.**
Planer podróży komunikacją miejską (jak Jakdojade) z dodatkiem: **przewidywanym obłożeniem każdego autobusu**, zanim do niego wsiądziesz. Sieć demo: **Rzeszów** (MPK – autobusy).

## Uruchomienie

```bash
cd luznybus
npm start          # http://localhost:3000
npm test           # testy (algorytm, planer, GTFS)
npm run evaluate   # ewaluacja algorytmu na symulowanym dniu
```

Bez zależności npm – wystarczy Node.js ≥ 20.

### Google Maps
Skopiuj `.env.example` → `.env` i wpisz `GOOGLE_MAPS_API_KEY` (włącz w Google Cloud: *Maps JavaScript API*, opcjonalnie *Places API (New)* do wyszukiwania adresów). Bez klucza aplikacja działa na OpenStreetMap (Leaflet) – wygodne przy developmencie.

### Prawdziwe dane – Rzeszów na żywo
W `.env` ustaw:
```
GTFS_URL=https://kmrzeszow.live/gtfs/latest.zip
GTFS_RT_URL=https://kmrzeszow.live/gtfs/rt/gtfsrt.pb
```
Serwer pobiera rozkład GTFS raz na dobę (do `data/gtfs-live/`) i co 15 s odpytuje GTFS‑Realtime: pozycje i opóźnienia autobusów są prawdziwe. `npm run check-live` sprawdza, czy dane pasują do siebie.

Źródło: [kmrzeszow.live/otwartedane](https://kmrzeszow.live/otwartedane/). To serwis społecznościowy, niepowiązany z ZTM/MPK, oparty na oficjalnym rozkładzie ZTM z [Open Data Rzeszów](https://otwartedane.erzeszow.pl/dataset/rozklady-jazdy-gtfs). Przewoźnik nie publikuje liczby pasażerów, więc bazowy popyt pochodzi z modelu ruchu skalibrowanego na prawdziwej sieci. Prognozę korygują realne odstępy między autobusami i zgłoszenia pasażerów. Jeśli feed poda `occupancy_status`, algorytm użyje go automatycznie.

Bez `GTFS_RT_URL` aplikacja działa na symulowanej sieci demo.

## Co jest w środku

| Moduł | Rola |
|---|---|
| `server/model/predictor.js` | **Algorytm obłożenia** – filtr Kalmana wzdłuż trasy |
| `server/model/history.js` | Model historyczny (napływ pasażerów, wysiadanie, czasy przejazdu) |
| `server/model/reputation.js` | Reputacja zgłaszających (odporność na trolli) |
| `server/planner/raptor.js` | Planer RAPTOR na czasach na żywo + koszt „odczuwany” z tłokiem |
| `server/sim/world.js` | Symulator „prawdziwego świata” (do demo i testów) |
| `server/live/` | Pobieranie GTFS i strumień GTFS‑Realtime (pozycje na żywo) |
| `server/network/` | Sieć demo Rzeszowa, import/eksport GTFS |
| `public/` | Aplikacja mobilna (PWA): mapa, wyszukiwarka, odjazdy, pojazdy, zgłoszenia |

### Algorytm w skrócie
1. **Model historyczny**: dla każdej linii, przystanku i półgodziny – ilu pasażerów przychodzi na minutę (λ), jaki odsetek wysiada (p), ile trwa przejazd. Wejścia przy pełnym pojeździe są pomijane (dane ocenzurowane).
2. **Odstęp od poprzedniego pojazdu**: na przystanku czeka λ · (czas od odjazdu poprzedniego autobusu). Spóźniony autobus zbiera więcej ludzi, a ten tuż za nim jest luźny („12 za 3 min – tłok, 12 za 9 min – luźno”).
3. **Filtr Kalmana przystanek po przystanku**: wysiadanie (dwumianowe), wsiadanie (Poisson), limit pojemności (momenty rozkładu ocenzurowanego). Ci, co się nie zmieścili, czekają na następny kurs.
4. **Dane na żywo**: GPS (opóźnienia, prognoza przyjazdów), liczniki APC w części floty, zgłoszenia pasażerów ważone reputacją i weryfikacją GPS, z odpornym bramkowaniem.
5. **Adaptacja dnia**: współczynniki popytu linii/przystanków (Gamma–Poisson z zapominaniem) wykrywają np. mecz czy koncert.
6. **Planer**: RAPTOR + mnożnik odczuwanego czasu w tłoku → tryb „Wygodnie” i podpowiedź „poczekaj X min na luźniejszy”.

Na symulowanym dniu: błąd prognozy na 5–15 min ok. 25% niższy niż sama średnia historyczna. Szczegóły na żywo są w zakładce **Algorytm** w aplikacji.

### Skąd brać prawdziwe dane
Google Maps **nie udostępnia** pozycji pojazdów ani obłożenia przez API. Źródłem jest przewoźnik: rozkład GTFS i (jeśli publikowany) GTFS‑Realtime z pozycjami pojazdów. Adapter GTFS‑RT jest w `server/live/realtime-feed.js`. Ma ten sam interfejs co symulator, więc algorytm działa bez zmian.
