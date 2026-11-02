/**
 * Forest Eyes — Deforestation Intelligence Platform
 * =================================================
 * Full API integration extracted from the wri/gfw GitHub repository:
 *
 *   1. GFW Data API       → https://data-api.globalforestwatch.org
 *      - Geostore (create/fetch areas from GeoJSON)
 *      - Tree cover loss (precomputed datasets by admin/geostore)
 *      - GLAD / Integrated deforestation alerts
 *      - FAO forest data (extent, deforestation rates, reforestation)
 *      - Biomass & carbon stock
 *
 *   2. Resource Watch API  → https://api.resourcewatch.org
 *      - Analysis endpoints (UMD loss/gain by admin/geostore/wdpa)
 *      - Climate cumulative emissions & deforestation tracking
 *      - Recent satellite tiles (Landsat via lat/lng)
 *
 *   3. GNW Analytics API   → https://analytics.globalnaturewatch.org
 *      - On-the-fly tree cover loss analytics for arbitrary GeoJSON polygons
 *
 *   4. Climate Watch API   → https://www.climatewatchdata.org/api/v1
 *      - Greenhouse gas emissions metadata & data (CO2, CH4, N2O by country)
 *
 *   5. Open-Meteo          → https://api.open-meteo.com   (free, no key)
 *      - Real-time weather (temperature, humidity, precipitation, wind)
 *
 *   6. Nominatim (OSM)     → https://nominatim.openstreetmap.org (free)
 *      - Location name search / geocoding
 */

// =============================================
// API BASE URLS (extracted from utils/apis.js)
// =============================================
const APIS = {
  GFW_DATA:          'https://data-api.globalforestwatch.org',
  RESOURCE_WATCH:    'https://api.resourcewatch.org/v1',
  GFW_API:           'https://api.resourcewatch.org',
  GNW_ANALYTICS:     'https://analytics.globalnaturewatch.org',
  CLIMATE_WATCH:     'https://www.climatewatchdata.org/api/v1',
  OPEN_METEO:        'https://api.open-meteo.com/v1',
  NOMINATIM:         'https://nominatim.openstreetmap.org',
};

// GFW API key: kept on the server (api/core.js reads GFW_API_KEY from .env locally or the
// Lambda environment on AWS). The browser calls our own /api/gfw/* routes, which add it.
// [aws] The previous key was public in this file; rotate it at globalforestwatch.org.
const API_BASE = window.FORESTEYES_API_BASE || '';

// Analysis dataset tables (from data/analysis-datasets.json)
const DATASETS = {
  ANNUAL_GEOSTORE_SUMMARY: 'geostore__tcl__summary',
  ANNUAL_GEOSTORE_CHANGE:  'geostore__tcl__change',
  GLAD_GEOSTORE_DAILY:     'geostore__glad__daily_alerts',
  INTEGRATED_ALERTS_GEOSTORE_DAILY: 'geostore__integrated_alerts__daily_alerts',
};

// =============================================
// MAP INITIALIZATION
// =============================================
const map = L.map('map', {
  center: [20, 0],
  zoom: 3,
  zoomControl: false,
  maxZoom: 16,   // GFW data tiles cap at z12; base layers work fine to z16; beyond that the tile APIs 404
  minZoom: 2,
  attributionControl: false,
});

// Base layers
const darkBase = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  maxZoom: 19,
});

const satelliteBase = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: '&copy; Esri, Maxar, Earthstar Geographics',
  maxZoom: 19,
});

// GFW Data Layers (from tiles.globalforestwatch.org — extracted from repo configs)
const treeCoverLayer = L.tileLayer('https://tiles.globalforestwatch.org/umd_tree_cover_density_2000/v1.8/tcd_30/{z}/{x}/{y}.png', {
  maxZoom: 12,
  opacity: 0.7,
  attribution: 'Tree Cover 2000 &copy; UMD/Hansen/Google/USGS/NASA',
});

const treeLossLayer = L.tileLayer('https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/tcd_30/{z}/{x}/{y}.png', {
  maxZoom: 12,
  opacity: 0.85,
  attribution: 'Tree Cover Loss &copy; UMD/Hansen/Google/USGS/NASA',
});

const gladAlertsLayer = L.tileLayer('https://tiles.globalforestwatch.org/glad_prod/tiles/{z}/{x}/{y}.png', {
  maxZoom: 12,
  opacity: 0.9,
  attribution: 'GLAD Alerts &copy; UMD/GLAD',
});
const treeLossColorLayer = L.layerGroup();

// Add default layers to map
satelliteBase.addTo(map);
treeCoverLayer.addTo(map);
treeLossLayer.addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// =============================================
// LAYER TOGGLE CONTROLS
// =============================================
// Safely bind layer toggles (they may not exist if HTML hasn't loaded yet)
function bindToggle(id, onCheck, onUncheck) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', (e) => e.target.checked ? onCheck() : onUncheck());
}

bindToggle('toggle-satellite',
  () => { map.removeLayer(darkBase); map.addLayer(satelliteBase); },
  () => { map.removeLayer(satelliteBase); map.addLayer(darkBase); }
);
bindToggle('toggle-tree-cover',
  () => map.addLayer(treeCoverLayer),
  () => map.removeLayer(treeCoverLayer)
);
bindToggle('toggle-tree-loss',
  () => syncTreeLossLayer(),
  () => syncTreeLossLayer()
);
bindToggle('toggle-glad',
  () => map.addLayer(gladAlertsLayer),
  () => map.removeLayer(gladAlertsLayer)
);

// State
let currentMarker = null;
let currentPolygon = null;
let lastName = null;
let latestApiUpdatedAt = null;
let latestLossRows = [];
let latestLossCenter = null;
let globeScene = null;

// =============================================
// APP STATE — Dual-Cache Architecture
// Keeps API and simulated data in completely
// separate stores keyed by "lat,lng" location ID.
// =============================================
const appState = {
  /** @type {Object<string, {raw: Object, formatted: Object, locationName: string, lat: number, lng: number}>} */
  apiCache: {},
  /** @type {Object<string, {raw: Object, formatted: Object, locationName: string, lat: number, lng: number}>} */
  simCache: {},
  /** Currently displayed location ID ("lat,lng") or null */
  activeLocationId: null,
};

/** Produce a stable cache key from coordinates (rounded to 4 dp to avoid float dust). */
function locationId(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

const $ = id => document.getElementById(id);
// [rename] Keep recent searches saved under the old app name (ForestWatch → Forest Eyes).
try {
  const oldSearches = localStorage.getItem('forestwatch-recent-searches');
  if (oldSearches && !localStorage.getItem('foresteyes-recent-searches')) {
    localStorage.setItem('foresteyes-recent-searches', oldSearches);
  }
  localStorage.removeItem('forestwatch-recent-searches');
} catch { /* storage unavailable (private mode): nothing to move */ }

const $latInput       = $('lat-input');
const $lngInput       = $('lng-input');
const $radiusInput    = $('radius-input');
const $radiusDisplay  = $('radius-display');
const $locationSearch = $('location-search');
const $searchBtn      = $('search-btn');
const $analyzeBtn     = $('analyze-btn');
const $retryBtn       = $('retry-btn');
const $statusDot      = $('status-dot');
const $statusText     = $('status-text');

const $resultPlaceholder  = $('result-placeholder');

function extractApiUpdatedAt(body, response) {
  return body?.meta?.updated_at || body?.metadata?.updated_at || body?.data?.updated_at ||
    response.headers.get('last-modified') || response.headers.get('date') || null;
}
const $resultContent      = $('result-content');
const $loadingState       = $('loading-state');
const $errorState         = $('error-state');
const $errorMessage       = $('error-message');
const $resultLocationName = $('result-location-name');
const $severityCard       = $('severity-card');
const $severityIcon       = $('severity-icon');
const $severityLevel      = $('severity-level');
const $severityDesc       = $('severity-desc');
const $statHa             = $('stat-ha');
const $statCo2            = $('stat-co2');
const $statYears          = $('stat-years');
const $statTrees          = $('stat-trees');
const $barChart           = $('bar-chart');
const $plantingNumber     = $('planting-number');
const $apiUpdated         = $('api-updated');
const $recentSearches     = $('recent-searches');
const $searchSuggestions  = $('search-suggestions');
const $globeContainer      = $('globe-container');
const $globeControls       = $('globe-controls');
const $treeLossMode        = $('tree-loss-mode');
const $toggleRealApi       = $('toggle-real-api');
const $toggleSimulate      = $('toggle-simulate');
const $dataSourceHint      = $('data-source-hint');

if ($treeLossMode) $treeLossMode.addEventListener('change', syncTreeLossLayer);

// =============================================
// DATA SOURCE TOGGLE
// =============================================
function getDataSourceMode() {
  return 'real'; // live GFW / Global Nature Watch data only; there is no simulated mode
}

function updateDataSourceHint() {
  if (!$dataSourceHint) return;
  if (getDataSourceMode() === 'real') {
    $dataSourceHint.textContent = 'Using live GFW API with authentication';
    $dataSourceHint.style.color = 'rgba(0, 230, 118, 0.5)';
  } else {
    $dataSourceHint.textContent = 'Using simulated biome estimates';
    $dataSourceHint.style.color = '';
  }
}

/**
 * When the user flips the toggle, instantly swap the displayed data
 * from the correct cache — no re-fetch, no re-simulation.
 * Uses structuredClone to guarantee zero mutation of cached data.
 */
function onDataSourceToggle() {
  updateDataSourceHint();

  const locId = appState.activeLocationId;
  if (!locId) return; // nothing analysed yet

  const mode  = getDataSourceMode();
  const cache = mode === 'real' ? appState.apiCache : appState.simCache;
  const entry = cache[locId];

  if (!entry) {
    // No cached data for this mode yet — tell the user
    const label = mode === 'real' ? 'Live API' : 'Simulated';
    $apiUpdated.textContent = `${label} data not yet available for this location — click Analyze.`;
    return;
  }

  // Deep-clone so the chart / UI can never mutate our cache
  const safeData = structuredClone(entry.formatted);
  renderDeforestationResults(entry.lat, entry.lng, entry.locationName, safeData, mode);
  setStatus('ready', `Switched to ${mode === 'real' ? 'Live API' : 'Simulated'} data`);
}

if ($toggleRealApi)  $toggleRealApi.addEventListener('change', onDataSourceToggle);
if ($toggleSimulate) $toggleSimulate.addEventListener('change', onDataSourceToggle);

const globeToggle = $('toggle-globe');
if (globeToggle) globeToggle.addEventListener('change', (event) => {
  const showGlobe = event.target.checked;
  $globeContainer.classList.toggle('hidden', !showGlobe);
  $globeControls?.classList.toggle('hidden', !showGlobe);
  $('map').classList.toggle('hidden', showGlobe);
  if (showGlobe) {
    initGlobe();
    resizeGlobe();
  }
  // (The loop is resumed after onToggle: resumed before, its first frame drew and uploaded the
  // full earth that the transition is about to hide.)
  window.ForestGlobeTransition?.onToggle(showGlobe); // [transition] animated 2D→3D wrap; no-op if globe-transition.js is missing
  resumeGlobe(); // the wrap/unwrap animation is driven by the globe's render loop: make sure it runs
});

const $climatePlaceholder = $('climate-placeholder');
const $climateContent     = $('climate-content');
const $cvTemp             = $('cv-temp');
const $cvHumidity         = $('cv-humidity');
const $cvPrecip           = $('cv-precip');
const $cvWind             = $('cv-wind');
const $cbTemp             = $('cb-temp');
const $cbHumidity         = $('cb-humidity');
const $cbPrecip           = $('cb-precip');
const $cbWind             = $('cb-wind');
const $gwGaugeFill        = $('gw-gauge-fill');
const $gwLabel            = $('gw-label');
const $gwDescription      = $('gw-description');

const $steps = [1,2,3,4].map(i => $(`step-${i}`));

// =============================================
// RADIUS SLIDER
// =============================================
$radiusInput.addEventListener('input', () => {
  const val = $radiusInput.value;
  $radiusDisplay.textContent = `${val} km`;
  const pct = ((val - 1) / (50 - 1)) * 100;
  $radiusInput.style.background = `linear-gradient(to right, #00e676 0%, #00e676 ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
});

// =============================================
// MAP CLICK — fills coords
// =============================================
map.on('click', (e) => {
  $latInput.value = e.latlng.lat.toFixed(6);
  $lngInput.value = e.latlng.lng.toFixed(6);
  lastName = null;
  if(typeof updatePrefixes === 'function') updatePrefixes();
});

// =============================================
// GEOCODING (Nominatim — from services/geocoding.js pattern)
// =============================================
async function geocodeLocation(query) {
  const url = `${APIS.NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const data = await res.json();
  if (!data || data.length === 0) throw new Error('Location not found. Try a different search term.');
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), name: data[0].display_name };
}

$searchBtn.addEventListener('click', doSearch);
$locationSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
  if (e.key === 'Escape') $searchSuggestions.classList.add('hidden');
});

let suggestionTimer = null;
let searchCount = 0; // suggestions loaded before the latest search are stale
function closeSuggestions() {
  clearTimeout(suggestionTimer);
  searchCount++;
  $searchSuggestions.classList.add('hidden');
}
$locationSearch.addEventListener('input', () => {
  clearTimeout(suggestionTimer);
  const query = $locationSearch.value.trim();
  if (query.length < 3) {
    $searchSuggestions.classList.add('hidden');
    return;
  }
  suggestionTimer = setTimeout(() => loadSearchSuggestions(query), 350);
});

document.addEventListener('click', (e) => {
  if (!$searchSuggestions.contains(e.target) && e.target !== $locationSearch) {
    $searchSuggestions.classList.add('hidden');
  }
});

async function loadSearchSuggestions(query) {
  const startedAt = searchCount;
  try {
    const url = `${APIS.NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&limit=5`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const places = await res.json();
    // A search ran (or the text changed) while this was loading: these suggestions are stale
    if (searchCount !== startedAt || $locationSearch.value.trim() !== query) return;
    $searchSuggestions.innerHTML = '';
    places.forEach(place => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'search-suggestion';
      item.textContent = place.display_name;
      item.addEventListener('click', () => {
        $locationSearch.value = place.display_name;
        $searchSuggestions.classList.add('hidden');
        applyLocation(parseFloat(place.lat), parseFloat(place.lon), place.display_name);
      });
      $searchSuggestions.appendChild(item);
    });
    $searchSuggestions.classList.toggle('hidden', places.length === 0);
  } catch (err) {
    $searchSuggestions.classList.add('hidden');
  }
}

async function doSearch() {
  const query = $locationSearch.value.trim();
  if (!query) return;
  closeSuggestions(); // else a pending suggestion list opens over the coordinate boxes
  setStatus('loading', 'Searching location...');
  try {
    const { lat, lng, name } = await geocodeLocation(query);
    applyLocation(lat, lng, name);
    setStatus('ready', 'Location found — click Analyze');
  } catch (err) {
    setStatus('error', err.message);
  }
}

function applyLocation(lat, lng, name) {
  $latInput.value = lat.toFixed(6);
  $lngInput.value = lng.toFixed(6);
  lastName = name.split(',').slice(0, 2).join(',');
  $locationSearch.value = lastName;
  map.setView([lat, lng], 10);
  focusGlobeOnCoordinates(lat, lng);
  saveRecentSearch({ lat, lng, name: lastName });
  if (typeof updatePrefixes === 'function') updatePrefixes();
}

// =============================================
// PRESET BUTTONS
// =============================================
function saveRecentSearch(search) {
  const stored = JSON.parse(localStorage.getItem('foresteyes-recent-searches') || '[]');
  const next = [search, ...stored.filter(item => item.name !== search.name)].slice(0, 6);
  localStorage.setItem('foresteyes-recent-searches', JSON.stringify(next));
  renderRecentSearches(next);
}

function renderRecentSearches(searches = JSON.parse(localStorage.getItem('foresteyes-recent-searches') || '[]')) {
  if (!$recentSearches) return;
  $recentSearches.innerHTML = '';
  if (!searches.length) {
    $recentSearches.innerHTML = '<p class="empty-recent">Your searched locations will appear here.</p>';
    return;
  }
  searches.forEach(search => {
    const button = document.createElement('button');
    button.className = 'btn-preset';
    button.textContent = `📍 ${search.name}`;
    button.title = `Load ${search.name}`;
    button.addEventListener('click', () => {
      applyLocation(search.lat, search.lng, search.name);
      setStatus('ready', `${search.name} loaded — click Analyze`);
    });
    $recentSearches.appendChild(button);
  });
}

// =============================================
// ANALYZE BUTTON
// =============================================
$analyzeBtn.addEventListener('click', () => {
  const lat = parseFloat($latInput.value);
  const lng = parseFloat($lngInput.value);
  if (isNaN(lat) || isNaN(lng)) {
    showError('Please enter valid latitude and longitude, or search for a location.');
    return;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    showError('Coordinates out of range. Latitude: -90 to 90. Longitude: -180 to 180.');
    return;
  }
  analyzeLocation(lat, lng);
});

// Same as Analyze: re-reads the inputs, so it also works after an input error and uses coordinates typed since
$retryBtn.addEventListener('click', () => $analyzeBtn.click());

// =============================================
//  CORE: ANALYZE LOCATION
//  In 'real' mode  → GFW Data API → GNW fallback (no simulation)
//  In 'simulate'   → pure biome-based estimate (no API calls)
//  Results are stored in the appropriate cache.
// =============================================
async function analyzeLocation(lat, lng) {
  const radiusKm = parseInt($radiusInput.value);
  const locationName = lastName || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const mode  = getDataSourceMode();
  const locId = locationId(lat, lng);

  // Clear *visual* UI for the new analysis, but caches survive
  showLoading();
  setStatus('loading', 'Analyzing…');
  clearMapLayers();
  appState.activeLocationId = locId;
  map.setView([lat, lng], 9);
  focusGlobeOnCoordinates(lat, lng);

  try {
    // STEP 1 — Build GeoJSON bounding box
    setStep(0);
    const geojson = createBoundingBoxGeoJSON(lat, lng, radiusKm);
    drawPolygon(geojson);
    // Tree cover in 2000 in the same box (denominator of the deforestation rate), fetched alongside
    const extentJob = fetchForestExtent(geojson).catch(err => {
      console.warn('[API] Forest extent unavailable:', err.message);
      return null;
    });
    await delay(400);

    let analyticsData = null;

    if (mode === 'real') {
      // ——— REAL API MODE ———
      setStep(1);
      try {
        // Without a GFW key on the server GFW refuses the query, so go straight to Global Nature Watch
        if (!(await gfwKeyConfigured())) throw new Error('no GFW key on the server');
        console.log('[API] Mode: REAL API — Strategy 1: GFW Data API');
        const geostoreId = await createGeostore(geojson);
        console.log('[API] Geostore created:', geostoreId);
        analyticsData = await queryTreeCoverLossDataset(geostoreId);
        console.log('[API] GFW Data API returned data');
      } catch (gfwErr) {
        console.warn('[API] GFW Data API failed:', gfwErr.message);
        try {
          console.log('[API] Mode: REAL API — Strategy 2: GNW Analytics API');
          const resourceId = await triggerGNWAnalyticsJob(geojson);
          setStep(2);
          analyticsData = await pollGNWAnalyticsJob(resourceId);
          console.log('[API] GNW Analytics API returned data');
        } catch (gnwErr) {
          console.warn('[API] GNW Analytics API also failed:', gnwErr.message);
          throw new Error('The live forest data services (GFW and Global Nature Watch) did not answer. Please try again in a minute.');
        }
      }
    }

    // STEP 3 — Format & store into the correct cache
    setStep(2);
    await delay(300);
    setStep(3);
    await delay(200);

    const formatted = formatAnalyticsResponse(analyticsData);
    formatted.areaKm2 = (2 * radiusKm) ** 2; // the analysis box is 2r × 2r
    const extent = await extentJob;
    formatted.forestHa2000 = extent ? extent.forestHa : null;
    formatted.forestCoverPct = extent ? extent.coverPct : null;
    latestApiUpdatedAt = analyticsData?.updatedAt || null;

    // ---- CACHE WRITE (strict isolation) ----
    const cacheEntry = {
      raw: analyticsData,
      formatted,
      locationName,
      lat,
      lng,
    };
    if (mode === 'real') {
      appState.apiCache[locId] = cacheEntry;
      console.log(`[CACHE] apiCache["${locId}"] written`);
    } else {
      appState.simCache[locId] = cacheEntry;
      console.log(`[CACHE] simCache["${locId}"] written`);
    }

    // ---- RENDER from a deep clone (zero mutation guarantee) ----
    const safeData = structuredClone(formatted);
    renderDeforestationResults(lat, lng, locationName, safeData, mode);

    // Climate data (fires in parallel)
    fetchAndRenderClimate(lat, lng, safeData.totalHa);

    setStatus('ready', `Analysis complete — ${locationName}`);

  } catch (err) {
    console.error('Analysis failed:', err);
    showError(`Analysis failed: ${err.message}. Please try again.`);
    setStatus('error', 'Analysis failed');
  } finally {
    if ($analyzeBtn) $analyzeBtn.disabled = false;
  }
}

// =============================================
// GEO HELPERS
// =============================================
function createBoundingBoxGeoJSON(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.0;
  const lngDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: `fw-${Date.now()}`,
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lng - lngDelta, lat - latDelta],
          [lng + lngDelta, lat - latDelta],
          [lng + lngDelta, lat + latDelta],
          [lng - lngDelta, lat + latDelta],
          [lng - lngDelta, lat - latDelta],
        ]],
      },
      properties: {},
    }],
  };
}

/** Hectares of tree cover (≥30 % canopy, year 2000) in the analysis box, counted by our server. */
async function fetchForestExtent(geojson) {
  const ring = geojson.features[0].geometry.coordinates[0];
  const bbox = [ring[0][0], ring[0][1], ring[2][0], ring[2][1]].map(v => v.toFixed(5)).join(',');
  const res = await fetch(`${API_BASE}/api/gfw/extent?bbox=${bbox}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Forest extent failed: ${res.status}`);
  return res.json();
}

function drawPolygon(geojson) {
  const coords = geojson.features[0].geometry.coordinates[0];
  const leafletCoords = coords.map(c => [c[1], c[0]]);
  currentPolygon = L.polygon(leafletCoords, {
    color: 'rgba(66, 165, 245, 0.8)',
    weight: 2,
    fillColor: 'rgba(66, 165, 245, 0.06)',
    fillOpacity: 1,
    dashArray: '6 4',
  }).addTo(map);
}

// =============================================
// API 1: GFW DATA API — Geostore + Dataset Query
// (from services/geostore.js — saveGeostore)
// =============================================
let gfwKeyCheck = null;
/** Asks our server once whether it has a GFW key (it never sends the key itself). */
function gfwKeyConfigured() {
  if (!gfwKeyCheck) {
    gfwKeyCheck = fetch(`${API_BASE}/api/health`)
      .then(r => (r.ok ? r.json() : {}))
      .then(h => h.gfwKeyConfigured !== false)
      .catch(() => true); // unknown: just try GFW
  }
  return gfwKeyCheck;
}

async function createGeostore(geojson) {
  // [aws] via our backend, which adds the GFW key (was: ${APIS.GFW_API}/geostore/ with the key in the browser)
  const res = await fetch(`${API_BASE}/api/gfw/geostore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geojson }),
  });
  if (!res.ok) throw new Error(`Geostore creation failed: ${res.status}`);
  const data = await res.json();
  const hash = data?.data?.attributes?.hash || data?.data?.id;
  if (!hash) throw new Error('No geostore hash in response');
  return hash;
}

// Query precomputed tree cover loss dataset by geostore
// (from services/analysis-cached.js — SQL_QUERIES.loss pattern)
async function queryTreeCoverLossDataset(geostoreId) {
  const dataset = DATASETS.ANNUAL_GEOSTORE_SUMMARY;
  const sql = encodeURIComponent(
    `SELECT umd_tree_cover_loss__year, ` +
    `SUM(umd_tree_cover_loss__ha) AS umd_tree_cover_loss__ha, ` +
    `SUM("gfw_gross_emissions_co2e_all_gases__Mg") AS gfw_gross_emissions_co2e_all_gases__Mg ` +
    `FROM data ` +
    `WHERE umd_tree_cover_density_2000__threshold >= 30 ` +
    `GROUP BY umd_tree_cover_loss__year ` +
    `ORDER BY umd_tree_cover_loss__year`
  );

  // [aws] via our backend, which adds the GFW key (was: ${APIS.GFW_DATA}/dataset/.../query with the key in the browser)
  const url = `${API_BASE}/api/gfw/query?dataset=${encodeURIComponent(dataset)}&sql=${sql}&geostore_id=${encodeURIComponent(geostoreId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dataset query failed: ${res.status}`);
  const body = await res.json();
  const rows = body?.data?.data || body?.data || [];
  if (!rows.length) throw new Error('No data rows returned from GFW Data API');

  // Transform to our standard format
  return {
    result: {
      tree_cover_loss_year: rows.map(r => r.umd_tree_cover_loss__year),
      area_ha: rows.map(r => r.umd_tree_cover_loss__ha || 0),
      carbon_emissions_MgCO2e: rows.map(r => r.gfw_gross_emissions_co2e_all_gases__Mg || 0),
    },
    updatedAt: extractApiUpdatedAt(body, res),
  };
}

// =============================================
// API 2: GNW ANALYTICS API
// (from utils/gnw-data-request.js)
// =============================================
async function triggerGNWAnalyticsJob(geojson) {
  const payload = {
    aoi: {
      type: 'feature_collection',
      feature_collection: geojson,
    },
    // ≥30 % canopy cover in 2000, like the GFW Data API query above, so both give 2001–2024.
    // (forest_filter 'natural_forest' is a 2020 snapshot: GNW only allows it for 2021 onwards.)
    start_year: '2001',
    end_year: '2024',
    canopy_cover: 30,
    intersections: [],
  };

  const res = await fetch(`${APIS.GNW_ANALYTICS}/v0/land_change/tree_cover_loss/analytics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`GNW Analytics POST failed: ${res.status}`);
  const data = await res.json();
  const link = data?.data?.link;
  if (!link) throw new Error('No resource link in GNW response');
  return link.split('/').pop();
}

async function pollGNWAnalyticsJob(resourceId) {
  const maxWait = 35000;
  let waited = 0;
  while (waited < maxWait) {
    const res = await fetch(`${APIS.GNW_ANALYTICS}/v0/land_change/tree_cover_loss/analytics/${resourceId}`);
    if (!res.ok) throw new Error(`GNW poll failed: ${res.status}`);
    const body = await res.json();
    const jobData = body?.data || body;
    const status = jobData?.status;
    if (status === 'saved' || status === 'success') return jobData;
    if (status === 'failed') throw new Error('GNW analytics job failed');
    const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10) * 1000;
    await delay(retryAfter);
    waited += retryAfter;
  }
  throw new Error('GNW analytics job timed out');
}

// =============================================
// FORMAT RESPONSE (mirrors gnw-data-request.js formatLegacyResponse)
// =============================================
function formatAnalyticsResponse(data) {
  const result = data?.result || data;
  const years      = result?.tree_cover_loss_year || [];
  const areaHa     = result?.area_ha || [];
  const emissions  = result?.carbon_emissions_MgCO2e || [];

  // Sum per year: Global Nature Watch returns one row per forest class (natural / non-natural /
  // unknown) for each year, the GFW Data API one row per year.
  const byYear = new Map();
  years.forEach((year, i) => {
    const r = byYear.get(year) || { year, ha: 0, emissions: 0 };
    r.ha += Number(areaHa[i]) || 0;
    r.emissions += Number(emissions[i]) || 0;
    byYear.set(year, r);
  });
  const rows = [...byYear.values()].sort((a, b) => a.year - b.year);

  const totalHa        = rows.reduce((s, r) => s + r.ha, 0);
  const totalEmissions = rows.reduce((s, r) => s + r.emissions, 0);
  const treesNeeded    = calculateTreesNeeded(totalEmissions, totalHa);

  return { rows, totalHa, totalEmissions, treesNeeded, updatedAt: data?.updatedAt || null };
}

// =============================================
// SEVERITY ENGINE
// =============================================
// Rated on the annual deforestation rate: the share of the year-2000 forest (≥30 % canopy) lost
// per year, compound form (Puyravaud 2003): r = 100 / t × ln(A2000 / (A2000 − loss)).
//   Low < 0.3 %/yr · Mid 0.3–1.0 · High 1.0–2.0 · Very high > 2.0
const LOSS_FIRST_YEAR = 2001;
const RATE_LEVELS = [
  { above: 2.0, level: 'VERY HIGH DEFORESTATION', color: 'red', icon: '🔴',
    desc: 'Forest is disappearing faster than 2 % a year. Immediate intervention required to prevent further ecosystem collapse.' },
  { above: 1.0, level: 'HIGH DEFORESTATION', color: 'orange', icon: '🟠',
    desc: 'Forest is being lost at 1–2 % a year. Protection and targeted reforestation are urgently needed.' },
  { above: 0.3, level: 'MID DEFORESTATION', color: 'yellow', icon: '🟡',
    desc: 'Forest is being lost at 0.3–1 % a year. Monitoring and reforestation recommended.' },
  { above: -Infinity, level: 'LOW DEFORESTATION', color: 'green', icon: '🟢',
    desc: 'Forest loss is below 0.3 % a year. This area appears well-preserved; keep monitoring.' },
];
const MIN_FOREST_HA = 10; // less tree cover than this in 2000: a rate would be meaningless

/** % of the year-2000 forest lost per year, or null when the forest area is unknown or ~0. */
function annualDeforestationRate({ rows = [], totalHa = 0, forestHa2000 } = {}) {
  if (!(forestHa2000 >= MIN_FOREST_HA)) return null;
  // Both loss sources cover 2001–2024; years without loss may be missing from the rows
  const lastYear = Math.max(2024, ...rows.map(r => r.year));
  const years = lastYear - LOSS_FIRST_YEAR + 1;
  // Pixel-counted forest can come out a little below the loss total: keep the log finite
  const remaining = Math.max(forestHa2000 - totalHa, forestHa2000 * 0.01);
  return (100 / years) * Math.log(forestHa2000 / remaining);
}

/** @param {object} data — formatAnalyticsResponse() result plus forestHa2000 / areaKm2 */
function getSeverityLevel(data) {
  const rate = annualDeforestationRate(data);
  if (rate !== null) {
    const band = RATE_LEVELS.find(b => rate > b.above);
    return { ...band, rate };
  }
  if (data?.forestHa2000 != null && data.forestHa2000 < MIN_FOREST_HA) return {
    level: 'NO FOREST TO RATE',
    color: 'green',
    icon: '🟢',
    rate: null,
    desc: 'There was almost no tree cover (≥30 % canopy) here in 2000, so a deforestation rate cannot be measured.',
  };
  return ratingByHectares(data?.totalHa || 0, data?.areaKm2);
}

// Fallback, only when the forest area could not be loaded: the old hectare rule. Thresholds are for
// the default 20 × 20 km box (10 km radius, 400 km²); other box sizes are scaled to it.
function ratingByHectares(totalHa, areaKm2 = 400) {
  const note = ' (Rated by hectares lost: forest area unavailable.)';
  const level = ratingByHectaresBase(totalHa * (400 / Math.max(1, areaKm2)));
  return { ...level, rate: null, desc: level.desc + note };
}

function ratingByHectaresBase(totalHa) {
  if (totalHa > 100) return {
    level: 'VERY HIGH DEFORESTATION',
    color: 'red',
    icon: '🔴',
    desc: 'Critical deforestation detected. Immediate intervention required to prevent further ecosystem collapse.',
  };
  if (totalHa > 10) return {
    level: 'MODERATE DEFORESTATION',
    color: 'orange',
    icon: '🟠',
    desc: 'Significant tree cover loss identified. Monitoring and targeted reforestation recommended.',
  };
  if (totalHa > 1) return {
    level: 'LOW DEFORESTATION',
    color: 'yellow',
    icon: '🟡',
    desc: 'Minor deforestation detected. Area should be monitored for future changes.',
  };
  return {
    level: 'NEGLIGIBLE DEFORESTATION',
    color: 'green',
    icon: '🟢',
    desc: 'Little to no deforestation detected. This area appears well-preserved.',
  };
}

// A growing tree absorbs ~0.021 t CO2 a year, ~0.84 t over ~40 years; ~60 % of seedlings survive.
// Planting goal = enough seedlings to re-absorb the emitted CO2 over 40 years, or to replant the
// cleared area at 400 trees/ha, whichever is larger. (The old formula divided by ONE year's uptake.)
const CO2_PER_TREE_T = 0.021 * 40;
const SEEDLING_SURVIVAL = 0.6;
function calculateTreesNeeded(totalEmissions, totalHa) {
  const offsetGoal = Math.ceil(totalEmissions / CO2_PER_TREE_T / SEEDLING_SURVIVAL);
  const replantGoal = Math.ceil(totalHa * 400);
  return Math.max(offsetGoal, replantGoal);
}

// =============================================
// RENDER DEFORESTATION RESULTS
// @param {string} source — 'real' | 'simulate'  (controls badge text)
// =============================================
function renderDeforestationResults(lat, lng, locationName, data, source) {
  const { rows, totalHa, totalEmissions, treesNeeded } = data;
  const severity = getSeverityLevel(data);

  $resultLocationName.textContent = `📍 ${locationName}`;

  // Show data origin badge
  if (source === 'real') {
    $apiUpdated.textContent = data.updatedAt
      ? `🟢 Live API data — updated ${formatDate(data.updatedAt)}`
      : '🟢 Live API data';
    $apiUpdated.style.color = 'rgba(0, 230, 118, 0.7)';
  } else {
    $apiUpdated.textContent = '🔵 Simulated biome estimate';
    $apiUpdated.style.color = 'rgba(66, 165, 245, 0.7)';
  }

  $severityCard.className = `severity-card ${severity.color}`;
  $severityIcon.textContent = severity.icon;
  $severityLevel.textContent = severity.level;
  $severityDesc.textContent = severity.desc;
  renderSeverityRate(severity, data);
  window.ForestTreeko?.setSeverity(severity.color); // [treeko] picture follows the result; no-op if treeko.js is missing

  $statHa.textContent    = formatNumber(totalHa, 1);
  $statCo2.textContent   = formatNumber(totalEmissions, 0);
  const minYear = rows.length ? rows[0].year : '—';
  const maxYear = rows.length ? rows[rows.length - 1].year : '—';
  $statYears.textContent = `${minYear}–${maxYear}`;
  $statTrees.textContent = formatCompact(treesNeeded);

  renderBarChart(rows, severity.color);
  renderTreeLossColorForm(lat, lng, rows);

  $plantingNumber.textContent = formatNumber(treesNeeded, 0);

  placeMarker(lat, lng, severity);

  $loadingState.classList.add('hidden');
  $resultContent.classList.remove('hidden');
}

/** The rate behind the rating, the forest it is measured against, and the scale. */
function renderSeverityRate(severity, data) {
  const $rate = $('severity-rate');
  if (!$rate) return;
  const scale = RATE_LEVELS.slice().reverse().map(b => {
    const range = { green: '< 0.3', yellow: '0.3–1', orange: '1–2', red: '> 2' }[b.color];
    return `<span class="rate-step ${b.color}${b.color === severity.color ? ' active' : ''}">${range}</span>`;
  }).join('');
  if (severity.rate === null) {
    $rate.innerHTML = data.forestHa2000 != null
      ? `Tree cover in 2000: <strong>${formatNumber(data.forestHa2000, 0)} ha</strong> (${data.forestCoverPct} % of the box)`
      : 'Annual rate unavailable: the forest area did not load.';
    return;
  }
  $rate.innerHTML = `
    <div class="rate-line">Annual deforestation rate <strong>${severity.rate.toFixed(2)} %/yr</strong></div>
    <div class="rate-scale" aria-label="Scale in % per year: low, mid, high, very high">${scale}</div>
    <div class="rate-base">${formatNumber(data.totalHa, 0)} ha lost of ${formatNumber(data.forestHa2000, 0)} ha tree cover in 2000
      (${data.forestCoverPct} % of the box, ≥30 % canopy), ${LOSS_FIRST_YEAR}–${Math.max(2024, ...data.rows.map(r => r.year))}.</div>`;
}

// =============================================
// BAR CHART
// =============================================
function renderBarChart(rows, color) {
  $barChart.innerHTML = '';
  const maxHa = Math.max(...rows.map(r => r.ha), 0.01);
  // 2001–2024 is 24 bars: too many for a label on each, so thin bars, a year label every 5 years
  // (and the first / last), values on hover
  const dense = rows.length > 12;
  $barChart.classList.toggle('dense', dense);
  rows.forEach((row, i) => {
    const pct = Math.max((row.ha / maxHa) * 100, 2);
    const item = document.createElement('div');
    item.className = 'bar-item';
    const valLabel = document.createElement('div');
    valLabel.className = 'bar-label-val';
    valLabel.textContent = row.ha > 0 ? formatNumber(row.ha, 1) : '0';
    const fill = document.createElement('div');
    fill.className = `bar-fill ${color}`;
    fill.style.height = '0%';
    fill.title = `${row.year}: ${row.ha.toFixed(2)} ha`;
    item.title = fill.title; // the whole column, so thin bars are easy to hover
    const yearLabel = document.createElement('div');
    yearLabel.className = 'bar-label-year';
    const labelled = !dense || i === 0 || i === rows.length - 1 || row.year % 5 === 0;
    yearLabel.textContent = labelled ? row.year : '';
    item.appendChild(valLabel);
    item.appendChild(fill);
    item.appendChild(yearLabel);
    $barChart.appendChild(item);
    setTimeout(() => { fill.style.height = `${pct}%`; }, 100);
  });
}

function renderTreeLossColorForm(lat, lng, rows) {
  latestLossRows = rows;
  latestLossCenter = { lat, lng };
  treeLossColorLayer.clearLayers();
  window.ForestHeatmap?.refresh(); // [heatmap] keep heatmap in sync after a new analysis
  const maxHa = Math.max(...rows.map(row => row.ha), 0);
  if (maxHa < 0.1) return;

  const radiusKm = parseInt($radiusInput.value, 10) || 10;
  const totalHa = rows.reduce((sum, row) => sum + row.ha, 0);
  const intensity = Math.min(Math.max(totalHa / 160, 0.18), 1);
  const centerRadius = Math.max(700, radiusKm * 230 * intensity);
  const midRadius = Math.max(centerRadius * 1.9, radiusKm * 430);
  const outerRadius = Math.max(midRadius * 1.65, radiusKm * 780);

  L.circle([lat, lng], {
    radius: outerRadius,
    stroke: false,
    fillColor: '#ffd166',
    fillOpacity: 0.06,
  }).bindTooltip(`Analysed area (~${radiusKm} km)`).addTo(treeLossColorLayer);

  L.circle([lat, lng], {
    radius: midRadius,
    stroke: false,
    fillColor: '#ff9800',
    fillOpacity: 0.08 + intensity * 0.05,
  }).bindTooltip(`Analysis: ${totalHa.toFixed(1)} ha lost in total`).addTo(treeLossColorLayer);

  L.circle([lat, lng], {
    radius: centerRadius,
    stroke: false,
    fillColor: '#f44336',
    fillOpacity: 0.12 + intensity * 0.1,
  }).bindTooltip('Analysed point (ring size reflects total loss, not exact locations)').addTo(treeLossColorLayer);

  // (Per-year circles used to be drawn at invented positions around the centre; the real loss
  // pattern is now shown by the colour-form tile layer from heatmap.js, so they are gone.)
  syncTreeLossLayer();
}

function getTreeLossMode() {
  return $treeLossMode?.value || 'dots';
}

function syncTreeLossLayer() {
  const enabled = $('toggle-tree-loss')?.checked ?? true;
  map.removeLayer(treeLossLayer);
  map.removeLayer(treeLossColorLayer);
  window.ForestHeatmap?.refresh(); // [heatmap] shows/hides itself from mode + toggle
  window.ForestGlobeLayers?.refresh(); // [globe-layers] Dot/Colour form on the 3D Earth
  window.ForestReplay?.refresh(); // [loss-replay] shows/hides itself from mode + toggle
  if (!enabled) return;
  if (getTreeLossMode() === 'heatmap') return; // [heatmap] no tile/colour layer in this mode
  if (getTreeLossMode() === 'replay') return; // [loss-replay] draws its own year-by-year layer

  if (getTreeLossMode() === 'color') {
    if (!treeLossColorLayer.getLayers().length && latestLossCenter && latestLossRows.length) {
      renderTreeLossColorForm(latestLossCenter.lat, latestLossCenter.lng, latestLossRows);
    }
    if (treeLossColorLayer.getLayers().length) map.addLayer(treeLossColorLayer);
    return;
  }

  map.addLayer(treeLossLayer);
}

// =============================================
// MAP MARKER
// =============================================
function placeMarker(lat, lng, severity) {
  if (currentMarker) map.removeLayer(currentMarker);
  const icon = L.divIcon({
    className: '',
    html: `<div class="custom-marker ${severity.color}"></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 40],
  });
  currentMarker = L.marker([lat, lng], { icon })
    .addTo(map)
    .bindPopup(`
      <div style="padding:4px 0">
        <strong style="font-size:14px">${severity.icon} ${severity.level}</strong><br/>
        <span style="font-size:11px;color:rgba(232,240,254,0.6)">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
      </div>
    `, { maxWidth: 220 });
}

// =============================================
// CLIMATE ENGINE (Open-Meteo — free, no API key)
// =============================================
async function fetchAndRenderClimate(lat, lng, totalHa) {
  try {
    const url = `${APIS.OPEN_METEO}/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    const c = data.current;

    const temp     = c.temperature_2m;
    const humidity = c.relative_humidity_2m;
    const precip   = c.precipitation;
    const wind     = c.wind_speed_10m;

    $cvTemp.textContent     = `${temp}°`;
    $cvHumidity.textContent = `${humidity}%`;
    $cvPrecip.textContent   = `${precip}`;
    $cvWind.textContent     = `${wind}`;

    $cbTemp.style.width     = `${Math.min(Math.max(((temp + 20) / 70) * 100, 0), 100)}%`;
    $cbHumidity.style.width = `${humidity}%`;
    $cbPrecip.style.width   = `${Math.min(precip * 10, 100)}%`;
    $cbWind.style.width     = `${Math.min(wind / 150 * 100, 100)}%`;

    renderGlobalWarmingIndicator(temp, humidity, totalHa);

    $climatePlaceholder.classList.add('hidden');
    $climateContent.classList.remove('hidden');
  } catch (err) {
    console.warn('Climate fetch failed:', err.message);
    $climatePlaceholder.innerHTML = '<p style="color:rgba(232,240,254,0.3);font-size:12px">Climate data unavailable</p>';
  }
}

function renderGlobalWarmingIndicator(temp, humidity, totalHa) {
  const tempScore      = Math.max(0, (temp - 15) / 40);
  const humidityScore  = Math.max(0, (100 - humidity) / 100);
  const deforestScore  = Math.min(totalHa / 200, 1);
  const composite      = (tempScore * 0.4 + humidityScore * 0.3 + deforestScore * 0.3);
  const gaugePos       = Math.max(5, Math.min(composite * 100, 95));

  $gwGaugeFill.style.left = `${gaugePos}%`;

  let label, desc, color;
  if (composite < 0.25) {
    label = '🟢 Low Risk'; color = '#00e676';
    desc = 'Environmental conditions appear stable. Minimal indicators of climate stress or deforestation-driven warming.';
  } else if (composite < 0.5) {
    label = '🟡 Moderate Risk'; color = '#ffeb3b';
    desc = 'Some warming indicators detected. Temperature and humidity levels suggest early signs of climate stress.';
  } else if (composite < 0.75) {
    label = '🟠 High Risk'; color = '#ff9800';
    desc = 'Significant warming indicators. High temperature, reduced humidity, and notable deforestation suggest elevated climate impact.';
  } else {
    label = '🔴 Critical Risk'; color = '#f44336';
    desc = 'Severe environmental stress detected. This area shows strong indicators of deforestation-driven climate change and requires urgent action.';
  }

  $gwLabel.textContent = label;
  $gwLabel.style.color = color;
  $gwDescription.textContent = desc;
}

// =============================================
// UI STATE HELPERS
// =============================================
function showLoading() {
  $resultPlaceholder.classList.add('hidden');
  $resultContent.classList.add('hidden');
  $errorState.classList.add('hidden');
  $loadingState.classList.remove('hidden');
  $analyzeBtn.disabled = true;
  resetSteps();
}

function showError(message) {
  $loadingState.classList.add('hidden');
  $resultContent.classList.add('hidden');
  $resultPlaceholder.classList.add('hidden');
  $errorState.classList.remove('hidden');
  $errorMessage.textContent = message;
  $analyzeBtn.disabled = false;
}

function setStatus(type, text) {
  $statusText.textContent = text;
  $statusDot.className = 'status-dot';
  if (type === 'loading') $statusDot.classList.add('loading');
  if (type === 'error')   $statusDot.classList.add('error');
}

function setStep(index) {
  $steps.forEach((step, i) => {
    step.classList.remove('active', 'done');
    if (i < index) step.classList.add('done');
    if (i === index) step.classList.add('active');
  });
}

function resetSteps() { $steps.forEach(s => s.classList.remove('active', 'done')); }

/**
 * Clear visual UI layers and active location pointer.
 * Caches (apiCache / simCache) are preserved so the user
 * can toggle back or revisit a previous location.
 */
function clearMapLayers() {
  if (currentMarker)  { map.removeLayer(currentMarker);  currentMarker  = null; }
  if (currentPolygon) { map.removeLayer(currentPolygon); currentPolygon = null; }
  latestLossRows = [];
  latestLossCenter = null;
  treeLossColorLayer.clearLayers();
  window.ForestHeatmap?.refresh(); // [heatmap] keep heatmap in sync when layers are cleared
  window.ForestGlobeLayers?.refresh(); // [globe-layers] keep 3D Earth layers in sync when cleared
  window.ForestReplay?.refresh(); // [loss-replay] analysed-area hectares are gone too
  // NOTE: appState.apiCache and appState.simCache intentionally NOT cleared.
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatNumber(n, decimals = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function formatCompact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function initGlobe() {
  if (globeScene || typeof THREE === 'undefined') return;
  const width = $globeContainer.clientWidth || window.innerWidth;
  const height = $globeContainer.clientHeight || window.innerHeight;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 100);
  camera.position.z = 3.1;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  $globeContainer.appendChild(renderer.domElement);

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.MeshPhongMaterial({
      map: new THREE.TextureLoader().load('https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg'),
      specular: new THREE.Color('#1a1a1a'), // [colours] neutral shine (was bluish '#223344')
      shininess: 12,
    })
  );
  scene.add(earth);
  earth.material.map.colorSpace = THREE.SRGBColorSpace; // [colours] the texture is sRGB; untagged it renders washed out
  scene.add(new THREE.AmbientLight('#ffffff', 1.4)); // [colours] neutral (was bluish '#7c93ad')
  const sunlight = new THREE.DirectionalLight('#ffffff', 2.35); // [colours] neutral (was '#fff1d2', 2.2): globe centre = 2D colours
  sunlight.position.set(4, 2, 5);
  scene.add(sunlight);
  globeScene = {
    scene,
    camera,
    renderer,
    earth,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    isDragging: false,
    dragMoved: false,
    lastPointer: { x: 0, y: 0 },
    autoRotate: true,
  };
  bindGlobeControls();
  // Render loop runs while the globe is on screen OR a 2D↔3D animation is playing (the wrap /
  // unwrap animation advances inside this loop), and only while this app is visible. Otherwise
  // it stops (it used to redraw 60×/s forever, even hidden) and resumeGlobe() restarts it.
  const animate = () => {
    if (!globeScene) return;
    if (!globeNeeded()) { globeScene.paused = true; return; }
    if (globeScene.autoRotate && !globeScene.isDragging) earth.rotation.y += 0.0015;
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };
  globeScene.animate = animate;
  animate();
}

function globeNeeded() {
  return !appHidden && (!!globeToggle?.checked || !!window.ForestGlobeTransition?.isRunning?.());
}

function resumeGlobe() {
  if (globeScene?.paused && globeNeeded()) {
    globeScene.paused = false;
    globeScene.animate();
  }
}

// The Earth Intelligence shell tells this app when it is hidden behind River Eyes
let appHidden = false;
window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.data?.type !== 'app-visibility') return;
  appHidden = !e.data.visible;
  if (!appHidden) resumeGlobe();
});

function resizeGlobe() {
  if (!globeScene) return;
  const width = $globeContainer.clientWidth || window.innerWidth;
  const height = $globeContainer.clientHeight || window.innerHeight;
  globeScene.camera.aspect = width / height;
  globeScene.camera.updateProjectionMatrix();
  const size = globeScene.renderer.getSize(new THREE.Vector2());
  if (size.x === width && size.y === height) return; // resizing reallocates the canvas (~10 ms per 2D→3D switch)
  globeScene.renderer.setSize(width, height);
}

window.addEventListener('resize', resizeGlobe);

function bindGlobeControls() {
  if (!globeScene) return;
  const canvas = globeScene.renderer.domElement;

  canvas.addEventListener('pointerdown', (event) => {
    globeScene.isDragging = true;
    globeScene.dragMoved = false;
    globeScene.lastPointer = { x: event.clientX, y: event.clientY };
    $globeContainer.classList.add('is-dragging');
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!globeScene?.isDragging) return;
    const dx = event.clientX - globeScene.lastPointer.x;
    const dy = event.clientY - globeScene.lastPointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) globeScene.dragMoved = true;
    globeScene.earth.rotation.y += dx * 0.006;
    globeScene.earth.rotation.x = clamp(globeScene.earth.rotation.x + dy * 0.004, -1.2, 1.2);
    globeScene.lastPointer = { x: event.clientX, y: event.clientY };
  });

  canvas.addEventListener('pointerup', (event) => {
    if (!globeScene) return;
    canvas.releasePointerCapture?.(event.pointerId);
    $globeContainer.classList.remove('is-dragging');
    const shouldPick = !globeScene.dragMoved;
    globeScene.isDragging = false;
    if (shouldPick) pickGlobeCoordinates(event);
  });

  canvas.addEventListener('pointercancel', () => {
    if (!globeScene) return;
    globeScene.isDragging = false;
    $globeContainer.classList.remove('is-dragging');
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomGlobe(event.deltaY > 0 ? 0.22 : -0.22);
  }, { passive: false });

  $('globe-zoom-in')?.addEventListener('click', () => zoomGlobe(-0.28));
  $('globe-zoom-out')?.addEventListener('click', () => zoomGlobe(0.28));
  $('globe-reset')?.addEventListener('click', resetGlobeView);
  $('globe-spin')?.addEventListener('click', toggleGlobeSpin);
}

function zoomGlobe(delta) {
  if (!globeScene) return;
  globeScene.camera.position.z = clamp(globeScene.camera.position.z + delta, 1.65, 5.4);
}

function resetGlobeView() {
  if (!globeScene) return;
  globeScene.camera.position.z = 3.1;
  globeScene.earth.rotation.set(0, 0, 0);
  globeScene.autoRotate = true;
  updateGlobeSpinButton();
}

function toggleGlobeSpin() {
  if (!globeScene) return;
  globeScene.autoRotate = !globeScene.autoRotate;
  updateGlobeSpinButton();
}

function updateGlobeSpinButton() {
  const spinButton = $('globe-spin');
  if (!spinButton || !globeScene) return;
  spinButton.setAttribute('aria-pressed', String(globeScene.autoRotate));
}

function pickGlobeCoordinates(event) {
  if (!globeScene) return;
  const rect = globeScene.renderer.domElement.getBoundingClientRect();
  globeScene.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  globeScene.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  globeScene.raycaster.setFromCamera(globeScene.pointer, globeScene.camera);
  const hit = globeScene.raycaster.intersectObject(globeScene.earth)[0];
  if (!hit) return;

  const localPoint = globeScene.earth.worldToLocal(hit.point.clone()).normalize();
  const lat = THREE.MathUtils.radToDeg(Math.asin(localPoint.y));
  const phi = Math.atan2(localPoint.z, -localPoint.x);
  const lng = normalizeLng(THREE.MathUtils.radToDeg(phi) - 180);

  $latInput.value = lat.toFixed(6);
  $lngInput.value = lng.toFixed(6);
  lastName = null;
  $locationSearch.value = '';
  updatePrefixes();
  setStatus('ready', `3D Earth selected ${lat.toFixed(4)}, ${lng.toFixed(4)} — click Analyze`);
}

function focusGlobeOnCoordinates(lat, lng) {
  if (!globeScene || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const phi = THREE.MathUtils.degToRad(normalizeLng(lng) + 180);
  const theta = THREE.MathUtils.degToRad(90 - lat);
  const point = new THREE.Vector3(
    -Math.cos(phi) * Math.sin(theta),
    Math.cos(theta),
    Math.sin(phi) * Math.sin(theta)
  );
  globeScene.earth.rotation.y = -Math.atan2(point.x, point.z);
  globeScene.earth.rotation.x = Math.asin(point.y) * 0.45;
}

function normalizeLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// =============================================
// INIT
// =============================================
setStatus('ready', 'Ready to Analyze');
$analyzeBtn.disabled = false;
renderRecentSearches();

// Re-enable button when results show
const analyzeObserver = new MutationObserver(() => {
  if (!$resultContent.classList.contains('hidden') || !$errorState.classList.contains('hidden')) {
    $analyzeBtn.disabled = false;
  }
});
analyzeObserver.observe($resultContent, { attributes: true });
analyzeObserver.observe($errorState, { attributes: true });

console.log('%c🌳 Forest Eyes loaded', 'color:#00e676;font-size:14px;font-weight:bold');
console.log('%c APIs wired from wri/gfw repo:', 'color:#42a5f5');
console.log('   1. GFW Data API    → data-api.globalforestwatch.org');
console.log('   2. Resource Watch  → api.resourcewatch.org');
console.log('   3. GNW Analytics   → analytics.globalnaturewatch.org');
console.log('   4. Climate Watch   → climatewatchdata.org');
console.log('   5. Open-Meteo      → api.open-meteo.com');
console.log('   6. Nominatim (OSM) → nominatim.openstreetmap.org');



// =============================================
// COORDINATE PREFIXES & SEARCH
// =============================================
function updatePrefixes() {
  const lat = parseFloat($latInput.value);
  const lng = parseFloat($lngInput.value);
  
  const latPrefix = document.getElementById('lat-prefix');
  if (latPrefix) {
    if (!isNaN(lat)) {
      latPrefix.textContent = lat >= 0 ? 'N' : 'S';
    } else {
      latPrefix.textContent = 'N/S';
    }
  }
  
  const lngPrefix = document.getElementById('lng-prefix');
  if (lngPrefix) {
    if (!isNaN(lng)) {
      lngPrefix.textContent = lng >= 0 ? 'E' : 'W';
    } else {
      lngPrefix.textContent = 'E/W';
    }
  }
}

$latInput.addEventListener('input', updatePrefixes);
$lngInput.addEventListener('input', updatePrefixes);
// Typed coordinates are a new place: drop the searched name (else the analysis keeps the old label)
[$latInput, $lngInput].forEach(el => el.addEventListener('input', () => {
  lastName = null;
  $locationSearch.value = '';
}));

const coordsSearchBtn = document.getElementById('coords-search-btn');
if (coordsSearchBtn) {
  coordsSearchBtn.addEventListener('click', () => {
    $analyzeBtn.click();
  });
}
