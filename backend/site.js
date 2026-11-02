/**
 * Earth Intelligence Platform — site ground conditions (site.js)
 * ==============================================================
 * POST /api/v1/site { lat, lon }
 *
 * Real, global data for a point on (or near) a river:
 *   - river snap + mean flow            HydroRIVERS (HydroSHEDS)
 *   - flow now vs. normal               GloFAS v4 via Open-Meteo Flood API
 *   - soil profile (0-30 cm)            ISRIC SoilGrids 2.0
 *   - earthquakes M5+ within 150 km     USGS ComCat (since 1970)
 * Values that no global dataset provides (bearing capacity, depth to bedrock) are NOT
 * estimated: the UI says they need a site investigation.
 */
'use strict';

const hazard = require('./hazard.js');
const soilIndia = require('./soil.js');

const SOILGRIDS = 'https://rest.isric.org/soilgrids/v2.0';
const SOIL_PROPS = ['clay', 'sand', 'silt', 'cfvo', 'bdod', 'soc', 'phh2o'];
const SOIL_DEPTHS = ['0-5cm', '5-15cm', '15-30cm'];
const QUAKE_RADIUS_KM = 150;
const QUAKE_MIN_MAG = 5;

const soilCache = new Map();
const quakeCache = new Map();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function getJson(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Mean of the top 30 cm (depth-weighted), in real units. */
async function soil(lat, lon) {
  // India: instant lookup from the local SoilGrids grid (nearest soil cell for towns and rivers)
  if (soilIndia.inside(lat, lon)) {
    const s = soilIndia.lookup(lat, lon, 8);
    return s ? { ...s, wrbGroup: null, wrbTop: [] } : { hasData: false };
  }
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!soilCache.has(key)) {
    const q = new URLSearchParams({ lon: String(lon), lat: String(lat), value: 'mean' });
    SOIL_PROPS.forEach(p => q.append('property', p));
    SOIL_DEPTHS.forEach(d => q.append('depth', d));
    const job = Promise.all([
      getJson(`${SOILGRIDS}/properties/query?${q}`, 30000),
      getJson(`${SOILGRIDS}/classification/query?lon=${lon}&lat=${lat}&number_classes=3`, 30000).catch(() => null),
    ]).then(([props, cls]) => {
      const out = {};
      const weights = { '0-5cm': 5, '5-15cm': 10, '15-30cm': 15 };
      for (const layer of props?.properties?.layers || []) {
        const f = Number(layer.unit_measure?.d_factor) || 1;
        let sum = 0, w = 0;
        for (const d of layer.depths || []) {
          const v = d?.values?.mean;
          if (v === null || v === undefined) continue;
          sum += (v / f) * weights[d.label]; w += weights[d.label];
        }
        if (w) out[layer.name] = +(sum / w).toFixed(layer.name === 'bdod' ? 2 : 1);
      }
      if (!Object.keys(out).length) return { hasData: false };
      return {
        hasData: true,
        wrbGroup: cls?.wrb_class_name || null,
        wrbTop: (cls?.wrb_class_probability || []).slice(0, 3).map(([name, p]) => ({ name, probability: p })),
        clayPct: out.clay ?? null,                  // SoilGrids: g/kg → %, via d_factor (10)
        sandPct: out.sand ?? null,
        siltPct: out.silt ?? null,
        coarseFragmentsPct: out.cfvo ?? null,       // cm3/dm3 → vol % (d_factor 10)
        bulkDensity: out.bdod ?? null,              // kg/dm3
        organicCarbonGkg: out.soc ?? null,          // g/kg
        pH: out.phh2o ?? null,                      // pH × 10 → pH (d_factor 10)
        textureClass: soilIndia.textureClass(out.clay, out.silt, out.sand),
      };
    });
    job.catch(() => soilCache.delete(key));
    soilCache.set(key, job);
  }
  return soilCache.get(key);
}

async function earthquakes(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (!quakeCache.has(key)) {
    const base = 'https://earthquake.usgs.gov/fdsnws/event/1/';
    const q = `format=geojson&latitude=${lat}&longitude=${lon}&maxradiuskm=${QUAKE_RADIUS_KM}` +
      `&minmagnitude=${QUAKE_MIN_MAG}&starttime=1970-01-01`;
    // One request (all events, strongest first) instead of count + list; retried once if USGS is slow
    const fetchList = () => getJson(`${base}query?${q}&orderby=magnitude&limit=500`, 25000);
    const job = fetchList().catch(() => new Promise(r => setTimeout(r, 1500)).then(fetchList)).then(all => ({
      count: (all.features || []).length,
      radiusKm: QUAKE_RADIUS_KM,
      minMagnitude: QUAKE_MIN_MAG,
      since: 1970,
      strongest: (all.features || []).slice(0, 5).map(f => ({
        magnitude: f.properties.mag,
        place: String(f.properties.place || '').normalize('NFC'),
        date: new Date(f.properties.time).toISOString().slice(0, 10),
      })),
    }));
    job.catch(() => quakeCache.delete(key));
    quakeCache.set(key, job);
  }
  return quakeCache.get(key);
}

async function assess({ lat, lon }) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw httpError(400, 'Valid lat and lon are required.');
  }
  const point = [lat, lon];
  const settle = (p, label) => p.then(v => v, err => { console.warn(`[site] ${label} unavailable:`, err.message); return null; });
  const [soilData, quakes] = await Promise.all([
    settle(soil(point[0], point[1]), 'soil'),
    settle(earthquakes(point[0], point[1]), 'earthquakes'),
  ]);

  return {
    point,
    river: null,
    flow: null,
    soil: soilData,
    earthquakes: quakes,
    notAvailable: [
      'Bearing capacity and depth to bedrock: no reliable global dataset; needs boreholes and lab tests.',
      'Official seismic zoning (e.g. IS 1893, Eurocode 8): check the national code for this country.',
    ],
    sources: [
      soilIndia.inside(point[0], point[1]) ? 'ISRIC SoilGrids 2.0 (India grid, ~2 km, top 30 cm)' : 'ISRIC SoilGrids 2.0 (modelled, 250 m, top 30 cm)',
      `USGS ComCat earthquakes M${QUAKE_MIN_MAG}+ within ${QUAKE_RADIUS_KM} km since 1970`,
    ],
  };
}

module.exports = { assess, soil };
