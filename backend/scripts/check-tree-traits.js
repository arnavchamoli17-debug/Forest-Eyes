/**
 * Checks the team's tree files (backend/data/tree-traits/*.json) before they go into the app.
 * For each file: OK, or every problem found. Then what the app will do with it: a new tree
 * (ECOCROP does not have it) or extra facts for an ECOCROP tree.
 *
 * Usage (from the project root):  node backend/scripts/check-tree-traits.js [file.json ...]
 * After adding NEW trees, run  node backend/scripts/build-native-ranges.js  for their native ranges.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const traits = require('../tree-traits.js');

const ecocrop = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tree-species.json'), 'utf8')).species;
const native = (() => { try { return require('../data/tree-native.json'); } catch { return {}; } })();

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(traits.DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => path.join(traits.DIR, f));

let bad = 0;
for (const file of files) {
  const name = path.basename(file);
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { console.log(`✕ ${name}: not valid JSON (${err.message})`); bad++; continue; }
  const { tree, errors } = traits.readTree(json, name);
  if (!tree) { console.log(`✕ ${name}\n${errors.map(e => `    - ${e}`).join('\n')}`); bad++; continue; }
  const base = ecocrop.find(s => s.id === tree.id || s.scientific === tree.scientific);
  const fields = Object.keys(tree.fields);
  // Listed under "Can grow here" only with rainfall and some temperature evidence
  const hasTemp = ['meanAnnualTempC', 'absMinTempC', 'altitudeM'].some(k => fields.includes(k));
  const missing = [!fields.includes('annualRainfallMm') && 'annualRainfallMm', !hasTemp && 'meanAnnualTempC, absMinTempC or altitudeM'].filter(Boolean);
  console.log(`✓ ${name}: ${tree.scientific}, ${fields.length} sourced fields (${fields.join(', ')})`);
  if (base) {
    console.log(`    ECOCROP has this tree (${base.id}): its ranges stay for scoring; altitude, frost limit and traits are added.`);
  } else {
    console.log('    New tree (not in ECOCROP): it is scored on these fields.');
    if (missing.length) console.log(`    ! Without ${missing.join(' and ')} it will be listed under "Not enough data yet".`);
    if (!native[tree.id]) console.log('    ! No native range yet: run  node backend/scripts/build-native-ranges.js');
  }
}
console.log(files.length ? `\n${files.length - bad} of ${files.length} file(s) OK.` : 'No tree files yet.');
process.exit(bad ? 1 : 0);
