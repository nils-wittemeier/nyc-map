# NYC Neighborhood Tracker

A personal web app to track which NYC neighborhoods you've visited. Open `index.html` in any modern browser — no build step, no server.

## How to run

**Local (no install):** Double-click `index.html`. The app loads Leaflet and Tailwind from CDNs, so an internet connection is required for the first load and for map tiles. Note: service worker / offline / "Add to Home Screen" features only work over HTTP(S), not `file://` — see the PWA section below for offline + phone use.

**As a PWA on your phone:** Deploy to GitHub Pages (free) and tap "Add to Home Screen" in mobile Safari/Chrome. Instructions below.

## Data source

The map shows the **NYC 2020 Neighborhood Tabulation Areas (NTAs)** from NYC Open Data, filtered to the 197 residential NTAs (`ntatype = 0`).

- Raw data: `data/nyc-neighborhoods-2020-nta.geojson` (262 features — includes parks, cemeteries, airports)
- Filtered + wrapped for the app: `data/neighborhoods.js` (197 features, exposed as `window.NEIGHBORHOODS_GEOJSON`)
- Source URL: `https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=300`

### Why 197 and not 262?

The full NTA dataset includes non-residential places: cemeteries (e.g. Green-Wood), airports (JFK, LaGuardia), Rikers Island, and large parks (Lincoln Terrace Park, Calvert Vaux Park, etc.). These don't really fit the "neighborhoods we've visited" idea, so they're filtered out by `ntatype = 0`. To include them, regenerate `data/neighborhoods.js` without the filter.

### Why this dataset and not Pediacities?

The original Pediacities NYC neighborhoods (~310 features) was hosted at `data.beta.nyc`, which is offline. Most online "Pediacities mirrors" actually serve the smaller snd3 NTA file (188 features, no borough field). The NYC Open Data 2020 NTAs are an authoritative substitute with native `boroname` and slightly finer detail than snd3.

The original snd3 file is preserved at `data/nyc-neighborhoods.geojson` for reference.

## Project structure

```
.
├── index.html                              # entry point
├── app.js                                  # all app logic
├── styles.css                              # small custom CSS
├── data/
│   ├── neighborhoods.js                    # the data the app actually uses
│   ├── nyc-neighborhoods-2020-nta.geojson  # raw NYC OpenData download (262)
│   └── nyc-neighborhoods.geojson           # original snd3 file (188), kept for reference
└── README.md
```

## Status

All four checkpoints from the plan are implemented:

- **Checkpoint 1:** Map renders all 197 neighborhoods, hover tooltip.
- **Checkpoint 2:** Click toggles visited state (gray ↔ green), persisted to `localStorage` under `nyc-tracker-v1`.
- **Checkpoint 3:** Right-docked side panel with three tabs:
  - **Details** — visited checkbox, date picker, notes, favorite-spots list
  - **List** — search box, borough filter, visited/unvisited filter; click to fly to
  - **Stats** — global progress + per-borough breakdown
- **Checkpoint 4:** JSON export/import (Stats tab), mobile bottom-drawer layout.
- **Plan tab:** build an ordered route (A → B → C …) of neighborhoods to walk. Add stops from the Details tab, reorder/remove from the Plan tab. Stops appear on the map as a violet fill with a numbered marker, connected by a dashed violet line.

## How click & panel interact

- Click a polygon → opens the Details panel for it (does **not** mark it visited — avoids accidental toggling while exploring).
- In the Details panel, click **Mark as visited** → polygon turns green and today's date is auto-filled.
- Click again on the green "✓ Visited" pill in the panel to unmark.
- Click on empty map → deselects.
- Chevron in the panel header → collapses the panel.

## Where is my data stored?

In your browser's **`localStorage`** under the key `nyc-tracker-v1` (it's not cookies). To inspect it: open DevTools → Application → Local Storage → `file://` (or wherever you opened `index.html` from).

**It survives:** closing the tab, closing the browser, restarting the computer, reloading the page.

**It is lost only if you:**

- clear browser site data / "clear cookies and site data" (some browsers lump localStorage in here)
- use a different browser, profile, or device
- open the file in private/incognito mode (cleared when the private session ends)

Bottom line: closing the page is fine, you don't need to export every time. **Do export** before clearing browser data, switching browsers/devices, or any major OS reset. The exported JSON is your portable backup.

## Deploying as a PWA (GitHub Pages)

The repo already includes `manifest.json`, `service-worker.js`, and icons. Steps:

1. **Make it a git repo and push to GitHub:**
   ```powershell
   cd C:\Users\Juijan\Documents\NYC-map
   git init
   git add .
   git commit -m "NYC Neighborhood Tracker"
   git branch -M main
   git remote add origin https://github.com/<your-username>/nyc-map.git
   git push -u origin main
   ```

2. **Enable Pages:** in the repo on github.com → Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `/ (root)`. Save. After ~30s the URL will be `https://<your-username>.github.io/nyc-map/`.

3. **Test in desktop Chrome:** open the URL. DevTools → Application → Service Workers should show one registered. Application → Manifest should show the icons + name parsed without errors.

4. **Install on iPhone:** open the URL in **Safari** (not Chrome — only Safari can install PWAs on iOS). Tap the Share button → "Add to Home Screen". You get an app icon, fullscreen UI on launch, and offline map tiles for areas you've already viewed.

5. **Install on Android:** open the URL in Chrome. Either tap the auto-prompt that appears, or menu → "Install app" / "Add to Home screen".

### Local PWA testing without deploying

Service workers don't work over `file://`. To test locally with a real HTTPS-equivalent (`http://localhost` is treated as secure):

```powershell
cd C:\Users\Juijan\Documents\NYC-map
python -m http.server 8000
```

Then open `http://localhost:8000`. The "Add to Home Screen" flow is normally only triggered for HTTPS, so for actual install testing use the GitHub Pages URL.

### Updating after a deploy

Bump the version in `service-worker.js` (`SHELL_CACHE = 'nyc-tracker-shell-v2'`, etc.) any time you change `index.html`/`app.js`/`styles.css`/`data/neighborhoods.js`. Old caches are pruned on the next visit, and the new version takes effect after the user reloads twice (once to install the new SW, once to activate).

## Regenerating `data/neighborhoods.js`

If you want to change the filter (e.g. include parks) or refresh the dataset, run this in PowerShell from the project root:

```powershell
$raw = Get-Content 'data/nyc-neighborhoods-2020-nta.geojson' -Raw
$json = $raw | ConvertFrom-Json
# Change the filter below to include other ntatypes:
#   0 = residential, 5 = Rikers, 6 = large non-residential, 7 = cemeteries,
#   8 = airports, 9 = parks
$filtered = @{ type='FeatureCollection'; features=@($json.features | Where-Object { $_.properties.ntatype -eq '0' }) }
$body = ($filtered | ConvertTo-Json -Depth 20 -Compress)
$out = "window.NEIGHBORHOODS_GEOJSON = $body;`n"
[System.IO.File]::WriteAllText('data/neighborhoods.js', $out, (New-Object System.Text.UTF8Encoding $false))
```
