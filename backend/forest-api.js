/**
 * Forest Eyes backend core (api/core.js)
 * ======================================
 * Shared by server.js (local) and api/lambda.js (AWS Lambda). No dependencies.
 * Treeko's prompt, soil and site logic live in ../treeko-brain.js (also used by the browser).
 *
 *   POST /api/treeko        Treeko chat (Gemini + ISRIC SoilGrids)
 *   POST /api/gfw/geostore  Create an analysis area      (adds the GFW key server-side)
 *   GET  /api/gfw/query     Query tree cover loss data   (adds the GFW key server-side)
 *   GET  /api/gfw/extent    Tree cover 2000 in a box     (counted from GFW map tiles, no key)
 *   GET  /api/health        Status (never reveals keys)
 *
 * Secrets come from environment variables (Lambda configuration or a local .env):
 *   GEMINI_API_KEY, GFW_API_KEY, GEMINI_MODEL
 */
'use strict';

const CONFIG = {
  model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  apiKey: (process.env.GEMINI_API_KEY || '').trim(),
  gfwKey: (process.env.GFW_API_KEY || '').trim(),
  // API Gateway and the Amplify proxy stop waiting after ~30 s, so stay under it.
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS) || 22000,
  soilTimeoutMs: Number(process.env.SOIL_TIMEOUT_MS) || 5000,
  gfwTimeoutMs: Number(process.env.GFW_TIMEOUT_MS) || 25000,
  maxBodyBytes: 64 * 1024,
};

const GFW = {
  geostore: 'https://api.resourcewatch.org/geostore/',
  data: 'https://data-api.globalforestwatch.org',
  // Only the datasets app.js uses can be queried through this proxy.
  datasets: new Set([
    'geostore__tcl__summary', 'geostore__tcl__change',
    'geostore__glad__daily_alerts', 'geostore__integrated_alerts__daily_alerts',
  ]),
};

// ---------------------------------------------------------------------------
// Treeko — shared brain (treeko-brain.js) with the server's key and timeouts
// ---------------------------------------------------------------------------
// treeko-brain.js is shared with the browser, so it lives with the frontend
const brain = require('../frontend/forest-eyes/treeko-brain.js');
const { summariseSoil, checkSites, systemPrompt, toContents, haversineKm, soilCache } = brain;

// Optional shared model client (the Earth Intelligence server plugs in the AI model here).
// Without it, Treeko calls Gemini directly with GEMINI_MODEL as before.
let generator = null;
function setGenerator(fn) { generator = typeof fn === 'function' ? fn : null; }

function askGemini(payload, fetchImpl = fetch) {
  return brain.askGemini(payload, {
    generate: generator ? req => generator(req, fetchImpl) : undefined,
    apiKey: CONFIG.apiKey,
    model: CONFIG.model,
    fetchImpl,
    geminiTimeoutMs: CONFIG.geminiTimeoutMs,
    soilTimeoutMs: CONFIG.soilTimeoutMs,
    getSoil: (lat, lng) => treekoSoil(lat, lng, fetchImpl),
    keyHint: 'GEMINI_API_KEY in the server settings',
    modelHint: 'Set GEMINI_MODEL in the server settings to a current model.',
  });
}

function getSoil(lat, lng, fetchImpl = fetch) {
  return brain.getSoil(lat, lng, fetchImpl, CONFIG.soilTimeoutMs);
}

const httpError = brain.httpError;

// Treeko's soil: the local India grid answers in < 1 ms; the SoilGrids API often takes 30 s,
// longer than Treeko can wait, so it is only the fallback outside India.
const soilGrid = require('./soil.js');
// Tree cover in 2000 inside the analysis box: the denominator of the deforestation rate
const forestExtent = require('./forest-extent.js');

function localSoil(lat, lng) {
  const s = soilGrid.lookup(lat, lng);
  if (!s) return null;
  const near = s.distanceKm ? ` (nearest cell with soil data, ${s.distanceKm} km away)` : '';
  const val = (x, unit) => (x == null ? 'n/a' : `${x}${unit}`);
  const text = [
    `Topsoil 0-30 cm${near}:`,
    `- Texture class (USDA): ${s.textureClass || 'n/a'} (clay ${val(s.clayPct, ' %')}, silt ${val(s.siltPct, ' %')}, sand ${val(s.sandPct, ' %')})`,
    `- pH (water): ${val(s.pH, '')}`,
    `- Organic carbon: ${val(s.organicCarbonGkg, ' g/kg')}`,
    `- Bulk density: ${val(s.bulkDensity, ' g/cm³')}`,
    `- Coarse fragments: ${val(s.coarseFragmentsPct, ' % by volume')}`,
    'This grid has no soil group, nitrogen or deeper layers: do not state them.',
  ].join('\n');
  return { text, hasData: true, source: `${s.source}, modelled` };
}

function treekoSoil(lat, lng, fetchImpl = fetch) {
  return localSoil(lat, lng) || brain.getSoil(lat, lng, fetchImpl, CONFIG.soilTimeoutMs);
}

// ---------------------------------------------------------------------------
// GFW proxy — the browser never sees GFW_API_KEY
// ---------------------------------------------------------------------------
async function gfwGeostore(bodyText, fetchImpl = fetch) {
  let payload;
  try { payload = JSON.parse(bodyText || '{}'); } catch { throw httpError(400, 'Bad request.'); }
  const g = payload?.geojson;
  if (!g || typeof g !== 'object' || !g.type) throw httpError(400, 'A GeoJSON "geojson" object is required.');
  const res = await fetchImpl(GFW.geostore, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(CONFIG.gfwKey ? { 'x-api-key': CONFIG.gfwKey } : {}) },
    body: JSON.stringify({ geojson: g }),
    signal: AbortSignal.timeout(CONFIG.gfwTimeoutMs),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function gfwQuery(q, fetchImpl = fetch) {
  const dataset = String(q.dataset || '');
  const sql = String(q.sql || '');
  const geostoreId = String(q.geostore_id || '');
  if (!GFW.datasets.has(dataset)) throw httpError(400, 'Unknown dataset.');
  if (!/^\s*SELECT\b/i.test(sql) || sql.includes(';') || sql.length > 2000) throw httpError(400, 'Only single SELECT queries are allowed.');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(geostoreId)) throw httpError(400, 'Bad geostore id.');
  const url = `${GFW.data}/dataset/${dataset}/latest/query?sql=${encodeURIComponent(sql)}` +
    `&geostore_id=${encodeURIComponent(geostoreId)}&geostore_origin=rw`;
  const res = await fetchImpl(url, {
    headers: CONFIG.gfwKey ? { 'x-api-key': CONFIG.gfwKey } : {},
    signal: AbortSignal.timeout(CONFIG.gfwTimeoutMs),
  });
  const lastModified = res.headers?.get?.('last-modified') || res.headers?.get?.('date') || null;
  return { status: res.status, json: await res.json().catch(() => ({})), headers: lastModified ? { 'last-modified': lastModified } : {} };
}

// ---------------------------------------------------------------------------
// Router shared by server.js and the Lambda handler
// ---------------------------------------------------------------------------
/** @returns {Promise<{status:number, json:object, headers?:object}>} */
async function handleApi({ method, path, query = {}, body = '' }, fetchImpl = fetch) {
  // Accept "/api/..." anywhere in the path (e.g. behind an API Gateway stage prefix).
  const i = path.indexOf('/api/');
  const route = i >= 0 ? path.slice(i) : path;
  try {
    if (route === '/api/health' || route === '/api/treeko/health') {
      return { status: 200, json: { ok: true, model: generator ? 'gemma (shared client)' : CONFIG.model, keyConfigured: !!CONFIG.apiKey, gfwKeyConfigured: !!CONFIG.gfwKey } };
    }
    if (Buffer.byteLength(body || '') > CONFIG.maxBodyBytes) throw httpError(413, 'Message too long.');
    if (route === '/api/treeko') {
      if (method !== 'POST') throw httpError(405, 'Use POST.');
      if (!CONFIG.apiKey) {
        throw httpError(503, 'Treeko is not set up yet: add GEMINI_API_KEY to the server settings (.env locally, Lambda environment on AWS).');
      }
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { throw httpError(400, 'Bad request.'); }
      if (!Array.isArray(payload.messages)) throw httpError(400, 'Bad request.');
      return { status: 200, json: await askGemini(payload, fetchImpl) };
    }
    if (route === '/api/gfw/geostore') {
      if (method !== 'POST') throw httpError(405, 'Use POST.');
      return await gfwGeostore(body, fetchImpl);
    }
    if (route === '/api/gfw/query') {
      if (method !== 'GET') throw httpError(405, 'Use GET.');
      return await gfwQuery(query, fetchImpl);
    }
    if (route === '/api/gfw/extent') {
      if (method !== 'GET') throw httpError(405, 'Use GET.');
      return { status: 200, json: await forestExtent.extent(query) };
    }
    throw httpError(404, 'Not found.');
  } catch (err) {
    const status = err.status || (err.name === 'TimeoutError' ? 504 : 500);
    if (status >= 500) console.warn('[api]', route, err.message);
    return {
      status,
      json: { error: err.status ? err.message : status === 504 ? 'The data service took too long to answer. Try again.' : 'Something went wrong.' },
    };
  }
}

module.exports = {
  CONFIG, handleApi, askGemini, setGenerator, getSoil, summariseSoil, checkSites, systemPrompt, toContents,
  haversineKm, soilCache, gfwGeostore, gfwQuery, localSoil,
};
