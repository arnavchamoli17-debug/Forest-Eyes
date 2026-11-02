/**
 * Forest Eyes — 2D map → 3D Earth transition (globe-transition.js)
 * =================================================================
 * Loaded AFTER app.js (and heatmap.js). app.js calls
 * ForestGlobeTransition.onToggle(showGlobe) at the end of the "3D Earth" toggle handler.
 *
 * Sequence (2D → 3D only; 3D → 2D keeps the original instant switch):
 *   1. Zoom-out on the real Leaflet map to a whole-world view (skipped if already there).
 *   2. Cross-fade to a temporary WebGL sheet that is pixel-aligned with that view and
 *      textured with the same base-map tiles (Mercator), so only overlays fade.
 *   3. The camera pulls back, the sheet un-projects Mercator → equirectangular and
 *      bends into a sphere: an isometric "partial sphere" whose radius shrinks from
 *      infinity to 1, so the edges curl backwards without stretching.
 *   4. Lighting goes from unlit (flat map look) to the globe's own Phong lighting, and
 *      the sheet's orientation slerps into the original earth's live orientation.
 *   5. Once its geometry coincides with the original earth, the original is shown and
 *      the sheet fades out over it; then the sheet is disposed.
 *
 * It reuses the existing renderer, scene, camera, lights and render loop (it hooks
 * scene.onBeforeRender), never touches the original earth's geometry or material,
 * and restores everything it changed on completion or cancellation.
 */
(function () {
  'use strict';

  const CONFIG = {
    flySeconds: 1.1,     // Leaflet zoom-out to the world view (skipped if already there)
    tileWaitMs: 2500,    // max extra wait for imagery after the zoom-out
    crossfadeMs: 400,    // DOM map → aligned WebGL sheet
    pullBackMs: 750,     // camera pulls back from the flat sheet
    wrapStartAt: 0.5,    // wrapping starts this far into the pull-back
    wrapMs: 2400,        // flat sheet → sphere
    handoffMs: 700,      // sheet fades out over the original globe
    earthWaitMs: 6000,   // max hold for the original globe's texture before handing off
    pullBack: 1.3,       // pull-back distance factor
    segX: 192,           // sheet tessellation (columns / rows)
    segY: 96,
    lowZoom: 2,          // low-res underlay that fills any missing high-res tile
    maxZoom: 4,          // highest mosaic zoom (4 → 4096 px square texture)
    handoffLift: 0.002,  // sheet sits this much above the globe while fading (no z-fighting)
  };

  const TAU = Math.PI * 2;
  const MAX_MERC_LAT = 85.0511287798;

  // ---------------------------------------------------------------------
  // Pure helpers (no DOM / THREE — unit tested)
  // ---------------------------------------------------------------------
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const clamp01 = v => clamp(v, 0, 1);
  const mix = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

  /** Web Mercator y in the same units as longitude in radians (±π at the cut-off). */
  function mercY(latDeg) {
    const phi = clamp(latDeg, -MAX_MERC_LAT, MAX_MERC_LAT) * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + phi / 2));
  }

  /**
   * One vertex of the bending sheet, in the sheet's local frame.
   * uRel: horizontal position (-0.5..0.5 of the world width = 2π units).
   * yFlat: vertical flat coordinate (radians-like units).
   * lambda: longitude span the sheet currently wraps (0 = flat, 2π = full sphere).
   * The sheet is bent onto a sphere of radius 2π/lambda, so the equator and the central
   * meridian keep their length (no stretching), and the front point stays at z = 1.
   * At lambda = 2π this is exactly a unit sphere centred on the local origin.
   */
  function wrapVertex(uRel, yFlat, lambda, out = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 }) {
    if (lambda < 1e-6) {
      out.x = TAU * uRel; out.y = yFlat; out.z = 1;
      out.nx = 0; out.ny = 0; out.nz = 1;
      return out;
    }
    const R = TAU / lambda;
    const lon = uRel * lambda;
    const lat = clamp(yFlat / R, -Math.PI / 2, Math.PI / 2);
    const cl = Math.cos(lat);
    out.nx = cl * Math.sin(lon);
    out.ny = Math.sin(lat);
    out.nz = cl * Math.cos(lon);
    out.x = R * out.nx;
    out.y = R * out.ny;
    out.z = R * (out.nz - 1) + 1;
    return out;
  }

  /**
   * Yaw (about +y) that maps the original earth's local frame onto the sheet's frame,
   * for a sheet centred on texture u = uc. THREE.SphereGeometry puts texture u at
   * (-cos 2πu, ·, sin 2πu); the full-wrap sheet puts it at (sin 2π(u-uc), ·, cos 2π(u-uc)).
   */
  const sheetYaw = uc => Math.PI / 2 - TAU * uc;

  /** Camera distance at which the flat sheet matches Leaflet's scale at `zoom`. */
  function flatDistance(viewHeightPx, zoom, fovDeg) {
    const unitsPerPx = TAU / (256 * Math.pow(2, zoom));
    return (viewHeightPx * unitsPerPx) / (2 * Math.tan((fovDeg * Math.PI / 180) / 2));
  }

  /** Smallest whole zoom at which one world copy is at least as wide as the view. */
  const fitZoom = widthPx => Math.max(0, Math.ceil(Math.log2(Math.max(widthPx, 1) / 256)));

  /** Mosaic zoom for a start zoom, device pixel ratio and GPU texture limit. */
  function mosaicZoom(startZoom, dpr, maxTextureSize) {
    let z = clamp(Math.round(startZoom + Math.log2(Math.max(dpr, 1))), CONFIG.lowZoom, CONFIG.maxZoom);
    while (z > CONFIG.lowZoom && 256 * Math.pow(2, z) > maxTextureSize) z--;
    return z;
  }

  // ---------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  function activeBase() {
    if (typeof satelliteBase !== 'undefined' && map.hasLayer(satelliteBase)) return satelliteBase;
    if (typeof darkBase !== 'undefined' && map.hasLayer(darkBase)) return darkBase;
    return typeof satelliteBase !== 'undefined' ? satelliteBase : null;
  }

  function tileUrl(layer, x, y, z) {
    const subs = layer.options.subdomains || '';
    const s = subs.length ? subs[Math.abs(x + y) % subs.length] : '';
    return L.Util.template(layer._url, Object.assign({}, layer.options, {
      s, x, y, z, r: L.Browser.retina ? '@2x' : '', // same {r} rule as Leaflet's getTileUrl
    }));
  }

  function textureReady(tex) {
    const img = tex?.image;
    if (!img) return false;
    if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
      return img.complete && img.naturalWidth > 0;
    }
    return true; // canvas / bitmap
  }

  /** Where the 2D view will start from, and which imagery to load for it. */
  function plan() {
    const size = map.getSize();
    const target = fitZoom(size.x);
    const startZoom = Math.min(map.getZoom(), target);
    const maxTex = globeScene?.renderer?.capabilities?.maxTextureSize || 4096;
    const base = activeBase();
    const zm = mosaicZoom(startZoom, dpr(), maxTex);
    return { size, target, startZoom, base, zm, key: base ? `${base._url}|${zm}` : '' };
  }

  // ---------------------------------------------------------------------
  // Imagery: whole-world mosaic of the active base map (Mercator)
  // ---------------------------------------------------------------------
  function loadTile(url) {
    return new Promise(resolve => {
      const img = new Image();
      let retried = false;
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => img.decode().then(() => resolve(img), () => resolve(img)); // not decoded inside toCanvas
      img.onerror = () => {
        // A cached non-CORS copy (from the Leaflet <img>) can fail a CORS request once.
        if (retried) return resolve(null);
        retried = true;
        img.src = url + (url.includes('?') ? '&' : '?') + 'fwcors=1';
      };
      img.src = url;
    });
  }

  function createMosaic(layer, zHigh, key) {
    const levels = [CONFIG.lowZoom, zHigh].filter((z, i, a) => a.indexOf(z) === i);
    const tiles = levels.map(z => {
      const n = Math.pow(2, z);
      const level = { z, total: n * n, loaded: [] };
      const jobs = [];
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
          jobs.push(loadTile(tileUrl(layer, x, y, z)).then(img => { if (img) level.loaded.push({ x, y, img }); }));
        }
      }
      level.done = Promise.all(jobs);
      return level;
    });

    return {
      key,
      zHigh,
      done: Promise.all(tiles.map(t => t.done)),
      /** Composes every tile loaded so far; null if coverage is too poor to use. */
      toCanvas() {
        const size = 256 * Math.pow(2, zHigh);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0a1628'; // Leaflet container background
        ctx.fillRect(0, 0, size, size);
        let coverage = 0;
        tiles.forEach(t => { // low-res underlay first, high-res on top
          const cell = size / Math.pow(2, t.z);
          t.loaded.forEach(({ x, y, img }) => ctx.drawImage(img, x * cell, y * cell, cell, cell));
          coverage = Math.max(coverage, t.loaded.length / t.total);
        });
        // No taint check (getImageData stalled ~60 ms reading the canvas back from the GPU): every
        // tile is loaded with crossOrigin, and a tile failing CORS fires onerror, never onload.
        return coverage >= 0.95 ? canvas : null;
      },
    };
  }

  let preloaded = null;
  function getMosaic(p) {
    if (!p.base) return null;
    if (!preloaded || preloaded.key !== p.key) preloaded = createMosaic(p.base, p.zm, p.key);
    return preloaded;
  }

  // The mosaic's texture is made once per base map and view size, ahead of time when possible, and
  // kept for both directions: composing and uploading it in the first frames of a switch stalled
  // them ~140 ms (2048²), and 3D → 2D used to rebuild it every time.
  let sheetTex = null; // { key, texture }

  function makeSheetTexture(mosaic) {
    const canvas = mosaic.toCanvas();
    if (!canvas || typeof globeScene === 'undefined' || !globeScene) return null;
    const texture = new THREE.CanvasTexture(canvas); // (an ImageBitmap of it cost more: 20–40 ms to make)
    texture.colorSpace = THREE.SRGBColorSpace; // shows tile colours exactly like the <img> tiles
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = globeScene.renderer.capabilities.getMaxAnisotropy?.() || 1;
    globeScene.renderer.initTexture(texture); // upload now, not in an animated frame
    return texture;
  }

  function keepSheetTexture(key, texture) {
    const old = sheetTex?.texture;
    if (old && old !== texture && !(run && run.texture === old)) old.dispose();
    sheetTex = { key, texture };
  }

  /**
   * Start loading imagery early (hover / focus on the 3D toggle, globe-zoom.js's warm-up), and make
   * the sheet texture while the browser is idle with the 2D map on screen.
   */
  function preload() {
    if (run || typeof map === 'undefined' || reducedMotion()) return;
    try {
      const p = plan();
      if (sheetTex?.key === p.key) return;
      const mosaic = getMosaic(p);
      const idle = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 500));
      mosaic?.done.then(() => idle(() => {
        if (run || preloaded !== mosaic || sheetTex?.key === p.key || $('toggle-globe')?.checked) return;
        const texture = makeSheetTexture(mosaic);
        if (!texture) return;
        keepSheetTexture(p.key, texture);
        if (preloaded === mosaic) preloaded = null; // release decoded tile images
      }));
    } catch (err) { /* preloading is best effort */ }
  }

  // ---------------------------------------------------------------------
  // Temporary morph mesh
  // ---------------------------------------------------------------------
  function buildSheet(uc, projection) {
    const nx = CONFIG.segX + 1;
    const ny = CONFIG.segY + 1;
    const uRel = new Float64Array(nx);
    const latRad = new Float64Array(ny);
    const merc = new Float64Array(ny);
    const uv = new Float32Array(nx * ny * 2);
    for (let i = 0; i < nx; i++) uRel[i] = i / CONFIG.segX - 0.5;
    for (let j = 0; j < ny; j++) {
      const latDeg = -90 + (180 * j) / CONFIG.segY;
      latRad[j] = latDeg * Math.PI / 180;
      merc[j] = mercY(latDeg);
      const v = projection === 'mercator' ? 0.5 + merc[j] / TAU : 0.5 + latDeg / 180;
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 2;
        uv[k] = uc + uRel[i]; // RepeatWrapping makes the wrap-around seamless
        uv[k + 1] = v;
      }
    }
    const index = [];
    for (let j = 0; j < CONFIG.segY; j++) {
      for (let i = 0; i < CONFIG.segX; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        index.push(a, b, d, a, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(index);
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return { geometry, uRel, latRad, merc, nx, ny };
  }

  const tmp = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
  function updateSheet(sheet, lambda, w) {
    const pos = sheet.geometry.attributes.position;
    const nor = sheet.geometry.attributes.normal;
    const P = pos.array, N = nor.array;
    for (let j = 0; j < sheet.ny; j++) {
      const yFlat = mix(sheet.merc[j], sheet.latRad[j], w); // Mercator → equirectangular
      for (let i = 0; i < sheet.nx; i++) {
        wrapVertex(sheet.uRel[i], yFlat, lambda, tmp);
        const k = (j * sheet.nx + i) * 3;
        P[k] = tmp.x; P[k + 1] = tmp.y; P[k + 2] = tmp.z;
        N[k] = tmp.nx; N[k + 1] = tmp.ny; N[k + 2] = tmp.nz;
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }

  // ---------------------------------------------------------------------
  // Run state
  // ---------------------------------------------------------------------
  let run = null;

  function canRun() {
    return typeof THREE !== 'undefined' && typeof map !== 'undefined' && typeof L !== 'undefined' &&
      typeof globeScene !== 'undefined' && globeScene && !reducedMotion() &&
      document.visibilityState !== 'hidden' && !!activeBase();
  }

  function newRun(dir) {
    const container = $('globe-container');
    const controls = $('globe-controls');
    const mapEl = $('map');
    const { camera, earth, scene } = globeScene;
    return {
      dir, // 'in' = 2D → 3D, 'out' = 3D → 2D
      phase: 'prep',
      container, controls, mapEl, scene,
      saved: {
        center: map.getCenter(),
        zoom: map.getZoom(),
        camZ: camera.position.z,
        earthVisible: earth.visible,
        containerOpacity: container.style.opacity,
        containerPointer: container.style.pointerEvents,
        controlsOpacity: controls?.style.opacity ?? '',
        controlsPointer: controls?.style.pointerEvents ?? '',
        mapPointer: mapEl.style.pointerEvents,
      },
      flew: false,
      viewRestored: false,
    };
  }

  /** 2D → 3D. Called right after app.js switched to the globe. */
  function start() {
    if (!canRun()) return false;
    const r = newRun('in');
    run = r;

    // Keep the 2D map on screen until the sheet has taken its place.
    r.mapEl.classList.remove('hidden');
    r.container.style.opacity = '0';
    r.container.style.pointerEvents = 'none';
    if (r.controls) { r.controls.style.opacity = '0'; r.controls.style.pointerEvents = 'none'; }
    globeScene.earth.visible = false; // original globe stays initialised, just not drawn until the handoff

    prepare(r).catch(err => {
      console.warn('[transition] skipped:', err?.message || err);
      if (run === r) finishNow(r);
    });
    return true;
  }

  /** 3D → 2D. Called right after app.js switched back to the map. */
  function startReverse() {
    if (!canRun()) return false;
    const r = newRun('out');
    run = r;

    // Keep the globe on screen (on top of the map) until the sheet has flattened.
    r.container.classList.remove('hidden');
    r.container.style.pointerEvents = 'none';
    r.mapEl.style.pointerEvents = 'none';
    map.invalidateSize?.({ pan: false }); // the map was display:none while in 3D

    prepare(r).catch(err => {
      console.warn('[transition] skipped:', err?.message || err);
      if (run === r) finishNow(r);
    });
    return true;
  }

  async function loadSheetTexture(r, p) {
    if (sheetTex?.key === p.key) return { texture: sheetTex.texture, projection: 'mercator', shared: true };
    const mosaic = getMosaic(p);
    if (mosaic) {
      await Promise.race([mosaic.done, delay(CONFIG.tileWaitMs)]);
      if (run !== r) return null;
      const texture = makeSheetTexture(mosaic);
      preloaded = null; // release decoded tile images
      if (texture) {
        keepSheetTexture(p.key, texture);
        return run === r ? { texture, projection: 'mercator', shared: true } : null;
      }
    }
    preloaded = null;
    // Fallback: the original globe's texture (equirectangular), with its own sampler settings
    const src = globeScene.earth.material.map;
    const until = performance.now() + CONFIG.earthWaitMs;
    while (!textureReady(src) && performance.now() < until) {
      await delay(100);
      if (run !== r) return null;
    }
    if (!textureReady(src)) return null;
    const texture = new THREE.Texture(src.image); // same image: never closed or kept
    texture.colorSpace = src.colorSpace;
    texture.flipY = src.flipY;
    texture.needsUpdate = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = globeScene.renderer.capabilities.getMaxAnisotropy?.() || 1;
    return { texture, projection: 'equirect', shared: false };
  }

  async function prepare(r) {
    const p = plan();

    if (r.dir === 'in') {
      if (sheetTex?.key !== p.key) getMosaic(p); // start loading while the map zooms out
      // 1. Zoom-out on the real 2D map.
      if (map.getZoom() > p.target) {
        r.flew = true;
        await new Promise(resolve => {
          const timer = setTimeout(resolve, CONFIG.flySeconds * 1000 + 600);
          map.once('moveend', () => { clearTimeout(timer); resolve(); });
          map.flyTo(map.getCenter(), p.target, { duration: CONFIG.flySeconds });
        });
        if (run !== r) return;
      }
    } else {
      // The 2D map ends where it is now (search/analysis may have moved it while in 3D).
      // Under the globe, put it at the world view the sheet will flatten into, so its
      // tiles load during the animation; it zooms back in after the cross-fade.
      r.target = { center: map.getCenter(), zoom: map.getZoom() };
      map.setView(r.target.center, p.startZoom, { animate: false });
      r.endZoom = p.startZoom;
    }

    // 2. Imagery: the same base-map tiles, or the original globe's texture as a fallback.
    const tex = await loadSheetTexture(r, p);
    if (run !== r) return;
    if (!tex) return finishNow(r);
    r.texture = tex.texture;
    r.textureShared = tex.shared; // kept for the next switch: not disposed in cleanup

    // 3. Sheet aligned with the Leaflet view (current view for 'in', end view for 'out').
    const center = map.getCenter();
    const zoom = map.getZoom();
    const lng = ((((center.lng + 180) % 360) + 360) % 360) - 180;
    const uc = (lng + 180) / 360;
    const { camera, scene } = globeScene;
    r.latC = clamp(center.lat, -MAX_MERC_LAT, MAX_MERC_LAT) * Math.PI / 180;
    r.mercC = mercY(center.lat);
    r.qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -sheetYaw(uc));
    r.qTarget = new THREE.Quaternion();
    r.qIdentity = new THREE.Quaternion();
    r.camZ0 = 1 + flatDistance(map.getSize().y || r.container.clientHeight, zoom, camera.fov);
    r.camPeak = r.camZ0 * CONFIG.pullBack;
    r.camTarget = r.saved.camZ;

    r.sheet = buildSheet(uc, tex.projection);
    r.material = new THREE.MeshPhongMaterial({
      map: r.texture,
      emissiveMap: r.texture,
      color: 0x000000,     // unlit: output = texture, like the 2D map
      emissive: 0xffffff,
      specular: 0x000000,
      side: THREE.DoubleSide,
    });
    if (r.dir === 'out') {
      // Starts as a transparent copy of the lit globe, fades in over it.
      r.material.transparent = true;
      r.material.depthWrite = false;
      r.material.side = THREE.FrontSide;
      r.material.opacity = 0;
    }
    r.mesh = new THREE.Mesh(r.sheet.geometry, r.material);
    r.mesh.frustumCulled = false; // vertices move every frame
    r.mesh.renderOrder = 3;       // above the globe's own overlays while fading
    scene.add(r.mesh);

    // 4. Drive the animation from the existing render loop (no second loop / canvas).
    r.prevHook = scene.onBeforeRender;
    scene.onBeforeRender = function (...args) {
      r.prevHook?.apply(this, args);
      tick(r);
    };
    r.hookInstalled = true;
    r.t0 = performance.now();
    r.phase = 'animate';
    if (r.dir === 'out' && r.controls) r.controls.classList.add('hidden');
    (r.dir === 'in' ? step : stepReverse)(r, 0); // first frame already in its start pose
  }

  function tick(r) {
    if (run !== r || r.phase !== 'animate') return;
    try {
      (r.dir === 'in' ? step : stepReverse)(r, performance.now() - r.t0);
    } catch (err) {
      console.warn('[transition] aborted:', err?.message || err);
      finishNow(r);
    }
  }

  const wrapStartMs = () => CONFIG.pullBackMs * CONFIG.wrapStartAt;
  const wrapEndMs = () => wrapStartMs() + CONFIG.wrapMs;

  /**
   * Shared pose of the sheet + camera at `tp` ms along the wrap timeline
   * (0 = flat and aligned with the 2D map, wrapEndMs() = sphere on the original globe).
   * Both directions use this, so 3D → 2D is the exact mirror of 2D → 3D.
   */
  function pose(r, tp, reverse) {
    const C = CONFIG;
    const { camera, earth } = globeScene;
    const wrapEnd = wrapEndMs();
    const p = clamp01((tp - wrapStartMs()) / C.wrapMs);

    // Camera: pull back, then glide to the globe's own camera distance.
    // (Reverse settles onto the map with ease-in-out so it does not stop abruptly.)
    const pull = clamp01(tp / C.pullBackMs);
    camera.position.z = tp < C.pullBackMs
      ? mix(r.camZ0, r.camPeak, reverse ? easeInOutCubic(pull) : easeOutCubic(pull))
      : mix(r.camPeak, r.camTarget, easeInOutCubic(clamp01((tp - C.pullBackMs) / (wrapEnd - C.pullBackMs))));

    // Shape: un-project Mercator, then bend into a sphere.
    const w = smoothstep(0, 0.7, p);
    updateSheet(r.sheet, TAU * easeInOutCubic(p), w);

    // Orientation and position converge on the original earth (which keeps auto-rotating).
    const s = smoothstep(0.3, 1, p);
    r.qTarget.copy(earth.quaternion).multiply(r.qYaw);
    r.mesh.quaternion.slerpQuaternions(r.qIdentity, r.qTarget, s);
    r.mesh.position.set(0, -mix(r.mercC, r.latC, w) * (1 - s), 0);
    r.mesh.scale.setScalar(1 + C.handoffLift * smoothstep(0.85, 1, p));

    // Shading: unlit flat map ↔ the globe's own Phong lighting.
    const k = smoothstep(0.25, 0.9, p);
    r.material.color.setScalar(k);
    r.material.emissive.setScalar(1 - k);
    r.material.specular.copy(earth.material.specular).multiplyScalar(k);
    r.material.shininess = earth.material.shininess;
    return p;
  }

  function commitFrame(r) {
    r.mesh.updateMatrixWorld();
    globeScene.camera.updateMatrixWorld(); // the renderer already updated matrices before this hook
  }

  /** 2D → 3D frame. */
  function step(r, t) {
    const C = CONFIG;
    const { earth } = globeScene;

    // Cross-fade from the DOM map to the aligned sheet, then retire the DOM map.
    if (!r.mapHidden) {
      const f = String(smoothstep(0, C.crossfadeMs, t));
      r.container.style.opacity = f;
      if (r.controls) r.controls.style.opacity = f;
      if (t >= C.crossfadeMs) {
        r.mapEl.classList.add('hidden');
        r.container.style.opacity = r.saved.containerOpacity;
        if (r.controls) r.controls.style.opacity = r.saved.controlsOpacity;
        restoreView(r);
        r.mapHidden = true;
      }
    }

    const p = pose(r, Math.max(0, t - C.crossfadeMs), false);

    // Handoff: shapes coincide → show the original earth and fade the sheet out over it.
    if (p >= 1) {
      if (r.handoffAt === undefined) {
        r.holdUntil ??= t + C.earthWaitMs;
        if (textureReady(earth.material.map) || t >= r.holdUntil) {
          r.handoffAt = t;
          earth.visible = r.saved.earthVisible;
          r.material.transparent = true;
          r.material.depthWrite = false;
          r.material.side = THREE.FrontSide;
          r.material.needsUpdate = true;
        }
      } else {
        const h = clamp01((t - r.handoffAt) / C.handoffMs);
        r.material.opacity = 1 - easeInOutCubic(h);
        if (h >= 1) return complete(r);
      }
    }
    commitFrame(r);
  }

  /** 3D → 2D frame: the same timeline played backwards. */
  function stepReverse(r, t) {
    const C = CONFIG;
    const wrapEnd = wrapEndMs();

    // 1. Sheet (already a sphere on the globe) fades in over the original globe.
    if (t < C.handoffMs) {
      pose(r, wrapEnd, true);
      r.material.opacity = easeInOutCubic(t / C.handoffMs);
      return commitFrame(r);
    }
    if (!r.solid) {
      r.solid = true;
      globeScene.earth.visible = false; // fully covered now; hidden until cleanup
      r.material.opacity = 1;
      r.material.transparent = false;
      r.material.depthWrite = true;
      r.material.side = THREE.DoubleSide;
      r.material.needsUpdate = true;
    }

    // 2. Unwrap: sphere → flat sheet aligned with the 2D map's world view.
    const tp = Math.max(0, wrapEnd - (t - C.handoffMs));
    pose(r, tp, true);

    // 3. Once flat, wait for the map's tiles, then cross-fade to the real 2D map.
    if (tp === 0) {
      r.flatAt ??= t;
      if (r.fadeAt === undefined) {
        const base = activeBase();
        if (!base?.isLoading?.() || t - r.flatAt >= C.tileWaitMs) r.fadeAt = t;
      } else {
        const f = smoothstep(0, C.crossfadeMs, t - r.fadeAt);
        r.container.style.opacity = String(1 - f);
        if (f >= 1) return completeReverse(r);
      }
    }
    commitFrame(r);
  }

  function restoreView(r) {
    if (!r.flew || r.viewRestored) return;
    r.viewRestored = true;
    map.stop?.();
    map.setView(r.saved.center, r.saved.zoom, { animate: false }); // 2D view as the user left it
  }

  function cleanup(r) {
    if (run === r) run = null;
    r.phase = 'done';
    if (r.hookInstalled) {
      r.scene.onBeforeRender = r.prevHook;
      r.hookInstalled = false;
    }
    if (r.mesh) {
      r.scene.remove(r.mesh);
      r.sheet.geometry.dispose();
      r.material.dispose();
      r.mesh = null;
    }
    if (!r.textureShared) r.texture?.dispose(); // the fallback's image is the earth's own: not closed
    r.texture = null;
    if (globeScene) {
      globeScene.earth.visible = r.saved.earthVisible;
      globeScene.camera.position.z = r.saved.camZ;
      globeScene.camera.updateMatrixWorld();
    }
    r.container.style.opacity = r.saved.containerOpacity;
    r.container.style.pointerEvents = r.saved.containerPointer;
    r.mapEl.style.pointerEvents = r.saved.mapPointer;
    if (r.controls) {
      r.controls.style.opacity = r.saved.controlsOpacity;
      r.controls.style.pointerEvents = r.saved.controlsPointer;
    }
    window.dispatchEvent(new Event('forest:globe-transition-end')); // [loss-replay] waits for the 2D map
  }

  /** 2D → 3D normal end: the original globe is on screen and the sheet is gone. */
  function complete(r) {
    cleanup(r);
    r.mapEl.classList.add('hidden');
  }

  /** 3D → 2D normal end: the 2D map is on screen; zoom back in to where it was. */
  function completeReverse(r) {
    r.container.classList.add('hidden');
    cleanup(r);
    if (r.target && r.target.zoom > r.endZoom) {
      map.flyTo(r.target.center, r.target.zoom, { duration: CONFIG.flySeconds });
    }
  }

  /** Abort, but still end in whichever view the toggle now asks for (original instant switch). */
  function finishNow(r) {
    cleanup(r);
    const show3d = !!$('toggle-globe')?.checked;
    if (r.dir === 'in') {
      restoreView(r);
      if (show3d) r.mapEl.classList.add('hidden');
    } else {
      if (r.target) map.setView(r.target.center, r.target.zoom, { animate: false });
      if (!show3d) r.container.classList.add('hidden');
    }
  }

  /** Stop a running transition; the caller (app.js) has already set the target view. */
  function cancel() {
    const r = run;
    if (!r) return false;
    cleanup(r);
    if (r.dir === 'in') restoreView(r);
    else if (r.target) map.setView(r.target.center, r.target.zoom, { animate: false });
    return true;
  }

  function onToggle(showGlobe) {
    const interrupted = cancel();
    if (showGlobe) start();
    else if (!interrupted) startReverse(); // switching back mid-animation stays instant
  }

  /**
   * Meshes with the sheet's two shader variants (opaque double-sided, transparent front-side),
   * for globe-zoom.js's idle warm-up to compile and draw once; otherwise each compiles in the first
   * frames of a switch. The materials are kept: three.js deletes a program once no material uses it.
   */
  let warmMaterials = null;
  function warmMeshes() {
    if (typeof THREE === 'undefined') return [];
    if (!warmMaterials) {
      const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      warmMaterials = [
        { side: THREE.DoubleSide },
        { side: THREE.FrontSide, transparent: true, depthWrite: false },
      ].map(o => new THREE.MeshPhongMaterial({ map: tex, emissiveMap: tex, ...o }));
    }
    return warmMaterials.map(m => Object.assign(new THREE.Mesh(new THREE.PlaneGeometry(), m), { frustumCulled: false }));
  }

  // Warm the tile cache while the user is about to switch.
  const toggleLabel = $('toggle-globe')?.closest('label');
  toggleLabel?.addEventListener('pointerenter', preload);
  toggleLabel?.addEventListener('focusin', preload);
  // A new base map needs a new sheet texture (only once the globe has been warmed up / used)
  $('toggle-satellite')?.addEventListener('change', () => {
    if (typeof globeScene !== 'undefined' && globeScene && !$('toggle-globe')?.checked) setTimeout(preload, 0);
  });

  window.ForestGlobeTransition = {
    onToggle,
    cancel,
    preload,
    warmMeshes,
    isRunning: () => !!run,
    // Exposed for testing
    _test: { wrapVertex, sheetYaw, flatDistance, fitZoom, mosaicZoom, mercY, CONFIG },
  };
})();
