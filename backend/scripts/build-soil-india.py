"""
Builds data/soil_india.bin: a ~2 km soil grid for the India region from ISRIC SoilGrids 2.0,
so soil lookups are instant and don't depend on the (slow) SoilGrids REST API.

For each property the top 30 cm is averaged (0-5, 5-15, 15-30 cm weighted by thickness)
and stored in SoilGrids' own integer units (int16, -32768 = no data):
  clay, sand, silt   g/kg            (/10 → %)
  cfvo               cm3/dm3         (/10 → vol % coarse fragments)
  bdod               cg/cm3          (/100 → kg/dm3)
  soc                dg/kg           (/10 → g/kg)
  phh2o              pH × 10         (/10 → pH)

Uses ISRIC's WCS map service, which resamples on the server (~7 s per layer); reading the
250 m source maps directly works too but takes ~2 min per layer.

Usage:  python -I scripts/build-soil-india.py data/soil_india.bin
Needs:  pip install rasterio numpy
Data:   Poggio, L. et al. (2021). SoilGrids 2.0. SOIL, 7, 217-240. CC BY 4.0.
"""
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
from rasterio.io import MemoryFile

W, S, E, N, RES = 68.0, 6.5, 97.5, 37.5, 0.02
WIDTH, HEIGHT = int(round((E - W) / RES)), int(round((N - S) / RES))
PROPS = ['clay', 'sand', 'silt', 'cfvo', 'bdod', 'soc', 'phh2o']
DEPTHS = {'0-5cm': 5, '5-15cm': 10, '15-30cm': 15}
WCS = ('https://maps.isric.org/mapserv?map=/map/{p}.map&SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage'
       '&COVERAGEID={p}_{d}_mean&FORMAT=image/tiff&SUBSET=X({w},{e})&SUBSET=Y({s},{n})'
       '&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326&OUTPUTCRS=http://www.opengis.net/def/crs/EPSG/0/4326'
       '&SCALESIZE=X({cols}),Y({rows})')
out = sys.argv[1]
t0 = time.time()


def read(job):
    prop, depth = job
    url = WCS.format(p=prop, d=depth, w=W, e=E, s=S, n=N, cols=WIDTH, rows=HEIGHT)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                data = r.read()
            with MemoryFile(data) as mem, mem.open() as src:
                assert (src.width, src.height) == (WIDTH, HEIGHT), (src.width, src.height)
                a = src.read(1).astype('float32')
            break
        except Exception as err:  # retry transient server/network errors
            if attempt == 3:
                raise
            print(f'  {prop} {depth}: retry ({err})', flush=True)
            time.sleep(5 * (attempt + 1))
    a[a <= 0] = np.nan  # SoilGrids uses 0 / nodata for water, rock, ice, built-up
    print(f'  {prop} {depth}: {np.isfinite(a).mean() * 100:.0f}% cells with data, {time.time() - t0:.0f}s', flush=True)
    return job, a


jobs = [(p, d) for p in PROPS for d in DEPTHS]
with ThreadPoolExecutor(max_workers=4) as pool:
    layers = dict(pool.map(read, jobs))

with open(out, 'wb') as fh:
    fh.write(b'SOIL')
    fh.write(struct.pack('<I5dII', 1, W, S, E, N, RES, WIDTH, HEIGHT))
    fh.write(struct.pack('<I', len(PROPS)))
    for p in PROPS:
        fh.write(p.encode().ljust(8, b'\0'))
    for p in PROPS:
        stack = np.stack([layers[(p, d)] for d in DEPTHS])
        w = np.array(list(DEPTHS.values()), dtype='float32')[:, None, None]
        ok = np.isfinite(stack)
        mean = np.where(ok, stack, 0).__mul__(w).sum(0) / np.maximum((ok * w).sum(0), 1e-9)
        mean[~ok.any(0)] = np.nan
        fh.write(np.where(np.isfinite(mean), np.round(mean), -32768).astype('<i2').tobytes())
print(f'wrote {out} ({WIDTH}x{HEIGHT}, {len(PROPS)} properties) in {time.time() - t0:.0f}s', flush=True)
