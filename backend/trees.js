/**
 * Earth Intelligence Platform — Forest Eyes tree planner (trees.js)
 * =================================================================
 * GET  /api/v1/trees/species                      the trees we can check: FAO ECOCROP (data/tree-species.json)
 *                   + the team's sourced trees (data/tree-traits/) + Kew native ranges (data/tree-native.json)
 * POST /api/v1/trees/site   { lat, lon, part }    one part of the place's conditions:
 *   part 'climate'  5 full years of ERA5 daily weather (Open-Meteo archive, era5_seamless):
 *                   mean / monthly / lowest temperature, sunshine hours; annual rainfall from the
 *                   CHPclim climatology (rainfall.js), ERA5 only where it has no land cell.
 *                   Fallbacks, in order: NASA POWER (MERRA-2, same 5 years), then the offline
 *                   WorldClim 1970–2000 normals (worldclim.js). Seasons for planting advice: WorldClim.
 *   part 'soil'     topsoil pH and texture (India grid, else ISRIC SoilGrids — can take ~30 s;
 *                   if it fails or has no soil at the point, the offline 0.2° SoilGrids grid)
 *   part 'air'      last 365 days of CAMS global air quality (Open-Meteo) vs. UNECE critical
 *                   levels for vegetation: O3 (AOT40), SO2, NOx
 * POST /api/v1/trees/report { lat, lon, name, speciesId, rainfallMm? }
 *                   how one tree and this place would get on: AI model, or a rule-based report
 *
 * The checklist itself (frontend/forest-eyes/tree-fit.js) runs in the browser and here.
 * Every number is measured or modelled data with its source; nothing is estimated by the AI.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const gemma = require('./gemma.js');
const site = require('./site.js');
const soilIndia = require('./soil.js');
const elevation = require('./elevation.js');
const rainfall = require('./rainfall.js');
const worldclim = require('./worldclim.js');
const tdwg = require('./tdwg.js');
const traits = require('./tree-traits.js');
const fit = require('../frontend/forest-eyes/tree-fit.js');

const DATA = path.join(__dirname, 'data');

const YEARS = 5;
const NO_AS_NO2 = 46.0055 / 30.0061;  // µg NO → µg NO2-equivalent (NOx is expressed as NO2)
const O3_UG_PER_PPB = 1.96;           // at 25 °C, 1 atm
// UNECE Mapping Manual (2024), chapter 3: Tables 3.1, 3.2 and 3.17
const LEVELS = { so2: 20, nox: 30, aot40: 5 };

// The trees we check: FAO ECOCROP + the team's sourced trees (data/tree-traits/) + Kew native ranges
const ecocrop = JSON.parse(fs.readFileSync(path.join(DATA, 'tree-species.json'), 'utf8'));
const nativeRanges = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'tree-native.json'), 'utf8')); } catch { return {}; }
})();
const team = traits.loadTeamTrees();
team.problems.forEach(p => console.warn('[trees] team tree data skipped:', p));
const allSpecies = traits.merge(ecocrop.species, team.trees, nativeRanges);
const byId = new Map(allSpecies.map(s => [s.id, s]));
const regionNames = nativeRanges._regions || {};
const regionList = codes => codes.map(c => regionNames[c] || c);

const climateCache = new Map();
const airCache = new Map();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function getJson(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function point({ lat, lon }) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw httpError(400, 'Valid lat and lon are required.');
  }
  return { lat, lon };
}

/** Cache a promise per ~5 km cell; a failed job is dropped so the next request retries. */
function cached(cache, lat, lon, job) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (!cache.has(key)) {
    const p = job();
    p.catch(() => cache.delete(key));
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(key, p);
  }
  return cache.get(key);
}

const mean = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---------------------------------------------------------------------------
// Climate: ERA5 (Open-Meteo archive)
// ---------------------------------------------------------------------------
/**
 * Sunshine hours from measured radiation, FAO-56 (Allen et al. 1998) eq. 21, 34 and 35 inverted:
 * Rs = (0.25 + 0.5 n/N) Ra → n = N (Rs/Ra − 0.25) / 0.5. Open-Meteo's own sunshine_duration
 * runs ~2.5 h/day above station records (Dehradun ~9.8 h, London ~7.7 h), this ~1 h.
 */
function sunshineHours(lat, isoDate, rsMJ) {
  const doy = Math.round((Date.parse(isoDate) - Date.parse(`${isoDate.slice(0, 4)}-01-01`)) / 864e5) + 1;
  const phi = lat * Math.PI / 180;
  const dr = 1 + 0.033 * Math.cos(2 * Math.PI * doy / 365);
  const dec = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))));
  const ra = 24 * 60 / Math.PI * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws));
  const N = 24 / Math.PI * ws;
  if (!(ra > 0) || !Number.isFinite(rsMJ)) return null;
  return Math.max(0, Math.min(N, N * (rsMJ / ra - 0.25) / 0.5));
}

// Climate comes from the first source that answers, all real records, never estimates:
//   1. ERA5 reanalysis, 5 years of daily data (Open-Meteo archive)
//   2. NASA POWER, the same 5 years of daily data from MERRA-2 (a separate provider and model)
//   3. WorldClim 2.1 monthly normals 1970–2000, bundled offline (worldclim.js)
// The coarse fallbacks (MERRA-2 ~50 km, WorldClim 0.5° outside India) can sit hundreds of metres
// above or below the point, so their temperatures are moved to the point's own altitude with the
// standard lapse rate, and the answer says so.
const LAPSE_C_PER_M = -0.0065; // ICAO standard atmosphere
const LAPSE_MIN_DIFF_M = 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ERA5 daily (Open-Meteo archive) in the shared daily form. */
async function era5Daily(lat, lon, first, last) {
  const j = await getJson('https://archive-api.open-meteo.com/v1/archive' +
    `?latitude=${lat}&longitude=${lon}&start_date=${first}-01-01&end_date=${last}-12-31` +
    '&daily=temperature_2m_mean,temperature_2m_min,precipitation_sum,shortwave_radiation_sum' +
    '&models=era5_seamless&timezone=auto', 30000);
  const d = j.daily;
  if (!d?.time?.length) throw new Error('no climate data');
  return {
    time: d.time, tmean: d.temperature_2m_mean, tmin: d.temperature_2m_min, rs: d.shortwave_radiation_sum, rain: d.precipitation_sum,
    gridElevationM: Number.isFinite(j.elevation) ? Math.round(j.elevation) : null,
    label: `ERA5 reanalysis ${first}–${last} (Copernicus/ECMWF, ~9–25 km grid) via Open-Meteo`,
  };
}

/** NASA POWER daily (MERRA-2 temperature and rain, CERES/MERRA-2 radiation) in the shared daily form. */
async function powerDaily(lat, lon, first, last) {
  const j = await getJson('https://power.larc.nasa.gov/api/temporal/daily/point' +
    `?parameters=T2M,T2M_MIN,PRECTOTCORR,ALLSKY_SFC_SW_DWN&community=AG&latitude=${lat}&longitude=${lon}` +
    `&start=${first}0101&end=${last}1231&format=JSON`, 30000);
  const p = j?.properties?.parameter;
  if (!p?.T2M) throw new Error('no climate data');
  const fill = j.header?.fill_value ?? -999;
  const keys = Object.keys(p.T2M).sort();
  const col = name => keys.map(k => (p[name]?.[k] === fill || p[name]?.[k] == null ? null : p[name][k]));
  const z = j.geometry?.coordinates?.[2];
  return {
    time: keys.map(k => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`),
    tmean: col('T2M'), tmin: col('T2M_MIN'), rs: col('ALLSKY_SFC_SW_DWN'), rain: col('PRECTOTCORR'),
    gridElevationM: Number.isFinite(z) ? Math.round(z) : null,
    label: `NASA POWER ${first}–${last} (MERRA-2 reanalysis, ~50 km grid; radiation from CERES/MERRA-2)`,
  };
}

const DAILY_SOURCES = [
  { id: 'era5', name: 'ERA5 (Open-Meteo)', load: era5Daily },
  { id: 'nasa-power', name: 'NASA POWER', load: powerDaily },
];

/** Daily records → the planner's temperature, frost and sunshine figures. */
function summarizeDaily(d, lat) {
  const months = Array.from({ length: 12 }, () => ({ t: [], lo: [], sun: [] }));
  const sun = [];
  let rain = 0, rainDays = 0;
  d.time.forEach((t, i) => {
    const m = months[Number(t.slice(5, 7)) - 1];
    if (Number.isFinite(d.tmean[i])) m.t.push(d.tmean[i]);
    if (Number.isFinite(d.tmin[i])) m.lo.push(d.tmin[i]);
    const h = sunshineHours(lat, t, d.rs[i]);
    if (h != null) { sun.push(h); m.sun.push(h); }
    if (Number.isFinite(d.rain[i])) { rain += d.rain[i]; rainDays++; }
  });
  const lows = d.tmin.filter(Number.isFinite);
  if (!lows.length || rainDays < 300 * YEARS || months.some(m => !m.t.length)) throw new Error('climate record incomplete');
  // A normal winter: the mean of each year's coldest night (the record low is a rare extreme)
  const yearLows = {};
  d.time.forEach((t, i) => {
    const v = d.tmin[i], y = t.slice(0, 4);
    if (Number.isFinite(v)) yearLows[y] = Math.min(yearLows[y] ?? Infinity, v);
  });
  const monthlySun = months.map(m => mean(m.sun));
  return {
    meanTempC: mean(d.tmean),
    monthlyTempC: months.map(m => mean(m.t)),
    monthlyMinC: months.map(m => mean(m.lo)),
    absMinC: Math.min(...lows),
    typicalMinC: mean(Object.values(yearLows)),
    sunHoursPerDay: mean(sun),
    sunHoursLowestMonth: Math.min(...monthlySun.filter(Number.isFinite)),
    rainMm: Math.round(rain / (rainDays / 365.25)),
  };
}

/** WorldClim monthly normals → the same figures (no daily record, so no record or typical lows). */
function summarizeNormals(wc, lat) {
  const monthlySun = wc.sradMJ.map((rs, m) => sunshineHours(lat, `2001-${String(m + 1).padStart(2, '0')}-15`, rs));
  return {
    meanTempC: mean(wc.tavgC),
    monthlyTempC: wc.tavgC,
    monthlyMinC: wc.tminC,
    absMinC: null,
    typicalMinC: null,
    sunHoursPerDay: mean(monthlySun),
    sunHoursLowestMonth: Math.min(...monthlySun.filter(Number.isFinite)),
    rainMm: wc.precMm.reduce((a, b) => a + b, 0),
  };
}

const monthRun = (start, n) => (n >= 12 ? 'all year' : n === 1 ? MONTHS[start] : `${MONTHS[start]}–${MONTHS[(start + n - 1) % 12]}`);

/** Month names → runs, wrapping round the year: [Jan, Feb, Oct, Nov, Dec] → "Oct–Feb". */
function monthRuns(names) {
  const on = MONTHS.map(m => names.includes(m));
  if (on.every(Boolean)) return 'all year';
  const runs = [];
  for (let s = 0; s < 12; s++) {
    if (!on[s] || on[(s + 11) % 12]) continue;
    let n = 0;
    while (on[(s + n) % 12]) n++;
    runs.push(monthRun(s, n));
  }
  return runs.join(', ');
}

/**
 * Dry and wet months from WorldClim's monthly normals, by the Bagnouls–Gaussen rule: a month is
 * dry when its rain in mm is at most twice its mean temperature in °C (Bagnouls & Gaussen 1957,
 * the ombrothermic diagram). The wet season starts in the first wet month after the longest dry run.
 */
function seasons(wc) {
  if (!wc) return null;
  const dry = wc.precMm.map((p, m) => p <= 2 * wc.tavgC[m]);
  const dryMonths = dry.flatMap((d, m) => (d ? [m] : []));
  const base = {
    monthlyRainMm: wc.precMm,
    dryMonths: dryMonths.map(m => MONTHS[m]),
    rule: 'dry month = rain (mm) at most twice the mean temperature (°C), Bagnouls & Gaussen 1957',
    source: `${wc.source}, ${wc.resolutionDeg}° grid`,
  };
  if (!dryMonths.length || dryMonths.length === 12) return { ...base, wetSeason: dryMonths.length ? null : 'all year', wetStart: null };
  // Longest run of dry months (wrapping round the year); the wet season follows it
  let best = { start: 0, n: 0 };
  for (let s = 0; s < 12; s++) {
    if (!dry[s] || dry[(s + 11) % 12]) continue;
    let n = 0;
    while (n < 12 && dry[(s + n) % 12]) n++;
    if (n > best.n) best = { start: s, n };
  }
  const wetStart = (best.start + best.n) % 12;
  let wetN = 0;
  while (wetN < 12 && !dry[(wetStart + wetN) % 12]) wetN++;
  return {
    ...base,
    wetSeason: monthRun(wetStart, wetN),
    wetStart: MONTHS[wetStart],
    longestDryRun: monthRun(best.start, best.n),
    dryRainMm: Math.round(mean(dryMonths.map(m => wc.precMm[m]))),
  };
}

function climate(lat, lon) {
  return cached(climateCache, lat, lon, async () => {
    const last = new Date().getUTCFullYear() - 1;
    const first = last - YEARS + 1;
    // Terrain tiles include sea depth: with no soil data either, a point well below sea level is open water
    const terrainJob = elevation.elevations([[lat, lon]]).then(z => (Number.isFinite(z[0]) ? Math.round(z[0]) : null), () => null);
    const failed = [];
    let used = null, s = null, daily = null;
    for (const src of DAILY_SOURCES) {
      try {
        daily = await src.load(lat, lon, first, last);
        s = summarizeDaily(daily, lat);
        used = src;
        break;
      } catch (err) {
        failed.push(`${src.name}: ${err.name === 'TimeoutError' ? 'no answer in 30 s' : err.message}`);
        console.warn(`[trees] climate from ${src.name} unavailable:`, err.message);
      }
    }
    const terrain = await terrainJob;
    const wc = worldclim.monthlyAt(lat, lon);
    let label, gridElevationM;
    if (used) {
      label = daily.label;
      gridElevationM = daily.gridElevationM;
    } else {
      if (!wc) throw new Error(`no climate source answered (${failed.join('; ')}) and the offline grid has no land cell here`);
      s = summarizeNormals(wc, lat);
      used = { id: 'worldclim', name: 'WorldClim (offline)' };
      label = `${wc.source}, offline copy, ${wc.resolutionDeg}° grid (~${Math.round(wc.resolutionDeg * 111)} km)`;
      gridElevationM = wc.cellElevationM;
    }

    // Coarse fallbacks: move temperatures to the point's altitude (ERA5 is used as it comes, as before).
    // With no terrain tiles (offline), WorldClim's 10' cell elevation is the closest altitude we have.
    const target = Number.isFinite(terrain) ? { m: terrain, what: "this point's" }
      : Number.isFinite(wc?.fineElevationM) ? { m: wc.fineElevationM, what: 'the surrounding ~18 km area\'s average (WorldClim)' } : null;
    let lapse = 0, lapseNote = '';
    if (used.id !== 'era5' && target && Number.isFinite(gridElevationM) && Math.abs(target.m - gridElevationM) >= LAPSE_MIN_DIFF_M) {
      lapse = (target.m - gridElevationM) * LAPSE_C_PER_M;
      lapseNote = `Temperatures adjusted by ${lapse > 0 ? '+' : ''}${round(lapse)} °C from the grid cell's ${gridElevationM} m to ${target.what} ${target.m} m (standard lapse rate, 6.5 °C per km)` +
        (lapse > 0 ? '; night-time lows are left as they are, since cold air collects in valleys at night.' : '.');
    }
    const t = x => (x == null ? null : round(x + lapse));
    // Night-time lows are only ever moved down: valley nights do not warm with lower altitude
    // (NASA POWER at Dehradun: raw typical low 0.2 °C, ERA5 0.8 °C, lapse-adjusted +4.9 → 5.1 °C)
    const lapseLow = Math.min(lapse, 0);
    const tLow = x => (x == null ? null : round(x + lapseLow));
    const monthly = s.monthlyTempC.map(t);

    // Rainfall: CHPclim long-term mean (gauge + satellite); the climate source only where CHPclim has no land cell
    const chp = rainfall.annualAt(lat, lon);
    const sourceRainName = used.id === 'era5' ? 'ERA5' : used.id === 'nasa-power' ? 'NASA POWER (MERRA-2)' : 'WorldClim';
    const fallbackNote = used.id === 'era5' ? ''
      : used.id === 'nasa-power' ? `ERA5 did not answer (${failed[0]}), so the climate is from NASA POWER, a separate source with a coarser grid.`
        : `No climate service answered (${failed.join('; ')}), so the climate is from the offline WorldClim normals (1970–2000 averages; recent years have been warmer in many places). Frost could not be checked: monthly averages do not record the coldest nights.`;
    const rainNote = chp
      ? 'Rainfall is a long-term average from rain gauges and satellites (CHPclim, ~5–10 km). Steep slopes can differ a lot from it: enter your local annual rainfall if you know it.'
      : `Rainfall here is from ${sourceRainName}, which can be far from gauge records. Enter your local annual rainfall if you know it.`;
    return {
      provider: used.id,
      failed,
      years: used.id === 'worldclim' ? '1970–2000 normals' : `${first}–${last}`,
      annualRainMm: chp ? chp.annualMm : s.rainMm,
      sourceRainMm: s.rainMm,
      rainSource: chp ? `${chp.source}, ${chp.resolutionDeg}° grid` : `${label} (CHPclim has no land cell here)`,
      meanTempC: t(s.meanTempC),
      coldestMonthC: Math.min(...monthly),
      warmestMonthC: Math.max(...monthly),
      absMinC: tLow(s.absMinC),
      typicalMinC: tLow(s.typicalMinC),
      coldestMonthMinC: s.monthlyMinC.some(Number.isFinite) ? tLow(Math.min(...s.monthlyMinC.filter(Number.isFinite))) : null, // average night of the coldest month
      frostMonths: s.monthlyMinC.flatMap((v, m) => (Number.isFinite(v) && v + lapseLow <= 0 ? [MONTHS[m]] : [])),
      sunHoursPerDay: round(s.sunHoursPerDay),
      sunHoursLowestMonth: round(s.sunHoursLowestMonth),
      monthlyTempC: monthly,
      lapseAdjustC: lapse ? round(lapse) : 0,
      gridElevationM,
      terrainElevationM: terrain,
      seasons: seasons(wc),
      region: tdwg.regionAt(lat, lon), // TDWG botanical region, for Kew's native / introduced records
      source: `temperature: ${label}${lapse ? ', adjusted to this altitude' : ''}; ` +
        `sunshine from ${used.id === 'worldclim' ? 'WorldClim' : sourceRainName} solar radiation (FAO-56); ` +
        `rainfall: ${chp ? 'CHPclim v1 long-term mean (Climate Hazards Group)' : sourceRainName}` +
        (wc ? `; seasons: ${wc.source}` : ''),
      caveat: [fallbackNote, lapseNote, rainNote].filter(Boolean).join(' '),
    };
  });
}

// ---------------------------------------------------------------------------
// Soil: India grid (instant) or SoilGrids (slow) — shared with River Eyes' site.js — and, when the
// SoilGrids API fails or has no data at the exact point, the offline worldwide SoilGrids grid
// ---------------------------------------------------------------------------
async function soil(lat, lon) {
  const shape = (s, source, extra = {}) => ({
    hasData: true,
    pH: s.pH ?? null,
    textureClass: s.textureClass || null,
    clayPct: s.clayPct, sandPct: s.sandPct, siltPct: s.siltPct,
    organicCarbonGkg: s.organicCarbonGkg,
    distanceKm: s.distanceKm || 0,
    source,
    ...extra,
  });
  let s = null, apiError = null;
  try {
    s = await site.soil(lat, lon);
  } catch (err) {
    apiError = err.name === 'TimeoutError' ? 'no answer in 30 s' : err.message;
    console.warn('[trees] SoilGrids API unavailable:', apiError);
  }
  if (s?.hasData) {
    return shape(s, soilIndia.inside(lat, lon) ? 'ISRIC SoilGrids 2.0, India grid (~2 km, top 30 cm)' : 'ISRIC SoilGrids 2.0 (modelled, 250 m, top 30 cm)');
  }
  // Outside India: the API failed, or has no soil at this exact point (built-up land, water, rock)
  if (!soilIndia.inside(lat, lon)) {
    const g = soilIndia.lookupGlobal(lat, lon);
    if (g) {
      return shape(g, g.source, {
        fallback: apiError
          ? `The SoilGrids service did not answer (${apiError}), so this is the offline SoilGrids copy: an average over ~22 km, not this exact spot.`
          : 'SoilGrids has no soil at this exact point (often built-up land or water), so this is the average of the surrounding ~22 km (offline SoilGrids copy).',
      });
    }
  }
  if (apiError) throw new Error(apiError);
  return { hasData: false };
}

// ---------------------------------------------------------------------------
// Air: CAMS global (Open-Meteo) vs. UNECE critical levels for vegetation
// ---------------------------------------------------------------------------
/** Sun above the horizon at this UTC hour (stands in for "global radiation > 50 W/m²"). */
function daylight(lat, lon, utcIso) {
  const t = new Date(`${utcIso}Z`);
  const doy = (Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(t.getUTCFullYear(), 0, 0)) / 864e5;
  const dec = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);
  const solarHour = t.getUTCHours() + 0.5 + lon / 15; // mid-hour, ignoring the equation of time
  const ha = (solarHour - 12) * Math.PI / 12;
  const phi = lat * Math.PI / 180;
  return Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha) > 0;
}

function air(lat, lon) {
  return cached(airCache, lat, lon, async () => {
    const end = new Date(Date.now() - 864e5);
    const start = new Date(end.getTime() - 364 * 864e5);
    const day = x => x.toISOString().slice(0, 10);
    const j = await getJson('https://air-quality-api.open-meteo.com/v1/air-quality' +
      `?latitude=${lat}&longitude=${lon}&start_date=${day(start)}&end_date=${day(end)}` +
      '&hourly=ozone,sulphur_dioxide,nitrogen_dioxide,nitrogen_monoxide,pm2_5&domains=cams_global&timezone=GMT', 30000);
    const h = j.hourly;
    if (!h?.time?.length) throw new Error('no air-quality data');
    // Winter half-year (UNECE: October–March) is April–September south of the equator
    const winter = m => (lat >= 0 ? m >= 10 || m <= 3 : m >= 4 && m <= 9);
    const so2 = [], so2Winter = [], nox = [], pm = [];
    const aotByMonth = new Array(12).fill(0);
    h.time.forEach((t, i) => {
      const m = Number(t.slice(5, 7));
      if (Number.isFinite(h.sulphur_dioxide[i])) { so2.push(h.sulphur_dioxide[i]); if (winter(m)) so2Winter.push(h.sulphur_dioxide[i]); }
      if (Number.isFinite(h.nitrogen_dioxide[i])) nox.push(h.nitrogen_dioxide[i] + (h.nitrogen_monoxide[i] || 0) * NO_AS_NO2);
      if (Number.isFinite(h.pm2_5[i])) pm.push(h.pm2_5[i]);
      const ppb = h.ozone[i] / O3_UG_PER_PPB;
      if (ppb > 40 && daylight(lat, lon, t)) aotByMonth[m - 1] += ppb - 40;
    });
    // Trees accumulate over a 6-month growing season; we take the worst 6 consecutive months
    let aot40 = 0;
    for (let s = 0; s < 12; s++) {
      let sum = 0;
      for (let k = 0; k < 6; k++) sum += aotByMonth[(s + k) % 12];
      aot40 = Math.max(aot40, sum);
    }
    const values = {
      aot40PpmH: round(aot40 / 1000),
      so2AnnualUg: round(mean(so2)),
      so2WinterUg: round(mean(so2Winter)),
      noxAnnualUg: round(mean(nox)),
      pm25AnnualUg: round(mean(pm)),
    };
    const ratios = {
      'Ozone': values.aot40PpmH / LEVELS.aot40,
      'SO₂': Math.max(values.so2AnnualUg, values.so2WinterUg ?? 0) / LEVELS.so2,
      'NOx': values.noxAnnualUg / LEVELS.nox,
    };
    const exceeded = Object.keys(ratios).filter(k => ratios[k] > 1);
    const status = !exceeded.length ? 'good'
      : exceeded.length === 1 && Math.max(...Object.values(ratios)) <= 2 ? 'moderate' : 'poor';
    return {
      status,
      exceeded,
      ...values,
      levels: { aot40PpmH: LEVELS.aot40, so2Ug: LEVELS.so2, noxUg: LEVELS.nox },
      // AOT40 here is an upper estimate: not scaled to canopy height, and daylight = sun above the horizon
      summary: `ozone AOT40 ${values.aot40PpmH} ppm·h (critical level ${LEVELS.aot40}; modelled, upper estimate), ` +
        `SO₂ ${values.so2AnnualUg} µg/m³ (level ${LEVELS.so2}), NOx ${values.noxAnnualUg} µg/m³ (level ${LEVELS.nox})`,
      period: `${day(start)} to ${day(end)}`,
      source: 'CAMS global atmospheric composition forecasts (~40 km, modelled) via Open-Meteo; critical levels: UNECE Mapping Manual 2024, ch. 3',
    };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const PARTS = { climate, soil, air };

async function sitePart(body) {
  const { lat, lon } = point(body);
  const fn = PARTS[body.part];
  if (!fn) throw httpError(400, 'part must be climate, soil or air.');
  return { part: body.part, lat, lon, data: await fn(lat, lon) };
}

function speciesList() {
  return {
    source: ecocrop.source,
    note: ecocrop.note,
    nativeSource: nativeRanges._source || null,
    regions: regionNames,
    teamTrees: team.trees.length,
    species: allSpecies,
  };
}

/**
 * Everything the report needs; parts that fail come back null and are reported as missing.
 * Soil is normally cached by the pop-up already; a fresh SoilGrids call can take 30 s, so the
 * report waits at most REPORT_SOIL_MS for it (the AI still needs its own time after this).
 */
const REPORT_SOIL_MS = 8000;

async function gather(lat, lon) {
  const settle = (p, label) => p.then(v => v, err => { console.warn(`[trees] ${label} unavailable:`, err.message); return null; });
  const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms / 1000} s`)), ms))]);
  const [c, s, a] = await Promise.all([
    settle(climate(lat, lon), 'climate'), settle(within(soil(lat, lon), REPORT_SOIL_MS), 'soil'), settle(air(lat, lon), 'air'),
  ]);
  return { lat, lon, climate: c, soil: s, air: a };
}

const REPORT_FIELDS = {
  headline: 'One sentence: how well this tree and this place suit each other.',
  relationship: '2-4 sentences: what this tree gives this place (shade, soil, water, wildlife, people) and what the place gives the tree, tied to the numbers.',
  strengths: 'List of 2-4 short sentences: why it suits this place, each quoting a number from the checklist.',
  risks: 'List of 1-4 short sentences: what could go wrong here and why, each quoting a number.',
  planting: 'List of 2-5 steps: when to plant, taken from seasons (the start of the wet season, not just before frostMonths), site choice from the checklist, and watering in the dry months named in seasons.',
  care: 'List of 1-4 steps for the first three years, each tied to the DATA (dry months, frost months, checklist notes, sourced traits).',
  check_on_site: 'List of 1-3 things to verify on the ground before planting.',
};

async function report(body) {
  const { lat, lon } = point(body);
  const sp = byId.get(String(body.speciesId || ''));
  if (!sp) throw httpError(400, 'Unknown tree.');
  const rainfallMm = Number(body.rainfallMm);
  const opts = Number.isFinite(rainfallMm) && rainfallMm > 0 && rainfallMm < 15000 ? { rainfallMm } : {};
  const place = String(body.name || '').slice(0, 120) || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const t0 = Date.now();

  const data = await gather(lat, lon);
  const result = fit.evaluate(data, sp, opts);
  const missing = ['climate', 'soil', 'air'].filter(k => !data[k] || (k === 'soil' && !data.soil.hasData));
  const region = data.climate?.region;
  const facts = {
    place, centre: [round(lat, 4), round(lon, 4)],
    tree: { name: sp.name, localName: sp.localName, scientific: sp.scientific, family: sp.family },
    native_status_Kew_WCVP: {
      placeRegion: region ? `${region.name} (${region.code})` : 'unknown',
      statusHere: result.nativeStatus, // native | introduced | not-recorded | unknown
      nativeTo: sp.wcvp ? regionList(sp.wcvp.native) : 'unknown',
    },
    [`requirements_${sp.requirementsFrom === 'team' ? 'team_sourced' : 'FAO_ECOCROP'}`]: {
      meanTempC: sp.temp || sp.tempAnnual, killingTempC: sp.killC, lowestRecordedTempC: sp.frostLimitC,
      annualRainMm: sp.rain, soilPH: sp.ph, light: sp.light, texture: sp.texture, drainage: sp.drainage, altitudeM: sp.altitudeM,
    },
    ...(sp.traits && Object.keys(sp.traits).length ? { traits_team_sourced: sp.traits } : {}),
    place_data: { climate: data.climate && { ...data.climate, monthlyTempC: undefined, caveat: undefined, seasons: undefined, failed: undefined },
      userRainfallMm: opts.rainfallMm ?? null, soil: data.soil, air: data.air && { ...data.air, levels: undefined } },
    seasons: data.climate?.seasons && { ...data.climate.seasons, frostMonths: data.climate.frostMonths },
    checklist: Object.fromEntries(fit.CHECKS.map(k => [k, result.checks[k]])),
    verdict: result.verdict,
  };

  const system = `You are Treeko, the forest ecologist of Forest Eyes. Write a short report on how ONE tree
species and ONE place would get on together, for people who want to plant it there.
RULES
- Use only the numbers in the DATA. Quote them with units. Never invent measurements, places or studies.
- The checklist verdicts are final: do not contradict them. "unknown" means no data, say so.
- Requirements come from FAO ECOCROP (expert ranges) or team-sourced references; place data are
  modelled (ERA5, SoilGrids, CAMS). Native status is Kew's WCVP record for the place's region:
  "introduced" means grown here but not native (not necessarily invasive); "not-recorded" means
  Kew has no record of it in this region. Do not call a tree native unless statusHere is "native".
- Use traits_team_sourced when present. Other general knowledge about the species (uses, wildlife
  value, root habit) is fine, but say "generally" and keep it brief. If the tree is not native here,
  advise checking local invasive-species rules.
- Planting and care advice must follow from the DATA: the planting time from seasons (wet season,
  dry months, frostMonths), site choice from the checklist. Do not give spacing, watering amounts,
  schedules or other numbers that are not in the DATA. If seasons is missing, say the timing
  could not be worked out from the data.
- Plain English, short sentences with spaces, no markdown, no headings.
Answer with ONE JSON object and nothing else, with exactly these keys:
${Object.entries(REPORT_FIELDS).map(([k, v]) => `"${k}": ${v}`).join('\n')}`;

  let out = null, model = null, aiError = null;
  try {
    const answer = await gemma.generate({
      system,
      contents: [{ role: 'user', parts: [{ text: `DATA (JSON):\n${JSON.stringify(facts, null, 1)}\n\nMissing data: ${missing.join(', ') || 'none'}` }] }],
      // JSON asked for in the prompt only: with the schema enforced Gemma loops (see gemma.js)
      schema: { type: 'object', properties: Object.fromEntries(Object.keys(REPORT_FIELDS).map(k => [k, { type: 'string' }])) },
      jsonMode: 'prompt',
      timeoutMs: 40000,
    });
    out = sanitize(gemma.parseJson(answer.text));
    model = answer.model;
  } catch (err) {
    aiError = err instanceof SyntaxError ? 'The model answer was not valid JSON.' : err.message;
  }
  const reportSource = !out ? 'rules' : model.startsWith('gemma') ? 'gemma' : 'backup';
  if (!out) out = ruleReport(sp, data, result, opts);
  console.log(`[trees] report ${sp.id} @ ${place}: ${reportSource}${aiError ? ` (AI failed: ${aiError})` : ''}, ${Date.now() - t0} ms`);
  return { speciesId: sp.id, place, report: out, reportSource, model, aiError, fit: result, missing };
}

/** Keeps the AI answer to the expected shape and sizes. */
function sanitize(r) {
  const str = (v, n = 500) => String(v ?? '').trim().slice(0, n);
  const list = (v, n = 5) => (Array.isArray(v) ? v : v ? [v] : []).slice(0, n).map(x => str(x, 300)).filter(Boolean);
  const out = {
    headline: str(r.headline, 300),
    relationship: str(r.relationship, 900),
    strengths: list(r.strengths), risks: list(r.risks), planting: list(r.planting), care: list(r.care),
    check_on_site: list(r.check_on_site, 3),
  };
  if (!out.headline || !out.relationship) throw new SyntaxError('incomplete report');
  return out;
}

/**
 * Transparent rule-based report, used ONLY when no AI model answered. Built from the
 * checklist notes; the UI labels it as rule-based.
 */
function ruleReport(sp, data, result, opts) {
  const c = result.checks;
  const label = { water: 'Water', soil: 'Soil', sun: 'Sunlight', air: 'Air', climate: 'Climate' };
  const by = s => fit.CHECKS.filter(k => c[k].status === s).map(k => `${label[k]}: ${c[k].note} Here: ${c[k].have}. It needs: ${c[k].need}.`);
  const name = `${sp.name}${sp.localName && sp.localName !== sp.name ? ` (${sp.localName})` : ''}`;
  const verdict = { good: 'suits this place well', care: 'can grow here with some care', no: 'is not a good choice here', nodata: 'cannot be judged yet (its needs are not fully recorded)' }[result.verdict];
  const rain = opts.rainfallMm ?? data.climate?.annualRainMm;
  const drySeason = rain != null && sp.rain && rain < sp.rain[1];
  const region = data.climate?.region?.name || 'this region';
  const nativeTo = sp.wcvp ? regionList(sp.wcvp.native).slice(0, 6).join(', ') + (sp.wcvp.native.length > 6 ? ' and more' : '') : null;
  const status = {
    native: `native to ${region} (Kew WCVP)`,
    introduced: `introduced in ${region}, not native (Kew WCVP; native to ${nativeTo}): check local invasive-species rules before planting`,
    'not-recorded': `not recorded in ${region} by Kew (native to ${nativeTo}): check local invasive-species rules before planting`,
    unknown: 'of unknown native status here',
  }[result.nativeStatus];
  // Planting and care: only what follows from this place's data and the tree's recorded needs
  const se = data.climate?.seasons;
  const frost = data.climate?.frostMonths || [];
  const frostText = frost.length ? `average night-time lows are at or below 0 °C in ${monthRuns(frost)}` : null;
  const frostFree = frost.length && frost.length < 12 ? monthRuns(MONTHS.filter(m => !frost.includes(m))) : null;
  const planting = [];
  if (se?.wetStart) {
    planting.push(`The wet season here runs ${se.wetSeason} and starts in ${se.wetStart} (${se.source}; ${se.rule}). Planting at its start gives the roots the whole wet season to establish.`);
  } else if (se?.wetSeason === 'all year') {
    planting.push(`No month here is dry (${se.rule}; ${se.source}), so rain-fed planting does not depend on the season${frost.length ? ', apart from the frost months' : ''}.`);
  } else if (se) {
    planting.push(`Every month here is dry (${se.rule}; ${se.source}): young trees will depend on watering all year.`);
  }
  if (se?.dryMonths.length && se.dryMonths.length < 12) {
    planting.push(`Dry months here: ${monthRuns(se.dryMonths)} (about ${se.dryRainMm} mm of rain a month on average): young trees will depend on watering then${drySeason ? ', and its yearly rainfall is below its ideal range too' : ''}.`);
  }
  if (frostText) {
    const from = data.climate.provider === 'worldclim' ? 'WorldClim normals' : `${data.climate.years} record`;
    planting.push(frostFree
      ? `Frost: ${frostText} (${from}); the frost-free months are ${frostFree}, so plant early in them.`
      : `Frost: ${frostText} (${from}), so there is no frost-free month to plant in.`);
  }
  if (c.sun.status === 'marginal') planting.push(c.sun.note);
  const sourced = k => (sp.values?.[k] != null && sp.sources?.[k] ? `${sp.values[k]} (${[sp.sources[k].title, sp.sources[k].year].filter(Boolean).join(', ')})` : null);
  if (sourced('plantingSeason')) planting.push(`Recorded planting season: ${sourced('plantingSeason')}.`);
  if (sourced('propagation')) planting.push(`Recorded propagation: ${sourced('propagation')}.`);
  if (!planting.length) planting.push('The planting time could not be worked out: no monthly rainfall and temperature data for this place.');

  const care = [];
  if (se?.dryMonths.length && se.dryMonths.length < 12) care.push(`In the dry months of the first years (${monthRuns(se.dryMonths)}), check soil moisture around the young tree and water when it is dry.`);
  if (frostText && (c.climate.status === 'marginal' || sp.killC != null)) care.push(`Protect young trees on frost nights: ${frostText}${sp.killC != null ? `, and frost below ${sp.killC} °C kills it (ECOCROP)` : ''}.`);
  const drainage = { W: 'well-drained', I: 'imperfectly drained', E: 'excessively drained (free-draining)', P: 'poorly drained' };
  const drains = (sp.drainage || []).map(d => drainage[d]).filter(Boolean);
  return {
    headline: `Rule-based check: ${name} ${verdict}.`,
    relationship: `${name} (${sp.scientific}, ${sp.family}) is ${status}. ` +
      `This report compares ${sp.requirementsFrom === 'team' ? 'team-sourced' : 'FAO ECOCROP'} growing ranges with modelled data for the place; it does not describe the ecology of the site.`,
    strengths: by('pass'),
    risks: [...by('fail'), ...by('marginal')],
    planting,
    care,
    check_on_site: [
      ...(c.soil.status === 'unknown' ? ['Test soil pH and texture: no soil data was available.']
        : [`Test soil pH on site: the soil data is modelled${data.soil?.fallback ? ' and averaged over ~22 km' : ''}.`]),
      ...(drains.length ? [`It grows best in ${drains.join(' or ')} soil (FAO ECOCROP): check that water does not stand on the planting spot after heavy rain.`] : []),
    ],
  };
}

module.exports = { speciesList, sitePart, report, climate, soil, air, sunshineHours, daylight };
