/**
 * Forest Eyes — switch between 2D and 3D by zooming (globe-zoom.js)
 * ================================================================
 * Loaded AFTER app.js and the other globe files. The "3D Earth" switch is hidden in the
 * layer bar; this file drives it instead, so every existing listener (app.js, heatmap.js,
 * globe-transition.js, globe-layers.js, globe-imagery.js) runs exactly as before.
 *
 *   2D → 3D: zoom out (wheel / pinch / "−" button / "−" key) while the 2D map already shows
 *            the whole world. The globe opens facing the place the map was showing.
 *   3D → 2D: zoom in on the globe (wheel / "+" button) once more after reaching its closest
 *            zoom. The 2D map opens on the place the globe is facing.
 */
(function () {
  'use strict';

  const CONFIG = {
    globeMinZ: 1.65,        // app.js zoomGlobe() lower clamp (closest globe zoom)
    enterCameraZ: 3.1,      // globe distance when it opens (app.js default view)
    exitZoomLevels: 2,      // 2D map lands this many levels closer than the whole-world view
    preloadOnStart: true,   // warm up 3D imagery shortly after load when starting near world view
    preloadDelayMs: 2500,
  };

  const $ = id => document.getElementById(id);
  const toggle = $('toggle-globe');
  const mapEl = $('map');
  if (!toggle || !mapEl || typeof map === 'undefined') return;

  const inGlobe = () => toggle.checked;
  const busy = () => !!window.ForestGlobeTransition?.isRunning?.();
  const threeReady = () => typeof THREE !== 'undefined' && typeof initGlobe === 'function';

  /** Smallest whole zoom at which one copy of the world is as wide as the map. */
  function worldZoom() {
    const w = map.getSize().x || window.innerWidth;
    return Math.max(0, Math.ceil(Math.log2(Math.max(w, 1) / 256)));
  }

  function setGlobe(on) {
    if (toggle.checked === on) return;
    toggle.checked = on;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const normalizeLngDeg = lng => ((((lng + 180) % 360) + 360) % 360) - 180;

  /**
   * Earth rotation (app.js Euler XYZ, rotation.z unused) that puts lat/lng exactly at the
   * centre of the screen. (app.js focusGlobeOnCoordinates only tilts 45 % of the way, which
   * would make 2D → 3D → 2D drift toward the equator.)
   */
  function rotationFacing(lat, lng) {
    const phi = (normalizeLngDeg(lng) + 180) * Math.PI / 180;
    const theta = (90 - lat) * Math.PI / 180;
    const px = -Math.cos(phi) * Math.sin(theta);
    const pz = Math.sin(phi) * Math.sin(theta);
    return { x: Math.max(Math.min(lat * Math.PI / 180, 1.2), -1.2), y: -Math.atan2(px, pz) }; // 1.2 = app.js drag limit
  }

  /** Lat/lng at the centre of the screen for an earth rotation (inverse of the above). */
  function latLngFacing(rx, ry) {
    const p = [-Math.cos(rx) * Math.sin(ry), Math.sin(rx), Math.cos(rx) * Math.cos(ry)]; // (Rx·Ry)⁻¹ · (0,0,1)
    const lat = Math.asin(Math.max(Math.min(p[1], 1), -1)) * 180 / Math.PI;
    const lng = normalizeLngDeg(Math.atan2(p[2], -p[0]) * 180 / Math.PI - 180); // app.js picking maths
    return { lat, lng };
  }

  function enter3D() {
    if (inGlobe() || busy() || !threeReady()) return;
    initGlobe(); // no-op if it already exists; lets the globe face this place before opening
    if (typeof globeScene !== 'undefined' && globeScene) {
      const c = map.getCenter();
      const r = rotationFacing(c.lat, c.lng);
      globeScene.earth.rotation.x = r.x;
      globeScene.earth.rotation.y = r.y;
      globeScene.camera.position.z = CONFIG.enterCameraZ;
    }
    setGlobe(true);
  }

  function exit3D() {
    if (!inGlobe() || busy() || typeof globeScene === 'undefined' || !globeScene) return;
    const { x, y } = globeScene.earth.rotation;
    const { lat, lng } = latLngFacing(x, y);
    map.setView([Math.max(Math.min(lat, 80), -80), lng], worldZoom() + CONFIG.exitZoomLevels, { animate: false });
    setGlobe(false);
  }

  // ---------------------------------------------------------------------
  // 2D: zooming out past the whole-world view opens the globe
  // ---------------------------------------------------------------------
  const swallow = e => { e.preventDefault(); e.stopPropagation(); };
  const atWorldView = () => map.getZoom() <= worldZoom();

  // Capture phase on the map container runs before Leaflet's own handlers.
  mapEl.addEventListener('wheel', e => {
    if (busy()) return swallow(e); // no map zooming underneath a running animation
    if (inGlobe()) return;
    if (e.deltaY > 0 && atWorldView()) { swallow(e); enter3D(); }
  }, { capture: true, passive: false });

  mapEl.addEventListener('click', e => {
    if (!e.target.closest?.('.leaflet-control-zoom-out, .leaflet-control-zoom-in')) return;
    if (busy()) return swallow(e);
    if (inGlobe()) return;
    if (e.target.closest('.leaflet-control-zoom-out') && atWorldView()) { swallow(e); enter3D(); }
  }, { capture: true });

  mapEl.addEventListener('keydown', e => {
    if (busy()) return swallow(e);
    if (inGlobe()) return;
    if ((e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') && atWorldView()) { swallow(e); enter3D(); }
  }, { capture: true });

  // Pinch-zoom (touch) cannot be intercepted cleanly; react once it has zoomed out.
  let lastZoom = map.getZoom();
  map.on('zoomend', () => {
    const z = map.getZoom();
    const zoomedOut = z < lastZoom;
    lastZoom = z;
    if (inGlobe() || busy()) return;
    if (zoomedOut && z < worldZoom()) enter3D();
    if (z <= worldZoom() + 1) warmUp();
  });

  // ---------------------------------------------------------------------
  // 3D: zooming in past the closest globe view opens the 2D map
  // ---------------------------------------------------------------------
  let zBefore = Infinity;
  const inGlobeUi = t => !!t?.closest?.('#globe-container, #globe-controls');
  const rememberZ = e => {
    if (inGlobe() && inGlobeUi(e.target) && typeof globeScene !== 'undefined' && globeScene) {
      zBefore = globeScene.camera.position.z; // before app.js's handler changes it
    }
  };
  const atClosest = () => zBefore <= CONFIG.globeMinZ + 1e-3;

  document.addEventListener('wheel', rememberZ, { capture: true, passive: true });
  document.addEventListener('click', rememberZ, { capture: true });
  // Bubble phase: runs after app.js has applied (and clamped) the zoom.
  document.addEventListener('wheel', e => {
    if (inGlobe() && !busy() && inGlobeUi(e.target) && e.deltaY < 0 && atClosest()) exit3D();
  }, { passive: true });
  document.addEventListener('click', e => {
    if (inGlobe() && !busy() && e.target.closest?.('#globe-zoom-in') && atClosest()) exit3D();
  });

  // ---------------------------------------------------------------------
  // Warm-up so the switch starts without waiting for imagery
  // ---------------------------------------------------------------------
  let warmed = false;
  function warmUp() {
    if (warmed) return;
    warmed = true;
    window.ForestGlobeTransition?.preload?.();
    window.ForestGlobeImagery?.preload?.();
    // Build the globe and compile its shaders while the browser is idle, so the first 2D→3D
    // switch does not stall (~1 s of one-time setup). The globe's render loop stays paused while
    // it is hidden, so this costs nothing afterwards.
    const idle = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 5000 }) : setTimeout(cb, 1000));
    idle(() => {
      if (inGlobe() || busy() || !threeReady()) return;
      initGlobe();
      window.ForestGlobeLayers?.refresh?.(); // starts preparing the tree-loss texture in the background
      idle(() => {
        try {
          const g = typeof globeScene !== 'undefined' && globeScene;
          if (g && !inGlobe()) {
            const extra = window.ForestGlobeTransition?.warmMeshes?.() || []; // the 2D↔3D sheet's shaders
            extra.forEach(m => g.scene.add(m));
            g.renderer.compile(g.scene, g.camera);
            extra.forEach(m => g.scene.remove(m));
            finishPrograms(g, extra);
          }
        } catch (err) {
          console.warn('[globe-zoom] shader warm-up skipped:', err.message);
        }
      });
    });
  }
  /**
   * Finish the shaders while nothing is animating. Measured on D3D11 (ANGLE), in the first frames
   * of a switch: three.js's first-use check waited ~90 ms for the driver to link, then the first
   * real draw cost ~57 ms (sheet) and ~38 ms (earth) on the GPU, which builds its shaders lazily.
   * So: wait without blocking until linked, run the checks, then draw once into a 4 × 4 target.
   */
  function finishPrograms(g, extra, tries = 50) {
    const programs = g.renderer.info.programs || [];
    if (tries > 0 && programs.some(p => p.isReady && !p.isReady())) {
      setTimeout(() => finishPrograms(g, extra, tries - 1), 100);
      return;
    }
    const target = new THREE.WebGLRenderTarget(4, 4);
    try {
      programs.forEach(p => { p.getUniforms(); p.getAttributes(); });
      if (inGlobe() || busy()) return; // the globe is drawing for real already
      extra.forEach(m => g.scene.add(m));
      g.renderer.setRenderTarget(target);
      g.renderer.render(g.scene, g.camera);
    } catch (err) {
      console.warn('[globe-zoom] shader warm-up skipped:', err.message);
    } finally {
      g.renderer.setRenderTarget(null);
      extra.forEach(m => { g.scene.remove(m); m.geometry.dispose(); });
      target.dispose();
    }
  }

  if (CONFIG.preloadOnStart) {
    window.addEventListener('load', () => setTimeout(() => {
      if (!inGlobe() && map.getZoom() <= worldZoom() + 1) warmUp();
    }, CONFIG.preloadDelayMs));
  }

  window.ForestGlobeZoom = { enter3D, exit3D, worldZoom, _test: { rotationFacing, latLngFacing, CONFIG } };
})();
