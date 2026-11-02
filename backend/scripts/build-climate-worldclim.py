"""
Builds data/climate_worldclim.bin: monthly climate normals from WorldClim 2.1 (1970-2000), the tree
planner's offline fallback when ERA5 (Open-Meteo) and NASA POWER both fail, and its source for the
seasons (dry / wet months) used in planting advice.

Per cell, 12 months each of:
  tavg   mean temperature        int8, 0.5 degC steps (value / 2), -128 = no data
  tmin   mean daily minimum      int8, 0.5 degC steps
  srad   solar radiation         uint8, 0.2 MJ/m2/day steps (value / 5); WorldClim gives kJ/m2/day
  prec   precipitation           uint16, mm/month
and once:
  elev   cell mean elevation     int16, m (to correct temperatures to a point's own altitude)

Two grids, gzip-compressed:
  India region  65-100 E, 5-40 N at WorldClim's 10 arc-minutes (no resampling)
  Global        180 W-180 E, 90 S-90 N at 0.5 degree (mean of the valid 10' cells in each 3 x 3 block)
then WorldClim's global 10' elevation (int16, m): with no internet for the terrain tiles, it is the
altitude a 0.5 degree cell's temperatures are moved to (much closer to the point than the 0.5 degree mean).

Usage:  python -I scripts/build-climate-worldclim.py <folder with the unzipped wc2.1_10m_* folders> data/climate_worldclim.bin
Needs:  pip install rasterio numpy
Data:   https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_{tavg,tmin,srad,prec,elev}.zip
        Fick, S.E. and R.J. Hijmans (2017). WorldClim 2: new 1-km spatial resolution climate surfaces
        for global land areas. International Journal of Climatology 37: 4302-4315. CC BY 4.0.
"""
import gzip
import os
import struct
import sys

import numpy as np
import rasterio

SRC, OUT = sys.argv[1], sys.argv[2]
RES = 1 / 6  # 10 arc-minutes
INDIA = (65.0, 5.0, 100.0, 40.0)  # W, S, E, N
BLOCK = 3  # global grid: 3 x 3 blocks of 10' = 0.5 degree


def read(var, month=None):
    name = f'wc2.1_10m_{var}' + (f'_{month:02d}' if month else '')
    with rasterio.open(os.path.join(SRC, f'wc2.1_10m_{var}', name + '.tif')) as src:
        assert (src.width, src.height) == (2160, 1080), (src.width, src.height)
        a = src.read(1, masked=True).astype('float64')
    return a.filled(np.nan)


def stack(var):
    return np.stack([read(var, m) for m in range(1, 13)])  # (12, 1080, 2160), north row first


layers = {v: stack(v) for v in ('tavg', 'tmin', 'srad', 'prec')}
layers['srad'] = layers['srad'] / 1000  # kJ -> MJ per m2 per day
elev = read('elev')
land = np.isfinite(layers['tavg']).all(0) & np.isfinite(layers['prec']).all(0)
print(f'10\' land cells: {land.sum()}', flush=True)


def window(a, w, s, e, n):
    """Rows/cols of the 10' grid (north first) covering w..e, s..n."""
    c0, c1 = round((w + 180) / RES), round((e + 180) / RES)
    r0, r1 = round((90 - n) / RES), round((90 - s) / RES)
    return a[..., r0:r1, c0:c1]


def block_mean(a, ok):
    """Mean of the valid cells in each BLOCK x BLOCK block (the last two axes)."""
    *lead, h, w = a.shape
    h2, w2 = h // BLOCK, w // BLOCK
    v = np.where(ok, a, 0.0)[..., :h2 * BLOCK, :w2 * BLOCK].reshape(*lead, h2, BLOCK, w2, BLOCK)
    n = ok[:h2 * BLOCK, :w2 * BLOCK].reshape(h2, BLOCK, w2, BLOCK).sum((1, 3))
    with np.errstate(invalid='ignore', divide='ignore'):
        m = v.sum((-3, -1)) / n
    m[..., n == 0] = np.nan
    return m


def encode(t, tn, sr, pr, el):
    ok = np.isfinite(t).all(0) & np.isfinite(pr).all(0)
    q8 = lambda x: np.where(ok, np.clip(np.round(x * 2), -127, 127), -128).astype('i1')
    sr8 = np.where(ok, np.clip(np.round(np.nan_to_num(sr) * 5), 0, 255), 0).astype('u1')
    pr16 = np.where(ok, np.clip(np.round(np.nan_to_num(pr)), 0, 65534), 65535).astype('<u2')
    el16 = np.where(ok & np.isfinite(el), np.round(np.nan_to_num(el)), -32768).astype('<i2')
    return [q8(t).tobytes(), q8(tn).tobytes(), sr8.tobytes(), pr16.tobytes(), el16.tobytes()], int(ok.sum())


grids = []
# India region at full 10' resolution
w, s, e, n = INDIA
india = [window(layers[v], w, s, e, n) for v in ('tavg', 'tmin', 'srad', 'prec')] + [window(elev, w, s, e, n)]
grids.append(((w, s, e, n, RES), india[0].shape[-1], india[0].shape[-2], *encode(*india)))
# Global at 0.5 degree
g = [block_mean(layers[v], land) for v in ('tavg', 'tmin', 'srad', 'prec')] + [block_mean(elev, land & np.isfinite(elev))]
grids.append(((-180.0, -90.0, 180.0, 90.0, RES * BLOCK), g[0].shape[-1], g[0].shape[-2], *encode(*g)))

out = bytearray(b'WCLM')
out += struct.pack('<I', len(grids))
for (bounds, width, height, _, _) in grids:
    out += struct.pack('<5dII', *bounds, width, height)
for (bounds, width, height, parts, cells) in grids:
    for p in parts:
        out += p
    print(f'grid {bounds}: {width}x{height}, {cells} cells with data', flush=True)
out += b'ELEV' + struct.pack('<II', elev.shape[1], elev.shape[0])
out += np.where(land & np.isfinite(elev), np.round(np.nan_to_num(elev)), -32768).astype('<i2').tobytes()
with gzip.open(OUT, 'wb', compresslevel=9) as fh:
    fh.write(out)
print(f'wrote {OUT}: {len(out) / 1e6:.1f} MB raw, {os.path.getsize(OUT) / 1e6:.1f} MB gzip', flush=True)
