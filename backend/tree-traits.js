/**
 * Earth Intelligence Platform — tree data added by the team (tree-traits.js)
 * ==========================================================================
 * One JSON file per tree in data/tree-traits/<id>.json (format: data/tree-traits/README.md).
 * Every value carries its source and the exact quote it was read from; a person must have
 * checked the quotes against the real page ("checkedBy"). This module validates the files,
 * converts units in code, and turns them into the shape tree-fit.js checks:
 *
 *   - a tree ECOCROP lacks becomes a new tree, scored on the fields the team found;
 *   - a tree ECOCROP has keeps ECOCROP's ranges for scoring and gains altitude, a frost limit
 *     (when ECOCROP has none) and the descriptive traits (leaf habit, height, uses…).
 *
 * Invalid files are skipped with the reasons printed, never half-loaded.
 * Check files with:  node backend/scripts/check-tree-traits.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data', 'tree-traits');

// Unit conversions are done here, in code — never by the person or the AI reading the source
const CONVERT = {
  mm: x => x, cm: x => x * 10, in: x => x * 25.4, inch: x => x * 25.4, inches: x => x * 25.4,
  C: x => x, '°C': x => x, F: x => (x - 32) * 5 / 9, '°F': x => (x - 32) * 5 / 9,
  m: x => x, ft: x => x * 0.3048, feet: x => x * 0.3048,
  pH: x => x, '': x => x,
};

const RANGE = 'range', NUMBER = 'number', CHOICE = 'choice', LIST = 'list', TEXT = 'text', BOOL = 'bool';
// field → kind, units allowed (first = the unit we store), sane bounds, choices
const FIELDS = {
  annualRainfallMm: { kind: RANGE, units: ['mm', 'cm', 'in', 'inch', 'inches'], min: 0, max: 15000, scores: true },
  meanAnnualTempC: { kind: RANGE, units: ['°C', 'C', '°F', 'F'], min: -30, max: 40, scores: true },
  absMinTempC: { kind: NUMBER, units: ['°C', 'C', '°F', 'F'], min: -60, max: 30, scores: true },
  absMaxTempC: { kind: NUMBER, units: ['°C', 'C', '°F', 'F'], min: 10, max: 60 },
  altitudeM: { kind: RANGE, units: ['m', 'ft', 'feet'], min: -100, max: 6000, scores: true },
  soilPh: { kind: RANGE, units: ['pH', ''], min: 3, max: 10.5, scores: true },
  soilTexture: { kind: LIST, choices: ['light', 'medium', 'heavy'], scores: true },
  light: { kind: CHOICE, choices: ['full-sun', 'partial-shade', 'shade-tolerant'], scores: true },
  leafHabit: { kind: CHOICE, choices: ['deciduous', 'evergreen', 'semi-evergreen'] },
  heightM: { kind: NUMBER, units: ['m', 'ft', 'feet'], min: 1, max: 120 },
  growthRate: { kind: CHOICE, choices: ['slow', 'medium', 'fast'] },
  droughtTolerance: { kind: CHOICE, choices: ['low', 'medium', 'high'] },
  frostTolerance: { kind: CHOICE, choices: ['low', 'medium', 'high'] },
  rootSystem: { kind: TEXT },
  nitrogenFixing: { kind: BOOL },
  uses: { kind: LIST },
  wildlifeValue: { kind: TEXT },
  pollutionTolerance: { kind: CHOICE, choices: ['sensitive', 'intermediate', 'tolerant'] },
  invasiveRisk: { kind: TEXT },
  plantingSeason: { kind: TEXT },
  propagation: { kind: TEXT },
};

// Light words → ECOCROP light classes (optimal, absolute); see tree-fit.js LIGHT. Our mapping.
const LIGHT_CLASSES = {
  'full-sun': { optimal: [1, 2], absolute: [1, 3] },
  'partial-shade': { optimal: [2, 3], absolute: [1, 4] },
  'shade-tolerant': { optimal: [3, 4], absolute: [1, 5] },
};
const TEXTURE_LETTER = { light: 'L', medium: 'M', heavy: 'H' };

/** Validates one field entry; returns { value } in stored units or { error }. */
function readField(key, entry) {
  const spec = FIELDS[key];
  if (!spec) return { error: `unknown field "${key}"` };
  if (entry == null || entry.value == null) return { value: null };
  // An untouched template range ({ min: null, max: null }) means "not filled in"
  if (spec.kind === RANGE && entry.value.min == null && entry.value.max == null) return { value: null };
  const src = entry.source || {};
  if (!String(src.title || '').trim()) return { error: `${key}: source.title is missing` };
  if (!String(src.page || src.url || '').trim()) return { error: `${key}: source.page or source.url is missing` };
  if (src.url && !/^https?:\/\/\S+$/.test(src.url)) return { error: `${key}: source.url must start with http:// or https://` };
  if (String(entry.quote || '').trim().length < 10) return { error: `${key}: the exact quote from the source is missing` };
  const unit = entry.unit ?? '';
  const raw = spec.units ? CONVERT[unit] : null;
  const conv = raw && (x => Math.round(raw(x) * 10) / 10); // 914.4000000000001 → 914.4
  if (spec.units && (!spec.units.includes(unit) || !raw)) return { error: `${key}: unit "${unit}" not accepted (use ${spec.units.join(', ')})` };
  const inBounds = x => Number.isFinite(x) && x >= spec.min && x <= spec.max;
  const v = entry.value;
  switch (spec.kind) {
    case RANGE: {
      if (typeof v !== 'object' || !Number.isFinite(v.min) || !Number.isFinite(v.max)) return { error: `${key}: value must be { "min": number, "max": number }` };
      const out = { min: conv(v.min), max: conv(v.max) };
      if (Number.isFinite(v.optMin) && Number.isFinite(v.optMax)) Object.assign(out, { optMin: conv(v.optMin), optMax: conv(v.optMax) });
      const order = [out.min, out.optMin ?? out.min, out.optMax ?? out.max, out.max];
      if (!order.every(inBounds) || order.some((x, i) => i && x < order[i - 1])) return { error: `${key}: range out of order or outside ${spec.min}–${spec.max}` };
      return { value: out };
    }
    case NUMBER: {
      const x = conv(Number(v));
      return inBounds(x) ? { value: x } : { error: `${key}: ${v} is outside ${spec.min}–${spec.max}` };
    }
    case CHOICE:
      return spec.choices.includes(v) ? { value: v } : { error: `${key}: "${v}" is not one of ${spec.choices.join(', ')}` };
    case LIST: {
      if (!Array.isArray(v) || !v.length) return { error: `${key}: value must be a non-empty list` };
      if (spec.choices && !v.every(x => spec.choices.includes(x))) return { error: `${key}: items must be ${spec.choices.join(', ')}` };
      return { value: v.map(x => String(x).slice(0, 80)).slice(0, 12) };
    }
    case BOOL:
      return typeof v === 'boolean' ? { value: v } : { error: `${key}: value must be true or false` };
    default:
      return typeof v === 'string' && v.trim() ? { value: v.trim().slice(0, 300) } : { error: `${key}: value must be text` };
  }
}

/** Validates a whole file. @returns {{ tree?: object, errors: string[] }} */
function readTree(json, fileName = '') {
  const errors = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(json.id || '')) errors.push('id must be lowercase words joined by hyphens, e.g. "peepal"');
  if (fileName && json.id && fileName !== `${json.id}.json`) errors.push(`file name must be ${json.id}.json`);
  if (!/^[A-Z][a-z-]+ [a-z-]+( (var|subsp)\. [a-z-]+)?$/.test(json.scientific || '')) errors.push('scientific must be the accepted Latin name, e.g. "Ficus religiosa"');
  for (const k of ['name', 'family']) if (!String(json[k] || '').trim()) errors.push(`${k} is missing`);
  if (!String(json.checkedBy || '').trim()) errors.push('checkedBy is missing: a person must check every quote against the real source');
  const fields = {}, sources = {};
  for (const [key, entry] of Object.entries(json.fields || {})) {
    const r = readField(key, entry);
    if (r.error) errors.push(r.error);
    else if (r.value !== null) {
      fields[key] = r.value;
      sources[key] = { ...entry.source, quote: String(entry.quote).slice(0, 600) };
    }
  }
  if (!Object.keys(fields).length) errors.push('no field has a sourced value');
  if (errors.length) return { errors };
  return {
    errors,
    tree: {
      id: json.id, scientific: json.scientific, name: json.name.trim(), localName: json.localName?.trim() || null,
      family: json.family.trim(), checkedBy: json.checkedBy.trim(), fields, sources,
    },
  };
}

/** Every file in data/tree-traits; bad files are reported, not loaded. */
function loadTeamTrees(dir = DIR) {
  const trees = [], problems = [];
  let files = [];
  // Files starting with "_" (the template) are not trees
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')); } catch { /* no folder yet */ }
  for (const f of files) {
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { problems.push(`${f}: not valid JSON (${err.message})`); continue; }
    const { tree, errors } = readTree(json, f);
    if (tree) trees.push(tree); else problems.push(...errors.map(e => `${f}: ${e}`));
  }
  return { trees, problems };
}

const range4 = r => (r ? [r.min, r.optMin ?? r.min, r.optMax ?? r.max, r.max] : null);

/** Team tree → the requirement shape tree-fit.js uses (for trees ECOCROP does not have). */
function toSpecies(t) {
  const f = t.fields;
  return {
    id: t.id, name: t.name, localName: t.localName, scientific: t.scientific, family: t.family,
    temp: null, seasonMonths: null, killC: null,
    tempAnnual: range4(f.meanAnnualTempC),
    rain: range4(f.annualRainfallMm),
    ph: range4(f.soilPh),
    light: f.light ? LIGHT_CLASSES[f.light] : null,
    texture: f.soilTexture ? { optimal: f.soilTexture.map(x => TEXTURE_LETTER[x]).join(''), absolute: f.soilTexture.map(x => TEXTURE_LETTER[x]).join('') } : null,
    drainage: null,
    ...extras(t),
    requirementsFrom: 'team',
  };
}

/** Altitude, frost limit and descriptive traits, added to any tree (ECOCROP or team). */
function extras(t) {
  const f = t.fields;
  const descriptive = Object.fromEntries(Object.entries(f).filter(([k]) => !FIELDS[k].scores || k === 'soilTexture' || k === 'light'));
  return {
    altitudeM: f.altitudeM ? [f.altitudeM.min, f.altitudeM.max] : null,
    frostLimitC: Number.isFinite(f.absMinTempC) ? Math.round(f.absMinTempC * 10) / 10 : null,
    traits: descriptive,
    values: f,           // every sourced value, as stored (shown with its source in the report)
    sources: t.sources,
    checkedBy: t.checkedBy,
  };
}

/**
 * ECOCROP trees + team trees + Kew native ranges → the list the app checks.
 * Team data never overrides ECOCROP's scoring ranges; it adds what ECOCROP lacks.
 */
function merge(ecocrop, team, native) {
  const byId = new Map(ecocrop.map(s => [s.id, { ...s, requirementsFrom: 'ecocrop' }]));
  for (const t of team) {
    const base = byId.get(t.id) || [...byId.values()].find(s => s.scientific === t.scientific);
    if (base) {
      const add = extras(t);
      Object.assign(base, add, { frostLimitC: base.killC == null ? add.frostLimitC : null, localName: base.localName || t.localName });
    } else {
      byId.set(t.id, toSpecies(t));
    }
  }
  for (const s of byId.values()) {
    const n = native?.[s.id];
    s.wcvp = n ? { name: n.wcvpName, native: n.native, introduced: n.introduced } : null;
    delete s.native; // the old hand-drawn regions are not used
  }
  return [...byId.values()];
}

module.exports = { FIELDS, readTree, loadTeamTrees, merge, toSpecies, LIGHT_CLASSES, DIR };
