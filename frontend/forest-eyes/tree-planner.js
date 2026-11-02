/**
 * Forest Eyes — "Which trees can grow here?" (tree-planner.js)
 * ============================================================
 * Loaded after app.js and tree-fit.js. The 🌱 button opens a pop-up over a blurred page:
 *   1. loads the place's climate, soil and air quality in parallel (/api/v1/trees/site),
 *      showing each source as it arrives (soil outside India can take ~30 s);
 *   2. checks every tree (TreeFit.rank) on water, soil, sunlight, air and climate;
 *   3. lists the trees that can grow here, each with its checklist and an on/off switch;
 *   4. switching a tree on asks for its report on this place (/api/v1/trees/report).
 * The user can replace the modelled rainfall with their own figure; the list updates at once.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const btn = $('plant-btn');
  if (!btn || !window.TreeFit) return;
  const Fit = window.TreeFit;

  const PARTS = [
    { key: 'climate', label: 'Climate: 5 years of weather (ERA5)' },
    { key: 'soil', label: 'Soil: pH and texture (SoilGrids)' },
    { key: 'air', label: 'Air quality: last 12 months (CAMS)' },
  ];
  const CHECK_LABEL = { water: 'Water', soil: 'Soil', sun: 'Sunlight', air: 'Air quality', climate: 'Climate' };
  const CHECK_ICON = { water: '💧', soil: '🪨', sun: '☀️', air: '💨', climate: '🌡️' };
  const STATUS_TEXT = { pass: 'suitable', marginal: 'possible with care', fail: 'not suitable', unknown: 'no data' };
  const BOX = { pass: '✓', marginal: '!', fail: '✕', unknown: '?' };
  // Kew WCVP status in the place's botanical region. Introduced ≠ invasive, so it is worded neutrally.
  const NATIVE_BADGE = {
    native: '<span class="tp-badge native" title="Native to this region (Kew, World Checklist of Vascular Plants)">Native here</span>',
    introduced: '<span class="tp-badge introduced" title="Grown here but not native (Kew WCVP). Not necessarily invasive.">Introduced here</span>',
    'not-recorded': '<span class="tp-badge absent" title="Kew WCVP has no record of it in this region">Not recorded here</span>',
  };
  const TRAIT_LABEL = {
    leafHabit: 'Leaves', heightM: 'Height (m)', growthRate: 'Growth', droughtTolerance: 'Drought tolerance',
    frostTolerance: 'Frost tolerance', rootSystem: 'Roots', nitrogenFixing: 'Fixes nitrogen', uses: 'Uses',
    wildlifeValue: 'Wildlife', pollutionTolerance: 'Pollution tolerance', invasiveRisk: 'Invasive risk',
    plantingSeason: 'Planting season', propagation: 'Propagation', soilTexture: 'Soil texture', light: 'Light',
    annualRainfallMm: 'Rainfall (mm/yr)', meanAnnualTempC: 'Mean temperature (°C)', absMinTempC: 'Lowest temperature (°C)',
    absMaxTempC: 'Highest temperature (°C)', altitudeM: 'Altitude (m)', soilPh: 'Soil pH',
  };

  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let speciesPromise = null;
  let overlay, modal, body, actions, lastFocus;
  let state = null;   // { seq, lat, lon, name, parts: {climate, soil, air}, status: {key: 'loading'|'done'|'error'}, rainfallMm, selected }
  let seq = 0;

  function loadSpecies() {
    speciesPromise ??= fetch('/api/v1/trees/species').then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).catch(err => { speciesPromise = null; throw err; });
    return speciesPromise;
  }

  async function post(url, payload, timeoutMs = 60000) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /** The place in the coordinate boxes (filled by search, map click or typing). */
  function currentPlace() {
    const lat = parseFloat($('lat-input')?.value), lon = parseFloat($('lng-input')?.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
    const name = (typeof lastName !== 'undefined' && lastName) || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return { lat, lon, name };
  }

  // ---------------------------------------------------------------------
  // Pop-up shell
  // ---------------------------------------------------------------------
  function build() {
    overlay = document.createElement('div');
    overlay.className = 'tp-overlay hidden';
    overlay.innerHTML = `
      <section class="tp-modal" role="dialog" aria-modal="true" aria-labelledby="tp-title" tabindex="-1">
        <header class="tp-head">
          <div class="tp-titles">
            <h2 class="tp-title" id="tp-title">🌱 Which trees can grow here?</h2>
            <div class="tp-place" id="tp-place"></div>
          </div>
          <button type="button" class="tp-close" aria-label="Close tree planner">×</button>
        </header>
        <div class="tp-actions hidden" id="tp-actions">
          <button type="button" class="btn-secondary tp-pdf">⬇ Download PDF</button>
          <span class="tp-pdf-note" role="status" aria-live="polite"></span>
        </div>
        <div class="tp-body" id="tp-body"></div>
      </section>`;
    document.body.appendChild(overlay);
    modal = overlay.querySelector('.tp-modal');
    body = overlay.querySelector('#tp-body');
    actions = overlay.querySelector('#tp-actions');
    actions.querySelector('.tp-pdf').addEventListener('click', downloadPdf);
    overlay.querySelector('.tp-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') trapFocus(e);
    });
  }

  /** Inside the platform shell (frontend/index.html) the Forest ⇄ River switch floats above this frame. */
  function tellShell(open) {
    if (window.parent !== window) window.parent.postMessage({ type: 'APP_MODAL', open }, location.origin);
  }

  function trapFocus(e) {
    const items = [...modal.querySelectorAll('button, input, summary, [tabindex="0"]')].filter(el => !el.disabled && el.offsetParent);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open() {
    const place = currentPlace();
    if (!place) {
      if (typeof setStatus === 'function') setStatus('error', 'Search for a place or click the map first');
      $('location-search')?.focus();
      return;
    }
    if (!overlay) build();
    lastFocus = document.activeElement;
    overlay.classList.remove('hidden');
    document.body.classList.add('tp-open');
    btn.setAttribute('aria-expanded', 'true');
    tellShell(true);
    const coords = `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`;
    $('tp-place').textContent = `📍 ${place.name === coords ? coords : `${place.name} · ${coords}`}`;
    modal.focus();
    start(place);
  }

  function close() {
    if (!overlay || overlay.classList.contains('hidden')) return;
    overlay.classList.add('hidden');
    document.body.classList.remove('tp-open');
    btn.setAttribute('aria-expanded', 'false');
    tellShell(false);
    seq++; // answers still on their way are ignored
    (lastFocus && document.contains(lastFocus) ? lastFocus : btn).focus();
  }

  // ---------------------------------------------------------------------
  // Loading the place
  // ---------------------------------------------------------------------
  function start(place) {
    const my = ++seq;
    state = { seq: my, ...place, parts: {}, status: {}, errors: {}, rainfallMm: null, selected: null, species: null, report: {} };
    PARTS.forEach(p => { state.status[p.key] = 'loading'; });
    renderLoading();

    loadSpecies().then(d => {
      if (my !== seq) return;
      Object.assign(state, { species: d.species, speciesSource: d.source, nativeSource: d.nativeSource, regions: d.regions || {} });
      update();
    },
      err => { if (my === seq) { state.speciesError = err.message; update(); } });

    for (const p of PARTS) {
      post('/api/v1/trees/site', { lat: place.lat, lon: place.lon, part: p.key }, p.key === 'soil' ? 45000 : 40000)
        .then(r => { if (my === seq) { state.parts[p.key] = r.data; state.status[p.key] = 'done'; update(); } })
        .catch(err => {
          if (my !== seq) return;
          state.status[p.key] = 'error';
          state.errors[p.key] = err.name === 'TimeoutError' ? 'took too long' : err.message;
          update();
        });
    }
  }

  /** Well below sea level (terrain tiles include sea depth); soil decides, since land can be too. */
  function belowSea() {
    const z = state.parts.climate?.terrainElevationM;
    return Number.isFinite(z) && z <= -10;
  }

  /** The list needs climate and the species; soil and air may arrive later (soil first if it may be water). */
  function ready() {
    return state.species && state.status.climate !== 'loading' && state.status.air !== 'loading'
      && !(belowSea() && state.status.soil === 'loading');
  }

  function update() {
    if (state.speciesError) return renderError(`The tree list could not load (${state.speciesError}).`);
    if (state.status.climate === 'error') return renderError(`Climate data did not load (${state.errors.climate}). Without it no tree can be checked.`);
    if (!ready()) return renderLoading();
    if (belowSea() && !state.parts.soil?.hasData) {
      return renderError(`This point looks like open water (about ${-state.parts.climate.terrainElevationM} m below sea level, no soil). Pick a point on land.`);
    }
    renderResults();
  }

  function stepIcon(s) { return s === 'done' ? '✓' : s === 'error' ? '✕' : ''; }

  function renderLoading() {
    updateActions(false);
    body.innerHTML = `
      <div class="tp-loading" role="status" aria-live="polite">
        <div class="spinner"></div>
        <p class="tp-loading-title">Reading this place's conditions…</p>
        <ul class="tp-steps">
          ${PARTS.map(p => `<li class="tp-step ${state.status[p.key]}"><span class="tp-step-icon" aria-hidden="true">${stepIcon(state.status[p.key])}</span>${escapeHtml(p.label)}
            <span class="sr-only">: ${state.status[p.key] === 'done' ? 'loaded' : state.status[p.key] === 'error' ? 'failed' : 'loading'}</span></li>`).join('')}
          <li class="tp-step ${state.species ? 'done' : 'loading'}"><span class="tp-step-icon" aria-hidden="true">${state.species ? '✓' : ''}</span>Tree requirements (FAO ECOCROP)</li>
        </ul>
      </div>`;
  }

  function renderError(message) {
    updateActions(false);
    body.innerHTML = `
      <div class="tp-error" role="alert">
        <div class="error-icon">⚠️</div>
        <p>${escapeHtml(message)}</p>
        <button type="button" class="btn-secondary tp-retry">Try again</button>
      </div>`;
    body.querySelector('.tp-retry').addEventListener('click', () => start({ lat: state.lat, lon: state.lon, name: state.name }));
  }

  // ---------------------------------------------------------------------
  // Results: place summary, trees that can grow (with switches), trees that cannot
  // ---------------------------------------------------------------------
  function site() {
    return {
      lat: state.lat, lon: state.lon,
      climate: state.parts.climate,
      soil: state.parts.soil || null,
      soilPending: state.status.soil === 'loading',
      air: state.parts.air || null,
    };
  }

  function box(status, label) {
    return `<span class="tp-box ${status}" role="img" aria-label="${escapeHtml(`${label}: ${STATUS_TEXT[status]}`)}">${BOX[status]}</span>`;
  }

  function summary() {
    const c = state.parts.climate, s = state.parts.soil, a = state.parts.air;
    const soilText = state.status.soil === 'loading' ? 'loading…'
      : state.status.soil === 'error' ? 'did not load'
        : s?.hasData ? `${[s.textureClass, Number.isFinite(s.pH) ? `pH ${s.pH}` : null].filter(Boolean).join(', ')}${s.fallback ? ' (~22 km average)' : s.distanceKm ? ` (${s.distanceKm} km away)` : ''}` : 'no data here';
    const airText = a ? `${{ good: 'Good', moderate: 'Moderate', poor: 'Poor' }[a.status]} for trees` : state.status.air === 'error' ? 'did not load' : '—';
    const rain = state.rainfallMm ?? c.annualRainMm;
    return `
      <div class="tp-site" aria-label="Conditions at this place">
        <div class="tp-site-item">
          <span class="tp-site-label">💧 Rainfall</span>
          <span class="tp-site-value"><input type="number" class="tp-rain" id="tp-rain" min="50" max="12000" step="10" value="${rain}" aria-describedby="tp-rain-note" /> mm/yr</span>
          ${state.rainfallMm != null ? `<button type="button" class="tp-link tp-rain-reset">use the data (${c.annualRainMm} mm)</button>` : ''}
        </div>
        <div class="tp-site-item"><span class="tp-site-label">🌡️ Temperature</span><span class="tp-site-value">${c.coldestMonthC} – ${c.warmestMonthC} °C <small>monthly means</small></span></div>
        <div class="tp-site-item"><span class="tp-site-label">❄️ Winter low</span><span class="tp-site-value">${Number.isFinite(c.typicalMinC)
          ? `${c.typicalMinC} °C <small>record ${c.absMinC}</small>`
          : `${c.coldestMonthMinC} °C <small>coldest month's average night</small>`}</span></div>
        <div class="tp-site-item"><span class="tp-site-label">☀️ Sunshine</span><span class="tp-site-value">${c.sunHoursPerDay} h/day</span></div>
        <div class="tp-site-item"><span class="tp-site-label">🪨 Soil</span><span class="tp-site-value">${escapeHtml(soilText)}</span></div>
        <div class="tp-site-item"><span class="tp-site-label">💨 Air</span><span class="tp-site-value tp-air-${a?.status || 'none'}">${escapeHtml(airText)}</span></div>
      </div>
      <p class="tp-note" id="tp-rain-note">${escapeHtml([c.caveat, s?.fallback].filter(Boolean).join(' '))}</p>`;
  }

  function checklist(fit) {
    return `<div class="tp-checks">${Fit.CHECKS.map(k => `
      <span class="tp-check" title="${escapeHtml(`${CHECK_LABEL[k]}: ${fit.checks[k].note}`)}">${box(fit.checks[k].status, CHECK_LABEL[k])}${CHECK_ICON[k]} ${CHECK_LABEL[k]}</span>`).join('')}
    </div>`;
  }

  function treeCard({ sp, fit }) {
    const on = state.selected === sp.id;
    const names = `${escapeHtml(sp.name)}${sp.localName && sp.localName !== sp.name ? ` <span class="tp-local">${escapeHtml(sp.localName)}</span>` : ''}`;
    return `
      <li class="tp-tree${on ? ' selected' : ''}">
        <label class="tp-tree-head">
          <span class="tp-tree-names"><strong>${names}</strong><em>${escapeHtml(sp.scientific)}</em></span>
          <span class="tp-badges">
            <span class="tp-badge ${fit.verdict}">${fit.verdict === 'good' ? 'Good fit' : 'With care'}</span>
            ${NATIVE_BADGE[fit.nativeStatus] || ''}
          </span>
          <input type="checkbox" role="switch" class="tp-switch" data-id="${escapeHtml(sp.id)}" ${on ? 'checked' : ''}
            aria-label="Show report for ${escapeHtml(sp.name)}" />
          <span class="toggle-slider" aria-hidden="true"></span>
        </label>
        ${checklist(fit)}
        ${on && narrow.matches ? reportBox() : ''}
      </li>`;
  }

  // Phones: the report opens under the tree that was switched on, not after the whole list
  const narrow = window.matchMedia('(max-width: 760px)');
  narrow.addEventListener('change', () => { if (body?.querySelector('.tp-columns')) renderResults(); });
  const reportBox = () => `<div class="tp-report" id="tp-report" aria-live="polite">${reportHtml()}</div>`;

  function group(title, rows) {
    return rows.length ? `<h4 class="tp-group">${title} <span>${rows.length}</span></h4><ul class="tp-trees">${rows.map(treeCard).join('')}</ul>` : '';
  }

  function renderResults() {
    const ranked = Fit.rank(site(), state.species, { rainfallMm: state.rainfallMm ?? undefined });
    const can = ranked.filter(r => r.fit.canGrow);
    const cannot = ranked.filter(r => r.fit.verdict === 'no'), nodata = ranked.filter(r => r.fit.verdict === 'nodata');
    state.ranked = ranked;
    if (state.selected && !can.some(r => r.sp.id === state.selected)) state.selected = null;
    const scroll = body.scrollTop;
    const focusId = document.activeElement?.dataset?.id;
    // Soil can arrive while the user is typing a rainfall figure: keep what they typed
    const typing = document.activeElement?.id === 'tp-rain' ? document.activeElement.value : null;

    updateActions(true);
    body.innerHTML = `
      ${summary()}
      <div class="tp-columns">
        <div class="tp-list">
          <h3 class="tp-h3">Can grow here <span class="tp-count">${can.length}</span></h3>
          ${can.length ? `<p class="tp-hint">Switch a tree on to see how it and this place would get on together.</p>
            ${group('Good fit', can.filter(r => r.fit.verdict === 'good'))}
            ${group('With care', can.filter(r => r.fit.verdict === 'care'))}`
            : '<p class="tp-empty">None of the trees we check suits this place: see why below. If you know your local annual rainfall, enter it above.</p>'}
          ${cannot.length ? `<details class="tp-cannot">
            <summary>Not suited here (${cannot.length})</summary>
            <ul>${cannot.map(({ sp, fit }) => `<li><strong>${escapeHtml(sp.name)}</strong>${sp.localName && sp.localName !== sp.name ? ` (${escapeHtml(sp.localName)})` : ''}:
              ${fit.failed.map(k => `${CHECK_ICON[k]} ${escapeHtml(fit.checks[k].note)}`).join(' ')}</li>`).join('')}</ul>
          </details>` : ''}
          ${nodata.length ? `<details class="tp-cannot">
            <summary>Not enough data yet (${nodata.length})</summary>
            <ul>${nodata.map(({ sp }) => `<li><strong>${escapeHtml(sp.name)}</strong>: its climate or rainfall needs are not recorded yet.</li>`).join('')}</ul>
          </details>` : ''}
          <p class="tp-legend">${['pass', 'marginal', 'fail', 'unknown'].map(s => `${box(s, s)} ${STATUS_TEXT[s]}`).join(' &nbsp; ')}</p>
        </div>
        ${narrow.matches ? '' : reportBox()}
      </div>
      <footer class="tp-sources">
        Tree requirements: ${escapeHtml(state.speciesSource || 'FAO ECOCROP')} (expert ranges), plus team-sourced values where cited.
        Native status: ${escapeHtml(state.nativeSource || 'Kew WCVP')}${state.parts.climate.region ? `, for the region ${escapeHtml(state.parts.climate.region.name)}` : ''}.
        Climate: ${escapeHtml(state.parts.climate.source)}.
        ${state.parts.soil?.hasData ? `Soil: ${escapeHtml(state.parts.soil.source)}.` : ''} ${state.parts.air ? `Air: ${escapeHtml(state.parts.air.source)}.` : ''}
        Sunlight needs per light class (very bright ≈ 7 h/day … light shade ≈ 1.5 h/day) are our own conversion. A screening aid: test the soil and ask a local nursery before planting.
      </footer>`;

    body.scrollTop = scroll;
    if (focusId) body.querySelector(`.tp-switch[data-id="${CSS.escape(focusId)}"]`)?.focus();
    if (typing !== null) { const r = body.querySelector('#tp-rain'); r.value = typing; r.focus(); }
    bindResults();
  }

  function bindResults() {
    const rain = body.querySelector('#tp-rain');
    rain.addEventListener('change', () => {
      const v = Number(rain.value);
      state.rainfallMm = Number.isFinite(v) && v >= 50 && v <= 12000 && v !== state.parts.climate.annualRainMm ? Math.round(v) : null;
      state.report = {}; // reports quoted the old rainfall
      renderResults();
      if (state.selected) loadReport(state.selected);
    });
    body.querySelector('.tp-rain-reset')?.addEventListener('click', () => {
      state.rainfallMm = null;
      state.report = {};
      renderResults();
      if (state.selected) loadReport(state.selected);
    });
    body.querySelectorAll('.tp-switch').forEach(sw => sw.addEventListener('change', () => {
      state.selected = sw.checked ? sw.dataset.id : null; // one tree at a time
      renderResults();
      if (state.selected) loadReport(state.selected);
    }));
    body.querySelector('.tp-report-retry')?.addEventListener('click', () => { delete state.report[state.selected]; loadReport(state.selected); });
  }

  // ---------------------------------------------------------------------
  // Report: one tree and this place
  // ---------------------------------------------------------------------
  function loadReport(id) {
    if (state.report[id]?.data || state.report[id]?.loading) return refreshReport();
    const my = seq;
    state.report[id] = { loading: true };
    refreshReport();
    post('/api/v1/trees/report', {
      lat: state.lat, lon: state.lon, name: state.name, speciesId: id, rainfallMm: state.rainfallMm ?? undefined,
    }, 90000).then(data => {
      if (my !== seq) return;
      state.report[id] = { data };
      refreshReport();
    }).catch(err => {
      if (my !== seq) return;
      state.report[id] = { error: err.name === 'TimeoutError' ? 'The report took too long.' : err.message };
      refreshReport();
    });
  }

  function refreshReport() {
    const el = body.querySelector('#tp-report');
    if (!el) return;
    el.innerHTML = reportHtml();
    el.querySelector('.tp-report-retry')?.addEventListener('click', () => { delete state.report[state.selected]; loadReport(state.selected); });
  }

  function reportHtml() {
    const id = state.selected;
    if (!id) {
      return `<div class="tp-report-empty"><div class="placeholder-icon">🌳</div>
        <p>Switch on a tree from the list to get its report: what it needs, what this place offers, and how to plant it.</p></div>`;
    }
    const row = state.ranked.find(r => r.sp.id === id);
    const r = state.report[id] || {};
    const sp = row.sp, fit = row.fit;
    const head = `
      <h3 class="tp-report-title">${escapeHtml(sp.name)}${sp.localName && sp.localName !== sp.name ? ` · ${escapeHtml(sp.localName)}` : ''}</h3>
      <p class="tp-report-sub"><em>${escapeHtml(sp.scientific)}</em> · ${escapeHtml(sp.family)} · ${nativeText(sp, fit)}</p>
      <table class="tp-table">
        <thead><tr><th scope="col">Check</th><th scope="col">This place</th><th scope="col">The tree needs</th></tr></thead>
        <tbody>${Fit.CHECKS.map(k => `<tr>
          <th scope="row">${box(fit.checks[k].status, CHECK_LABEL[k])} ${CHECK_ICON[k]} ${CHECK_LABEL[k]}</th>
          <td>${escapeHtml(fit.checks[k].have)}</td>
          <td>${escapeHtml(fit.checks[k].need)}<div class="tp-table-note">${escapeHtml(fit.checks[k].note)}</div></td></tr>`).join('')}
        </tbody>
      </table>`;
    if (r.loading) {
      return `${head}<div class="tp-report-loading" role="status"><div class="spinner"></div><p>Treeko is writing the report on ${escapeHtml(sp.name)} and this place…</p></div>`;
    }
    if (r.error) {
      return `${head}<div class="tp-report-error" role="alert"><p>The report failed: ${escapeHtml(r.error)}</p>
        <button type="button" class="btn-secondary tp-report-retry">Try again</button></div>`;
    }
    if (!r.data) return head;
    const rep = r.data.report;
    const list = (title, items) => (items?.length ? `<h4>${title}</h4><ul>${items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '');
    const by = r.data.reportSource === 'rules'
      ? `Rule-based report (no AI answer${r.data.aiError ? `: ${escapeHtml(r.data.aiError)}` : ''}).`
      : r.data.reportSource === 'gemma' ? `Written by ${escapeHtml(r.data.model)} from the data above.` : 'Written by the backup AI model from the data above.';
    return `${head}
      <div class="tp-report-text">
        <p class="tp-headline">${escapeHtml(rep.headline)}</p>
        <p>${escapeHtml(rep.relationship)}</p>
        ${list('Why it suits this place', rep.strengths)}
        ${list('Risks here', rep.risks)}
        ${list('How to plant it', rep.planting)}
        ${list('Care in the first three years', rep.care)}
        ${list('Check on site first', rep.check_on_site)}
        <p class="tp-by">${by}${r.data.missing?.length ? ` Missing data: ${escapeHtml(r.data.missing.join(', '))}.` : ''}</p>
      </div>
      ${traitsHtml(sp)}`;
  }

  /** "Native to West Himalaya, India and 5 more (Kew)", with the status here. */
  function nativeText(sp, fit, esc = escapeHtml) {
    if (!sp.wcvp) return 'native range not recorded';
    const names = sp.wcvp.native.map(c => state.regions[c] || c);
    const list = names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
    const here = { native: ' (native here)', introduced: ' (introduced here)', 'not-recorded': ' (not recorded here)' }[fit.nativeStatus] || '';
    return `native to ${esc(list)}${here}`;
  }

  const fmtTrait = v => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? `${v.min}–${v.max}` : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
  const sourceText = s => [s.title, s.edition, s.year, s.page ? `p. ${s.page}` : null].filter(Boolean).join(', ');

  /** The team's sourced values for this tree, each with its source and quote. */
  function traitsHtml(sp) {
    if (!sp.sources || !Object.keys(sp.sources).length) return '';
    const fmt = fmtTrait;
    const rows = Object.entries(sp.sources).map(([k, s]) => {
      const v = sp.values?.[k];
      const where = sourceText(s);
      return `<li><strong>${escapeHtml(TRAIT_LABEL[k] || k)}</strong>${v != null ? `: ${escapeHtml(fmt(v))}` : ''}
        <div class="tp-table-note">${s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(where)}</a>` : escapeHtml(where)} — “${escapeHtml(s.quote)}”</div></li>`;
    });
    return `<div class="tp-traits"><h4>Sourced tree facts</h4><ul>${rows.join('')}</ul>
      <p class="tp-by">Added by the team, checked by ${escapeHtml(sp.checkedBy || '—')}.</p></div>`;
  }

  // ---------------------------------------------------------------------
  // PDF: this place's growing conditions, then every tree that can grow here
  // ---------------------------------------------------------------------
  const TEXTURE_NAME = { L: 'light (sandy)', M: 'medium (loamy)', H: 'heavy (clayey)', O: 'organic' };
  const DRAINAGE = { W: 'well-drained', I: 'imperfectly drained', E: 'excessively drained (free-draining)', P: 'poorly drained' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const FIT_TEXT = { good: 'Good fit', care: 'With care' };
  const NATIVE_TEXT = { native: 'Native here', introduced: 'Introduced here', 'not-recorded': 'Not recorded here' };
  const PDF_STATUS = { pass: 'OK', marginal: 'Care', fail: 'No', unknown: '?' };
  const fin = Number.isFinite;

  // jsPDF is only fetched the first time someone asks for a PDF (same libraries as Hazard Lens)
  const loadScript = src => new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error(`could not load ${src}`));
    document.head.append(s);
  });
  let pdfLib = null;
  const loadPdfLib = () => (pdfLib ??= loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
    .then(() => loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'))
    .catch(err => { pdfLib = null; throw err; }));

  // jsPDF's built-in fonts only cover Latin-1: swap the symbols the data uses (SO₂, ≈, –), take the accents off
  // other Latin letters (Gdańsk → Gdansk, İzmir → Izmir), drop the rest (emoji, non-Latin scripts)
  const UNACCENTED = { ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i', ħ: 'h', Ħ: 'H', ŧ: 't', Ŧ: 'T', œ: 'oe', Œ: 'OE', ŋ: 'ng', Ŋ: 'NG' };
  const pdfText = s => String(s ?? '').replace(/≈/g, '~').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/→/g, '->')
    .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[₀-₉]/g, d => String(d.charCodeAt(0) - 0x2080))
    .replace(/[^\x00-\xff]/g, ch => UNACCENTED[ch] ?? ch.normalize('NFD').replace(/\p{M}/gu, ''))
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, '').replace(/ {2,}/g, ' ').trim();
  // A name with no letters left after that (Devanagari, CJK, Arabic…) is replaced by the coordinates
  const pdfName = (name, coords) => (/[A-Za-z\xc0-\xff]/.test(pdfText(name)) ? pdfText(name) : coords);

  const textures = codes => codes.split('').map(c => TEXTURE_NAME[c]).filter(Boolean).join(', ');
  const lightSpan = ([a, b]) => (a === b ? Fit.LIGHT[a].label : `${Fit.LIGHT[a].label} to ${Fit.LIGHT[b].label}`);

  /** What this place offers trees, as [measure, value] rows. */
  function conditionRows() {
    const c = state.parts.climate, s = state.parts.soil, a = state.parts.air, se = c.seasons;
    const rows = [
      ['Annual rainfall', state.rainfallMm != null ? `${state.rainfallMm} mm a year (your figure; the data gives ${c.annualRainMm} mm)` : `${c.annualRainMm} mm a year`],
    ];
    if (se?.wetSeason) rows.push(['Wet season', se.wetSeason]);
    if (Array.isArray(se?.dryMonths)) rows.push(['Dry months', se.dryMonths.length ? `${se.dryMonths.join(', ')} (${se.rule})` : 'none']);
    if (fin(c.meanTempC)) rows.push(['Mean temperature', `${c.meanTempC} °C over the year`]);
    rows.push(['Monthly mean temperature', `${c.coldestMonthC} °C (coldest month) to ${c.warmestMonthC} °C (warmest month)`]);
    rows.push(['Winter low', fin(c.typicalMinC) ? `${c.typicalMinC} °C in a normal winter (record ${c.absMinC} °C)` : `${c.coldestMonthMinC} °C (coldest month's average night)`]);
    // frostMonths = months whose AVERAGE night is at or below 0 °C (backend): single frosty nights are not counted
    if (Array.isArray(c.frostMonths)) {
      rows.push(['Months with average nights at or below 0 °C', c.frostMonths.length ? c.frostMonths.join(', ')
        : fin(c.typicalMinC) && c.typicalMinC < 0 ? `none on average, but frosty nights still occur (normal winter low ${c.typicalMinC} °C)` : 'none']);
    }
    rows.push(['Sunshine', `${c.sunHoursPerDay} h a day${fin(c.sunHoursLowestMonth) ? ` (${c.sunHoursLowestMonth} h in the dullest month)` : ''}`]);
    if (fin(c.terrainElevationM)) rows.push(['Altitude', `${c.terrainElevationM} m`]);
    if (c.region) rows.push(['Botanical region', `${c.region.name} (${c.region.code})`]);
    if (s?.hasData) {
      const where = s.fallback ? ' (~22 km average)' : s.distanceKm ? ` (${s.distanceKm} km away)` : '';
      // SoilGrids can return some layers without others: each row only when its values exist
      if (s.textureClass) rows.push(['Soil texture', `${s.textureClass}${Fit.TEXTURE_OF[s.textureClass] ? `, ${TEXTURE_NAME[Fit.TEXTURE_OF[s.textureClass]]}` : ''}${where}`]);
      if (fin(s.pH)) rows.push(['Soil pH', `${s.pH}${s.textureClass ? '' : where}`]);
      if ([s.clayPct, s.sandPct, s.siltPct].every(fin)) rows.push(['Clay / sand / silt', `${s.clayPct} / ${s.sandPct} / ${s.siltPct} %`]);
      if (fin(s.organicCarbonGkg)) rows.push(['Organic carbon', `${s.organicCarbonGkg} g/kg`]);
    } else {
      rows.push(['Soil', state.status.soil === 'error' ? `did not load (${state.errors.soil})` : 'no soil data here: test the soil on site']);
    }
    rows.push(['Air quality for trees', a
      ? `${{ good: 'Good', moderate: 'Moderate', poor: 'Poor' }[a.status]}${a.exceeded?.length ? ` (${a.exceeded.join(', ')} above the critical level)` : ''}: ${a.summary}`
      : state.status.air === 'error' ? `did not load (${state.errors.air})` : 'no data']);
    return rows;
  }

  const drains = sp => (sp.drainage || []).map(d => DRAINAGE[d]).filter(Boolean).join(' or ');
  const ideal = (r, unit = '') => (r.length === 4 ? `${r[1]}-${r[2]}${unit}` : `${r[0]}-${r[r.length - 1]}${unit}`);

  /** A tree's ideal conditions in one line, for the "with care" table. */
  function needSummary(sp) {
    return [
      sp.temp ? `${ideal(sp.temp, ' °C')} in the growing season` : sp.tempAnnual ? `${ideal(sp.tempAnnual, ' °C')} annual mean` : null,
      sp.killC != null ? `killed by frost below ${sp.killC} °C` : null,
      sp.rain ? `${ideal(sp.rain, ' mm')} rain a year` : null,
      sp.ph ? `soil pH ${ideal(sp.ph)}` : null,
      sp.texture ? `${textures(sp.texture.optimal)} soil` : null,
      sp.drainage?.length ? drains(sp) : null,
      sp.light ? `${lightSpan(sp.light.optimal)} light` : null,
      sp.altitudeM ? `${sp.altitudeM[0]}-${sp.altitudeM[1]} m altitude` : null,
    ].filter(Boolean).join('; ') || 'not recorded';
  }

  /** The team's sourced values for a tree, as [fact, value (source: "quote")] rows. */
  const sourcedRows = sp => Object.entries(sp.sources || {}).map(([k, s]) => {
    const v = sp.values?.[k];
    return [TRAIT_LABEL[k] || k, `${v != null ? `${fmtTrait(v)} ` : ''}(${sourceText(s)}: "${s.quote}")`];
  });

  /**
   * The PDF bar lives outside #tp-body, so re-rendering the list never swaps the button under a click
   * (typing a rainfall figure and clicking the button re-renders on blur, between mousedown and click).
   * While busy the button stays focusable (aria-disabled, not disabled), so focus stays in the dialog.
   */
  function updateActions(show) {
    if (!actions) return;
    actions.classList.toggle('hidden', !show);
    if (!show) return;
    const pdfBtn = actions.querySelector('.tp-pdf');
    const wait = state.status.soil === 'loading';
    pdfBtn.disabled = wait; // only ever before the first click: soil never starts loading again for this place
    pdfBtn.setAttribute('aria-disabled', String(wait || !!state.pdfBusy));
    pdfBtn.textContent = state.pdfBusy ? 'Preparing PDF…' : state.pdfMsg === 'failed' ? 'PDF failed - try again' : '⬇ Download PDF';
    actions.querySelector('.tp-pdf-note').textContent = wait ? 'Waiting for the soil data…'
      : state.pdfBusy ? 'Preparing the PDF…'
        : state.pdfMsg === 'done' ? 'PDF downloaded.'
          : state.pdfMsg === 'failed' ? 'The PDF could not be made. Check the connection and try again.'
            : 'This place\'s growing conditions and every tree that can grow here.';
  }

  async function downloadPdf(e) {
    const s = state;
    // detail > 1: the second click of a double-click (once jsPDF is cached the first one finishes before it)
    if (!s || s.pdfBusy || s.status.soil === 'loading' || e?.detail > 1) return;
    s.pdfBusy = true;
    s.pdfMsg = null;
    updateActions(true);
    try {
      await loadPdfLib();
      if (state !== s) return; // another place was opened meanwhile: the rest is synchronous
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
      let y = M;
      const room = h => { if (y + h > H - M - 14) { doc.addPage(); y = M; } };
      const line = (text, size = 10, style = 'normal', color = 40) => {
        doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(color);
        const lines = doc.splitTextToSize(pdfText(text), W - 2 * M);
        room(lines.length * size * 1.3);
        doc.text(lines, M, y + size * 0.9);
        y += lines.length * size * 1.3;
      };
      const heading = (text, size = 13) => { y += 6; room(size * 1.3 + 60); line(text, size, 'bold', 20); y += 3; };
      const table = (head, rows, opts = {}) => {
        doc.autoTable({
          startY: y, margin: { left: M, right: M, top: M, bottom: M + 14 },
          head: head && [head.map(pdfText)], body: rows.map(r => r.map(pdfText)),
          styles: { font: 'helvetica', fontSize: 9, cellPadding: 4, overflow: 'linebreak', textColor: 40 },
          headStyles: { fillColor: [20, 70, 45], textColor: 255 },
          alternateRowStyles: { fillColor: [244, 248, 245] },
          rowPageBreak: 'avoid', // a tree's row stays on one page
          ...opts,
        });
        y = doc.lastAutoTable.finalY + 12;
      };
      const ranked = s.ranked;
      const can = ranked.filter(r => r.fit.canGrow);
      const cannot = ranked.filter(r => r.fit.verdict === 'no'), nodata = ranked.filter(r => r.fit.verdict === 'nodata');
      const c = s.parts.climate;
      const coords = `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;
      const place = pdfName(s.name, coords);
      // A fixed Latin-digit locale: Marathi, Bengali or Arabic digits would be dropped by the Latin-1 font
      const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

      line('Which trees can grow here?', 20, 'bold', 20);
      line(place, 13, 'bold');
      line(`Lat ${s.lat.toFixed(4)}, Lon ${s.lon.toFixed(4)}${c.region ? ` · ${c.region.name}` : ''} · Generated ${when} by Forest Eyes`, 9, 'normal', 110);
      y += 4;
      line(`${can.length} of the ${ranked.length} trees we check can grow here (${can.filter(r => r.fit.verdict === 'good').length} good fit, ${can.filter(r => r.fit.verdict === 'care').length} with care).`, 10);

      // 1. The place
      heading('1. Growing conditions at this place');
      line('What this place offers a tree. Every tree below is checked against these figures.', 9, 'italic', 90);
      y += 4;
      table(['Measure', 'This place'], conditionRows(), { columnStyles: { 0: { cellWidth: 140, fontStyle: 'bold' } } });
      if (Array.isArray(c.monthlyTempC) && c.monthlyTempC.length === 12) {
        room(80);
        const rain = c.seasons?.monthlyRainMm;
        const rainRow = Array.isArray(rain) && rain.length === 12;
        table(['', ...MONTHS], [
          ['Mean temp (°C)', ...c.monthlyTempC.map(v => (fin(v) ? String(Math.round(v * 10) / 10) : '-'))],
          ...(rainRow ? [['Rain (mm)', ...rain.map(v => (fin(v) ? String(v) : '-'))]] : []),
        ], { styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 3, halign: 'center', textColor: 40 }, columnStyles: { 0: { cellWidth: 75, halign: 'left', fontStyle: 'bold' } } });
        // The rows come from different datasets than the annual rainfall: say so, or the sums look wrong
        const tempFrom = `${{ era5: 'ERA5 reanalysis', 'nasa-power': 'NASA POWER', worldclim: 'WorldClim' }[c.provider] || 'modelled data'}, ${c.years}`;
        line(`Monthly temperatures: ${tempFrom}.${rainRow ? ` Monthly rain, wet season and dry months: ${c.seasons.source}. ` +
          `The annual rainfall above is ${s.rainfallMm != null ? 'your own figure' : `a different long-term average (${c.rainSource})`}, so the months need not add up to it.` : ''}`, 8, 'italic', 100);
        y += 4;
      }
      const caveat = [c.caveat, s.parts.soil?.fallback].filter(Boolean).join(' ');
      if (caveat) { line(caveat, 8.5, 'italic', 100); y += 4; }

      // 2. The best trees: a profile each. 3. The rest that can grow: one row each.
      const names = sp => `${sp.name}${sp.localName && sp.localName !== sp.name ? ` (${sp.localName})` : ''}`;
      const small = { font: 'helvetica', fontSize: 8, cellPadding: 3, textColor: 40 };
      const best = can.filter(({ sp, fit }) => fit.verdict === 'good' || s.report[sp.id]?.data);
      const rest = can.filter(r => !best.includes(r));
      const SPECIES = Fit.SPECIES_CHECKS; // air is the same for every tree: section 1
      const noteFor = ({ fit }) => SPECIES.filter(k => fit.checks[k].status !== 'pass')
        .map(k => `${CHECK_LABEL[k]}: ${fit.checks[k].note}`).join('\n');

      heading(`2. Best trees for this place (${best.length})`);
      if (!can.length) {
        line('None of the trees we check suits this place (see section 4). If you know your local annual rainfall, enter it in the planner and download again.', 10);
      } else if (!best.length) {
        line(`No tree passes every check here. The ${rest.length} trees in section 3 can grow with care: each row says what to watch.`, 10);
      } else {
        // Missing place data (no soil here, soil failed to load…) leaves a check 'unknown': never claim it passed
        const unchecked = SPECIES.filter(k => best.some(r => r.fit.checks[k].status === 'unknown')).map(k => CHECK_LABEL[k].toLowerCase());
        line(`${unchecked.length
          ? `Every tree that passes every check that could be made here. ${unchecked.join(' and ').replace(/^./, x => x.toUpperCase())} could not be checked ("?" below): test on site`
          : 'Every tree that passes all the checks for water, soil, sunlight and climate'}` +
          `${best.some(r => r.fit.verdict !== 'good') ? '; plus the trees you opened a report for in the planner' : ''}. ` +
          'Air quality is the same for every tree (section 1).', 9, 'italic', 90);
        best.forEach(({ sp, fit }, i) => {
          heading(`2.${i + 1} ${names(sp)}`, 12);
          line(`${sp.scientific} · ${sp.family} · ${FIT_TEXT[fit.verdict]}`, 9.5, 'italic', 70);
          line(`${nativeText(sp, fit, x => x).replace(/^./, x => x.toUpperCase())} (Kew WCVP).`, 9, 'normal', 70);
          y += 4;
          const dr = drains(sp);
          table(['Check', `What it needs (${sp.requirementsFrom === 'ecocrop' ? 'FAO ECOCROP' : 'team-sourced'})`, 'Here'],
            SPECIES.map(k => [CHECK_LABEL[k], `${fit.checks[k].need}${k === 'soil' && dr ? `; ${dr}` : ''}`, `${PDF_STATUS[fit.checks[k].status]}: ${fit.checks[k].note}`]),
            { styles: small, columnStyles: { 0: { cellWidth: 58, fontStyle: 'bold' }, 1: { cellWidth: 200 } } });
          const facts = sourcedRows(sp);
          if (facts.length) table(['Sourced tree facts', ''], facts, { styles: small, columnStyles: { 0: { cellWidth: 120, fontStyle: 'bold' } } });
          const rep = s.report[sp.id]?.data;
          if (rep?.report) {
            const r = rep.report;
            room(60);
            line('Planting report', 10.5, 'bold', 30);
            if (r.headline) line(r.headline, 9.5, 'bold', 40);
            if (r.relationship) line(r.relationship, 9);
            [['Why it suits this place', r.strengths], ['Risks here', r.risks], ['How to plant it', r.planting],
              ['Care in the first three years', r.care], ['Check on site first', r.check_on_site]].forEach(([title, items]) => {
              if (!items?.length) return;
              y += 2;
              line(title, 9, 'bold', 50);
              items.forEach(x => line(`- ${x}`, 9));
            });
            line(rep.reportSource === 'rules' ? 'Rule-based report (no AI answer).'
              : rep.reportSource === 'gemma' ? `Written by ${rep.model} from the data above.` : 'Written by the backup AI model from the data above.', 8, 'italic', 110);
          }
        });
        if (best.some(({ sp }) => !s.report[sp.id]?.data)) {
          y += 4;
          line('Planting reports (when and how to plant, care in the first years): switch a tree on in the planner to get its report, then download again to include it.', 8.5, 'italic', 100);
        }
      }

      if (rest.length) {
        heading(`3. Can also grow here, with care (${rest.length})`);
        line('These trees can grow here, but at least one check needs attention or is not recorded for the tree. "Care" = possible with care, "?" = not recorded.', 9, 'italic', 90);
        y += 4;
        table(['Tree', 'Native status', 'Ideal conditions', 'What needs care here'],
          rest.map(r => [`${names(r.sp)}\n${r.sp.scientific}\n${r.sp.family}`, NATIVE_TEXT[r.fit.nativeStatus] || 'unknown', needSummary(r.sp), noteFor(r)]),
          { styles: small, columnStyles: { 0: { cellWidth: 115, fontStyle: 'bold' }, 1: { cellWidth: 58 }, 2: { cellWidth: 150 } } });
      }

      // 4. Trees that cannot grow here
      if (cannot.length || nodata.length) {
        heading(`4. Not suited here (${cannot.length})${nodata.length ? ` and not enough data (${nodata.length})` : ''}`);
        if (cannot.length) {
          table(['Tree', 'Why not'], cannot.map(({ sp, fit }) => [`${names(sp)}\n${sp.scientific}`,
            fit.failed.map(k => `${CHECK_LABEL[k]}: ${fit.checks[k].note}`).join('\n')]),
            { styles: small, columnStyles: { 0: { cellWidth: 130, fontStyle: 'bold' } } });
        }
        if (nodata.length) line(`Not enough data yet (climate or rainfall needs not recorded): ${nodata.map(({ sp }) => sp.name).join(', ')}.`, 9);
      }

      // Sources
      heading('Sources', 11);
      [`Tree requirements: ${s.speciesSource || 'FAO ECOCROP'} (expert ranges), plus team-sourced values where cited.`,
        `Native status: ${s.nativeSource || 'Kew WCVP'}${c.region ? `, for the region ${c.region.name}` : ''}.`,
        `Climate: ${c.source}.`,
        s.parts.soil?.hasData ? `Soil: ${s.parts.soil.source}.` : null,
        s.parts.air ? `Air: ${s.parts.air.source}.` : null,
        'Sunlight needs per light class (very bright ~ 7 h/day ... light shade ~ 1.5 h/day) are our own conversion.',
      ].filter(Boolean).forEach(t => line(t, 8.5, 'normal', 80));
      y += 4;
      line('A screening aid, not a planting prescription: test the soil and ask a local nursery or forest department before planting.', 8.5, 'italic', 100);

      const pages = doc.getNumberOfPages();
      for (let p = 1; p <= pages; p++) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130);
        doc.text(pdfText(`Forest Eyes · Which trees can grow here? · ${place}`), M, H - 22);
        doc.text(`Page ${p} of ${pages}`, W - M, H - 22, { align: 'right' });
      }
      const slug = place.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'place';
      doc.save(`trees-for-${slug}-${new Date().toISOString().slice(0, 10)}.pdf`);
      s.pdfMsg = 'done';
    } catch (err) {
      s.pdfMsg = 'failed';
      console.error('[tree planner pdf]', err);
    } finally {
      s.pdfBusy = false;
      if (state === s && !actions.classList.contains('hidden')) updateActions(true);
    }
  }

  btn.addEventListener('click', open);
  window.ForestTreePlanner = { open, close };
})();
