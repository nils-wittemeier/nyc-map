# NYC Neighborhood Tracker

A small web app for marking off NYC neighborhoods you've visited and planning walking routes between them. Tap a neighborhood, mark it visited, add a date and notes — or string several into an ordered walking plan.

Built as a single-page progressive web app: vanilla JavaScript, [Leaflet](https://leafletjs.com/) for the map, no build step. Your data lives in the browser's `localStorage`; export to JSON when you want to back up or sync between devices.

**Live app:** <https://nils-wittemeier.github.io/nyc-map/>

## Features

- **Interactive map** of all 262 NYC Neighborhood Tabulation Areas (NTAs) — residential neighborhoods plus parks, cemeteries, airports, and a handful of special areas. Hover for the name, click to inspect.
- **Per-neighborhood detail:** mark visited (auto-fills today's date), free-text notes, favorite-spots list.
- **List** with full-text search and filters by borough or visited / unvisited.
- **Plan** an ordered walking route — drag-and-drop to reorder. Stops are drawn on the map as a violet fill with numbered markers and a connecting line.
- **Stats** with overall progress and a per-borough breakdown.
- **Offline-ready PWA** — installable to the home screen on iOS and Android; works without network for areas already viewed.
- **JSON export / import** for backup and manual cross-device sync.

## Using the app

1. Open the [live app](https://nils-wittemeier.github.io/nyc-map/) in a browser.
2. Click any polygon to open its details panel. Clicking does **not** mark a neighborhood visited — that's a deliberate button in the panel, so you can explore the map without toggling things by accident.
3. In the panel, **Mark as visited** highlights the polygon green and fills in today's date. Add notes, favorite spots, or **+ Add to plan** to stage the neighborhood as a stop on a walking route.
4. Use the **List**, **Plan**, and **Stats** tabs as you like. Filters and the active selection persist across reloads.

### Install on phone

- **iPhone:** open the live link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open in **Chrome** → menu (⋮) → **Install app**.

After installing, it launches like a native app — fullscreen, with map tiles cached for offline use.

## Where is my data?

In your browser's `localStorage` under the key `nyc-tracker-v1`. It is **not** synced between devices or browsers — each install is independent.

It survives closing the tab, closing the browser, and reloading. You'll lose it only if you clear browser site data, switch browsers / profiles / devices, or use private mode.

For backup or cross-device sync, use **Export JSON** in the Stats tab, then **Import JSON** on the other device. The exported file is a portable snapshot of all visits and the current plan.

## Running locally / forking

The app is a static site with no build step.

```sh
git clone https://github.com/nils-wittemeier/nyc-map.git
cd nyc-map
python -m http.server 8000
```

Then open <http://localhost:8000>. Service-worker and PWA install features require HTTP(S), not `file://`, so use the local server (or a deployed copy) for those — opening `index.html` directly works for everything else.

To deploy your own copy: fork the repo, then **Settings → Pages → Source: Deploy from a branch → main / (root)**. Your copy will be live at `https://<your-username>.github.io/<repo-name>/` within a minute.

When you change app code, bump the cache version near the top of `service-worker.js` (`'nyc-tracker-shell-vN'`) so installed clients pick up the new build on their next reload.

## Data source

The map uses the **NYC 2020 Neighborhood Tabulation Areas (NTAs)** from NYC Open Data — all 262 features, including residential neighborhoods, parks, cemeteries, airports, and a few special areas.

- Source: <https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson>
- Stable per-feature key: `nta2020` (e.g. `BK0101` for Greenpoint)
- Borough: `boroname`
- Type: `ntatype` — `0` residential, `5` Rikers, `6` large non-residential, `7` cemetery, `8` airport, `9` park. The Details panel shows a friendly version of this.

The raw GeoJSON is checked in at `data/nyc-neighborhoods-2020-nta.geojson` for transparency. At runtime the app loads `data/neighborhoods.js`, a wrapped version of that file (wrapping is necessary because `file://` origin can't `fetch()` local JSON in most browsers). Regeneration instructions are in the comment at the top of `data/neighborhoods.js`.

## Project layout

```
.
├── index.html          entry point + CDN deps
├── app.js              all client logic
├── styles.css          custom CSS on top of Tailwind CDN
├── manifest.json       PWA manifest
├── service-worker.js   offline shell + tile cache
├── icons/              PWA icons (192px, 512px)
└── data/
    ├── neighborhoods.js                    data loaded by the app
    └── nyc-neighborhoods-2020-nta.geojson  raw export from NYC OpenData
```

## Tech notes

- **No build step.** Leaflet, Tailwind (Play CDN), and SortableJS load via CDN. The service worker caches them on first visit so the app runs fully offline thereafter.
- **Basemap** is CARTO Voyager. OpenStreetMap's own tile servers reject `file://` origins via their Referer policy, so CARTO is used instead.
- **State** is a single object keyed by `nta2020` code. Mutations route through `updateVisit()` / `addToPlan()` helpers that save to `localStorage` and patch the affected map layer in place — no full re-render.
