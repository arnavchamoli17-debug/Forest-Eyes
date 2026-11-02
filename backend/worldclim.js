/**
 * Earth Intelligence Platform — monthly climate normals, offline (worldclim.js)
 * ============================================================================
 * Reads data/climate_worldclim.bin (built by scripts/build-climate-worldclim.py from WorldClim 2.1,
 * 1970-2000): monthly mean temperature, mean daily minimum, solar radiation and precipitation,
 * plus the cell's mean elevation. 10 arc-minutes (~18 km) for the India region, 0.5° worldwide.
 * Lookups take < 1 ms.
 *
 * Used by the tree planner (trees.js) for the seasons (dry / wet months) behind its planting
 * advice, and as the last climate fallback when ERA5 and NASA POWER both fail. Land only: a
 * point on a coast gets the nearest land cell within a few cells, and says how far it is.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILE = path.join(__dirname, 'data', 'climate_worldclim.bin');
const SOURCE = 'WorldClim 2.1 monthly normals 1970–2000 (Fick & Hijmans 2017)';
let grids;

function load() {
  if (grids !== undefined) return grids;
  try {
    const b = zlib.gunzipSync(fs.readFileSync(FILE));
    if (b.toString('latin1', 0, 4) !== 'WCLM') throw new Error('bad header');
    const count = b.readUInt32LE(4);
    let off = 8;
    grids = [];
    for (let k = 0; k < count; k++) {
      const [W, S, E, N, res] = [0, 1, 2, 3, 4].map(i => b.readDoubleLE(off + 8 * i));
      grids.push({ W, S, E, N, res, width: b.readUInt32LE(off + 40), height: b.readUInt32LE(off + 44) });
      off += 48;
    }
    const take = (Type, n) => {
      const a = new Type(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + n * Type.BYTES_PER_ELEMENT));
      off += n * Type.BYTES_PER_ELEMENT;
      return a;
    };
    for (const g of grids) {
      const n = g.width * g.height;
      g.tavg = take(Int8Array, 12 * n);   // 0.5 °C steps, -128 = no data
      g.tmin = take(Int8Array, 12 * n);
      g.srad = take(Uint8Array, 12 * n);  // 0.2 MJ/m²/day steps
      g.prec = take(Uint16Array, 12 * n); // mm/month
      g.elev = take(Int16Array, n);       // m, -32768 = no data
    }
    // WorldClim's global 10' elevation: the altitude reference when the terrain tiles are out of reach
    if (b.toString('latin1', off, off + 4) === 'ELEV') {
      const width = b.readUInt32LE(off + 4), height = b.readUInt32LE(off + 8);
      off += 12;
      grids.elev10 = { W: -180, S: -90, E: 180, N: 90, res: 1 / 6, width, height, elev: take(Int16Array, width * height) };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[worldclim] could not load climate grid:', err.message);
    grids = null;
  }
  return grids;
}

function available() { return !!load(); }

/** Nearest cell with data within `rings` cells of (lat, lon) in grid g, or null. */
function nearest(g, lat, lon, rings) {
  if (lat < g.S || lat >= g.N || lon < g.W || lon >= g.E) return null;
  const col = Math.floor((lon - g.W) / g.res), row = Math.floor((g.N - lat) / g.res);
  const n = g.width * g.height;
  const has = (r, c) => r >= 0 && r < g.height && c >= 0 && c < g.width && g.tavg[r * g.width + c] !== -128;
  for (let ring = 0; ring <= rings; ring++) {
    let best = null, bestKm = Infinity;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring || !has(row + dr, col + dc)) continue;
        const cLat = g.N - (row + dr + 0.5) * g.res, cLon = g.W + (col + dc + 0.5) * g.res;
        const km = Math.hypot((cLat - lat) * 111.32, (cLon - lon) * 111.32 * Math.cos(lat * Math.PI / 180));
        if (km < bestKm) { bestKm = km; best = (row + dr) * g.width + col + dc; }
      }
    }
    if (best !== null) return { i: best, n, km: ring === 0 ? 0 : bestKm };
  }
  return null;
}

/**
 * Monthly normals at (lat, lon): the India grid where it covers the point, else the global grid.
 * Returns null where neither has a land cell nearby (open sea, Antarctica's interior).
 */
function monthlyAt(lat, lon) {
  const gs = load();
  if (!gs) return null;
  for (const g of gs) {
    const hit = nearest(g, lat, lon, 2);
    if (!hit) continue;
    const { i, n, km } = hit;
    const months = (a, f) => Array.from({ length: 12 }, (_, m) => f(a[m * n + i]));
    const elev = g.elev[i];
    const e10 = gs.elev10;
    const fine = e10 && e10.elev[Math.min(e10.height - 1, Math.floor((90 - lat) * 6)) * e10.width + Math.min(e10.width - 1, Math.floor((lon + 180) * 6))];
    return {
      fineElevationM: fine == null || fine === -32768 ? null : fine, // 10' (~18 km) cell mean at the point
      tavgC: months(g.tavg, v => v / 2),
      tminC: months(g.tmin, v => v / 2),
      sradMJ: months(g.srad, v => v / 5),
      precMm: months(g.prec, v => v),
      cellElevationM: elev === -32768 ? null : elev,
      resolutionDeg: +g.res.toFixed(3),
      distanceKm: Math.round(km),
      source: SOURCE,
    };
  }
  return null;
}

module.exports = { available, monthlyAt, SOURCE };
