/**
 * Earth Intelligence Platform — long-term annual rainfall (rainfall.js)
 * =====================================================================
 * Reads data/rain_chpclim.bin (built by scripts/build-rainfall.py from CHPclim v1, the Climate
 * Hazards Group's satellite- and gauge-based precipitation climatology): mean annual rainfall in
 * mm/yr, 0.05° for the India region and 0.1° worldwide. Lookups take < 1 ms.
 *
 * Used instead of ERA5 reanalysis rainfall, which is far off at town scale in India
 * (Srinagar 2673 vs 699 mm, Pune 1454 vs 798, Dehradun 1350 vs 1734). Land only: a point
 * on a coast or lake gets the nearest land cell within a few cells.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILE = path.join(__dirname, 'data', 'rain_chpclim.bin');
const NODATA = 65535;
const SOURCE = 'CHPclim v1 long-term mean (Climate Hazards Group, satellite + rain-gauge climatology; Funk et al. 2015)';
let grids;

function load() {
  if (grids !== undefined) return grids;
  try {
    const b = zlib.gunzipSync(fs.readFileSync(FILE));
    if (b.toString('latin1', 0, 4) !== 'RAIN') throw new Error('bad header');
    const count = b.readUInt32LE(4);
    let off = 8;
    grids = [];
    for (let k = 0; k < count; k++) {
      const [W, S, E, N, res] = [0, 1, 2, 3, 4].map(i => b.readDoubleLE(off + 8 * i));
      grids.push({ W, S, E, N, res, width: b.readUInt32LE(off + 40), height: b.readUInt32LE(off + 44) });
      off += 48;
    }
    for (const g of grids) {
      g.mm = new Uint16Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + g.width * g.height * 2));
      off += g.width * g.height * 2;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[rainfall] could not load rainfall grid:', err.message);
    grids = null;
  }
  return grids;
}

/** @returns {{ annualMm: number, resolutionDeg: number, distanceCells: number, source: string } | null} */
function annualAt(lat, lon) {
  for (const g of load() || []) {
    if (lon < g.W || lon >= g.E || lat < g.S || lat >= g.N) continue;
    const row = Math.floor((g.N - lat) / g.res), col = Math.floor((lon - g.W) / g.res);
    for (let ring = 0; ring <= 3; ring++) { // nearest land cell for coasts and lakes
      let sum = 0, n = 0;
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const r = row + dr, c = col + dc;
          if (r < 0 || r >= g.height || c < 0 || c >= g.width) continue;
          const v = g.mm[r * g.width + c];
          if (v !== NODATA) { sum += v; n++; }
        }
      }
      if (n) return { annualMm: Math.round(sum / n), resolutionDeg: g.res, distanceCells: ring, source: SOURCE };
    }
  }
  return null;
}

module.exports = { annualAt, SOURCE };
