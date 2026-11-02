"""
Builds data/rain_chpclim.bin: long-term mean annual rainfall (mm/yr) from CHPclim v1, the Climate
Hazards Group's satellite- and station-based precipitation climatology (0.05 degree, monthly).
The 12 monthly grids are summed; land only (-9999 = no data).

Why: ERA5 reanalysis rainfall is far off at town scale in India (2021-2025 ERA5 vs CHPclim:
Srinagar 2673 vs 699 mm, Pune 1454 vs 798, Dehradun 1350 vs 1734). CHPclim is built from
rain-gauge normals plus satellite fields and is much closer to local records.

Two grids, uint16 mm (65535 = no data), gzip-compressed:
  India region  65-100 E, 5-40 N  at 0.05 degree (full resolution: valleys and ridges differ)
  Global        180 W-180 E, 90 S-90 N at 0.1 degree (mean of the valid 0.05 cells)

Usage:  python -I scripts/build-rainfall.py <folder with CHPclim.01.tif ... CHPclim.12.tif> data/rain_chpclim.bin
Needs:  pip install tifffile numpy
Data:   https://data.chc.ucsb.edu/products/CHPclim/v1/90N-90S.landonly/monthly/
        Funk, C. et al. (2015). A global satellite-assisted precipitation climatology.
        Earth System Science Data, 7, 275-287.
"""
import gzip
import struct
import sys

import numpy as np
import tifffile

RES = 0.05
INDIA = (65.0, 5.0, 100.0, 40.0)  # W, S, E, N
NODATA = 65535


def annual(folder):
    total, valid = None, None
    for m in range(1, 13):
        a = tifffile.imread(f'{folder}/CHPclim.{m:02d}.tif').astype(np.float32)  # 3600 x 7200, origin 180 W 90 N
        ok = a > -9000
        total = np.where(ok, a, 0) if total is None else total + np.where(ok, a, 0)
        valid = ok if valid is None else valid & ok
    total[~valid] = np.nan
    return total


def to_u16(a):
    return np.where(np.isnan(a), NODATA, np.clip(np.rint(a), 0, NODATA - 1)).astype('<u2')


def main(folder, out):
    a = annual(folder)
    w, s, e, n = INDIA
    r0, r1 = int(round((90 - n) / RES)), int(round((90 - s) / RES))
    c0, c1 = int(round((w + 180) / RES)), int(round((e + 180) / RES))
    india = a[r0:r1, c0:c1]
    blocks = a.reshape(1800, 2, 3600, 2)
    cnt = np.sum(~np.isnan(blocks), axis=(1, 3))
    glob = np.where(cnt > 0, np.nansum(blocks, axis=(1, 3)) / np.maximum(cnt, 1), np.nan)
    grids = [(w, s, e, n, RES, india), (-180.0, -90.0, 180.0, 90.0, 0.1, glob)]
    body = bytearray(b'RAIN' + struct.pack('<I', len(grids)))
    for gw, gs, ge, gn, res, g in grids:
        body += struct.pack('<5d2I', gw, gs, ge, gn, res, g.shape[1], g.shape[0])
    for *_, g in grids:
        body += to_u16(g).tobytes()
    with open(out, 'wb') as f:
        f.write(gzip.compress(bytes(body), 9))
    print(f'India {india.shape}, global {glob.shape} -> {out}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
