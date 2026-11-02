/**
 * Forest Eyes — Tree Loss "Dot form" and "Colour form" on the 3D Earth (globe-layers.js)
 * =====================================================================================
 * Loaded AFTER app.js. app.js calls ForestGlobeLayers.refresh() from syncTreeLossLayer()
 * and clearMapLayers(); this file also listens to the 3D Earth toggle. (Heatmap mode on
 * the globe is drawn by heatmap.js.)
 *
 *   Dot form    → the same UMD/Hansen loss tiles as the 2D Tree Loss layer, wrapped onto
 *                 the globe at the same opacity.
 *   Colour form → worldwide loss coloured with the 2D colour form's palette
 *                 (yellow = isolated loss → orange → red = dense clusters), plus the zones
 *                 of the last analysis (the same circles app.js draws in 2D), enlarged to a
 *                 minimum size so they stay visible from orbit.
 *
 * Everything is a child of the original earth mesh (rotates with it, hidden with it);
 * the earth's own geometry, material and lights are never changed.
 */
(function () {
  'use strict';

  const CONFIG = {
    lossZoom: 3,          // GFW tile zoom used for the globe (3 → 2048×1024 texture)
    radius: 1.0015,       // overlay sphere, just above the earth
    coverRadius: 1.001,   // Tree Cover sphere: between the earth and the loss overlay
    coverOpacity: 0.7,    // same as the 2D Tree Cover layer
    dotOpacity: 0.85,     // same as the 2D Tree Loss layer
    colourGlobal: true,   // Colour form also colours worldwide loss on the globe
    colourBlur: 2,        // px neighbourhood used to grade loss density
    colourGain: 4,        // how quickly density turns red
    colourMinAlpha: 0.85, // every loss pixel is at least this opaque (vivid, not washed out)
    zoneMinDeg: 2.5,      // analysed area drawn at least this big (radius, degrees)
    zoneMinOpacity: 0.35,
    zoneOpacityBoost: 1.8,
  };

  // The 2D colour form's own colours (app.js treeLossColor / renderTreeLossColorForm)
  const PALETTE = [[0, '#ffd166'], [0.5, '#ff9800'], [1, '#f44336']];
  const EARTH_RADIUS_M = 6371000;
  const MAX_MERC_LAT = 85.0511287798;

  // ---------------------------------------------------------------------
  // Pure helpers (unit tested)
  // ---------------------------------------------------------------------
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const hexToRgb = hex => { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  const PAL_RGB = PALETTE.map(([t, c]) => [t, hexToRgb(c)]);

  function paletteRgb(t) {
    const x = clamp(Number.isFinite(t) ? t : 0, 0, 1);
    for (let i = 1; i < PAL_RGB.length; i++) {
      const [t1, b] = PAL_RGB[i];
      if (x <= t1) {
        const [t0, a] = PAL_RGB[i - 1];
        const f = (x - t0) / (t1 - t0 || 1);
        return a.map((v, k) => Math.round(v + (b[k] - v) * f));
      }
    }
    return PAL_RGB[PAL_RGB.length - 1][1];
  }

  /** Earth-local unit vector for lat/lng — same convention as app.js focusGlobeOnCoordinates. */
  function latLngToVec(lat, lng) {
    const phi = (lng + 180) * Math.PI / 180;
    const theta = (90 - lat) * Math.PI / 180;
    return [-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)];
  }

  /** Local east / north unit vectors at lat/lng (tangent plane). */
  function tangentBasis(lat, lng) {
    const phi = (lng + 180) * Math.PI / 180;
    const theta = (90 - lat) * Math.PI / 180;
    return {
      east: [Math.sin(phi), 0, Math.cos(phi)],
      north: [Math.cos(phi) * Math.cos(theta), Math.sin(theta), -Math.sin(phi) * Math.cos(theta)],
    };
  }

  function boxBlur(src, w, h, r) {
    if (r <= 0) return src;
    const tmp = new Float32Array(src.length);
    const dst = new Float32Array(src.length);
    const norm = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + ((k + w) % w)];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s * norm; // horizontally wraps around the date line
        s += src[y * w + ((x + r + 1) % w)] - src[y * w + ((x - r + w) % w)];
      }
    }
    // Vertical pass: running column sums, row by row (O(w·h), memory-friendly). Rows outside the
    // image count as 0, exactly like the previous per-pixel loop.
    const col = new Float32Array(w);
    for (let y = 0; y <= Math.min(r, h - 1); y++) for (let x = 0; x < w; x++) col[x] += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) dst[row + x] = col[x] * norm;
      const add = y + r + 1, sub = y - r;
      if (add < h) for (let x = 0; x < w; x++) col[x] += tmp[add * w + x];
      if (sub >= 0) for (let x = 0; x < w; x++) col[x] -= tmp[sub * w + x];
    }
    return dst;
  }

  /** Loss RGBA (equirect) → Colour form RGBA, in place into `out`. */
  function colourise(rgba, w, h, out) {
    const strength = new Float32Array(w * h);
    for (let i = 0; i < strength.length; i++) strength[i] = (rgba[i * 4] / 255) * (rgba[i * 4 + 3] / 255);
    const density = boxBlur(boxBlur(strength, w, h, CONFIG.colourBlur), w, h, CONFIG.colourBlur);
    for (let i = 0; i < strength.length; i++) {
      const presence = rgba[i * 4 + 3] / 255;
      const d = density[i];
      if (presence < 0.02 && d < 0.02) { out[i * 4 + 3] = 0; continue; }
      const [r, g, b] = paletteRgb(Math.min(1, d * CONFIG.colourGain));
      const alpha = Math.max(presence > 0.02 ? CONFIG.colourMinAlpha : 0, Math.min(0.7, d * 3));
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = Math.round(alpha * 255);
    }
    return out;
  }

  /**
   * RGBA (top row first) → texture data (bottom row first) whose fully transparent pixels
   * carry the colour of nearby loss pixels instead of black. When the globe shrinks the
   * texture (mipmaps / filtering), sparse loss then fades out as red, not as dark smudges.
   */
  function bleedAndFlip(rgba, w, h, radius = 3) {
    const n = w * h;
    const pr = new Float32Array(n), pg = new Float32Array(n), pb = new Float32Array(n), pa = new Float32Array(n);
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let i = 0; i < n; i++) {
      const a = rgba[i * 4 + 3] / 255;
      pr[i] = rgba[i * 4] * a; pg[i] = rgba[i * 4 + 1] * a; pb[i] = rgba[i * 4 + 2] * a; pa[i] = a;
      sr += pr[i]; sg += pg[i]; sb += pb[i]; sa += a;
    }
    const fallback = sa > 0 ? [sr / sa, sg / sa, sb / sa] : [0, 0, 0];
    const blur = c => boxBlur(boxBlur(c, w, h, radius), w, h, radius);
    const br = blur(pr), bg = blur(pg), bb = blur(pb), ba = blur(pa);
    const out = new Uint8Array(n * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = ((h - 1 - y) * w + x) * 4; // flip: texture rows start at the bottom (south)
        if (rgba[i * 4 + 3] > 0) {
          out[o] = rgba[i * 4]; out[o + 1] = rgba[i * 4 + 1]; out[o + 2] = rgba[i * 4 + 2];
        } else if (ba[i] > 1e-4) {
          out[o] = Math.round(br[i] / ba[i]); out[o + 1] = Math.round(bg[i] / ba[i]); out[o + 2] = Math.round(bb[i] / ba[i]);
        } else {
          out[o] = Math.round(fallback[0]); out[o + 1] = Math.round(fallback[1]); out[o + 2] = Math.round(fallback[2]);
        }
        out[o + 3] = rgba[i * 4 + 3];
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Loss imagery (shared by Dot and Colour form)
  // ---------------------------------------------------------------------
  let loss = null; // { state: 'loading' | 'ready' | 'failed', dotTex, colourTex }

  function lossTileUrl(x, y, z) {
    // The globe must READ the pixels, which GFW's tile server does not always allow cross-site
    // (CORS). Our server forwards the same tiles from our own origin (backend: /tiles/gfw-loss).
    if (location.protocol.startsWith('http')) return `/tiles/gfw-loss/${z}/${x}/${y}.png`;
    const tpl = (typeof treeLossLayer !== 'undefined' && treeLossLayer._url) ||
      'https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/tcd_30/{z}/{x}/{y}.png';
    return L.Util.template(tpl, { x, y, z, s: '', r: '' });
  }

  function loadTile(url) {
    return new Promise(resolve => {
      const img = new Image();
      let retried = false;
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        // The 2D map caches these tiles without CORS; a distinct URL fetches a CORS copy.
        if (retried) return resolve(null);
        retried = true;
        img.src = url + (url.includes('?') ? '&' : '?') + 'fwglobe=1';
      };
      img.src = url;
    });
  }

  const pause = () => new Promise(r => setTimeout(r, 0)); // let the browser draw a frame

  /** Loads a whole zoom level of tiles; resolves to an equirectangular canvas, or null if none loaded. */
  function loadEquirect(tileUrl, z) {
    const n = Math.pow(2, z);
    const W = 256 * n;
    const jobs = [];
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) jobs.push(loadTile(tileUrl(x, y, z)).then(img => ({ x, y, img })));
    }
    return Promise.all(jobs).then(tiles => {
      const ok = tiles.filter(t => t.img);
      if (!ok.length) return null;
      // Mercator mosaic → equirectangular texture (the globe's own projection).
      const merc = document.createElement('canvas');
      merc.width = merc.height = W;
      const mctx = merc.getContext('2d');
      ok.forEach(({ x, y, img }) => mctx.drawImage(img, x * 256, y * 256, 256, 256));
      const H = W / 2;
      const eq = document.createElement('canvas');
      eq.width = W;
      eq.height = H;
      const ectx = eq.getContext('2d');
      for (let j = 0; j < H; j++) {
        const lat = clamp(90 - ((j + 0.5) / H) * 180, -MAX_MERC_LAT, MAX_MERC_LAT) * Math.PI / 180;
        const my = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2 * W;
        ectx.drawImage(merc, 0, Math.min(Math.floor(my), W - 1), W, 1, 0, j, W, 1);
      }
      return { eq, ectx, W, H };
    });
  }

  function ensureLoss() {
    if (loss && loss.state !== 'failed') return;
    loss = { state: 'loading' };
    const current = loss;
    loadEquirect(lossTileUrl, CONFIG.lossZoom).then(async mosaic => {
      if (loss !== current) return;
      if (!mosaic) {
        console.warn('[globe-layers] Tree loss tiles could not be loaded for the 3D globe (network or CORS). ' +
          'Dot/Colour form show only the analysis zones on the globe.');
        current.state = 'failed';
        return refresh();
      }
      const { eq, ectx, W, H } = mosaic;
      try {
        await pause();
        const data = ectx.getImageData(0, 0, W, H).data;
        await pause();
        current.dotTex = makeDataTexture(bleedAndFlip(data, W, H), W, H);
        // Colour form texture is built the first time Colour form is shown (see colourTexture())
        current.raw = { data, W, H };
      } catch (err) {
        console.warn('[globe-layers] Could not read loss tiles; showing them unprocessed:', err.message);
        current.dotTex = makeTexture(eq);
      }
      current.state = 'ready';
      refresh();
    });
  }

  /** Colour form texture, built on first use (it is the slowest step and Dot form never needs it). */
  function colourTexture() {
    if (!loss || loss.state !== 'ready') return null;
    if (!loss.colourTex && loss.raw) {
      const { data, W, H } = loss.raw;
      const coloured = colourise(data, W, H, new Uint8ClampedArray(W * H * 4));
      loss.colourTex = makeDataTexture(bleedAndFlip(coloured, W, H), W, H);
    }
    return loss.colourTex || null;
  }

  // ---------------------------------------------------------------------
  // Tree Cover 2000 imagery (the 2D Tree Cover layer, under the loss)
  // ---------------------------------------------------------------------
  let cover = null; // { state: 'loading' | 'ready' | 'failed', tex }

  function coverTileUrl(x, y, z) {
    if (location.protocol.startsWith('http')) return `/tiles/gfw-cover/${z}/${x}/${y}.png`; // backend: same-origin copy
    const tpl = (typeof treeCoverLayer !== 'undefined' && treeCoverLayer._url) ||
      'https://tiles.globalforestwatch.org/umd_tree_cover_density_2000/v1.8/tcd_30/{z}/{x}/{y}.png';
    return L.Util.template(tpl, { x, y, z, s: '', r: '' });
  }

  function ensureCover() {
    if (cover && cover.state !== 'failed') return;
    cover = { state: 'loading' };
    const current = cover;
    loadEquirect(coverTileUrl, CONFIG.lossZoom).then(async mosaic => {
      if (cover !== current) return;
      if (!mosaic) {
        console.warn('[globe-layers] Tree cover tiles could not be loaded for the 3D globe (network or CORS).');
        current.state = 'failed';
        return refresh();
      }
      const { eq, ectx, W, H } = mosaic;
      try {
        await pause();
        current.tex = makeDataTexture(bleedAndFlip(ectx.getImageData(0, 0, W, H).data, W, H), W, H);
      } catch (err) {
        console.warn('[globe-layers] Could not read tree cover tiles; showing them unprocessed:', err.message);
        current.tex = makeTexture(eq);
      }
      current.state = 'ready';
      refresh();
    });
  }

  function makeDataTexture(data, w, h) {
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = globeScene?.renderer?.capabilities?.getMaxAnisotropy?.() || 1;
    tex.needsUpdate = true;
    return tex;
  }

  function makeTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = globeScene?.renderer?.capabilities?.getMaxAnisotropy?.() || 1;
    return tex;
  }

  // ---------------------------------------------------------------------
  // Meshes (children of the original earth)
  // ---------------------------------------------------------------------
  let overlay = null;
  let coverOverlay = null;
  let zones = null;
  let zonesKey = '';

  function ensureMeshes() {
    if (overlay || typeof THREE === 'undefined' || !globeScene) return;
    coverOverlay = new THREE.Mesh(
      new THREE.SphereGeometry(CONFIG.coverRadius, 128, 64),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: CONFIG.coverOpacity })
    );
    coverOverlay.renderOrder = 1; // drawn before (under) the loss overlay
    coverOverlay.visible = false;
    globeScene.earth.add(coverOverlay);
    overlay = new THREE.Mesh(
      new THREE.SphereGeometry(CONFIG.radius, 128, 64), // same UV layout as the earth
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
    );
    overlay.renderOrder = 2;
    overlay.visible = false;
    globeScene.earth.add(overlay);
    zones = new THREE.Group();
    globeScene.earth.add(zones);
  }

  function clearZones() {
    zones?.children.slice().forEach(m => {
      zones.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
  }

  /** Re-creates the analysis zones from the 2D colour-form circles. */
  function buildZones(show) {
    const layers = show && typeof treeLossColorLayer !== 'undefined'
      ? treeLossColorLayer.getLayers().filter(l => l.getLatLng && l.getRadius)
      : [];
    const key = layers.map(l => { const p = l.getLatLng(); return `${p.lat},${p.lng},${l.getRadius()},${l.options.fillColor}`; }).join('|');
    if (key === zonesKey) return;
    zonesKey = key;
    clearZones();
    if (!layers.length) return;

    const c = (typeof latestLossCenter !== 'undefined' && latestLossCenter) || layers[0].getLatLng();
    const cosLat = Math.max(Math.cos(c.lat * Math.PI / 180), 0.18);
    const offsetDeg = ll => [(ll.lng - c.lng) * cosLat, ll.lat - c.lat]; // east, north (degrees)
    let extent = 0;
    layers.forEach(l => {
      const [e, n] = offsetDeg(l.getLatLng());
      extent = Math.max(extent, Math.hypot(e, n) + (l.getRadius() / EARTH_RADIUS_M) * 180 / Math.PI);
    });
    const k = Math.max(1, CONFIG.zoneMinDeg / Math.max(extent, 1e-6)); // enlarge to stay visible
    const centre = latLngToVec(c.lat, c.lng);
    const { east, north } = tangentBasis(c.lat, c.lng);
    const zAxis = new THREE.Vector3(0, 0, 1);
    let outer = 0;

    layers.forEach((l, i) => {
      const [e, n] = offsetDeg(l.getLatLng()).map(v => v * k * Math.PI / 180);
      const dir = new THREE.Vector3(
        centre[0] + east[0] * e + north[0] * n,
        centre[1] + east[1] * e + north[1] * n,
        centre[2] + east[2] * e + north[2] * n
      ).normalize();
      const ang = (l.getRadius() / EARTH_RADIUS_M) * k;
      outer = Math.max(outer, ang + Math.hypot(e, n));
      const o = l.options;
      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(ang, 64),
        new THREE.MeshBasicMaterial({
          color: o.fillColor || o.color || '#ff9800',
          transparent: true,
          opacity: clamp((o.fillOpacity ?? 0.4) * CONFIG.zoneOpacityBoost, CONFIG.zoneMinOpacity, 0.92),
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      mesh.position.copy(dir).multiplyScalar(CONFIG.radius + 0.0006 + i * 0.0002);
      mesh.quaternion.setFromUnitVectors(zAxis, dir);
      mesh.renderOrder = 4 + i;
      zones.add(mesh);
    });

    // Crisp outline so the analysed area reads clearly from orbit.
    const dir = new THREE.Vector3(...centre);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(outer * 0.96, outer, 96),
      new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide })
    );
    ring.position.copy(dir).multiplyScalar(CONFIG.radius + 0.0006 + layers.length * 0.0002);
    ring.quaternion.setFromUnitVectors(zAxis, dir);
    ring.renderOrder = 4 + layers.length;
    zones.add(ring);
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  function refresh() {
    if (typeof globeScene === 'undefined' || !globeScene) return; // globe is created lazily
    ensureMeshes();
    if (!overlay) return;
    const enabled = document.getElementById('toggle-tree-loss')?.checked ?? true;
    const mode = document.getElementById('tree-loss-mode')?.value || 'dots';
    const wantDots = enabled && mode === 'dots';
    const wantColour = enabled && mode === 'color';

    if (wantDots || (wantColour && CONFIG.colourGlobal)) ensureLoss();
    const ready = loss?.state === 'ready';
    const tex = !ready ? null : wantDots ? loss.dotTex : wantColour && CONFIG.colourGlobal ? colourTexture() : null;
    if (overlay.material.map !== tex) {
      overlay.material.map = tex;
      overlay.material.needsUpdate = true;
    }
    overlay.material.opacity = wantDots ? CONFIG.dotOpacity : 1;
    overlay.visible = !!tex;
    buildZones(wantColour);

    // Tree Cover: hidden in Heatmap form, as heatmap.js hides it on the 2D map
    const wantCover = (document.getElementById('toggle-tree-cover')?.checked ?? true) && !(enabled && mode === 'heatmap');
    if (wantCover) ensureCover();
    const coverTex = wantCover && cover?.state === 'ready' ? cover.tex : null;
    if (coverOverlay.material.map !== coverTex) {
      coverOverlay.material.map = coverTex;
      coverOverlay.material.needsUpdate = true;
    }
    coverOverlay.visible = !!coverTex;
  }

  // The globe is created by app.js's toggle listener, which runs before this one.
  document.getElementById('toggle-globe')?.addEventListener('change', refresh);
  document.getElementById('toggle-tree-cover')?.addEventListener('change', refresh);

  window.ForestGlobeLayers = {
    refresh,
    // Exposed for testing
    _test: { paletteRgb, latLngToVec, tangentBasis, colourise, boxBlur, bleedAndFlip, CONFIG },
  };
})();
