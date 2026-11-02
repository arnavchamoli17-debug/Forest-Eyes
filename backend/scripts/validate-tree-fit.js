/**
 * How often does the tree planner agree with reality? For test places, compares the trees the
 * app says "can grow" with the trees actually recorded within RADIUS_KM in GBIF (occurrence
 * records: herbarium specimens and observations).
 *
 * Reports RECALL: of the checked trees recorded near a place, the share the app accepts. A tree
 * recorded there and rejected by the app is a likely error (or a planted tree outside its range:
 * GBIF includes cultivated trees). Precision is not measured: a tree NOT recorded nearby is weak
 * evidence, because GBIF coverage is uneven (sparse in much of India).
 *
 * TUNED places were used to adjust two rules (frost for Kew-native trees, sunshine never failing);
 * HOLDOUT places were not looked at while tuning, so their recall is the fairer estimate.
 * Hill towns use a 10 km radius so records from valleys and plains far below do not count.
 * Uses the live data sources (same as the app): ~1 min per place.
 * Usage (from the project root):  node backend/scripts/validate-tree-fit.js [minRecords] [tuned|holdout|fresh]
 */
'use strict';

const trees = require('../trees.js');
const fit = require('../../frontend/forest-eyes/tree-fit.js');

const MIN_RECORDS = Number(process.argv[2]) || 3; // a tree counts as "recorded here" from this many records
const ONLY_SET = process.argv[3]; // run one set of places only (each place costs many Open-Meteo calls)
// [name, lat, lon, radius km, set]
const PLACES = [
  ['Dehradun', 30.3165, 78.0322, 30, 'tuned'], ['Shimla', 31.1048, 77.1734, 10, 'tuned'], ['Nainital', 29.3919, 79.4542, 10, 'tuned'],
  ['Delhi', 28.6139, 77.209, 30, 'tuned'], ['Jaisalmer', 26.9157, 70.9083, 30, 'tuned'], ['Bengaluru', 12.9716, 77.5946, 30, 'tuned'],
  ['Kolkata', 22.5726, 88.3639, 30, 'tuned'], ['Seville', 37.3891, -5.9845, 30, 'tuned'], ['London', 51.5074, -0.1278, 30, 'tuned'],
  ['Pune', 18.5204, 73.8567, 30, 'holdout'], ['Bhopal', 23.2599, 77.4126, 30, 'holdout'], ['Guwahati', 26.1445, 91.7362, 30, 'holdout'],
  ['Srinagar', 34.0837, 74.7973, 10, 'holdout'], ['Chennai', 13.0827, 80.2707, 30, 'holdout'],
  // Added after the soil-texture rule was changed using the holdout places above: a fresh set.
  // Its misses (gulmohar, arjun "too wet" at Thiruvananthapuram) then made too much rain a warning,
  // so the fresh set is tuned too now: add new places for an unbiased estimate
  ['Hyderabad', 17.385, 78.4867, 30, 'fresh'], ['Lucknow', 26.8467, 80.9462, 30, 'fresh'], ['Ahmedabad', 23.0225, 72.5714, 30, 'fresh'],
  ['Ranchi', 23.3441, 85.3096, 30, 'fresh'], ['Thiruvananthapuram', 8.5241, 76.9366, 30, 'fresh'],
];
const API = 'https://api.gbif.org/v1';
const PACE_MS = 20000; // between places, to stay under Open-Meteo's per-minute limit

async function get(url) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (res?.ok) return res.json();
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error(`GBIF did not answer: ${url}`);
}

(async () => {
  const { species } = trees.speciesList();
  // GBIF backbone species keys (occurrence search needs these, not WCVP checklist keys)
  const keyOf = new Map();
  for (const sp of species) {
    const m = await get(`${API}/species/match?name=${encodeURIComponent(sp.scientific)}&kingdom=Plantae&strict=true`);
    if (m.speciesKey && m.matchType !== 'NONE') keyOf.set(sp.id, m.speciesKey);
  }
  console.log(`${keyOf.size}/${species.length} trees matched to the GBIF backbone; recorded = ≥${MIN_RECORDS} records within the radius\n`);

  const total = { tuned: { recorded: 0, accepted: 0 }, holdout: { recorded: 0, accepted: 0 }, fresh: { recorded: 0, accepted: 0 } };
  for (const [name, lat, lon, RADIUS_KM, set] of PLACES.filter(p => !ONLY_SET || p[4] === ONLY_SET)) {
    // Open-Meteo weights long requests as many calls (5 years daily + 1 year hourly per place) and
    // answers HTTP 429 above its per-minute limit: pace the places and retry once after a minute
    const load = () => Promise.all([
      trees.climate(lat, lon), trees.soil(lat, lon).catch(() => ({ hasData: false })), trees.air(lat, lon).catch(() => null),
    ]);
    const [climate, soil, air] = await load().catch(async err => {
      console.log(`   (${err.message}: waiting 65 s)`);
      await new Promise(r => setTimeout(r, 65000));
      return load();
    });
    await new Promise(r => setTimeout(r, PACE_MS));
    const site = { lat, lon, climate, soil, air };
    const ranked = fit.rank(site, species);
    const keys = [...keyOf.values()];
    const counts = new Map();
    for (let i = 0; i < keys.length; i += 50) { // GBIF accepts many taxonKey params; batches keep URLs short
      const q = keys.slice(i, i + 50).map(k => `taxonKey=${k}`).join('&');
      const r = await get(`${API}/occurrence/search?${q}&geoDistance=${lat},${lon},${RADIUS_KM}km&hasCoordinate=true` +
        '&hasGeospatialIssue=false&occurrenceStatus=PRESENT&coordinateUncertaintyInMeters=0,5000&limit=0&facet=speciesKey&facetLimit=300');
      for (const c of r.facets?.[0]?.counts || []) counts.set(Number(c.name), c.count);
    }
    const recorded = ranked.filter(r => (counts.get(keyOf.get(r.sp.id)) || 0) >= MIN_RECORDS);
    const accepted = recorded.filter(r => r.fit.canGrow);
    const missed = recorded.filter(r => !r.fit.canGrow);
    total[set].recorded += recorded.length; total[set].accepted += accepted.length;
    const pct = recorded.length ? Math.round(100 * accepted.length / recorded.length) : null;
    console.log(`[${set}] ${name} (${climate.region?.name || '?'}, ${RADIUS_KM} km): app accepts ${ranked.filter(r => r.fit.canGrow).length}/${species.length} trees; ` +
      `${recorded.length} checked trees recorded nearby; recall ${pct ?? '—'}% (${accepted.length}/${recorded.length})`);
    for (const r of missed) {
      const why = r.fit.verdict === 'nodata' ? 'not enough data' : r.fit.failed.map(k => `${k}: ${r.fit.checks[k].note}`).join(' | ');
      console.log(`   ✕ ${r.sp.id} (${counts.get(keyOf.get(r.sp.id))} records, ${r.fit.nativeStatus}) — ${why}`);
    }
  }
  console.log('');
  for (const set of ['tuned', 'holdout', 'fresh'].filter(s => !ONLY_SET || s === ONLY_SET)) {
    const t = total[set];
    console.log(`Recall, ${set} places: ${t.recorded ? Math.round(100 * t.accepted / t.recorded) : '—'}% (${t.accepted}/${t.recorded})`);
  }
})().catch(err => { console.error(err.message); process.exit(1); });
