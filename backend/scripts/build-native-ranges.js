/**
 * Builds data/tree-native.json: where each tree is native or introduced, from Kew's World Checklist
 * of Vascular Plants (WCVP, CC BY 4.0), read through GBIF's API (Kew's own POWO API blocks scripts).
 * Covers the ECOCROP trees (data/tree-species.json) and the team's trees (data/tree-traits/*.json).
 *
 *   { "<tree id>": { wcvpName, wcvpKey, matchedAs, native: [TDWG codes], introduced: [TDWG codes] } }
 *   plus "_regions": { code: name } for every code used (from data/tdwg-level3.geojson).
 *
 * Matching: the accepted name in our data is looked up in WCVP; an ACCEPTED record with that exact
 * name wins (several names have homonyms that are synonyms of other species: Pinus sylvestris,
 * Shorea robusta); otherwise a synonym is followed to its accepted name. A tree with no match gets
 * no entry: its native status is unknown, never guessed. Records marked DOUBTFUL are left out.
 *
 * Usage (from the project root):  node backend/scripts/build-native-ranges.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const tdwg = require('../tdwg.js');
const traits = require('../tree-traits.js');

const DATA = path.join(__dirname, '..', 'data');
const WCVP = 'f382f0ce-323a-4091-bb9f-add557f3a9a2'; // GBIF dataset key of WCVP (Royal Botanic Gardens, Kew)
const API = 'https://api.gbif.org/v1';

async function get(url) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (res?.ok) return res.json();
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(`GBIF did not answer: ${url}`);
}

async function match(name) {
  const res = await get(`${API}/species/search?datasetKey=${WCVP}&q=${encodeURIComponent(name)}&rank=SPECIES&limit=50`);
  const same = res.results.filter(r => r.canonicalName === name);
  const accepted = same.find(r => r.taxonomicStatus === 'ACCEPTED');
  if (accepted) return { record: accepted, matchedAs: 'accepted' };
  const syn = same.find(r => r.acceptedKey);
  if (syn) return { record: await get(`${API}/species/${syn.acceptedKey}`), matchedAs: `synonym of ${syn.accepted}` };
  return null;
}

(async () => {
  const trees = [
    ...JSON.parse(fs.readFileSync(path.join(DATA, 'tree-species.json'), 'utf8')).species,
    ...traits.loadTeamTrees().trees,
  ];
  const out = {}, used = new Set(), report = [];
  for (const t of trees) {
    const name = t.scientific.replace(/\s+(var|subsp)\..*$/, '');
    const m = await match(name);
    if (!m) { report.push(`${t.id.padEnd(20)} ${name.padEnd(32)} NO MATCH: native status unknown`); continue; }
    const dist = await get(`${API}/species/${m.record.key}/distributions?limit=1000`);
    const rows = dist.results.filter(d => d.status !== 'DOUBTFUL' && d.locationId?.startsWith('TDWG:'));
    const native = rows.filter(d => d.establishmentMeans !== 'INTRODUCED').map(d => d.locationId.slice(5)).sort();
    const introduced = rows.filter(d => d.establishmentMeans === 'INTRODUCED').map(d => d.locationId.slice(5)).sort();
    [...native, ...introduced].forEach(c => used.add(c));
    out[t.id] = { wcvpName: m.record.scientificName, wcvpKey: m.record.key, matchedAs: m.matchedAs, native, introduced };
    report.push(`${t.id.padEnd(20)} ${name.padEnd(32)} → ${m.record.scientificName.padEnd(48)} ${m.matchedAs.padEnd(10)} native ${native.length}, introduced ${introduced.length}`);
  }
  const names = tdwg.names();
  const missingNames = [...used].filter(c => !names[c]);
  out._regions = Object.fromEntries([...used].sort().map(c => [c, names[c] || c]));
  out._source = 'Kew World Checklist of Vascular Plants (WCVP), via GBIF dataset f382f0ce-323a-4091-bb9f-add557f3a9a2, CC BY 4.0';
  out._built = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(DATA, 'tree-native.json'), JSON.stringify(out, null, 1));
  console.log(report.join('\n'));
  if (missingNames.length) console.warn('region codes not in the TDWG map:', missingNames.join(' '));
  console.log(`${Object.keys(out).filter(k => !k.startsWith('_')).length}/${trees.length} trees matched -> data/tree-native.json`);
})().catch(err => { console.error(err.message); process.exit(1); });
