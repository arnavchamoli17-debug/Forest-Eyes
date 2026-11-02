/**
 * Earth Intelligence Platform — Forest Eyes & DATA (server.js)
 * =============================================================
 * Serves the web app in ../frontend and the APIs of Forest Eyes and DATA.
 * Run (from the project root): npm start   — or: node backend/server.js
 * Open: http://localhost:8080
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');            // project root
const FRONTEND = path.join(ROOT, 'frontend');       // the only folder served to browsers

// Keys live in .env at the project root (or backend/.env); on a host, in its environment settings.
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(__dirname, '.env'));

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const PORT = Number(process.env.PORT) || 8080;

// Load Forest Eyes core API
let forestCore = null;
try {
  forestCore = require('./forest-api.js');
} catch (err) {
  console.warn('Forest Eyes core API load note:', err.message);
}

// Shared AI client — Treeko and DATA all answer through it
const gemma = require('./gemma.js');
forestCore?.setGenerator(gemma.generate);
// Keeps the chat assistants on topic and code-free (shared with the browser, like treeko-brain.js)
const guard = require('../frontend/forest-eyes/ai-guard.js');

// Rate limits: the model quota is shared by everyone using the site. Per visitor, plus a
// site-wide cap, because a visitor can fake x-forwarded-for to look like many visitors.
function rateLimiter({ max, siteMax, windowMs = 10 * 60 * 1000 }) {
  const ipHits = new Map(); // ip -> request times in the window
  let siteHits = [];
  return function allowed(req) {
    // cf-connecting-ip if a Cloudflare proxy set it (not verified for Render), else x-forwarded-for's
    // first entry. Both can be faked when no proxy overwrites them: the site-wide cap is the backstop.
    const ip = String(req.headers['cf-connecting-ip'] || '').trim() ||
      String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const now = Date.now();
    siteHits = siteHits.filter(t => now - t < windowMs);
    const hits = (ipHits.get(ip) || []).filter(t => now - t < windowMs);
    if (hits.length >= max || siteHits.length >= siteMax) { ipHits.set(ip, hits); return false; }
    hits.push(now);
    siteHits.push(now);
    ipHits.set(ip, hits);
    if (ipHits.size > 5000) for (const [k, v] of ipHits) if (now - v[v.length - 1] >= windowMs) ipHits.delete(k);
    return true;
  };
}
// Treeko and Aqua chat
const chatAllowed = rateLimiter({
  max: Number(process.env.CHAT_MAX_PER_WINDOW) || 20,
  siteMax: Number(process.env.CHAT_MAX_SITE_PER_WINDOW) || 300,
});
// One-shot AI readings: DATA, tree reports (one per tree switched on)
const aiReadAllowed = rateLimiter({
  max: Number(process.env.AI_MAX_PER_WINDOW) || 40,
  siteMax: Number(process.env.AI_MAX_SITE_PER_WINDOW) || 400,
});
const TOO_MANY = { error: 'Too many questions in a short time. Please wait a few minutes and ask again.' };
const TOO_MANY_AI = { error: 'Too many requests in a short time. Please wait a few minutes and try again.' };
function tooMany(res, body) {
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
  return res.end(JSON.stringify(body));
}
const hazard = require('./hazard.js');
const site = require('./site.js');
const trees = require('./trees.js');
const tileCache = new Map(); // GFW loss and tree cover tiles forwarded for the 3D globe

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.md':   'text/markdown; charset=utf-8',
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        req.resume();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  // No favicon file: answer "no content" instead of a 404 in every browser console
  if (req.url === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'public, max-age=86400' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/'; }
  if (rel.endsWith('/')) rel += 'index.html';

  // Only frontend/ is public, and never hidden files (.env, .git…).
  if (rel.split(/[\\/]/).some(seg => seg.startsWith('.') || seg === 'node_modules')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('404 Not Found');
  }
  const file = path.normalize(path.join(FRONTEND, rel));

  if (!file.startsWith(FRONTEND + path.sep)) {
    res.writeHead(403); return res.end('Access denied');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    // 'no-cache' = the browser keeps a copy but asks every time; unchanged files get a tiny 304.
    // So a new deploy is always picked up, and repeat visits do not re-download everything.
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const cached = staticCache.get(file);
    const send = entry => {
      const gzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { ...headers, ...(entry.gz ? { vary: 'Accept-Encoding' } : {}), ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
      res.end(gzip ? entry.gz : entry.raw);
    };
    if (cached && cached.etag === etag) return send(cached);
    fs.readFile(file, (err2, raw) => {
      if (err2) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404 Not Found'); }
      // Text files are gzipped once and kept (the whole frontend is ~1 MB, ~250 kB gzipped)
      const entry = { etag, raw, gz: COMPRESSIBLE.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null };
      staticCache.set(file, entry);
      send(entry);
    });
  });
}
const staticCache = new Map(); // file → { etag, raw, gz }
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.csv', '.txt', '.md']);


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // 1. Forest Eyes APIs (/api/...)
  if (url.pathname.startsWith('/api/treeko') || url.pathname.startsWith('/api/gfw') || url.pathname === '/api/health') {
    if (url.pathname === '/api/treeko' && req.method === 'POST' && !chatAllowed(req)) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      return res.end(JSON.stringify(TOO_MANY));
    }
    if (forestCore) {
      try {
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req, 64 * 1024) : '';
        const result = await forestCore.handleApi({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body
        }, fetch);
        res.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...(result.headers || {})
        });
        return res.end(JSON.stringify(result.json));
      } catch (err) {
        res.writeHead(err.status || 500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // 2. River Eyes APIs (/api/v1/...)
  if (url.pathname === '/api/v1/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'HEALTHY',
      service: 'Earth Intelligence Platform (Forest Eyes)',
      version: '2.5.0',
      ai: gemma.describe(),
      timestamp: new Date().toISOString()
    }));
  }

  // Ground conditions at a site: soil, earthquakes (/api/v1/site)
  if (url.pathname === '/api/v1/site' && req.method === 'POST') {
    try {
      const result = await site.assess(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.status || (err instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'Site data failed.' }));
    }
  }

  // Forest Eyes tree planner: the trees we can check (/api/v1/trees/species)
  if (url.pathname === '/api/v1/trees/species' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(trees.speciesList()));
  }

  // Tree planner: one part of a place's conditions (/api/v1/trees/site) — { lat, lon, part: climate | soil | air }
  if (url.pathname === '/api/v1/trees/site' && req.method === 'POST') {
    try {
      const result = await trees.sitePart(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (status >= 500) console.warn('[trees]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'This data source did not answer. Try again.' }));
    }
  }

  // Tree planner: report on one tree at one place (/api/v1/trees/report) — { lat, lon, name, speciesId, rainfallMm? }
  if (url.pathname === '/api/v1/trees/report' && req.method === 'POST') {
    if (!aiReadAllowed(req)) return tooMany(res, TOO_MANY_AI);
    try {
      const result = await trees.report(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 500);
      if (status >= 500) console.warn('[trees report]', err.message);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'The tree report failed. Try again.' }));
    }
  }


  // GFW tree-loss tiles from our own origin (/tiles/gfw-loss/z/x/y.png): the 3D globe has to read
  // their pixels, which the GFW tile server does not always allow cross-site (CORS). Cached in memory.
  // /tiles/gfw-loss/v1.12/z/x/y.png serves the 2001–2024 release (used by the year replay); its tiles
  // are 512 px and also carry pixels with year 0, so the other modes stay on v1.11 (2001–2023).
  // /tiles/gfw-cover/z/x/y.png serves Tree Cover 2000 (same tiles as the 2D Tree Cover layer) for the globe.
  const tileMatch = /^\/tiles\/gfw-(loss|cover)\/(?:(v1\.12)\/)?(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.png$/.exec(url.pathname);
  if (tileMatch && req.method === 'GET') {
    const layer = tileMatch[1];
    const version = tileMatch[2] || 'v1.11';
    const [z, x, y] = tileMatch.slice(3).map(Number);
    if (z > 12 || x >= 2 ** z || y >= 2 ** z || (layer === 'cover' && tileMatch[2])) { res.writeHead(404); return res.end(); }
    const key = layer === 'cover' ? `cover/${z}/${x}/${y}` : `${version}/${z}/${x}/${y}`;
    const upstream = layer === 'cover'
      ? `https://tiles.globalforestwatch.org/umd_tree_cover_density_2000/v1.8/tcd_30/${z}/${x}/${y}.png`
      : `https://tiles.globalforestwatch.org/umd_tree_cover_loss/${version}/tcd_30/${z}/${x}/${y}.png`;
    let tile = tileCache.get(key);
    if (!tile) {
      try {
        const up = await fetch(upstream, { signal: AbortSignal.timeout(15000) });
        tile = up.ok ? { status: 200, body: Buffer.from(await up.arrayBuffer()) } : { status: up.status, body: null };
      } catch {
        tile = { status: 502, body: null };
      }
      if (tile.status === 200 || tile.status === 404) {
        if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
        tileCache.set(key, tile);
      }
    }
    if (!tile.body) { res.writeHead(tile.status); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(tile.body);
  }

  // DATA (/api/v1/hazard) — satellite image + global data → AI hazard reading
  if (url.pathname === '/api/v1/hazard' && req.method === 'POST') {
    if (!aiReadAllowed(req)) return tooMany(res, TOO_MANY_AI);
    try {
      const result = await hazard.assess(JSON.parse(await readBody(req, 4 * 1024) || '{}'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.status || (err instanceof SyntaxError ? 400 : 500), { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.status || err instanceof SyntaxError ? err.message : 'DATA assessment failed.' }));
    }
  }

  // Global soil profile (/api/v1/soil) — reuses Forest Eyes' ISRIC SoilGrids client
  if (url.pathname === '/api/v1/soil' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!forestCore || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Valid lat and lon are required.' }));
    }
    // A full SoilGrids profile often takes 20+ s, so allow longer than Treeko's 5 s budget.
    const soil = await require('../frontend/forest-eyes/treeko-brain.js').getSoil(lat, lon, fetch, 35000);
    res.writeHead(soil ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(soil || { error: 'SoilGrids is unavailable right now.' }));
  }

  // Weather Proxy (/api/v1/weather)
  if (url.pathname === '/api/v1/weather') {
    const lat = url.searchParams.get('lat') || '30.38';
    const lon = url.searchParams.get('lon') || '79.32';
    try {
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,surface_pressure,wind_speed_10m`;
      const wRes = await fetch(weatherUrl);
      const wData = await wRes.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(wData));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 3. Static Files Serving
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`\n================================================================`);
  console.log(`🌍 Earth Intelligence Platform (Forest Eyes + DATA)`);
  console.log(`   Running at:  http://localhost:${PORT}`);
  console.log(`   Forest Eyes: 3D Globe, Hansen Tree Loss, Treeko AI`);
  console.log(`   DATA:        Global Multi-Hazard Assessment, AI Engine`);
  console.log(`================================================================\n`);
});
