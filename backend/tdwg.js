/**
 * Earth Intelligence Platform — botanical region of a point (tdwg.js)
 * ===================================================================
 * Kew's World Checklist of Vascular Plants records where each species is native or introduced
 * by TDWG "level 3" region (World Geographical Scheme for Recording Plant Distributions:
 * ~country level, with large countries split, e.g. India → IND, WHM West Himalaya, EHM, ASS).
 * regionAt(lat, lon) finds the region containing a point, from data/tdwg-level3.geojson
 * (369 regions, 1.8 MB, loaded once). Coastlines are coarse, so a point just off every polygon
 * gets the nearest region within NEAR_KM.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'tdwg-level3.geojson');
const NEAR_KM = 25;
let regions;

function load() {
  if (regions !== undefined) return regions;
  try {
    const geo = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    regions = geo.features.map(f => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      let w = 180, s = 90, e = -180, n = -90;
      for (const poly of polys) for (const [x, y] of poly[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
      return { code: f.properties.LEVEL3_COD, name: f.properties.LEVEL3_NAM, polys, box: [w, s, e, n] };
    });
  } catch (err) {
    console.warn('[tdwg] region map unavailable:', err.message);
    regions = null;
  }
  return regions;
}

/** Even-odd ray test over every ring (outer rings and holes). */
function inside(lon, lat, polys) {
  let hit = false;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) hit = !hit;
      }
    }
  }
  return hit;
}

/** Distance (km) from a point to the nearest edge of a region. */
function edgeKm(lon, lat, polys) {
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
  let best = Infinity;
  for (const poly of polys) for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
      const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/** @returns {{code: string, name: string, distanceKm?: number} | null} */
function regionAt(lat, lon) {
  const all = load();
  if (!all) return null;
  const inBox = (r, pad) => lon >= r.box[0] - pad && lon <= r.box[2] + pad && lat >= r.box[1] - pad && lat <= r.box[3] + pad;
  const hit = all.find(r => inBox(r, 0) && inside(lon, lat, r.polys));
  if (hit) return { code: hit.code, name: hit.name };
  const pad = NEAR_KM / 100; // degrees, generous
  let best = null;
  for (const r of all) {
    if (!inBox(r, pad)) continue;
    const km = edgeKm(lon, lat, r.polys);
    if (km <= NEAR_KM && (!best || km < best.distanceKm)) best = { code: r.code, name: r.name, distanceKm: Math.round(km) };
  }
  return best;
}

/** Code → name for every region (for the species data and the UI). */
function names() {
  return Object.fromEntries((load() || []).map(r => [r.code, r.name]));
}

module.exports = { regionAt, names };
