/* NYC Neighborhood Tracker
 * Map of NYC neighborhoods. Click toggles visited state and opens the
 * details panel for that neighborhood. Side panel has Details / List / Stats
 * tabs, with search, filters, borough breakdown, and JSON export/import.
 *
 * Sections:
 *   1. Constants, helpers, lookups
 *   2. Storage (state + localStorage) and mutations
 *   3. Map + tiles
 *   4. GeoJSON layer + selection
 *   5. Side panel rendering (Details / List / Stats)
 *   6. Export / Import
 *   7. Bootstrap + event wiring
 */

// ---------- 1. Constants, helpers, lookups ----------

const NYC_CENTER = [40.7128, -74.0060];
const NYC_DEFAULT_ZOOM = 11;

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];

// Maps NYC OpenData's `ntatype` codes to user-facing labels.
const NTA_TYPE_LABELS = {
  '0': 'Residential',
  '5': 'Other',           // Rikers Island
  '6': 'Other',           // large non-residential (Navy Yard, Fort Hamilton, …)
  '7': 'Cemetery',
  '8': 'Airport',
  '9': 'Park',
};
function ntaTypeLabel(feature) {
  return NTA_TYPE_LABELS[feature.properties.ntatype] || 'Other';
}

// Pale tints per ntatype — subtle hue variation that complements the basemap.
const FILL_BY_TYPE = {
  '0': '#93c5fd', // blue-300    — residential (light blue)
  '5': '#fde68a', // amber-200   — Rikers
  '6': '#fde68a', // amber-200   — other large non-residential
  '7': '#a8a29e', // stone-400   — cemetery (muted/somber)
  '8': '#bae6fd', // sky-200     — airport
  '9': '#c8e6c9', //              — park (muted sage; matches map-cartography convention)
};
const FILL_OPACITY_DEFAULT = 0.40;

const STYLE_OUTLINE_DEFAULT = { color: '#475569', weight: 1 }; // slate-600

const STYLE_VISITED = {
  fillColor: '#10b981',         // emerald-500 — saturated, slightly teal-leaning
  fillOpacity: 0.6,
  color: '#065f46',             // emerald-800
  weight: 3,                    // thick border, matching the plan outline
};

const STYLE_SELECTED_OUTLINE = {
  color: '#2563eb',             // blue-600
  weight: 3,
};

const STYLE_PLAN_OUTLINE = {
  color: '#7c3aed',             // violet-600
  weight: 3,
};

const STYLE_PLAN_FILL_UNVISITED = {
  fillColor: '#a78bfa',         // violet-400
  fillOpacity: 0.5,
};

const STYLE_HOVER = {
  color: '#ffffff',
  weight: 2,
  fillOpacity: 0.65,
};

function featureKey(feature) {
  return feature.properties.nta2020;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const features = window.NEIGHBORHOODS_GEOJSON.features;
const featuresByKey = new Map(features.map((f) => [featureKey(f), f]));

// ---------- 2. Storage + mutations ----------

const STORAGE_KEY = 'nyc-tracker-v1';

function defaultState() {
  return {
    schemaVersion: 1,
    visits: {},
    plan: { name: 'Walk plan', stops: [] },   // ordered list of nta2020 codes
    ui: { lastSelectedNta: null, sidePanelOpen: true },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === 1 && parsed.visits) {
      parsed.ui = parsed.ui || { lastSelectedNta: null, sidePanelOpen: true };
      parsed.plan = parsed.plan || { name: 'Walk plan', stops: [] };
      return parsed;
    }
    return defaultState();
  } catch {
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Failed to save state:', err);
  }
}

const state = loadState();

const ui = {
  selectedKey: state.ui.lastSelectedNta || null,
  activeTab: 'details',
  collapsed: !state.ui.sidePanelOpen,
  filter: { search: '', borough: 'all', status: 'all' },
};

function isVisited(key) {
  return !!(state.visits[key] && state.visits[key].visited);
}

function ensureVisit(key) {
  if (!state.visits[key]) {
    state.visits[key] = { visited: false, visitedDate: null, notes: '', favoriteSpots: [] };
  }
  return state.visits[key];
}

function updateVisit(key, patch) {
  const v = ensureVisit(key);
  Object.assign(v, patch);
  // Auto-fill today's date the first time something is marked visited.
  if (patch.visited === true && !v.visitedDate) {
    v.visitedDate = new Date().toISOString().slice(0, 10);
  }
  saveState();
  const layer = layersByKey.get(key);
  if (layer) layer.setStyle(styleFor(layer.feature));
  updateProgressChip();
}

// Plan helpers
function isInPlan(key) { return state.plan.stops.includes(key); }
function planIndex(key) { return state.plan.stops.indexOf(key); }

function addToPlan(key) {
  if (isInPlan(key)) return;
  state.plan.stops.push(key);
  saveState();
  refreshPlanLayer();
  if (ui.activeTab === 'plan') renderPlan();
}

function removeFromPlan(key) {
  const i = planIndex(key);
  if (i < 0) return;
  state.plan.stops.splice(i, 1);
  saveState();
  refreshPlanLayer();
  if (ui.activeTab === 'plan') renderPlan();
}

// ---------- 3. Map + tiles ----------

const map = L.map('map', {
  center: NYC_CENTER,
  zoom: NYC_DEFAULT_ZOOM,
  preferCanvas: true,
  zoomControl: true,
});

// CARTO Voyager basemap — free, no API key, works from file:// origin.
// (OpenStreetMap's own tile servers block file:// because of their Referer-based usage policy.)
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

// ---------- 4. GeoJSON layer + selection ----------

const layersByKey = new Map();

function styleFor(feature) {
  const key = featureKey(feature);
  const visited = isVisited(key);
  const planned = isInPlan(key);

  // Base: pale tint per ntatype + default outline.
  let s = {
    fillColor: FILL_BY_TYPE[feature.properties.ntatype] || FILL_BY_TYPE['0'],
    fillOpacity: FILL_OPACITY_DEFAULT,
    ...STYLE_OUTLINE_DEFAULT,
  };

  // Visited rose wins over planned violet; either replaces the type tint.
  if (visited) s = { ...s, ...STYLE_VISITED };
  else if (planned) s = { ...s, ...STYLE_PLAN_FILL_UNVISITED };

  // Outline: selected blue > planned violet > visited rose / default slate.
  if (planned) s = { ...s, ...STYLE_PLAN_OUTLINE };
  if (key === ui.selectedKey) s = { ...s, ...STYLE_SELECTED_OUTLINE };

  return s;
}

const neighborhoodsLayer = L.geoJSON(window.NEIGHBORHOODS_GEOJSON, {
  style: styleFor,
  onEachFeature: (feature, layer) => {
    const key = featureKey(feature);
    layersByKey.set(key, layer);

    layer.bindTooltip(feature.properties.ntaname, {
      sticky: true, direction: 'top', className: 'nta-tooltip',
    });

    layer.on({
      mouseover: (e) => e.target.setStyle(STYLE_HOVER),
      mouseout: (e) => neighborhoodsLayer.resetStyle(e.target),
      click: (e) => {
        // Click only selects + opens panel. Visited toggle is a button in the
        // details panel — avoids accidental toggling while exploring.
        selectNeighborhood(key);
        L.DomEvent.stopPropagation(e);
      },
    });
  },
}).addTo(map);

map.fitBounds(neighborhoodsLayer.getBounds(), { padding: [20, 20] });

// Click on map background -> deselect
map.on('click', () => {
  if (!ui.selectedKey) return;
  const prev = ui.selectedKey;
  ui.selectedKey = null;
  state.ui.lastSelectedNta = null;
  saveState();
  const layer = layersByKey.get(prev);
  if (layer) layer.setStyle(styleFor(layer.feature));
  if (ui.activeTab === 'details') renderDetails();
});

function refreshAllStyles() {
  for (const [, layer] of layersByKey) {
    layer.setStyle(styleFor(layer.feature));
  }
}

// Average-of-vertices centroid. Good enough for NYC neighborhood polygons —
// avoids the bbox-center-falls-outside problem of getBounds().getCenter().
function polygonCentroid(layer) {
  let outer = layer.getLatLngs();
  while (Array.isArray(outer) && outer.length > 0 && Array.isArray(outer[0])) {
    outer = outer[0];
  }
  if (!outer || !outer.length) return null;
  let sumLat = 0, sumLng = 0;
  for (const ll of outer) { sumLat += ll.lat; sumLng += ll.lng; }
  return [sumLat / outer.length, sumLng / outer.length];
}

let planMarkersLayer = null;
let planLineLayer = null;

function refreshPlanLayer() {
  if (planMarkersLayer) { map.removeLayer(planMarkersLayer); planMarkersLayer = null; }
  if (planLineLayer)    { map.removeLayer(planLineLayer);    planLineLayer = null; }
  refreshAllStyles();

  const stops = state.plan.stops
    .map((k) => ({ key: k, layer: layersByKey.get(k) }))
    .filter((s) => s.layer);
  if (!stops.length) return;

  const centroids = stops.map((s) => polygonCentroid(s.layer)).filter(Boolean);

  if (centroids.length >= 2) {
    planLineLayer = L.polyline(centroids, {
      color: '#7c3aed',
      weight: 3,
      opacity: 0.85,
      dashArray: '6,6',
    }).addTo(map);
  }

  planMarkersLayer = L.layerGroup();
  centroids.forEach((latlng, i) => {
    const icon = L.divIcon({
      className: 'plan-marker',
      html: `<div class="plan-marker-inner">${i + 1}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    L.marker(latlng, { icon, interactive: false, keyboard: false }).addTo(planMarkersLayer);
  });
  planMarkersLayer.addTo(map);
}

function selectNeighborhood(key, { fly = false } = {}) {
  const prev = ui.selectedKey;
  ui.selectedKey = key;
  state.ui.lastSelectedNta = key;
  ui.activeTab = 'details';
  ui.collapsed = false;
  state.ui.sidePanelOpen = true;
  saveState();

  if (prev && prev !== key) {
    const prevLayer = layersByKey.get(prev);
    if (prevLayer) prevLayer.setStyle(styleFor(prevLayer.feature));
  }
  const layer = layersByKey.get(key);
  if (layer) layer.setStyle(styleFor(layer.feature));

  applyPanelChrome();
  renderDetails();

  if (fly && layer) {
    map.fitBounds(layer.getBounds(), { maxZoom: 14, padding: [60, 60] });
  }
}

// ---------- 5. Side panel rendering ----------

function applyPanelChrome() {
  const panel = document.getElementById('side-panel');
  panel.dataset.collapsed = String(ui.collapsed);
  for (const tab of ['details', 'list', 'plan', 'stats']) {
    const btn = document.getElementById(`tab-btn-${tab}`);
    const content = document.getElementById(`tab-${tab}`);
    if (btn) btn.classList.toggle('active', ui.activeTab === tab);
    if (content) content.classList.toggle('hidden', ui.activeTab !== tab);
  }
  document.getElementById('panel-toggle-icon').innerHTML = ui.collapsed ? '&#9652;' : '&#9662;';
}

function renderActiveTab() {
  if (ui.activeTab === 'details') renderDetails();
  if (ui.activeTab === 'list') renderList();
  if (ui.activeTab === 'plan') renderPlan();
  if (ui.activeTab === 'stats') renderStats();
}

// --- Details tab ---
function renderDetails() {
  const root = document.getElementById('tab-details');
  if (!ui.selectedKey) {
    root.innerHTML = `<div class="p-4 text-sm text-slate-500">Click a neighborhood on the map to see details.</div>`;
    return;
  }
  const f = featuresByKey.get(ui.selectedKey);
  if (!f) {
    root.innerHTML = `<div class="p-4 text-sm text-red-500">Neighborhood not found.</div>`;
    return;
  }
  const v = state.visits[ui.selectedKey] || { visited: false, visitedDate: '', notes: '', favoriteSpots: [] };
  root.innerHTML = `
    <div class="p-4 space-y-4">
      <div>
        <h2 class="text-lg font-semibold leading-tight">${escapeHtml(f.properties.ntaname)}</h2>
        <div class="text-xs text-slate-500">${escapeHtml(f.properties.boroname)} &middot; ${escapeHtml(ntaTypeLabel(f))}</div>
      </div>
      ${v.visited
        ? `<button id="d-toggle" class="w-full rounded border border-emerald-600 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 text-sm font-medium px-3 py-2 flex items-center justify-center gap-2">
            <span>&#10003; Visited</span>
            <span class="text-xs font-normal text-emerald-700">— click to unmark</span>
          </button>`
        : `<button id="d-toggle" class="w-full rounded bg-emerald-600 text-white hover:bg-emerald-700 text-sm font-semibold px-3 py-2">
            Mark as visited
          </button>`
      }
      ${isInPlan(ui.selectedKey)
        ? `<button id="d-plan-toggle" class="w-full rounded border border-violet-600 bg-violet-50 text-violet-800 hover:bg-violet-100 text-sm px-3 py-2">
            In plan (stop #${planIndex(ui.selectedKey) + 1}) — remove
          </button>`
        : `<button id="d-plan-toggle" class="w-full rounded border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm px-3 py-2">
            + Add to plan
          </button>`
      }
      <label class="block text-sm">
        <span class="text-slate-700">Visited on</span>
        <input id="d-date" type="date" class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm" value="${escapeHtml(v.visitedDate || '')}"/>
      </label>
      <label class="block text-sm">
        <span class="text-slate-700">Notes</span>
        <textarea id="d-notes" rows="4" class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Restaurants, parks, anything memorable...">${escapeHtml(v.notes)}</textarea>
      </label>
      <div>
        <div class="text-sm text-slate-700 mb-1">Favorite spots</div>
        <ul id="d-spots" class="space-y-1">
          ${(v.favoriteSpots || []).map((s, i) => `
            <li class="flex gap-1">
              <input data-idx="${i}" type="text" class="d-spot flex-1 rounded border border-slate-300 px-2 py-1 text-sm" value="${escapeHtml(s)}" placeholder="Joe's Pizza"/>
              <button data-idx="${i}" class="d-spot-remove px-2 text-slate-400 hover:text-red-600" aria-label="Remove">&times;</button>
            </li>`).join('')}
        </ul>
        <button id="d-spot-add" class="mt-2 text-sm text-blue-600 hover:underline">+ Add spot</button>
      </div>
    </div>
  `;

  document.getElementById('d-toggle').addEventListener('click', () => {
    const willBeVisited = !isVisited(ui.selectedKey);
    updateVisit(ui.selectedKey, { visited: willBeVisited });
    // Mark-visited removes the stop from the plan automatically
    // (a visited place isn't a future destination anymore).
    if (willBeVisited && isInPlan(ui.selectedKey)) {
      removeFromPlan(ui.selectedKey);
    }
    renderDetails(); // refresh button label + auto-filled date
  });
  document.getElementById('d-plan-toggle').addEventListener('click', () => {
    if (isInPlan(ui.selectedKey)) removeFromPlan(ui.selectedKey);
    else addToPlan(ui.selectedKey);
    renderDetails();
  });
  document.getElementById('d-date').addEventListener('change', (e) => {
    updateVisit(ui.selectedKey, { visitedDate: e.target.value || null });
  });
  document.getElementById('d-notes').addEventListener('blur', (e) => {
    updateVisit(ui.selectedKey, { notes: e.target.value });
  });
  document.getElementById('d-spot-add').addEventListener('click', () => {
    const cur = ensureVisit(ui.selectedKey);
    cur.favoriteSpots = [...(cur.favoriteSpots || []), ''];
    updateVisit(ui.selectedKey, { favoriteSpots: cur.favoriteSpots });
    renderDetails();
  });
  const spotsEl = document.getElementById('d-spots');
  spotsEl.addEventListener('focusout', (e) => {
    if (!e.target.classList.contains('d-spot')) return;
    const idx = +e.target.dataset.idx;
    const cur = ensureVisit(ui.selectedKey);
    cur.favoriteSpots[idx] = e.target.value;
    updateVisit(ui.selectedKey, { favoriteSpots: cur.favoriteSpots });
  });
  spotsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button.d-spot-remove');
    if (!btn) return;
    const idx = +btn.dataset.idx;
    const cur = ensureVisit(ui.selectedKey);
    cur.favoriteSpots.splice(idx, 1);
    updateVisit(ui.selectedKey, { favoriteSpots: cur.favoriteSpots });
    renderDetails();
  });
}

// --- List tab ---
function renderList() {
  const root = document.getElementById('tab-list');
  if (root.dataset.shellRendered !== '1') {
    root.innerHTML = `
      <div class="sticky top-0 bg-white border-b border-slate-200 z-10 p-3 space-y-2">
        <input id="l-search" type="text" placeholder="Search neighborhoods..." class="w-full rounded border border-slate-300 px-2 py-1 text-sm"/>
        <div class="flex gap-2">
          <select id="l-borough" class="flex-1 rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="all">All boroughs</option>
            ${BOROUGHS.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
          </select>
          <select id="l-status" class="flex-1 rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="all">All</option>
            <option value="visited">Visited</option>
            <option value="unvisited">Unvisited</option>
          </select>
        </div>
        <div id="l-count" class="text-xs text-slate-500"></div>
      </div>
      <ul id="l-results" class="divide-y divide-slate-100"></ul>
    `;
    root.dataset.shellRendered = '1';
    document.getElementById('l-search').addEventListener('input', (e) => {
      ui.filter.search = e.target.value;
      renderListItems();
    });
    document.getElementById('l-borough').addEventListener('change', (e) => {
      ui.filter.borough = e.target.value;
      renderListItems();
    });
    document.getElementById('l-status').addEventListener('change', (e) => {
      ui.filter.status = e.target.value;
      renderListItems();
    });
    document.getElementById('l-results').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-key]');
      if (btn) selectNeighborhood(btn.dataset.key, { fly: true });
    });
  }
  document.getElementById('l-search').value = ui.filter.search;
  document.getElementById('l-borough').value = ui.filter.borough;
  document.getElementById('l-status').value = ui.filter.status;
  renderListItems();
}

function renderListItems() {
  const ul = document.getElementById('l-results');
  if (!ul) return;
  const q = ui.filter.search.trim().toLowerCase();
  const filtered = features.filter((f) => {
    if (q && !f.properties.ntaname.toLowerCase().includes(q)) return false;
    if (ui.filter.borough !== 'all' && f.properties.boroname !== ui.filter.borough) return false;
    const visited = isVisited(featureKey(f));
    if (ui.filter.status === 'visited' && !visited) return false;
    if (ui.filter.status === 'unvisited' && visited) return false;
    return true;
  });
  filtered.sort((a, b) => a.properties.ntaname.localeCompare(b.properties.ntaname));

  ul.innerHTML = filtered.map((f) => {
    const key = featureKey(f);
    const visited = isVisited(key);
    const isSel = key === ui.selectedKey;
    return `
      <li>
        <button data-key="${key}" class="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 ${isSel ? 'bg-blue-50' : ''}">
          <span class="inline-block w-2 h-2 rounded-full ${visited ? 'bg-emerald-500' : 'bg-slate-300'}"></span>
          <span class="flex-1 truncate text-sm">${escapeHtml(f.properties.ntaname)}</span>
          <span class="text-xs text-slate-400">${escapeHtml(f.properties.boroname)}</span>
        </button>
      </li>`;
  }).join('');
  document.getElementById('l-count').textContent = `${filtered.length} of ${features.length}`;
}

// --- Plan tab ---
function renderPlan() {
  const root = document.getElementById('tab-plan');
  const stops = state.plan.stops;
  const visitedCount = stops.filter((k) => isVisited(k)).length;

  root.innerHTML = `
    <div class="p-3 border-b border-slate-200 bg-white sticky top-0 z-10 space-y-2">
      <input id="p-name" type="text" value="${escapeHtml(state.plan.name)}" placeholder="Walk plan name"
             class="w-full font-medium text-sm rounded border border-slate-300 px-2 py-1"/>
      <div class="text-xs text-slate-500">${stops.length} stops &middot; ${visitedCount} visited</div>
    </div>
    ${stops.length === 0
      ? `<div class="p-4 text-sm text-slate-500">
          No stops yet. Click a neighborhood, then <span class="font-medium">+ Add to plan</span> in the Details tab.
        </div>`
      : `<ol id="p-stops" class="divide-y divide-slate-100">
          ${stops.map((key, i) => {
            const f = featuresByKey.get(key);
            if (!f) return `<li class="px-3 py-2 text-sm text-red-500">Unknown: ${escapeHtml(key)}</li>`;
            const visited = isVisited(key);
            return `
              <li data-key="${key}" class="flex items-center gap-2 px-2 py-2 bg-white">
                <span class="drag-handle text-slate-400 hover:text-slate-700 select-none px-1" aria-label="Drag to reorder">&#x2630;</span>
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-violet-600 text-white text-xs font-semibold flex-shrink-0">${i + 1}</span>
                <button data-action="select" data-key="${key}" class="flex-1 text-left min-w-0">
                  <div class="text-sm flex items-center gap-2 truncate">
                    <span class="inline-block w-2 h-2 rounded-full flex-shrink-0 ${visited ? 'bg-emerald-500' : 'bg-slate-300'}"></span>
                    <span class="truncate">${escapeHtml(f.properties.ntaname)}</span>
                  </div>
                  <div class="text-xs text-slate-500 ml-4">${escapeHtml(f.properties.boroname)}</div>
                </button>
                <button data-action="remove" data-key="${key}" class="px-2 text-slate-400 hover:text-red-600" aria-label="Remove">&times;</button>
              </li>`;
          }).join('')}
        </ol>
        <div class="p-3 border-t border-slate-200 flex gap-2">
          <button id="p-fit" class="flex-1 rounded border border-slate-300 text-sm px-3 py-1.5 hover:bg-slate-100">Zoom to plan</button>
          <button id="p-clear" class="flex-1 rounded border border-red-300 text-red-700 text-sm px-3 py-1.5 hover:bg-red-50">Clear plan</button>
        </div>`
    }
  `;

  document.getElementById('p-name').addEventListener('blur', (e) => {
    state.plan.name = e.target.value;
    saveState();
  });

  if (stops.length > 0) {
    const stopsEl = document.getElementById('p-stops');
    stopsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const key = btn.dataset.key;
      const action = btn.dataset.action;
      if (action === 'remove') { removeFromPlan(key); renderPlan(); }
      else if (action === 'select') { selectNeighborhood(key, { fly: true }); }
    });

    // Drag-to-reorder via SortableJS (CDN-loaded). Touch + desktop.
    if (typeof Sortable !== 'undefined') {
      Sortable.create(stopsEl, {
        animation: 150,
        handle: '.drag-handle',
        forceFallback: true,    // pointer-event-based — consistent across iOS/Android/desktop
        fallbackTolerance: 3,
        ghostClass: 'plan-ghost',
        chosenClass: 'plan-chosen',
        dragClass:  'plan-drag',
        onEnd: (evt) => {
          if (evt.oldIndex === evt.newIndex || evt.oldIndex == null || evt.newIndex == null) return;
          const [moved] = state.plan.stops.splice(evt.oldIndex, 1);
          state.plan.stops.splice(evt.newIndex, 0, moved);
          saveState();
          refreshPlanLayer();
          renderPlan();
        },
      });
    }
    document.getElementById('p-fit').addEventListener('click', () => {
      const layers = stops.map((k) => layersByKey.get(k)).filter(Boolean);
      if (!layers.length) return;
      const group = L.featureGroup(layers);
      map.fitBounds(group.getBounds(), { padding: [40, 40] });
    });
    document.getElementById('p-clear').addEventListener('click', () => {
      if (!confirm('Clear all stops from the plan?')) return;
      state.plan.stops = [];
      saveState();
      refreshPlanLayer();
      renderPlan();
    });
  }
}

// --- Stats tab ---
function renderStats() {
  const root = document.getElementById('tab-stats');
  const total = features.length;
  const visited = Object.values(state.visits).filter((v) => v && v.visited).length;
  const pct = total > 0 ? Math.round((visited / total) * 100) : 0;

  const byBoro = {};
  for (const b of BOROUGHS) byBoro[b] = { visited: 0, total: 0 };
  for (const f of features) {
    const b = f.properties.boroname;
    if (!byBoro[b]) byBoro[b] = { visited: 0, total: 0 };
    byBoro[b].total++;
    if (isVisited(featureKey(f))) byBoro[b].visited++;
  }

  root.innerHTML = `
    <div class="p-4 space-y-5">
      <div>
        <div class="flex items-baseline gap-1">
          <span class="text-3xl font-bold text-slate-800">${visited}</span>
          <span class="text-base text-slate-400">/ ${total}</span>
        </div>
        <div class="text-sm text-slate-500">${pct}% complete</div>
        <div class="mt-2 h-2 bg-slate-200 rounded">
          <div class="h-2 bg-emerald-500 rounded transition-all" style="width: ${pct}%"></div>
        </div>
      </div>
      <div>
        <div class="text-sm font-medium mb-2">By borough</div>
        <ul class="space-y-2">
          ${BOROUGHS.map((b) => {
            const s = byBoro[b];
            const p = s.total > 0 ? Math.round((s.visited / s.total) * 100) : 0;
            return `
              <li>
                <div class="flex justify-between text-sm">
                  <span>${escapeHtml(b)}</span>
                  <span class="text-slate-500">${s.visited}/${s.total} &middot; ${p}%</span>
                </div>
                <div class="mt-1 h-1.5 bg-slate-200 rounded">
                  <div class="h-1.5 bg-emerald-500 rounded transition-all" style="width: ${p}%"></div>
                </div>
              </li>`;
          }).join('')}
        </ul>
      </div>
      <div class="border-t border-slate-200 pt-4 space-y-2">
        <div class="text-sm font-medium">Backup &amp; sync</div>
        <div class="flex gap-2">
          <button id="s-export" class="flex-1 rounded bg-slate-800 text-white text-sm px-3 py-1.5 hover:bg-slate-900">Export JSON</button>
          <button id="s-import" class="flex-1 rounded bg-white border border-slate-300 text-sm px-3 py-1.5 hover:bg-slate-100">Import JSON</button>
          <input id="s-import-file" type="file" accept="application/json,.json" class="hidden"/>
        </div>
        <div class="text-xs text-slate-500">Export saves a file you can email or copy to another device. Import replaces your current data.</div>
      </div>
    </div>
  `;
  document.getElementById('s-export').addEventListener('click', exportJSON);
  document.getElementById('s-import').addEventListener('click', () => document.getElementById('s-import-file').click());
  document.getElementById('s-import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importJSON(file);
    e.target.value = '';
  });
}

// ---------- 6. Export / Import ----------

function exportJSON() {
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nyc-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || parsed.schemaVersion !== 1 || !parsed.visits) {
        alert('That file does not look like a valid NYC tracker backup.');
        return;
      }
      if (!confirm('Import will replace your current data. Continue?')) return;
      // Reset state object in place (state is const)
      const fresh = defaultState();
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, fresh, parsed);
      saveState();
      ui.selectedKey = state.ui.lastSelectedNta || null;
      ui.collapsed = !state.ui.sidePanelOpen;
      refreshPlanLayer();           // also calls refreshAllStyles()
      updateProgressChip();
      applyPanelChrome();
      renderActiveTab();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ---------- 7. Bootstrap + event wiring ----------

function updateProgressChip() {
  const total = features.length;
  const visited = Object.values(state.visits).filter((v) => v && v.visited).length;
  const pct = total > 0 ? Math.round((visited / total) * 100) : 0;
  document.getElementById('progress-chip').textContent = `${visited} / ${total} · ${pct}%`;
}

for (const tab of ['details', 'list', 'plan', 'stats']) {
  const btn = document.getElementById(`tab-btn-${tab}`);
  if (!btn) continue;
  btn.addEventListener('click', () => {
    ui.activeTab = tab;
    if (ui.collapsed) {
      ui.collapsed = false;
      state.ui.sidePanelOpen = true;
      saveState();
    }
    applyPanelChrome();
    renderActiveTab();
  });
}

document.getElementById('panel-toggle').addEventListener('click', () => {
  ui.collapsed = !ui.collapsed;
  state.ui.sidePanelOpen = !ui.collapsed;
  saveState();
  applyPanelChrome();
});

applyPanelChrome();
renderActiveTab();
updateProgressChip();
refreshPlanLayer();
