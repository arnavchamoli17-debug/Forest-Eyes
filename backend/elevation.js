/**
 * Earth Intelligence Platform — elevation from AWS Terrain Tiles (elevation.js)
 * ===========================================================================
 * Free, keyless, not rate-limited: Terrarium PNG tiles on the AWS Open Data registry,
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   elevation (m) = R * 256 + G + B / 256 - 32768
 * Zoom 12 ≈ 38 m per pixel at the equator (data: SRTM, ETOPO1, GMTED and national DEMs).
 * Includes a minimal PNG decoder (8-bit RGB/RGBA, all filter types) so there are no dependencies.
 */
'use strict';

const zlib = require('zlib');

const ZOOM = 12;
const TILE = 256;
const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const SOURCE = 'AWS Terrain Tiles (Mapzen/Tilezen: SRTM, GMTED, ETOPO1 and national DEMs), ~38 m';

const tiles = new Map(); // key → Promise<Float32Array>
const MAX_TILES = 200;   // Int16 tiles: ~26 MB worst case (the free host has 512 MB in total)

/** PNG → raw pixels { width, height, bpp, px } (8-bit RGB/RGBA). Also used for JRC water tiles. */
function decodePngPixels(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width, height, bitDepth, colorType;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`unsupported PNG (depth ${bitDepth}, type ${colorType})`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y > 0 ? px[prev + i] : 0;
      const c = i >= bpp && y > 0 ? px[prev + i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      px[dst + i] = v & 255;
    }
  }
  return { width, height, bpp, px };
}

/** Terrarium PNG → elevations. */
function decodePng(buf) {
  const { width, height, bpp, px } = decodePngPixels(buf);
  const out = new Int16Array(width * height); // whole metres: enough, and half the memory
  for (let i = 0; i < width * height; i++) {
    out[i] = Math.round(px[i * bpp] * 256 + px[i * bpp + 1] + px[i * bpp + 2] / 256 - 32768);
  }
  return out;
}

function tile(x, y, z = ZOOM) {
  const key = `${z}/${x}/${y}`;
  if (!tiles.has(key)) {
    if (tiles.size >= MAX_TILES) tiles.delete(tiles.keys().next().value);
    // Up to 3 attempts: one dropped connection must not fail a whole analysis
    const job = (async () => {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(URL(z, x, y), { signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error(`terrain tile HTTP ${r.status}`);
          return decodePng(Buffer.from(await r.arrayBuffer()));
        } catch (err) {
          lastErr = err;
          await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
        }
      }
      throw lastErr;
    })();
    job.catch(() => tiles.delete(key)); // retry next time
    tiles.set(key, job);
  }
  return tiles.get(key);
}

/** Web-Mercator pixel position of a point at zoom z. */
function pixel(lat, lon, z = ZOOM) {
  const n = 2 ** z * TILE;
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
}

async function sample(px, py, z = ZOOM) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  const t = await tile(tx, ty, z);
  const ix = Math.min(TILE - 1, Math.max(0, Math.floor(px - tx * TILE)));
  const iy = Math.min(TILE - 1, Math.max(0, Math.floor(py - ty * TILE)));
  return t[iy * TILE + ix];
}

/**
 * Elevations (m) for [[lat, lon], ...], bilinear between the 4 nearest pixels.
 * zoom 12 ≈ 38 m pixels (default); lower zooms are coarser but need far fewer tiles
 * (zoom 9 ≈ 300 m, used to pre-screen whole regions).
 */
async function elevations(points, z = ZOOM) {
  return Promise.all(points.map(async ([lat, lon]) => {
    const [x, y] = pixel(lat, lon, z);
    const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5);
    const fx = x - 0.5 - x0, fy = y - 0.5 - y0;
    const [a, b, c, d] = await Promise.all([sample(x0, y0, z), sample(x0 + 1, y0, z), sample(x0, y0 + 1, z), sample(x0 + 1, y0 + 1, z)]);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }));
}

module.exports = { elevations, SOURCE, decodePng, decodePngPixels };
