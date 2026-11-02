/**
 * Exports the REAL data the platform uses, for the demo places, as CSV files in datasets/.
 *
 *   node scripts/export-datasets.js
 *
 * Nothing here is invented: every row comes from a public dataset or API, and
 * datasets/README.md records the source, licence and retrieval time of each file.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'datasets');

const PLACES = [
  { id: 'joshimath', name: 'Joshimath, Chamoli (India)', lat: 30.555, lon: 79.565 },
  { id: 'uttarkashi', name: 'Uttarkashi, Bhagirathi (India)', lat: 30.73, lon: 78.44 },
  { id: 'manaus', name: 'Amazon near Manaus (Brazil)', lat: -3.13, lon: -59.95 },
  { id: 'cologne', name: 'Rhine at Cologne (Germany)', lat: 50.94, lon: 6.96 },
  { id: 'derna', name: 'Derna (Libya)', lat: 32.76, lon: 22.64 },
  { id: 'sindh', name: 'Indus, Sindh (Pakistan)', lat: 26.2, lon: 68.37 },
];
const FOREST_RADIUS_KM = 10;

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function writeCsv(file, header, rows) {
  fs.writeFileSync(path.join(OUT, file), [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n');
  console.log(`  ${file}: ${rows.length} rows`);
  return rows.length;
}
async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoDay = t => new Date(t).toISOString().slice(0, 10);

// 1. Tree cover loss 2021-2024 (UMD/Hansen, natural forest) via Global Nature Watch analytics — no key
async function treeCoverLoss(p) {
  const dLat = FOREST_RADIUS_KM / 111, dLon = FOREST_RADIUS_KM / (111 * Math.cos(p.lat * Math.PI / 180));
  const fc = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', id: `export-${p.id}`, properties: {},
      geometry: { type: 'Polygon', coordinates: [[[p.lon - dLon, p.lat - dLat], [p.lon + dLon, p.lat - dLat], [p.lon + dLon, p.lat + dLat], [p.lon - dLon, p.lat + dLat], [p.lon - dLon, p.lat - dLat]]] },
    }],
  };
  const base = 'https://analytics.globalnaturewatch.org/v0/land_change/tree_cover_loss/analytics';
  const job = await getJson(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aoi: { type: 'feature_collection', feature_collection: fc }, start_year: '2021', end_year: '2024', forest_filter: 'natural_forest', intersections: [] }),
  });
  const id = job?.data?.link?.split('/').pop();
  if (!id) throw new Error('no job id');
  for (let i = 0; i < 30; i++) {
    const b = await getJson(`${base}/${id}`);
    const j = b?.data || b;
    if (j.status === 'saved' || j.status === 'success') return j.result || j;
    if (j.status === 'failed') throw new Error('job failed');
    await sleep(2000);
  }
  throw new Error('job timed out');
}

// 2. Daily river discharge, last 3 years + 14-day forecast (GloFAS v4 via Open-Meteo) — no key
async function riverFlow(p) {
  const now = Date.now();
  const j = await getJson('https://flood-api.open-meteo.com/v1/flood' +
    `?latitude=${p.lat}&longitude=${p.lon}&daily=river_discharge` +
    `&start_date=${isoDay(now - 3 * 365 * 864e5)}&end_date=${isoDay(now + 14 * 864e5)}`);
  return { cell: [j.latitude, j.longitude], time: j.daily.time, q: j.daily.river_discharge };
}

// 3. Earthquakes M5+ within 150 km since 1970 (USGS ComCat) — no key
async function earthquakes(p) {
  const j = await getJson('https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson' +
    `&latitude=${p.lat}&longitude=${p.lon}&maxradiuskm=150&minmagnitude=5&starttime=1970-01-01&orderby=time`);
  return j.features || [];
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const retrieved = new Date().toISOString();
  const counts = {};

  console.log('Tree cover loss (Global Nature Watch / UMD)…');
  const lossRows = [];
  const lossRaw = {};
  for (const p of PLACES) {
    try {
      const r = await treeCoverLoss(p);
      lossRaw[p.id] = r;
      // Result is column-oriented: { field: [values...] }. Write every column as given.
      const cols = Object.keys(r).filter(k => Array.isArray(r[k]));
      const n = cols.length ? r[cols[0]].length : 0;
      for (let i = 0; i < n; i++) lossRows.push([p.id, FOREST_RADIUS_KM, ...cols.map(c => r[c][i])]);
      lossRaw._cols = cols;
      console.log(`   ${p.id}: ${n} rows`);
    } catch (err) {
      console.warn(`   ${p.id}: unavailable (${err.message})`);
    }
  }
  if (lossRaw._cols) {
    counts.forest = writeCsv('tree_cover_loss_demo.csv', ['place', 'half_width_km', ...lossRaw._cols], lossRows);
  }

  console.log('River discharge (GloFAS via Open-Meteo)…');
  const flowRows = [];
  for (const p of PLACES) {
    try {
      const f = await riverFlow(p);
      f.time.forEach((t, i) => flowRows.push([p.id, f.cell[0], f.cell[1], t, f.q[i], t > isoDay(Date.now()) ? 'forecast' : 'reanalysis/nowcast']));
    } catch (err) { console.warn(`   ${p.id}: unavailable (${err.message})`); }
  }
  counts.flow = writeCsv('river_discharge_glofas_demo.csv', ['place', 'grid_lat', 'grid_lon', 'date', 'discharge_m3s', 'kind'], flowRows);

  console.log('Earthquakes (USGS)…');
  const eqRows = [];
  for (const p of PLACES) {
    try {
      for (const f of await earthquakes(p)) {
        const [lon, lat, depth] = f.geometry.coordinates;
        eqRows.push([p.id, new Date(f.properties.time).toISOString(), f.properties.mag, f.properties.magType, lat, lon, depth, f.properties.place, f.id]);
      }
    } catch (err) { console.warn(`   ${p.id}: unavailable (${err.message})`); }
  }
  counts.quakes = writeCsv('earthquakes_usgs_demo.csv', ['place', 'time_utc', 'magnitude', 'mag_type', 'lat', 'lon', 'depth_km', 'usgs_place', 'usgs_event_id'], eqRows);

  writeCsv('places.csv', ['place', 'name', 'lat', 'lon'], PLACES.map(p => [p.id, p.name, p.lat, p.lon]));

  fs.writeFileSync(path.join(OUT, 'README.md'), `# Datasets

Real data used by the Earth Intelligence Platform, exported for the demo places in \`places.csv\`.
Regenerate with \`node scripts/export-datasets.js\`. Retrieved: ${retrieved}.

The live app queries the same sources on demand for any place on Earth; these files are snapshots.

| File | Rows | Source | Licence / terms |
|---|---|---|---|
| \`tree_cover_loss_demo.csv\` | ${counts.forest ?? 'n/a'} | Tree cover loss 2021-2024, natural forest, ${FOREST_RADIUS_KM} km box (UMD / Hansen et al., via Global Nature Watch analytics API) | CC BY 4.0 |
| \`earthquakes_usgs_demo.csv\` | ${counts.quakes} | USGS ComCat earthquakes M5+ within 150 km since 1970 | Public domain |

Also used live (not exported): ISRIC SoilGrids 2.0 (CC BY 4.0), AWS Terrain Tiles (various open DEMs),
Esri World Imagery (attribution required), Open-Meteo weather (CC BY 4.0).

## Citations
- Lehner, B., Grill, G. (2013). Global river hydrography and network routing: baseline data and new approaches to study the world's large river systems. *Hydrological Processes*, 27(15), 2171-2186.
- Hansen, M. C. et al. (2013). High-resolution global maps of 21st-century forest cover change. *Science*, 342(6160), 850-853.
- Harrigan, S. et al. (2020). GloFAS-ERA5 operational global river discharge reanalysis 1979-present. *Earth System Science Data*, 12, 2043-2060.
- Poggio, L. et al. (2021). SoilGrids 2.0: producing soil information for the globe with quantified spatial uncertainty. *SOIL*, 7, 217-240.
`);
  console.log('  README.md written');
})();
