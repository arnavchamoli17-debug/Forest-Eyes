/**
 * Forest Eyes — tree cover in 2000 inside an analysis box (forest-extent.js)
 * =========================================================================
 * GET /api/gfw/extent?bbox=w,s,e,n  →  { forestHa, boxHa, coverPct, zoom, tiles, source }
 *
 * The deforestation rate needs the forest area that could be lost. Global Forest Watch's
 * tree-cover tiles (UMD/Hansen tree cover 2000, ≥30 % canopy — the same threshold as the loss
 * data) are a plain mask: a pixel is drawn where there was tree cover. Counting the drawn
 * pixels inside the box gives the area, without a GFW key. Zoom 12 (~38 m pixels at the
 * equator, close to the 30 m source) is used when the box needs ≤ MAX_TILES tiles, else a
 * coarser zoom; the result is an estimate, labelled as such. Tiles are read 8 at a time and
 * dropped after counting, so memory stays small on the free host.
 */
'use strict';

const { decodePngPixels } = require('./elevation.js');

const TILE_URL = (z, x, y) => `https://tiles.globalforestwatch.org/umd_tree_cover_density_2000/v1.8/tcd_30/${z}/${x}/${y}.png`;
const MAX_ZOOM = 12;
// Coarser zooms overcount (a pixel is drawn if any of it is forest: Dehradun 20 km box z12 16,410 ha,
// z11 +6 %, z10 +12 %), so zoom 12 is kept up to the app's 50 km radius (~150 tiles)
const MAX_TILES = 180;
const EARTH_M = 40075016.686;  // equator length
const cache = new Map();       // bbox key → Promise<result>

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const lonToX = (lon, z) => (lon + 180) / 360 * 2 ** z;
const latToY = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
const yToLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;

/** Tree-cover hectares in one tile, counting only pixels whose centre is inside the box. */
async function tileForestHa(z, x, y, box) {
  // One retry: a single dropped tile connection ("fetch failed") would fail the whole box
  const get = () => fetch(TILE_URL(z, x, y), { signal: AbortSignal.timeout(15000) });
  const res = await get().catch(() => new Promise(r => setTimeout(r, 1000)).then(get));
  if (res.status === 404) return 0; // no tile: no tree cover there (open sea)
  if (!res.ok) throw new Error(`tree-cover tile HTTP ${res.status}`);
  const { width, height, bpp, px } = decodePngPixels(Buffer.from(await res.arrayBuffer()));
  const [w, s, e, n] = box;
  const n2 = 2 ** z;
  let ha = 0;
  for (let row = 0; row < height; row++) {
    const lat = yToLat(y + (row + 0.5) / height, z);
    if (lat < s || lat > n) continue;
    const pxM = EARTH_M * Math.cos(lat * Math.PI / 180) / (n2 * width); // pixel side, metres
    const pxHa = pxM * pxM / 10000;
    for (let col = 0; col < width; col++) {
      const lon = (x + (col + 0.5) / width) / n2 * 360 - 180;
      if (lon < w || lon > e) continue;
      const alpha = bpp === 4 ? px[(row * width + col) * 4 + 3] : 255;
      if (alpha > 0) ha += pxHa;
    }
  }
  return ha;
}

async function extent(query) {
  const box = String(query.bbox || '').split(',').map(Number);
  const [w, s, e, n] = box;
  if (box.length !== 4 || !box.every(Number.isFinite) || w >= e || s >= n || Math.abs(s) > 85 || Math.abs(n) > 85
    || w < -180 || e > 180 || e - w > 3 || n - s > 3) {
    throw httpError(400, 'bbox=w,s,e,n is required (at most 3° across).');
  }
  const key = box.map(v => v.toFixed(4)).join(',');
  if (!cache.has(key)) {
    const job = (async () => {
      // Finest zoom whose tiles over the box stay within MAX_TILES
      let z = MAX_ZOOM, xs, ys;
      for (; z >= 6; z--) {
        xs = [Math.floor(lonToX(w, z)), Math.floor(lonToX(e, z))];
        ys = [Math.floor(latToY(n, z)), Math.floor(latToY(s, z))];
        if ((xs[1] - xs[0] + 1) * (ys[1] - ys[0] + 1) <= MAX_TILES) break;
      }
      const tiles = [];
      for (let x = xs[0]; x <= xs[1]; x++) for (let y = ys[0]; y <= ys[1]; y++) tiles.push([x, y]);
      let forestHa = 0;
      for (let i = 0; i < tiles.length; i += 8) { // 8 at a time: tiles are ~260 kB each
        const part = await Promise.all(tiles.slice(i, i + 8).map(([x, y]) => tileForestHa(z, x, y, box)));
        forestHa += part.reduce((a, b) => a + b, 0);
      }
      const midLat = (s + n) / 2 * Math.PI / 180;
      const boxHa = (n - s) * 111320 * (e - w) * 111320 * Math.cos(midLat) / 10000;
      return {
        forestHa: Math.round(forestHa),
        boxHa: Math.round(boxHa),
        coverPct: +(100 * forestHa / boxHa).toFixed(1),
        zoom: z,
        tiles: tiles.length,
        source: 'UMD/Hansen tree cover 2000 (≥30 % canopy) via Global Forest Watch tiles; area counted from map pixels (estimate)',
      };
    })();
    job.catch(() => cache.delete(key));
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(key, job);
  }
  return cache.get(key);
}

module.exports = { extent, tileForestHa };
