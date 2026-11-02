"""
Builds data/soil_global.bin: a coarse worldwide topsoil grid from ISRIC SoilGrids 2.0, the tree
planner's offline fallback when the SoilGrids REST API (outside India) fails or times out.

Source: SoilGrids 2.0 aggregated to 5 km by ISRIC (cell means, Goode Homolosine), reprojected here
to 0.2 degree latitude/longitude by averaging. For each property the top 30 cm is averaged (0-5,
5-15, 15-30 cm weighted by thickness) and stored in SoilGrids' own integer units, in the same
'SOIL' layout as soil_india.bin (int16, -32768 = no data), gzip-compressed:
  clay, sand, silt   g/kg            (/10 -> %)
  soc                dg/kg           (/10 -> g/kg)
  phh2o              pH x 10         (/10 -> pH)

Usage:  python -I scripts/build-soil-global.py <folder with the *_mean_5000.tif files> data/soil_global.bin
Needs:  pip install rasterio numpy
Data:   https://files.isric.org/soilgrids/latest/data_aggregated/5000m/<property>/<property>_<depth>_mean_5000.tif
        Poggio, L. et al. (2021). SoilGrids 2.0. SOIL, 7, 217-240. CC BY 4.0.
"""
import gzip
import os
import struct
import sys

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

SRC, OUT = sys.argv[1], sys.argv[2]
W, S, E, N, RES = -180.0, -90.0, 180.0, 90.0, 0.2
WIDTH, HEIGHT = int(round((E - W) / RES)), int(round((N - S) / RES))
PROPS = ['clay', 'sand', 'silt', 'soc', 'phh2o']
DEPTHS = {'0-5cm': 5, '5-15cm': 10, '15-30cm': 15}


def read(prop, depth):
    with rasterio.open(os.path.join(SRC, f'{prop}_{depth}_mean_5000.tif')) as src:
        a = src.read(1).astype('float32')
        a[(a <= 0) | (a == src.nodata)] = np.nan  # SoilGrids uses 0 / nodata for water, rock, ice, built-up
        dst = np.full((HEIGHT, WIDTH), np.nan, dtype='float32')
        reproject(a, dst, src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
                  dst_transform=from_origin(W, N, RES, RES), dst_crs='EPSG:4326', dst_nodata=np.nan,
                  resampling=Resampling.average)
    print(f'  {prop} {depth}: {np.isfinite(dst).mean() * 100:.0f}% cells with data', flush=True)
    return dst


out = bytearray(b'SOIL')
out += struct.pack('<I5dII', 1, W, S, E, N, RES, WIDTH, HEIGHT)
out += struct.pack('<I', len(PROPS))
for p in PROPS:
    out += p.encode().ljust(8, b'\0')
for p in PROPS:
    stack = np.stack([read(p, d) for d in DEPTHS])
    w = np.array(list(DEPTHS.values()), dtype='float32')[:, None, None]
    ok = np.isfinite(stack)
    mean = (np.where(ok, stack, 0) * w).sum(0) / np.maximum((ok * w).sum(0), 1e-9)
    mean[~ok.any(0)] = np.nan
    out += np.where(np.isfinite(mean), np.round(mean), -32768).astype('<i2').tobytes()
with gzip.open(OUT, 'wb', compresslevel=9) as fh:
    fh.write(out)
print(f'wrote {OUT} ({WIDTH}x{HEIGHT}, {len(PROPS)} properties): {len(out) / 1e6:.1f} MB raw, '
      f'{os.path.getsize(OUT) / 1e6:.1f} MB gzip', flush=True)
