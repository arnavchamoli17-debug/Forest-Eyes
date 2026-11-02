/**
 * Forest Eyes — 3D Earth uses the same imagery as the 2D map (globe-imagery.js)
 * ============================================================================
 * Loaded AFTER app.js. Builds a whole-world texture from the exact base-map tiles the
 * 2D map shows (Esri satellite, or the dark basemap when Satellite is off), reprojected
 * from the map's Web Mercator to the globe's equirectangular layout, and puts it on the
 * original earth mesh. Same geometry, material, lights and controls; only the picture
 * changes, so 2D and 3D colours match.
 *
 * The texture is the reprojected canvas, uploaded ahead while the 2D map is idle; heatmap.js gets
 * a JPEG copy (texture.userData.src) to recolour for Heatmap mode. If the tiles cannot be loaded,
 * the globe keeps its original NASA texture.
 */
(function () {
  'use strict';

  const CONFIG = {
    maxZoom: 4,          // tile zoom → texture width 256·2^z (4 → 4096 × 2048)
    minCoverage: 0.95,   // share of tiles that must load before the texture is used
    jpegQuality: 0.92,
    fadeMs: 600,         // cross-fade when the picture changes while the globe is on screen
    tilesPerSlice: 32,   // tiles drawn per frame while building
    rowsPerSlice: 256,   // reprojected rows per frame while building
  };
  const MAX_MERC_LAT = 85.0511287798;
  const yieldToFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

  const $ = id => document.getElementById(id);
  const entries = new Map(); // key → Promise<{ key, img } | null>
  let baseTex = null;        // texture the earth shows when not in Heatmap mode
  let originalTex = null;    // app.js's own texture (fallback)
  let wantedKey = '';

  function activeBase() {
    if (typeof map === 'undefined') return null;
    if (typeof satelliteBase !== 'undefined' && map.hasLayer(satelliteBase)) return satelliteBase;
    if (typeof darkBase !== 'undefined' && map.hasLayer(darkBase)) return darkBase;
    return typeof satelliteBase !== 'undefined' ? satelliteBase : null;
  }

  function textureZoom() {
    const maxTex = (typeof globeScene !== 'undefined' && globeScene?.renderer?.capabilities?.maxTextureSize) || 4096;
    let z = CONFIG.maxZoom;
    while (z > 2 && 256 * Math.pow(2, z) > maxTex) z--;
    return z;
  }

  function tileUrl(layer, x, y, z) {
    const subs = layer.options.subdomains || '';
    const s = subs.length ? subs[Math.abs(x + y) % subs.length] : '';
    return L.Util.template(layer._url, Object.assign({}, layer.options, {
      s, x, y, z, r: L.Browser.retina ? '@2x' : '', // same {r} rule as Leaflet
    }));
  }

  function loadTile(url) {
    return new Promise(resolve => {
      const img = new Image();
      let retried = false;
      img.crossOrigin = 'anonymous';
      img.onload = () => img.decode().then(() => resolve(img), () => resolve(img)); // decoded off the main thread, not in drawImage
      img.onerror = () => {
        // The 2D map caches these tiles without CORS; a distinct URL fetches a CORS copy.
        if (retried) return resolve(null);
        retried = true;
        img.src = url + (url.includes('?') ? '&' : '?') + 'fwglobe=1';
      };
      img.src = url;
    });
  }

  /** Mercator tiles → equirectangular <img> (blob URL). Resolves null on failure. */
  function build(layer, z, key) {
    if (entries.has(key)) return entries.get(key);
    const job = (async () => {
      const n = Math.pow(2, z);
      const W = 256 * n;
      const jobs = [];
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) jobs.push(loadTile(tileUrl(layer, x, y, z)).then(img => ({ x, y, img })));
      }
      const tiles = await Promise.all(jobs);
      const ok = tiles.filter(t => t.img);
      if (ok.length / tiles.length < CONFIG.minCoverage) {
        console.warn('[globe-imagery] Base-map tiles could not be loaded for the 3D globe; keeping its original texture.');
        return null;
      }
      // Drawn in slices with yields: in one go it blocked ~70 ms, and it may run while the
      // 2D map pans or a 2D ↔ 3D switch animates.
      const merc = document.createElement('canvas');
      merc.width = merc.height = W;
      const mctx = merc.getContext('2d');
      for (let i = 0; i < ok.length; i++) {
        const { x, y, img } = ok[i];
        mctx.drawImage(img, x * 256, y * 256, 256, 256);
        if (i % CONFIG.tilesPerSlice === CONFIG.tilesPerSlice - 1) await yieldToFrame();
      }

      const H = W / 2;
      const eq = document.createElement('canvas');
      eq.width = W;
      eq.height = H;
      const ectx = eq.getContext('2d');
      for (let j = 0; j < H; j++) {
        const lat = Math.min(Math.max(90 - ((j + 0.5) / H) * 180, -MAX_MERC_LAT), MAX_MERC_LAT) * Math.PI / 180;
        const my = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2 * W;
        ectx.drawImage(merc, 0, Math.min(Math.floor(my), W - 1), W, 1, 0, j, W, 1);
        if (j % CONFIG.rowsPerSlice === CONFIG.rowsPerSlice - 1) await yieldToFrame();
      }
      merc.width = merc.height = 0; // free memory

      // No taint check (getImageData stalled ~90 ms reading the canvas back from the GPU): tiles are
      // loaded with crossOrigin, and a tile failing CORS fires onerror (→ retry / null), never onload.
      // The canvas itself is the texture; the JPEG copy heatmap.js needs is made only when asked
      // for (toBlob also reads the canvas back: ~100 ms).
      return { key, canvas: eq, src: null, blobJob: null };
    })().catch(err => {
      console.warn('[globe-imagery] Failed to build globe imagery:', err?.message || err);
      return null;
    });
    entries.set(key, job);
    job.then(e => { if (!e) entries.delete(key); }); // allow a later retry
    return job;
  }

  function globeOnScreen() {
    const container = $('globe-container');
    return !!container && !container.classList.contains('hidden') && globeScene.earth.visible &&
      !window.ForestGlobeTransition?.isRunning?.();
  }

  /** Put `tex` on the earth; cross-fade from the old picture if the globe is on screen. */
  function setEarthTexture(tex) {
    const earth = globeScene.earth;
    const old = earth.material.map;
    if (!globeOnScreen() || !old) {
      earth.material.map = tex;
      return;
    }
    const veil = new THREE.Mesh(earth.geometry, new THREE.MeshPhongMaterial({
      map: old,
      specular: earth.material.specular.clone(),
      shininess: earth.material.shininess,
      transparent: true,
      depthWrite: false,
    }));
    veil.scale.setScalar(1.0008);
    veil.renderOrder = 1;
    earth.add(veil); // rotates with the earth; below the loss / heat overlays
    earth.material.map = tex;
    const t0 = performance.now();
    const fade = () => {
      const f = Math.min((performance.now() - t0) / CONFIG.fadeMs, 1);
      veil.material.opacity = 1 - f * f * (3 - 2 * f);
      if (f < 1) return requestAnimationFrame(fade);
      earth.remove(veil);
      veil.material.dispose(); // geometry is the earth's own: not disposed
    };
    requestAnimationFrame(fade);
  }

  /** URL of a JPEG copy, for heatmap.js; undefined until made (heatmap.js asks again shortly). */
  function blobUrl(entry) {
    entry.blobJob ??= new Promise(res => entry.canvas.toBlob(res, 'image/jpeg', CONFIG.jpegQuality))
      .then(blob => { if (blob) entry.src = URL.createObjectURL(blob); });
    return entry.src || undefined;
  }

  /** The earth texture for a built entry: one object per entry, so it can be uploaded ahead. */
  function textureFor(entry) {
    if (entry.tex) return entry.tex;
    const tex = new THREE.CanvasTexture(entry.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = globeScene.renderer.capabilities.getMaxAnisotropy?.() || 1;
    tex.userData.fwKey = entry.key;
    // heatmap.js reads userData.src (not enumerable: three.js copies userData as JSON)
    Object.defineProperty(tex.userData, 'src', { get: () => blobUrl(entry) });
    entry.tex = tex;
    return tex;
  }

  /**
   * Upload the texture to the GPU while the 2D map is on screen and the browser is idle.
   * Otherwise the upload happens in the frame the globe first appears: mid-transition.
   */
  function uploadAhead(entry) {
    const idle = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 500));
    idle(() => {
      if (typeof globeScene === 'undefined' || !globeScene || $('toggle-globe')?.checked) return;
      try {
        globeScene.renderer.initTexture(textureFor(entry));
      } catch (err) {
        console.warn('[globe-imagery] texture upload ahead skipped:', err?.message || err);
      }
    });
  }

  /** Make the globe show the imagery of the 2D map's current base layer. */
  function apply() {
    if (typeof THREE === 'undefined' || typeof globeScene === 'undefined' || !globeScene) return;
    const earth = globeScene.earth;
    // Adopt app.js's photo texture as the original; never heatmap.js's canvas texture.
    const isPhoto = t => typeof t?.image?.src === 'string';
    if (!originalTex && isPhoto(earth.material.map)) originalTex = baseTex = earth.material.map;
    if (!baseTex) return; // Heatmap mode is showing; retried when the mode changes
    const layer = activeBase();
    if (!layer) return;
    const z = textureZoom();
    const key = `${layer._url}|${z}`;
    wantedKey = key;
    build(layer, z, key).then(entry => {
      if (!entry || wantedKey !== key || !globeScene) return;
      if (baseTex?.userData?.fwKey === key) return; // already showing it
      // In Heatmap mode heatmap.js shows its own texture; swap once it restores ours.
      if (earth.material.map !== baseTex) return;
      const tex = textureFor(entry);
      const previous = baseTex;
      baseTex = tex;
      setEarthTexture(tex);
      if (previous && previous !== originalTex) setTimeout(() => previous.dispose(), CONFIG.fadeMs + 100);
    });
  }

  /** Start building early (e.g. when the 2D map nears the world view). */
  function preload() {
    if (typeof THREE === 'undefined') return;
    const layer = activeBase();
    if (layer) build(layer, textureZoom(), `${layer._url}|${textureZoom()}`).then(entry => entry && uploadAhead(entry));
  }

  // Re-check whenever something that affects the globe's picture changes.
  ['toggle-globe', 'toggle-satellite', 'tree-loss-mode', 'toggle-tree-loss'].forEach(id => {
    $(id)?.addEventListener('change', apply);
  });

  window.ForestGlobeImagery = { apply, preload };
})();
