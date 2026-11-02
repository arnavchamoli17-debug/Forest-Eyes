/**
 * Forest Eyes — which trees fit a place (tree-fit.js)
 * ===================================================
 * Shared by the browser (window.TreeFit) and the server (require): compares a place's
 * measured conditions with each tree's growing requirements and returns one checklist per tree:
 *
 *   water    annual rainfall          vs. the tree's rainfall range (mm/yr)
 *   soil     topsoil pH and texture   vs. the tree's pH range and texture classes
 *   sun      sunshine hours per day   vs. the tree's light class (hours: our heuristic, below)
 *   air      ozone / SO2 / NOx        vs. UNECE critical levels for vegetation (same for every tree)
 *   climate  temperature, frost,      vs. the tree's temperature range, frost limit and altitude
 *            altitude
 *
 * Requirements come from FAO ECOCROP (backend/data/tree-species.json) or, for trees ECOCROP
 * lacks, from sourced team data (backend/data/tree-traits/); native status from Kew's WCVP.
 * Each check is 'pass', 'marginal', 'fail' or 'unknown' (no data: never counted as pass or fail).
 * A tree "can grow here" when no check fails and its climate and water needs are known.
 * Contains no keys and makes no network calls.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TreeFit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHECKS = ['water', 'soil', 'sun', 'air', 'climate'];
  const SPECIES_CHECKS = ['water', 'soil', 'sun', 'climate'];

  // ECOCROP light classes. The hours are OUR heuristic (ECOCROP gives only the class): the
  // annual mean of sunshine hours per day that a class needs in the open.
  const LIGHT = {
    1: { label: 'very bright', hours: 7 },
    2: { label: 'clear skies', hours: 5 },
    3: { label: 'cloudy skies', hours: 3 },
    4: { label: 'light shade', hours: 1.5 },
    5: { label: 'heavy shade', hours: 0 },
  };

  // USDA texture class (soil.js textureClass) → ECOCROP texture: L light, M medium, H heavy
  const TEXTURE_OF = {
    'Sand': 'L', 'Loamy sand': 'L', 'Sandy loam': 'L',
    'Loam': 'M', 'Silt loam': 'M', 'Silt': 'M', 'Sandy clay loam': 'M', 'Clay loam': 'M', 'Silty clay loam': 'M',
    'Sandy clay': 'H', 'Silty clay': 'H', 'Clay': 'H',
  };
  const TEXTURE_NAME = { L: 'light (sandy)', M: 'medium (loamy)', H: 'heavy (clayey)', O: 'organic' };
  const PH_SLACK = 0.5;        // our tolerance for modelled (SoilGrids) pH just outside a tree's range
  const ALTITUDE_SLACK_M = 150; // planted trees often grow a little beyond their recorded altitude
  // Kew-native trees may be up to this much colder than ECOCROP's frost limit before it rules them out
  // (a region like West Himalaya spans foothills to treeline, so nativeness alone is weak evidence)
  const NATIVE_FROST_SLACK_C = 3;
  // A recorded lowest temperature is what the tree met in the wild, not its limit: only far below it fails
  const TEAM_FROST_SLACK_C = 5;

  // Team data records the range a tree lives in the wild, not its limits: a little beyond is marginal
  const TEAM_SLACK = { rain: x => x * 0.15, temp: () => 2 };

  const r1 = x => Math.round(x * 10) / 10;
  const check = (status, have, need, note) => ({ status, have, need, note });
  // The tree's own requirement is not recorded (as opposed to missing data for the place)
  const noRequirement = (what) => ({ status: 'unknown', have: '—', need: 'not recorded for this tree', note: `No ${what} requirement recorded for this tree yet.`, gap: true });

  /** [abs min, opt min, opt max, abs max] → 'pass' | 'marginal' | 'fail', plus which side. */
  function inRange(v, [aMin, oMin, oMax, aMax], slack = 0) {
    if (v < aMin - slack) return { status: 'fail', side: 'low' };
    if (v > aMax + slack) return { status: 'fail', side: 'high' };
    if (v < oMin) return { status: 'marginal', side: 'low' };
    if (v > oMax) return { status: 'marginal', side: 'high' };
    return { status: 'pass', side: null };
  }

  const worst = (...s) => (s.includes('fail') ? 'fail' : s.includes('marginal') ? 'marginal' : s.includes('unknown') ? 'unknown' : 'pass');
  const rangeText = ([aMin, oMin, oMax, aMax], unit) => (oMin === aMin && oMax === aMax
    ? `${aMin}–${aMax} ${unit} in its natural range`
    : `${oMin}–${oMax} ${unit} ideal (survives ${aMin}–${aMax})`);

  /** Kew WCVP status of the tree in the place's TDWG region. */
  function nativeStatus(region, sp) {
    if (!sp.wcvp || !region?.code) return 'unknown';
    if (sp.wcvp.native.includes(region.code)) return 'native';
    if (sp.wcvp.introduced.includes(region.code)) return 'introduced';
    return 'not-recorded';
  }

  // -------------------------------------------------------------------------
  // The five checks
  // -------------------------------------------------------------------------
  function water(sp, climate, rainfallMm) {
    if (!sp.rain) return noRequirement('rainfall');
    const rain = Number.isFinite(rainfallMm) ? rainfallMm : climate?.annualRainMm;
    const [aMin, , , aMax] = sp.rain;
    const need = rangeText(sp.rain, 'mm/yr');
    if (!Number.isFinite(rain)) return check('unknown', 'no rainfall data', need, 'Rainfall data did not load.');
    // Team ranges have ideal = recorded range, so the slack band beyond it comes out marginal
    const slack = sp.requirementsFrom === 'team' ? TEAM_SLACK.rain(rain < aMin ? aMin : aMax) : 0;
    const range = inRange(rain, sp.rain, slack);
    const { side } = range;
    // Too much rain only warns: ECOCROP's upper limits are loose (gulmohar and arjun, capped at
    // 1800 mm, are common in Thiruvananthapuram), and drainage matters more than the total
    const tooWet = range.status === 'fail' && side === 'high';
    const status = tooWet ? 'marginal' : range.status;
    const have = `${Math.round(rain)} mm/yr`;
    const note = tooWet
      ? `Wetter than its recorded range (above ${aMax} mm a year): plant only on well-drained or raised ground, as roots can rot in waterlogged soil.`
      : {
        pass: 'Rainfall is in its range.',
        marginal: side === 'low' ? 'Drier than ideal: water the saplings through their first dry seasons.' : 'Wetter than ideal: plant on well-drained or raised ground.',
        fail: `Too dry: it needs at least ${aMin} mm a year, so it would depend on irrigation for life.`,
      }[status];
    return check(status, have, need, note);
  }

  function soil(sp, s, pending) {
    const needs = [];
    if (sp.ph) needs.push(sp.ph[1] === sp.ph[0] && sp.ph[2] === sp.ph[3] ? `pH ${sp.ph[0]}–${sp.ph[3]}` : `pH ${sp.ph[1]}–${sp.ph[2]} ideal (${sp.ph[0]}–${sp.ph[3]})`);
    if (sp.texture) needs.push(`${sp.texture.optimal.split('').map(c => TEXTURE_NAME[c]).join(', ')} soil`);
    if (!needs.length) return noRequirement('soil');
    const need = needs.join('; ');
    if (!s?.hasData) return check('unknown', pending ? 'loading…' : 'no soil data here', need, pending ? 'Soil data is still loading.' : 'No soil data for this point (often water, rock or built-up land). Test the soil on site.');
    const parts = [], notes = [], states = [];
    if (sp.ph && Number.isFinite(s.pH)) {
      // Modelled pH is uncertain: up to PH_SLACK beyond the absolute range counts as marginal
      const r = inRange(s.pH, sp.ph), side = r.side;
      const status = r.status === 'fail' && sp.ph[0] - PH_SLACK <= s.pH && s.pH <= sp.ph[3] + PH_SLACK ? 'marginal' : r.status;
      parts.push(`pH ${s.pH}`);
      states.push(status);
      if (status !== 'pass') notes.push(`soil is ${side === 'low' ? 'more acidic' : 'more alkaline'} than it ${status === 'fail' ? 'tolerates' : 'prefers'}`);
    }
    const cls = TEXTURE_OF[s.textureClass];
    if (sp.texture && cls) {
      parts.push(`${s.textureClass.toLowerCase()} (${TEXTURE_NAME[cls]})`);
      // Never 'fail' on texture: ECOCROP's classes are coarse and SoilGrids texture is modelled; in
      // validation it wrongly rejected banyan, shisham and mahua on the Deccan's heavy clay soils
      const outside = !sp.texture.absolute.includes(cls);
      const status = outside || !sp.texture.optimal.includes(cls) ? 'marginal' : 'pass';
      states.push(status);
      if (status !== 'pass') notes.push(outside ? `${TEXTURE_NAME[cls]} soil is outside what it is recorded on, so improve drainage and add organic matter at planting` : `${TEXTURE_NAME[cls]} soil is not ideal for it`);
    }
    if (!states.length) return check('unknown', 'soil data incomplete', need, 'The soil values this tree needs are missing for this point.');
    const status = worst(...states);
    const note = status === 'pass' ? 'Soil suits it.'
      : `${notes.join('; ').replace(/^./, c => c.toUpperCase())}.${status === 'marginal' ? ' Compost or mulch helps.' : ''}`;
    return check(status, parts.join(', '), need, note);
  }

  function sun(sp, climate) {
    if (!sp.light) return noRequirement('light');
    const [brightOpt, dimOpt] = sp.light.optimal;
    const [brightAbs, dimAbs] = sp.light.absolute;
    const need = `~${LIGHT[dimOpt].hours}+ h/day ideal (${LIGHT[brightOpt].label}${dimOpt !== brightOpt ? ` to ${LIGHT[dimOpt].label}` : ''}); copes down to ~${LIGHT[dimAbs].hours} h`;
    const h = climate?.sunHoursPerDay;
    if (!Number.isFinite(h)) return check('unknown', 'no sunshine data', need, 'Sunshine data did not load.');
    const have = `${r1(h)} h/day`;
    // Shade lovers: more sun than the brightest class they like
    if (brightAbs > 1 && h >= LIGHT[brightAbs - 1].hours) {
      return check('marginal', have, need, 'More sun than it tolerates in the open: plant under nurse trees or give shade while young.');
    }
    if (brightOpt > 1 && h >= LIGHT[brightOpt - 1].hours) {
      return check('marginal', have, need, 'Prefers some shade: grows best under a light canopy.');
    }
    if (h >= LIGHT[dimOpt].hours) return check('pass', have, need, 'Enough sunshine in the open.');
    // Never 'fail': the hours per class are our own uncalibrated conversion, and in validation it
    // wrongly rejected trees native to cloudy places (wild cherry in London)
    if (h >= LIGHT[dimAbs].hours) return check('marginal', have, need, 'Less sun than ideal: plant in the open, away from tall trees and buildings.');
    return check('marginal', have, need, 'Much less sun than it prefers: plant in the most open, sunny spot available.');
  }

  function air(a) {
    const need = 'below UNECE critical levels for vegetation';
    if (!a) return check('unknown', 'no air-quality data', need, 'Air-quality data did not load.');
    const status = { good: 'pass', moderate: 'marginal', poor: 'marginal' }[a.status] || 'unknown';
    // UNECE critical levels mark measurable harm (ozone 5 ppm·h ≈ 5 % less tree biomass), not death
    const note = {
      good: 'Ozone, SO₂ and NOx are below the UNECE critical levels for vegetation.',
      moderate: `${a.exceeded.join(' and ')} above its critical level: expect somewhat slower growth, not death.`,
      poor: `${a.exceeded.join(' and ')} well above critical levels: expect slower growth (at the ozone level of 5 ppm·h trees lose ~5 % biomass).`,
    }[a.status];
    return check(status, a.summary, need, `${note} (Same for every tree: there is no per-species tolerance data.)`);
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const RANK = { pass: 2, marginal: 1, fail: 0 };

  /**
   * ECOCROP's way (as in Recocrop): the temperature range applies to the growing season only.
   * Every run of seasonMonths consecutive months is tried; the best one counts. Outside it the
   * tree rests, and only frost (the killing temperature) matters.
   */
  function growingWindow(monthly, sp) {
    const n = sp.seasonMonths || 12;
    const [, oMin, oMax] = sp.temp;
    let best = null;
    for (let s = 0; s < 12; s++) {
      const temps = Array.from({ length: n }, (_, k) => monthly[(s + k) % 12]);
      const status = worst(...temps.map(t => inRange(t, sp.temp).status));
      // Ties go to the window closest to the ideal range; side = where most of the shortfall is
      const cold = temps.reduce((a, t) => a + Math.max(0, oMin - t), 0);
      const hot = temps.reduce((a, t) => a + Math.max(0, t - oMax), 0);
      const w = { status, side: cold >= hot ? 'low' : 'high', start: s, n, off: cold + hot };
      if (!best || RANK[status] > RANK[best.status] || (status === best.status && w.off < best.off)) best = w;
      if (n === 12) break;
    }
    best.label = best.n === 12 ? 'all year' : `${MONTHS[best.start]}–${MONTHS[(best.start + best.n - 1) % 12]}`;
    return best;
  }

  /** Temperature range: ECOCROP's growing-season window, or the annual mean from team data. */
  function temperature(sp, c) {
    if (sp.temp) {
      const [aMin, oMin, oMax, aMax] = sp.temp;
      const season = sp.seasonMonths >= 12 ? 'all year' : `over a ${sp.seasonMonths}-month growing season`;
      const win = growingWindow(c.monthlyTempC, sp);
      return {
        need: `${oMin}–${oMax} °C ideal ${season} (${aMin}–${aMax})`,
        status: win.status,
        fail: win.side === 'low' ? `Too cold: no ${sp.seasonMonths}-month stretch is warm enough for it to grow.` : `Too hot: no ${sp.seasonMonths}-month stretch is cool enough for it.`,
        marginal: `best growing months (${win.label}) are ${win.side === 'low' ? 'cooler' : 'warmer'} than ideal, so growth is slower`,
        pass: `temperatures suit it (${win.label})`,
      };
    }
    if (sp.tempAnnual) {
      // Ideal = recorded range here, so the slack band beyond it comes out marginal
      const r = inRange(c.meanTempC, sp.tempAnnual, TEAM_SLACK.temp());
      return {
        need: `${rangeText(sp.tempAnnual, '°C')} (annual mean)`,
        status: r.status,
        fail: r.side === 'low' ? 'Too cold: the annual mean is well below its natural range.' : 'Too hot: the annual mean is well above its natural range.',
        marginal: `the annual mean (${r1(c.meanTempC)} °C) is just ${c.meanTempC < sp.tempAnnual[0] ? 'below' : 'above'} its natural range`,
        pass: 'the annual mean temperature is within its natural range',
      };
    }
    // Team data from silviculture references often gives only the coldest temperature and the
    // altitude the tree grows at (e.g. Troup's "absolute minimum shade temperature"): judged on those
    if (sp.frostLimitC != null || sp.altitudeM) {
      return { need: null, status: 'pass', pass: 'no temperature range recorded; its recorded lowest temperature and altitude suit this place' };
    }
    return null;
  }

  /**
   * @param {string} [nativeHere] Kew status here. A tree Kew records as native in this region survives
   *   its winters somewhere in it, so a SMALL shortfall against ECOCROP's (often crude) frost limit does
   *   not rule it out: validation found it rejecting native banj oak and horse chestnut around Shimla.
   */
  function climateCheck(sp, c, nativeHere) {
    if (!c || !Array.isArray(c.monthlyTempC) || c.monthlyTempC.length !== 12) return check('unknown', 'no temperature data', '—', 'Temperature data did not load.');
    const t = temperature(sp, c);
    const needs = [t?.need,
      sp.killC != null ? `frost below ${sp.killC} °C kills it` : sp.frostLimitC != null ? `recorded down to ${sp.frostLimitC} °C` : null,
      sp.altitudeM ? `${sp.altitudeM[0]}–${sp.altitudeM[1]} m altitude` : null].filter(Boolean);
    const need = needs.join('; ') || 'not recorded for this tree';
    const elev = Number.isFinite(c.terrainElevationM) ? `; ${c.terrainElevationM} m altitude` : '';
    // Monthly normals (offline fallback) have no daily record, so no typical or record winter low
    const frostKnown = Number.isFinite(c.typicalMinC);
    const lows = frostKnown ? `winter lows ~${r1(c.typicalMinC)} °C (record ${r1(c.absMinC)} °C)`
      : `coldest month's average night ~${r1(c.coldestMonthMinC)} °C (no record of the coldest nights)`;
    const have = `${r1(c.coldestMonthC)}–${r1(c.warmestMonthC)} °C monthly means; ${lows}${elev}`;
    if (!t) return { ...noRequirement('temperature'), have };
    if (t.status === 'fail') return check('fail', have, need, t.fail);
    if (!frostKnown) return climateWithoutFrost(sp, c, t, have, need);
    const tooCold = sp.killC != null && c.typicalMinC < sp.killC;
    const nativeExcuse = nativeHere === 'native' && c.typicalMinC >= sp.killC - NATIVE_FROST_SLACK_C;
    if (tooCold && !nativeExcuse) {
      return check('fail', have, need, `A normal winter here (lowest ~${r1(c.typicalMinC)} °C) is colder than the ${sp.killC} °C frost that kills it.`);
    }
    // Team trees: much colder than anywhere it is recorded in the wild rules it out
    if (sp.killC == null && sp.frostLimitC != null && c.typicalMinC < sp.frostLimitC - TEAM_FROST_SLACK_C) {
      return check('fail', have, need, `A normal winter here (~${r1(c.typicalMinC)} °C) is far colder than the lowest temperature recorded for it (${sp.frostLimitC} °C).`);
    }
    const notes = [];
    if (t.status === 'marginal') notes.push(t.marginal);
    if (tooCold) notes.push(`winters here (~${r1(c.typicalMinC)} °C) are colder than ECOCROP's frost limit (${sp.killC} °C), but Kew records it as native in this region: use local seed and protect young plants`);
    else if (sp.killC != null && c.absMinC < sp.killC) notes.push(`the record low (${r1(c.absMinC)} °C) was below its frost-kill ${sp.killC} °C, so protect young plants in hard winters`);
    else if (sp.killC != null && c.typicalMinC < sp.killC + 2) notes.push('winter lows come close to its frost-kill temperature, so protect young plants on cold nights');
    else if (sp.frostLimitC != null && c.typicalMinC < sp.frostLimitC) notes.push(`winters here (~${r1(c.typicalMinC)} °C) are colder than the lowest temperature recorded for it (${sp.frostLimitC} °C)`);
    else if (sp.killC == null && sp.frostLimitC == null && c.typicalMinC < 0) notes.push(`its frost tolerance is not recorded and nights here fall to ~${r1(c.typicalMinC)} °C, so check that local trees of this kind survive winter`);
    if (sp.altitudeM && Number.isFinite(c.terrainElevationM)) {
      const [lo, hi] = sp.altitudeM, z = c.terrainElevationM;
      if (z < lo - ALTITUDE_SLACK_M || z > hi + ALTITUDE_SLACK_M) notes.push(`${z} m is ${z < lo ? 'below' : 'above'} its recorded altitude (${lo}–${hi} m)`);
    }
    if (!notes.length) return check('pass', have, need, `${t.pass.replace(/^./, x => x.toUpperCase())}.`);
    return check('marginal', have, need, `${notes.join('; ').replace(/^./, x => x.toUpperCase())}.`);
  }

  /**
   * Climate check from monthly normals only. The coldest nights are colder than the coldest month's
   * AVERAGE night, so that average settles a frost failure but can never clear a frost-sensitive tree.
   */
  function climateWithoutFrost(sp, c, t, have, need) {
    const night = c.coldestMonthMinC;
    const limit = sp.killC ?? sp.frostLimitC;
    if (sp.killC != null && Number.isFinite(night) && night < sp.killC) {
      return check('fail', have, need, `Even the average night of the coldest month here (~${r1(night)} °C) is colder than the ${sp.killC} °C frost that kills it.`);
    }
    const notes = [];
    if (t.status === 'marginal') notes.push(t.marginal);
    if (limit != null || (Number.isFinite(night) && night < 0)) {
      notes.push(`frost could not be checked: only monthly averages are available here (the coldest month's average night is ~${r1(night)} °C, and the coldest nights are lower)`);
    }
    if (sp.altitudeM && Number.isFinite(c.terrainElevationM)) {
      const [lo, hi] = sp.altitudeM, z = c.terrainElevationM;
      if (z < lo - ALTITUDE_SLACK_M || z > hi + ALTITUDE_SLACK_M) notes.push(`${z} m is ${z < lo ? 'below' : 'above'} its recorded altitude (${lo}–${hi} m)`);
    }
    if (!notes.length) return check('pass', have, need, `${t.pass.replace(/^./, x => x.toUpperCase())}.`);
    return check('marginal', have, need, `${notes.join('; ').replace(/^./, x => x.toUpperCase())}.`);
  }

  // -------------------------------------------------------------------------
  // Whole checklist for one tree, and the ranked list for a place
  // -------------------------------------------------------------------------
  const POINTS = { pass: 2, marginal: 1, unknown: 1, fail: 0 };

  /**
   * @param {object} site  { lat, lon, region, climate, soil, soilPending, air } from /api/v1/trees/site
   * @param {object} sp    one species from /api/v1/trees/species
   * @param {object} [opts] { rainfallMm } — the user's own annual rainfall, replaces the reanalysis value
   */
  function evaluate(site, sp, opts = {}) {
    const status = nativeStatus(site.region || site.climate?.region, sp);
    const checks = {
      water: water(sp, site.climate, opts.rainfallMm),
      soil: soil(sp, site.soil, site.soilPending),
      sun: sun(sp, site.climate),
      air: air(site.air),
      climate: climateCheck(sp, site.climate, status),
    };
    // Air is the same for every tree (no per-species data), so it is shown but does not rank trees
    const statuses = SPECIES_CHECKS.map(k => checks[k].status);
    const native = status === 'native';
    // A tree is only listed as able to grow when its climate and water needs are known
    const enoughData = checks.climate.status !== 'unknown' && checks.water.status !== 'unknown';
    const canGrow = enoughData && !statuses.includes('fail');
    const marginal = statuses.filter(s => s === 'marginal').length;
    const gaps = SPECIES_CHECKS.filter(k => checks[k].gap);
    // No frost data (ECOCROP killing temperature missing) where winters freeze: ranked lower
    const frostUnknown = sp.killC == null && sp.frostLimitC == null && Number.isFinite(site.climate?.typicalMinC) && site.climate.typicalMinC < 0;
    return {
      id: sp.id,
      checks,
      canGrow,
      enoughData,
      // 'good': every tree-specific need is recorded and passes; 'care': grows with some help or
      // has needs not recorded; 'no': a check fails; 'nodata': climate or water needs not recorded
      verdict: !enoughData ? 'nodata' : !canGrow ? 'no' : marginal === 0 && !gaps.length ? 'good' : 'care',
      gaps,
      native,
      nativeStatus: status,
      frostUnknown,
      score: statuses.reduce((s, x) => s + POINTS[x], 0) + (native ? 1 : 0) - (frostUnknown ? 2 : 0),
      failed: CHECKS.filter(k => checks[k].status === 'fail'),
    };
  }

  /** Every tree for this place: those that can grow first, best score first, natives first on ties. */
  function rank(site, species, opts) {
    return species.map(sp => ({ sp, fit: evaluate(site, sp, opts) }))
      .sort((a, b) => (b.fit.canGrow - a.fit.canGrow) || (b.fit.score - a.fit.score) || (b.fit.native - a.fit.native)
        || a.sp.name.localeCompare(b.sp.name));
  }

  return { CHECKS, SPECIES_CHECKS, LIGHT, TEXTURE_OF, nativeStatus, evaluate, rank };
});
