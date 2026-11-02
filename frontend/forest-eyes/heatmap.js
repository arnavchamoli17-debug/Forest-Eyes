/**
 * Forest Eyes — Deforestation heatmap mode (spec: arnav.txt)
 * ==========================================================
 * Loaded AFTER app.js. Reads app.js globals (map, satelliteBase, darkBase,
 * treeLossLayer, treeCoverLayer, gladAlertsLayer, globeScene) but never
 * reassigns them. app.js calls ForestHeatmap.refresh() from
 * syncTreeLossLayer(), renderTreeLossColorForm() and clearMapLayers().
 *
 * Everything below is active ONLY while Tree Loss Form = "Heatmap":
 *   - land            → green (no / negligible deforestation)
 *   - water           → blue
 *   - tree cover loss → gradient green → yellow → orange → red, hotter where clearings
 *                       are dense (real UMD/Hansen loss tiles, all years)
 *   - Tree Cover / GLAD overlays and the app's basemaps are hidden
 * Recolouring is done with SVG filters, so the browser never needs to read
 * tile pixels (no CORS requirement). Leaving the mode restores everything.
 */
(function () {
  'use strict';

  const CONFIG = {
    satelliteUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    lossUrl: 'https://tiles.globalforestwatch.org/umd_tree_cover_loss/v1.11/tcd_30/{z}/{x}/{y}.png',
    maxNativeZoom: 12,
    // Blur (px) by zoom: small, so individual clearings stay sharp. Above the
    // tiles' native zoom (12) Leaflet enlarges them, so blur grows with it.
    blurLowZoom: 1.2,   // zoom ≤ 6 (each tile pixel already covers a large area)
    blurMidZoom: 1.8,   // zoom 7–10
    blurHighZoom: 2.5,  // zoom 11–12
    // Every loss pixel is drawn at least at this ramp position (≈ yellow-green),
    // so the smallest clearings stay visible even where density is low.
    minLossT: 0.26,
    gain: 2,            // how quickly density reaches red (Sensitivity slider)
    gamma: 0.4,         // power scale like GFW's own decode: spreads light,
                        // moderate and heavy loss across green → yellow → red
    floor: 0.02,        // density below this stays fully green (no haze on water)
    gainMin: 0.25,      // Sensitivity slider range (log scale)
    gainMax: 32,
    // Land: blue duotone that keeps faint terrain shading
    // Land: green (= no / negligible deforestation), faint terrain shading kept
    landLow: [0, 120, 60],
    landHigh: [40, 175, 90],
    landContrast: 0.6,
    waterColor: [74, 144, 217], // water: plain blue
    // Water: pixels where blue clearly exceeds red+green get waterColor
    waterStart: 9 / 255,  // blueness where water colour starts
    waterFull: 17 / 255,  // blueness where it is fully water colour
    globeZoom: 3,
  };

  // Green (none / negligible) → yellow → orange → red → dark red (high)
  const STOPS = [
    [0.00, '#009a4e'],
    [0.12, '#2a9d3a'],
    [0.25, '#8cc21d'],
    [0.36, '#f5e400'],
    [0.55, '#ffa500'],
    [0.72, '#ff6a00'],
    [0.86, '#ee0000'],
    [1.00, '#9b0f1d'],
  ];

  // ---------------------------------------------------------------------
  // Pure helpers (no DOM / map access — unit tested)
  // ---------------------------------------------------------------------
  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const STOP_RGB = STOPS.map(([t, c]) => [t, hexToRgb(c)]);

  function rampRgb(t) {
    const x = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), 1);
    for (let s = 1; s < STOP_RGB.length; s++) {
      const [t1, b] = STOP_RGB[s];
      if (x <= t1) {
        const [t0, a] = STOP_RGB[s - 1];
        const f = (x - t0) / (t1 - t0 || 1);
        return a.map((v, i) => Math.round(v + (b[i] - v) * f));
      }
    }
    return STOP_RGB[STOP_RGB.length - 1][1];
  }

  /** Blurred loss density (0..1) → { t: ramp position, alpha }. */
  function densityToHeat(d) {
    let v = Math.min(Math.max(d * CONFIG.gain, 0), 1);
    v = Math.max(0, (v - CONFIG.floor) / (1 - CONFIG.floor));
    const t = Math.pow(v, CONFIG.gamma);
    return { t, alpha: Math.min(1, t * 2) };
  }

  // Sensitivity slider (0–100) ↔ gain on a log scale
  const sliderToGain = p => CONFIG.gainMin * Math.pow(CONFIG.gainMax / CONFIG.gainMin, p / 100);
  const gainToSlider = g => 100 * Math.log(g / CONFIG.gainMin) / Math.log(CONFIG.gainMax / CONFIG.gainMin);

  /** Land/water recolouring for one sRGB pixel (0..255). */
  function baseColor(r, g, b) {
    const R = r / 255, G = g / 255, B = b / 255;
    const blueness = B - 0.5 * R - 0.5 * G;
    const water = Math.min(Math.max((blueness - CONFIG.waterStart) / (CONFIG.waterFull - CONFIG.waterStart), 0), 1);
    let y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    y = Math.min(Math.max((y - 0.5) * CONFIG.landContrast + 0.5, 0), 1);
    return [0, 1, 2].map(i => {
      const land = CONFIG.landLow[i] + y * (CONFIG.landHigh[i] - CONFIG.landLow[i]);
      return Math.round(land * (1 - water) + CONFIG.waterColor[i] * water);
    });
  }

  function boxBlur(src, w, h, r) {
    if (r <= 0) return src;
    const tmp = new Float32Array(src.length);
    const dst = new Float32Array(src.length);
    const norm = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) s += src[y * w + xx]; }
        tmp[y * w + x] = s * norm;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) s += tmp[yy * w + x]; }
        dst[y * w + x] = s * norm;
      }
    }
    return dst;
  }

  /**
   * The slow part of the globe heatmap (blurring) does not depend on Sensitivity, so it is done
   * once per tile: density (blurred loss) and presence (raw alpha) are cached.
   */
  function tileDensity(rgba, w, h) {
    const a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = (rgba[i * 4] / 255) * (rgba[i * 4 + 3] / 255);
    const density = boxBlur(boxBlur(a, w, h, 1), w, h, 1);
    const presence = new Float32Array(w * h);
    for (let i = 0; i < presence.length; i++) presence[i] = rgba[i * 4 + 3] / 255;
    return { density, presence };
  }

  // Colour ramp as a table (it is smooth, so 1024 steps are exact to within 1/255). The
  // sensitivity curve itself is computed exactly per pixel: it is steep near its floor.
  const RAMP_SIZE = 1024;
  const rampTable = new Uint8ClampedArray(RAMP_SIZE * 3);
  for (let k = 0; k < RAMP_SIZE; k++) rampTable.set(rampRgb(k / (RAMP_SIZE - 1)), k * 3);
  let lutGain = null; // gain the globe overlay was last rendered with

  /** Cached tile density → heat RGBA: plain arithmetic, no allocations, fast enough while dragging. */
  function densityToHeatRgba({ density, presence }, out) {
    const pw = presenceWeight();
    const { gain, floor, gamma } = CONFIG;
    const top = RAMP_SIZE - 1;
    for (let i = 0; i < density.length; i++) {
      let v = Math.min(1, density[i] + pw * presence[i]) * gain;          // = densityToHeat(), inlined
      v = v <= floor ? 0 : (v >= 1 ? 1 : (v - floor) / (1 - floor));
      const t = v > 0 ? Math.pow(v, gamma) : 0;
      const k = ((t * top + 0.5) | 0) * 3;
      const o = i * 4;
      out[o] = rampTable[k]; out[o + 1] = rampTable[k + 1]; out[o + 2] = rampTable[k + 2];
      out[o + 3] = Math.round(Math.min(1, t * 2) * 255);
    }
    lutGain = gain;
    return out;
  }

  /** Loss tile RGBA (alpha = loss present) → heat RGBA, for the 3D globe. */
  function lossToHeatRgba(rgba, w, h, out = new Uint8ClampedArray(w * h * 4)) {
    const a = new Float32Array(w * h);
    // Loss strength = red channel × alpha (matches the SVG filter below)
    for (let i = 0; i < a.length; i++) a[i] = (rgba[i * 4] / 255) * (rgba[i * 4 + 3] / 255);
    const d = boxBlur(boxBlur(a, w, h, 1), w, h, 1);
    const pw = presenceWeight();
    for (let i = 0; i < d.length; i++) {
      const { t, alpha } = densityToHeat(Math.min(1, d[i] + pw * (rgba[i * 4 + 3] / 255)));
      const [cr, cg, cb] = rampRgb(t);
      out.set([cr, cg, cb, Math.round(alpha * 255)], i * 4);
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // SVG filters (GPU recolouring, no pixel access needed)
  // ---------------------------------------------------------------------
  // 256 entries: the power curve changes fastest near zero, so a coarse
  // table would wash out light loss when Sensitivity is high.
  function table(fn, n = 256) {
    return Array.from({ length: n }, (_, i) => fn(i / (n - 1)).toFixed(4)).join(' ');
  }

  function installFilters() {
    const lo = CONFIG.landLow.map(v => v / 255);
    const hi = CONFIG.landHigh.map(v => v / 255);
    const c = CONFIG.landContrast;
    const W = [0.2126, 0.7152, 0.0722];
    const landRows = [0, 1, 2].map(ch => {
      const dlt = hi[ch] - lo[ch];
      return `${W.map(w => (w * c * dlt).toFixed(5)).join(' ')} 0 ${(lo[ch] + (0.5 - 0.5 * c) * dlt).toFixed(5)}`;
    }).join(' ');
    const k = 1 / (CONFIG.waterFull - CONFIG.waterStart);
    const wc = CONFIG.waterColor.map(v => (v / 255).toFixed(4));
    const waterAlpha = `${(-0.5 * k).toFixed(4)} ${(-0.5 * k).toFixed(4)} ${k.toFixed(4)} 0 ${(-CONFIG.waterStart * k).toFixed(4)}`;

    // Filter region in user space: an HTML layer container has no size of
    // its own, so a bounding-box region could clip the tiles.
    const region = 'filterUnits="userSpaceOnUse" x="-50000" y="-50000" width="100000" height="100000"';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `
      <filter id="fw-heat-base" ${region} color-interpolation-filters="sRGB">
        <feColorMatrix in="SourceGraphic" type="matrix" result="land"
          values="${landRows} 0 0 0 0 1"/>
        <feColorMatrix in="SourceGraphic" type="matrix" result="water"
          values="0 0 0 0 ${wc[0]}  0 0 0 0 ${wc[1]}  0 0 0 0 ${wc[2]}  ${waterAlpha}"/>
        <feMerge><feMergeNode in="land"/><feMergeNode in="water"/></feMerge>
      </filter>
      <filter id="fw-heat-loss" ${region} color-interpolation-filters="sRGB">
        <!-- Loss strength = red channel × alpha. GFW loss tiles carry loss
             intensity in red, so sparse loss at low zoom stays cooler. -->
        <feColorMatrix in="SourceGraphic" type="matrix" result="redAsAlpha"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0"/>
        <feComposite in="redAsAlpha" in2="SourceGraphic" operator="in" result="mask"/>
        <feGaussianBlur id="fw-heat-blur" in="mask" stdDeviation="${blurForZoom(3)}" result="blur"/>
        <!-- Sharp copy of every loss pixel, added on top of the smooth density
             so single small clearings never disappear into the blur. -->
        <feColorMatrix in="SourceGraphic" type="matrix" result="presence"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/>
        <feComposite id="fw-heat-sum" in="blur" in2="presence" operator="arithmetic"
          k1="0" k2="1" k3="${presenceWeight().toFixed(5)}" k4="0" result="sum"/>
        <feColorMatrix in="sum" type="matrix" result="density"
          values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 1 0"/>
        <feComponentTransfer in="density">
          <feFuncR id="fw-heat-r" type="table"/>
          <feFuncG id="fw-heat-g" type="table"/>
          <feFuncB id="fw-heat-b" type="table"/>
          <feFuncA id="fw-heat-a" type="table"/>
        </feComponentTransfer>
      </filter>
      <!-- Colour form (2D): same recipe as the 3D globe. Blurred loss density x4 picks the
           colour (yellow → orange → red); alpha = every loss pixel ~0.85 plus density glow. -->
      <filter id="fw-colour-loss" ${region} color-interpolation-filters="sRGB">
        <feColorMatrix in="SourceGraphic" type="matrix" result="redAsAlpha"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0"/>
        <feComposite in="redAsAlpha" in2="SourceGraphic" operator="in" result="mask"/>
        <feGaussianBlur id="fw-colour-blur" in="mask" stdDeviation="${colourBlurForZoom(3)}" result="blur"/>
        <feColorMatrix in="blur" type="matrix" result="dens"
          values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1"/>
        <feComponentTransfer in="dens" result="rgb">
          <feFuncR type="table" tableValues="${table(x => colourRgb(x)[0] / 255)}"/>
          <feFuncG type="table" tableValues="${table(x => colourRgb(x)[1] / 255)}"/>
          <feFuncB type="table" tableValues="${table(x => colourRgb(x)[2] / 255)}"/>
        </feComponentTransfer>
        <feComponentTransfer in="blur" result="alphaDensity">
          <feFuncA type="table" tableValues="${table(x => Math.min(0.7, x * 3))}"/>
        </feComponentTransfer>
        <feComponentTransfer in="SourceGraphic" result="alphaPresence">
          <feFuncA type="discrete" tableValues="0 ${Array(49).fill('0.85').join(' ')}"/>
        </feComponentTransfer>
        <feComposite in="alphaDensity" in2="alphaPresence" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="alpha"/>
        <feComposite in="rgb" in2="alpha" operator="in"/>
      </filter>`;
    document.body.appendChild(svg);
    updateHeatTables();
  }

  // Colour form palette and blur: same as globe-layers.js (CONFIG.colourGain 4, blur ~2 px)
  const COLOUR_STOPS = [[0, [255, 209, 102]], [0.5, [255, 152, 0]], [1, [244, 67, 54]]]; // #ffd166 #ff9800 #f44336
  function colourRgb(d) {
    const x = Math.min(1, Math.max(0, d * 4));
    for (let s = 1; s < COLOUR_STOPS.length; s++) {
      const [t1, b] = COLOUR_STOPS[s];
      if (x <= t1) {
        const [t0, a] = COLOUR_STOPS[s - 1];
        const f = (x - t0) / (t1 - t0);
        return a.map((v, i) => Math.round(v + (b[i] - v) * f));
      }
    }
    return COLOUR_STOPS[COLOUR_STOPS.length - 1][1];
  }
  function colourBlurForZoom(z) {
    // ~2 px of tile data; tiles are upscaled beyond their native zoom, so the blur grows with them
    return Math.min(16, 2 * Math.pow(2, Math.max(0, z - CONFIG.maxNativeZoom)));
  }

  function blurForZoom(z) {
    let px = z <= 6 ? CONFIG.blurLowZoom : z <= 10 ? CONFIG.blurMidZoom : CONFIG.blurHighZoom;
    if (z > CONFIG.maxNativeZoom) px *= Math.pow(2, z - CONFIG.maxNativeZoom);
    return Math.min(px, 16);
  }

  /** Density a lone loss pixel must add to land exactly on minLossT. */
  function presenceWeight() {
    const v = CONFIG.floor + Math.pow(CONFIG.minLossT, 1 / CONFIG.gamma) * (1 - CONFIG.floor);
    return Math.min(v / CONFIG.gain, 1);
  }

  function updateBlur() {
    const z = typeof map.getZoom === 'function' ? map.getZoom() : 3;
    document.getElementById('fw-heat-blur')?.setAttribute('stdDeviation', blurForZoom(z));
    document.getElementById('fw-colour-blur')?.setAttribute('stdDeviation', colourBlurForZoom(z));
  }

  /** (Re)writes the colour lookup tables, e.g. after the sensitivity changes. */
  function updateHeatTables() {
    document.getElementById('fw-heat-sum')?.setAttribute('k3', presenceWeight().toFixed(5));
    const heat = x => rampRgb(densityToHeat(x).t);
    const set = (id, fn) => document.getElementById(id)?.setAttribute('tableValues', table(fn));
    set('fw-heat-r', x => heat(x)[0] / 255);
    set('fw-heat-g', x => heat(x)[1] / 255);
    set('fw-heat-b', x => heat(x)[2] / 255);
    set('fw-heat-a', x => densityToHeat(x).alpha);
  }

  // ---------------------------------------------------------------------
  // 2D layers owned by the heatmap mode
  // ---------------------------------------------------------------------
  function tagContainer(layer, cls) {
    if (!layer) return;
    layer.on('add', () => layer.getContainer()?.classList.add(cls));
    if (map.hasLayer(layer)) layer.getContainer()?.classList.add(cls);
  }

  // Own satellite copy, so water/land work whatever the Satellite toggle says.
  const heatBase = L.tileLayer(CONFIG.satelliteUrl, {
    maxZoom: 19,
    zIndex: 0,
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
  });
  // Same tiles as the Tree Loss layer, displayed (not read), then recoloured.
  const heatLoss = L.tileLayer(
    (typeof treeLossLayer !== 'undefined' && treeLossLayer._url) || CONFIG.lossUrl, {
      maxNativeZoom: CONFIG.maxNativeZoom,
      maxZoom: 19,
      zIndex: 5,
      attribution: 'Tree Cover Loss &copy; UMD/Hansen/Google/USGS/NASA',
    });
  // Colour form (2D): the same loss tiles again, recoloured with the Colour form palette.
  const colourLoss = L.tileLayer(
    (typeof treeLossLayer !== 'undefined' && treeLossLayer._url) || CONFIG.lossUrl, {
      maxNativeZoom: CONFIG.maxNativeZoom,
      maxZoom: 19,
      zIndex: 5,
      attribution: 'Tree Cover Loss &copy; UMD/Hansen/Google/USGS/NASA',
    });
  tagContainer(heatBase, 'fw-heat-base');
  tagContainer(heatLoss, 'fw-heat-loss');
  tagContainer(colourLoss, 'fw-colour-loss');

  function tagAppLayers() {
    [typeof satelliteBase !== 'undefined' && satelliteBase,
     typeof darkBase !== 'undefined' && darkBase,
     typeof treeCoverLayer !== 'undefined' && treeCoverLayer,
     typeof gladAlertsLayer !== 'undefined' && gladAlertsLayer,
    ].forEach(l => l && tagContainer(l, 'fw-hide-in-heatmap'));
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let monoActive = false;
  let globeOverlay = null;
  let globeTiles = null;
  let globeLoading = false;
  let baseTexture = null;
  let baseTextureLoading = false;
  let globeOriginals = null;

  function isHeatmapVisible() {
    const enabled = document.getElementById('toggle-tree-loss')?.checked ?? true;
    return enabled && (document.getElementById('tree-loss-mode')?.value === 'heatmap');
  }

  // Globe tiles must be read pixel by pixel: load them from our own server (no CORS failures)
  function lossUrl(coords) {
    if (location.protocol.startsWith('http')) return `/tiles/gfw-loss/${coords.z}/${coords.x}/${coords.y}.png`;
    return L.Util.template(heatLoss._url, coords);
  }

  // ---------------------------------------------------------------------
  // 3D globe
  // ---------------------------------------------------------------------
  function applyBaseTexture() {
    if (monoActive && globeScene && baseTexture) globeScene.earth.material.map = baseTexture;
  }

  function buildBaseTexture() {
    if (baseTexture) return applyBaseTexture();
    if (baseTextureLoading || !globeScene) return;
    const original = globeOriginals?.map || globeScene.earth.material.map;
    const src = original?.userData?.src || original?.image?.src; // globe-imagery.js textures are canvases: src in userData
    if (!src) {
      setTimeout(() => { if (monoActive) buildBaseTexture(); }, 500);
      return;
    }
    baseTextureLoading = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      baseTextureLoading = false;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = baseColor(d[i], d[i + 1], d[i + 2]);
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
        ctx.putImageData(data, 0, 0);
      } catch (err) {
        console.warn('[heatmap] Could not recolour globe texture:', err.message);
        return;
      }
      baseTexture = new THREE.CanvasTexture(canvas);
      baseTexture.colorSpace = original.colorSpace; // match the existing pipeline
      applyBaseTexture();
    };
    img.onerror = () => { baseTextureLoading = false; };
    img.src = src;
  }

  function setGlobeHeatBase(on) {
    if (typeof THREE === 'undefined' || !globeScene) return;
    const { scene, earth } = globeScene;
    const lights = scene.children.filter(o => o.isAmbientLight || o.isDirectionalLight);
    if (on) {
      if (!globeOriginals) {
        globeOriginals = {
          map: earth.material.map,
          specular: earth.material.specular.clone(),
          lights: lights.map(l => ({ light: l, color: l.color.clone(), intensity: l.intensity })),
        };
      }
      lights.forEach(l => {
        l.color.set('#ffffff');
        l.intensity = l.isAmbientLight ? 1.2 : 2.0;
      });
      earth.material.specular.set('#111111');
      buildBaseTexture();
    } else if (globeOriginals) {
      earth.material.map = globeOriginals.map;
      earth.material.specular.copy(globeOriginals.specular);
      globeOriginals.lights.forEach(({ light, color, intensity }) => {
        light.color.copy(color);
        light.intensity = intensity;
      });
      globeOriginals = null;
    }
  }

  /** Load the 8×8 z3 loss tiles once; they are re-coloured on year changes. */
  function loadGlobeTiles() {
    if (globeTiles || globeLoading) return;
    globeLoading = true;
    const z = CONFIG.globeZoom;
    const n = 2 ** z;
    const jobs = [];
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        jobs.push(new Promise(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = c.height = 256;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, 256, 256);
            try {
              resolve({ x, y, raw: ctx.getImageData(0, 0, 256, 256).data });
            } catch (err) {
              resolve(null); // pixel access blocked: WebGL cannot use it either
            }
          };
          // [globe fix] The 2D map caches these tiles without CORS; retry once with a distinct
          // URL so the browser fetches a CORS copy instead of failing on the cached one.
          img.onerror = () => {
            if (img.dataset.retried) return resolve({ x, y, raw: null });
            img.dataset.retried = '1';
            img.src = lossUrl({ x, y, z }) + '?fwglobe=1';
          };
          img.src = lossUrl({ x, y, z });
        }));
      }
    }
    Promise.all(jobs).then(results => {
      globeLoading = false;
      globeTiles = results.filter(r => r && r.raw);
      if (!globeTiles.length) {
        console.warn('[heatmap] Loss tiles could not be read for the 3D globe (likely CORS); globe shows land/water only.');
        globeTiles = null; // [globe fix] allow a retry on the next refresh instead of giving up for the session
      }
      renderGlobeOverlay();
    });
  }

  // ---------------------------------------------------------------------
  // Globe heat overlay on the GPU. The blurred loss density is uploaded once as a float texture;
  // a shader applies the Sensitivity curve and the colour ramp per pixel. Moving the slider only
  // changes a uniform, so there is no CPU work while dragging. If the GPU path fails, the CPU
  // path below recolours a canvas instead (slower, used only on slider release).
  // ---------------------------------------------------------------------
  let gpuFailed = false;
  let mercCanvas = null, eqCanvas = null, tileImage = null;

  /** Web Mercator tile grid → equirectangular float rows (north first), density + presence. */
  function buildEquirectDensity() {
    const n = 2 ** CONFIG.globeZoom;
    const W = 256 * n, H = W / 2;
    const mercD = new Float32Array(W * W), mercP = new Float32Array(W * W);
    globeTiles.forEach(tile => {
      if (!tile.heat) tile.heat = tileDensity(tile.raw, 256, 256); // blurred once, then cached
      const { density, presence } = tile.heat;
      for (let r = 0; r < 256; r++) {
        const dst = (tile.y * 256 + r) * W + tile.x * 256;
        mercD.set(density.subarray(r * 256, r * 256 + 256), dst);
        mercP.set(presence.subarray(r * 256, r * 256 + 256), dst);
      }
    });
    // Texture row 0 is the SOUTH edge (DataTexture is not flipped), so write rows bottom-up.
    const data = new Float32Array(W * H * 2);
    for (let j = 0; j < H; j++) {
      const lat = Math.max(Math.min(90 - ((j + 0.5) / H) * 180, 85.0511), -85.0511) * Math.PI / 180;
      const my = Math.min(Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2 * W), W - 1);
      const out = (H - 1 - j) * W * 2;
      for (let x = 0; x < W; x++) {
        data[out + 2 * x] = mercD[my * W + x];
        data[out + 2 * x + 1] = mercP[my * W + x];
      }
    }
    return { data, W, H };
  }

  function rampTexture() {
    const rgba = new Uint8Array(RAMP_SIZE * 4);
    for (let k = 0; k < RAMP_SIZE; k++) {
      rgba[k * 4] = rampTable[k * 3]; rgba[k * 4 + 1] = rampTable[k * 3 + 1]; rgba[k * 4 + 2] = rampTable[k * 3 + 2]; rgba[k * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(rgba, RAMP_SIZE, 1, THREE.RGBAFormat);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  function buildGpuOverlay() {
    const { data, W, H } = buildEquirectDensity();
    const density = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.FloatType);
    density.magFilter = density.minFilter = THREE.NearestFilter; // float linear filtering is not guaranteed
    density.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        density: { value: density },
        ramp: { value: rampTexture() },
        gain: { value: CONFIG.gain },
        floorV: { value: CONFIG.floor },
        gamma: { value: CONFIG.gamma },
        pw: { value: presenceWeight() },
      },
      vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      // Same maths as densityToHeat(); the ramp holds sRGB colours, written out as-is
      // (like the previous sRGB canvas texture on a basic material).
      fragmentShader: `uniform sampler2D density; uniform sampler2D ramp;
        uniform float gain; uniform float floorV; uniform float gamma; uniform float pw;
        varying vec2 vUv;
        void main() {
          vec2 dp = texture2D(density, vUv).rg;
          float v = clamp(min(1.0, dp.r + pw * dp.g) * gain, 0.0, 1.0);
          v = max(0.0, (v - floorV) / (1.0 - floorV));
          float t = v > 0.0 ? pow(v, gamma) : 0.0;
          vec3 c = texture2D(ramp, vec2(t * ${(RAMP_SIZE - 1) / RAMP_SIZE} + ${0.5 / RAMP_SIZE}, 0.5)).rgb;
          gl_FragColor = vec4(c, min(1.0, t * 2.0));
        }`,
    });
    globeOverlay = new THREE.Mesh(new THREE.SphereGeometry(1.003, 64, 64), material);
    globeOverlay.renderOrder = 2;
    globeOverlay.userData.gpu = true;
    globeScene.earth.add(globeOverlay); // child of earth → rotates with it
    // Compile now and confirm the shader really runs; otherwise fall back to the CPU path.
    const { renderer, scene, camera } = globeScene;
    if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 not available');
    renderer.compile(scene, camera);
    const program = renderer.properties.get(material).currentProgram;
    if (program?.diagnostics && program.diagnostics.runnable === false) throw new Error('shader did not compile');
  }

  /** CPU fallback: recolour into a canvas texture (slow; only used if the GPU path fails). */
  function renderCpuOverlay() {
    const z = CONFIG.globeZoom;
    const n = 2 ** z;
    if (!mercCanvas) {
      mercCanvas = document.createElement('canvas');
      mercCanvas.width = mercCanvas.height = 256 * n;
    }
    const mctx = mercCanvas.getContext('2d');
    if (!tileImage) tileImage = mctx.createImageData(256, 256);
    globeTiles.forEach(tile => {
      if (!tile.heat) tile.heat = tileDensity(tile.raw, 256, 256);
      densityToHeatRgba(tile.heat, tileImage.data);
      mctx.putImageData(tileImage, tile.x * 256, tile.y * 256);
    });
    const W = 256 * n, H = W / 2;
    if (!eqCanvas) {
      eqCanvas = document.createElement('canvas');
      eqCanvas.width = W;
      eqCanvas.height = H;
    }
    const ectx = eqCanvas.getContext('2d');
    ectx.clearRect(0, 0, W, H);
    for (let j = 0; j < H; j++) {
      const lat = Math.max(Math.min(90 - ((j + 0.5) / H) * 180, 85.0511), -85.0511) * Math.PI / 180;
      const my = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2 * W;
      ectx.drawImage(mercCanvas, 0, Math.min(Math.floor(my), W - 1), W, 1, 0, j, W, 1);
    }
    if (!globeOverlay) {
      const texture = new THREE.CanvasTexture(eqCanvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      globeOverlay = new THREE.Mesh(
        new THREE.SphereGeometry(1.003, 64, 64),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
      );
      globeOverlay.renderOrder = 2;
      globeScene.earth.add(globeOverlay);
    } else {
      globeOverlay.material.map.needsUpdate = true;
    }
  }

  function renderGlobeOverlay() {
    if (typeof THREE === 'undefined' || !globeScene || !globeTiles?.length) return;
    if (!gpuFailed && (!globeOverlay || globeOverlay.userData.gpu)) {
      try {
        if (!globeOverlay) buildGpuOverlay();
        const u = globeOverlay.material.uniforms;
        u.gain.value = CONFIG.gain;
        u.pw.value = presenceWeight();
        lutGain = CONFIG.gain;
        globeOverlay.visible = monoActive;
        return;
      } catch (err) {
        console.warn('[heatmap] GPU globe overlay unavailable, using the CPU path:', err.message);
        gpuFailed = true;
        if (globeOverlay) { globeScene.earth.remove(globeOverlay); globeOverlay = null; }
      }
    }
    renderCpuOverlay();
    globeOverlay.visible = monoActive;
  }

  // ---------------------------------------------------------------------
  // Legend
  // ---------------------------------------------------------------------
  const legend = document.createElement('div');
  legend.className = 'fw-heatmap-legend hidden';
  legend.setAttribute('role', 'note');
  legend.innerHTML = `
    <div class="fw-heatmap-legend-bar" style="background: linear-gradient(to right, ${
      STOPS.map(([t, c]) => `${c} ${t * 100}%`).join(', ')})"></div>
    <div class="fw-heatmap-legend-labels"><span>No / negligible</span><span>High deforestation</span></div>
    <label class="fw-heatmap-sensitivity">
      <span>Sensitivity</span>
      <input type="range" min="0" max="100" step="1" value="${Math.round(gainToSlider(CONFIG.gain))}" aria-label="Heatmap sensitivity">
    </label>
    <div class="fw-heatmap-legend-note">Water is blue. Tree cover loss 2001–2023 (all years),
      UMD/Hansen via Global Forest Watch. Raise the sensitivity if it looks all green, lower it if large areas turn red.</div>`;
  document.body.appendChild(legend);
  // The slider fires dozens of 'input' events per second. Recolouring the map (SVG filter) is
  // coalesced to one update per frame; the 3D globe is recoloured on the GPU (instant), or, on the
  // CPU fallback, once when the slider is released.
  let tablesFrame = 0, globeTimer = 0;
  function scheduleHeatUpdate(final) {
    if (!tablesFrame) {
      tablesFrame = requestAnimationFrame(() => { tablesFrame = 0; updateHeatTables(); });
    }
    if (!globeTiles?.length || !globeOverlay?.visible) return;
    if (globeOverlay.userData.gpu) { renderGlobeOverlay(); return; } // uniforms only: instant
    clearTimeout(globeTimer);
    if (final) globeTimer = setTimeout(renderGlobeOverlay, 0); // CPU fallback: recolour once on release
  }
  const slider = legend.querySelector('input[type="range"]');
  slider?.addEventListener('input', e => {
    CONFIG.gain = sliderToGain(parseFloat(e.target.value));
    scheduleHeatUpdate(false);
  });
  slider?.addEventListener('change', () => scheduleHeatUpdate(true));

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  function sync() {
    const visible = isHeatmapVisible();

    // 2D Colour form: worldwide real loss, coloured (the analysis rings are drawn by app.js)
    const colourOn = (document.getElementById('toggle-tree-loss')?.checked ?? true) &&
      document.getElementById('tree-loss-mode')?.value === 'color';
    if (colourOn && !map.hasLayer(colourLoss)) map.addLayer(colourLoss);
    if (!colourOn && map.hasLayer(colourLoss)) map.removeLayer(colourLoss);

    [heatBase, heatLoss].forEach(layer => {
      if (visible && !map.hasLayer(layer)) map.addLayer(layer);
      if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
    });

    if (visible !== monoActive) {
      monoActive = visible;
      document.getElementById('map')?.classList.toggle('fw-heat', visible);
      setGlobeHeatBase(visible);
    }
    if (visible && globeScene) loadGlobeTiles();
    // sensitivity changed while the globe overlay was hidden: recolour it now
    if (visible && globeTiles?.length && lutGain !== CONFIG.gain) renderGlobeOverlay();
    if (globeOverlay) globeOverlay.visible = visible;
    legend.classList.toggle('hidden', !visible);
  }

  // The globe is created lazily by app.js on first toggle. app.js registered
  // its listener first, so initGlobe() has already run when this one fires.
  document.getElementById('toggle-globe')?.addEventListener('change', () => {
    if (!globeScene) return;
    if (monoActive) setGlobeHeatBase(true);
    sync();
  });

  installFilters();
  tagAppLayers();
  if (typeof map.on === 'function') map.on('zoomend', updateBlur);
  updateBlur();

  window.ForestHeatmap = {
    refresh: sync,
    // Exposed for testing / reuse
    baseColor,
    densityToHeat,
    rampRgb,
    lossToHeatRgba,
    tileDensity,
    densityToHeatRgba,
  };
})();
