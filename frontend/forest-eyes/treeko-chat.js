/**
 * Forest Eyes — Treeko chat window (treeko-chat.js)
 * =================================================
 * Loaded AFTER app.js and treeko.js. Clicking the Treeko button (event "treeko:open")
 * opens a chat about the place the user is looking at. Treeko's brain (treeko-brain.js)
 * builds the question from the place, the deforestation analysis and soil data.
 *
 *  - Server mode (live site, or node server.js): the Forest Eyes server holds the Gemini key.
 *  - Browser mode (index.html opened as a file, or localhost without a server): the user
 *    pastes their own key once in the chat; it is saved only in this browser.
 *
 * Planting-site answers come back as checked coordinates: they are listed in the chat
 * and pinned on the map.
 */
(function () {
  'use strict';

  const CONFIG = {
    endpoint: window.TREEKO_API_URL || '/api/treeko',
    // Browser mode (no server): only when the app is opened as a file or from this computer.
    // On a deployed site the server holds the key and visitors are never asked for one.
    allowBrowserKey: window.TREEKO_ALLOW_BROWSER_KEY ??
      (location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)),
    keyStorage: 'foresteyes-gemini-key',
    browserTimeoutMs: 45000,
    timeoutMs: 75000,
    maxHistory: 12,
    quickQuestions: [
      'What is the soil profile?',
      'Type of trees to be planted',
      'Where can we plant trees?',
    ],
  };

  const $ = id => document.getElementById(id);
  const btn = $('treeko-btn');
  if (!btn) return;

  // ---------------------------------------------------------------------
  // Pure helpers (unit tested)
  // ---------------------------------------------------------------------
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Small, safe Markdown subset: paragraphs, **bold**, *italic*, `code`, bullet and numbered lists. */
  function renderMarkdown(text) {
    const inline = s => escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    const out = [];
    let list = null; // { tag, items }
    let para = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((bullet || numbered)[1]);
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line.replace(/^#{1,6}\s+(.*)$/, '**$1**'));
      }
    }
    flushPara(); flushList();
    return out.join('');
  }

  /** The place the user is looking at, with analysis results when available. */
  function currentContext() {
    const radiusKm = parseInt($('radius-input')?.value, 10) || 10;
    const inLat = parseFloat($('lat-input')?.value);
    const inLng = parseFloat($('lng-input')?.value);
    const hasInput = Number.isFinite(inLat) && Number.isFinite(inLng);
    const state = typeof appState !== 'undefined' ? appState : null;
    const mode = typeof getDataSourceMode === 'function' ? getDataSourceMode() : 'real';
    const cache = state ? (mode === 'real' ? state.apiCache : state.simCache) : null;
    const activeId = state?.activeLocationId;
    const entry = activeId && cache ? cache[activeId] : null;
    const idOf = (lat, lng) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

    // A newly searched place (not analysed yet) wins over an older analysis.
    if (hasInput && (!entry || idOf(inLat, inLng) !== activeId)) {
      const name = (typeof lastName !== 'undefined' && lastName) || `${inLat.toFixed(4)}, ${inLng.toFixed(4)}`;
      return { name, lat: inLat, lng: inLng, radiusKm, analysis: null, weather: weatherText() };
    }
    if (!entry) return null;
    const f = entry.formatted || {};
    const rating = typeof getSeverityLevel === 'function' ? getSeverityLevel(f) : null;
    const severity = rating?.level || '';
    return {
      name: entry.locationName,
      lat: entry.lat,
      lng: entry.lng,
      radiusKm,
      analysis: {
        source: mode,
        severity,
        totalHa: +(f.totalHa || 0).toFixed(2),
        totalEmissionsT: Math.round(f.totalEmissions || 0),
        treesNeeded: f.treesNeeded ?? null,
        annualRatePct: rating?.rate != null ? +rating.rate.toFixed(2) : null,
        forestHa2000: f.forestHa2000 ?? null,
        yearly: (f.rows || []).map(r => ({ year: r.year, ha: +(+r.ha).toFixed(2) })),
      },
      weather: weatherText(),
    };
  }

  function weatherText() {
    const box = $('climate-content');
    if (!box || box.classList.contains('hidden')) return null;
    const t = id => $(id)?.textContent?.trim();
    const parts = [
      t('cv-temp') && `temperature ${t('cv-temp')}C`,
      t('cv-humidity') && `humidity ${t('cv-humidity')}`,
      t('cv-precip') && `precipitation ${t('cv-precip')} mm`,
      t('cv-wind') && `wind ${t('cv-wind')} km/h`,
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }

  const placeKey = ctx => (ctx ? `${ctx.lat.toFixed(4)},${ctx.lng.toFixed(4)}|${ctx.analysis ? 'a' : 's'}` : 'none');
  const fmtCoord = (lat, lng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  let panel, log, input, sendBtn, placeEl, keyBtn;
  let history = [];      // [{ role: 'user' | 'treeko', text }] sent to the server
  let lastPlace = null;
  let busy = false;
  let sitesLayer = null;

  function build() {
    panel = document.createElement('section');
    panel.className = 'treeko-chat hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'treeko-chat-title');
    panel.innerHTML = `
      <header class="treeko-chat-head">
        <span class="treeko-avatar" aria-hidden="true">
          <img src="assets/treeko/treeko-low.png" data-mood="low" alt="" />
          <img src="assets/treeko/treeko-moderate.png" data-mood="moderate" alt="" />
          <img src="assets/treeko/treeko-high.png" data-mood="high" alt="" />
        </span>
        <div class="treeko-chat-titles">
          <div class="treeko-chat-title" id="treeko-chat-title">Treeko</div>
          <div class="treeko-chat-place" id="treeko-chat-place"></div>
        </div>
        <button type="button" class="treeko-chat-key hidden" aria-label="AI key settings" title="AI key">🔑</button>
        <button type="button" class="treeko-chat-close" aria-label="Close Treeko chat">×</button>
      </header>
      <div class="treeko-chat-log" role="log" aria-live="polite"></div>
      <div class="treeko-quick" role="group" aria-label="Quick questions">
        ${CONFIG.quickQuestions.map(q => `<button type="button" class="treeko-chip">${escapeHtml(q)}</button>`).join('')}
      </div>
      <div class="treeko-input-row">
        <textarea class="treeko-input" rows="1" maxlength="1000" placeholder="Ask Treeko about this place…" aria-label="Message Treeko"></textarea>
        <button type="button" class="treeko-send" aria-label="Send">➤</button>
      </div>`;
    document.body.appendChild(panel);
    log = panel.querySelector('.treeko-chat-log');
    input = panel.querySelector('.treeko-input');
    sendBtn = panel.querySelector('.treeko-send');
    placeEl = panel.querySelector('#treeko-chat-place');

    panel.querySelector('.treeko-chat-close').addEventListener('click', close);
    keyBtn = panel.querySelector('.treeko-chat-key');
    keyBtn.addEventListener('click', () => showKeyCard());
    panel.querySelectorAll('.treeko-chip').forEach(c => c.addEventListener('click', () => ask(c.textContent)));
    sendBtn.addEventListener('click', () => ask(input.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
    });
    input.addEventListener('input', autosize);
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    // Keep the header avatar in step with the Treeko button's mood.
    const syncMood = () => panel.setAttribute('data-mood', btn.dataset.mood || 'low');
    new MutationObserver(syncMood).observe(btn, { attributes: true, attributeFilter: ['data-mood'] });
    syncMood();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
  }

  function open() {
    if (!panel) build();
    refreshPlace(true);
    whenModeKnown().then(m => {
      keyBtn.classList.toggle('hidden', m !== 'browser');
      if (m === 'browser' && !savedKey() && !sessionKey) showKeyCard();
    });
    panel.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => input.focus(), 30);
  }

  function close() {
    if (!panel) return;
    panel.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
    btn.focus();
  }

  /** Updates the header and, when the place changed, starts a fresh conversation about it. */
  function refreshPlace(greet) {
    const ctx = currentContext();
    placeEl.textContent = ctx ? `📍 ${ctx.name}` : 'No place selected';
    const key = placeKey(ctx);
    if (key !== lastPlace) {
      const first = lastPlace === null;
      lastPlace = key;
      history = []; // answers about the previous place would confuse the new one
      clearSites();
      if (greet || !first) {
        addBubble('treeko', ctx
          ? `${first ? 'Hi! I\'m **Treeko** 🌳 ' : ''}Let's talk about **${ctx.name}**${ctx.analysis ? ` — ${ctx.analysis.severity.toLowerCase()} (${ctx.analysis.totalHa} ha lost)` : ''}. Ask me about the soil, which trees to plant, or where to plant them.`
          : `${first ? 'Hi! I\'m **Treeko** 🌳 ' : ''}Search for a place (and click **Analyze Deforestation**), then ask me about its soil, the right trees, or where to plant them.`,
          first ? '' : 'note');
      }
    }
    return ctx;
  }

  function addBubble(role, text, kind = '') {
    const el = document.createElement('div');
    el.className = `treeko-msg ${role}${kind ? ` ${kind}` : ''}`;
    if (role === 'user') el.textContent = text;
    else el.innerHTML = renderMarkdown(text);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function addTyping() {
    const el = document.createElement('div');
    el.className = 'treeko-msg treeko typing';
    el.setAttribute('aria-label', 'Treeko is typing');
    el.innerHTML = '<span></span><span></span><span></span>';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  // ---------------------------------------------------------------------
  // How Treeko answers: through the Forest Eyes server, or straight from this browser
  // ---------------------------------------------------------------------
  let modePromise = null;
  let pendingQuestion = null;

  /** 'server' if a Forest Eyes server with a Gemini key is reachable, else 'browser' (if allowed). */
  function whenModeKnown() {
    modePromise ??= (async () => {
      if (location.protocol !== 'file:') {
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 4000);
          const r = await fetch(`${CONFIG.endpoint}/health`, { cache: 'no-store', signal: ctrl.signal });
          const j = await r.json();
          if (r.ok && j.keyConfigured) return 'server';
        } catch { /* no server here */ }
      }
      return CONFIG.allowBrowserKey ? 'browser' : 'server';
    })();
    return modePromise;
  }

  const savedKey = () => { try { return localStorage.getItem(CONFIG.keyStorage) || ''; } catch { return ''; } };
  const browserModel = () => window.TREEKO_MODEL || window.TreekoBrain?.DEFAULT_MODEL || 'gemini-3.6-flash';

  /** In-chat box to paste the Gemini key once (saved only in this browser). */
  function showKeyCard() {
    log.querySelector('.treeko-keycard')?.remove();
    const has = !!savedKey();
    const card = document.createElement('div');
    card.className = 'treeko-msg treeko treeko-keycard';
    card.innerHTML = `
      <p><strong>${has ? 'AI key' : 'One-time setup'}</strong> — ${has
        ? 'Treeko is using the key saved in this browser.'
        : 'paste your Google AI Studio API key to chat with Treeko.'}</p>
      <p class="treeko-meta">It's saved only in this browser on this computer — never in the app's files, and never sent anywhere except Google AI Studio.</p>
      <div class="treeko-key-row">
        <input type="password" class="treeko-key-input" autocomplete="off" spellcheck="false"
               placeholder="${has ? 'Paste a new key to replace it' : 'Paste Google AI Studio API key'}" aria-label="Google AI Studio API key" />
        <button type="button" class="treeko-key-save">Save</button>
      </div>
      <div class="treeko-key-links">
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Get a key</a>
        ${has ? '<button type="button" class="treeko-key-remove">Remove saved key</button>' : ''}
      </div>`;
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    const field = card.querySelector('.treeko-key-input');
    const save = () => {
      const key = field.value.trim();
      if (key.length < 20 || /\s/.test(key)) {
        field.setCustomValidity('That doesn\'t look like a full API key.');
        field.reportValidity();
        return;
      }
      try { localStorage.setItem(CONFIG.keyStorage, key); } catch { /* private mode: keep for this page only */ }
      sessionKey = key;
      card.remove();
      addBubble('treeko', 'Key saved ✓ Ask me anything about this place!', 'note');
      if (pendingQuestion) { const q = pendingQuestion; pendingQuestion = null; ask(q); }
      else input.focus();
    };
    card.querySelector('.treeko-key-save').addEventListener('click', save);
    field.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    field.addEventListener('input', () => field.setCustomValidity(''));
    card.querySelector('.treeko-key-remove')?.addEventListener('click', () => {
      try { localStorage.removeItem(CONFIG.keyStorage); } catch { /* ignore */ }
      sessionKey = '';
      card.remove();
      addBubble('treeko', 'Saved key removed from this browser.', 'note');
      showKeyCard();
    });
    setTimeout(() => field.focus(), 30);
  }
  let sessionKey = '';

  async function askServer(payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
    let res;
    try {
      res = await fetch(CONFIG.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('That took too long. Please try again.');
      throw new Error('I can\'t reach the Forest Eyes server right now. Please try again in a moment.');
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
    return data;
  }

  async function askInBrowser(payload) {
    if (!window.TreekoBrain) throw new Error('Treeko could not load (treeko-brain.js is missing).');
    try {
      return await window.TreekoBrain.askGemini(payload, {
        apiKey: savedKey() || sessionKey,
        model: browserModel(),
        fetchImpl: (url, opts) => window.fetch(url, opts),
        geminiTimeoutMs: CONFIG.browserTimeoutMs,
        soilTimeoutMs: 6000,
        keyHint: 'the key saved in Treeko (🔑 button above)',
        modelHint: 'Set window.TREEKO_MODEL to a current model.',
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error('The AI took too long to answer. Please try again.');
      if (err instanceof TypeError) throw new Error('I couldn\'t reach the AI service. Check your internet connection and try again.');
      throw err;
    }
  }

  async function ask(text) {
    const question = String(text || '').trim();
    if (!question || busy) return;
    const mode = await whenModeKnown();
    if (mode === 'browser' && !savedKey() && !sessionKey) {
      pendingQuestion = question; // asked automatically once the key is saved
      input.value = '';
      autosize();
      showKeyCard();
      return;
    }
    const ctx = refreshPlace(false);
    busy = true;
    input.value = '';
    autosize();
    sendBtn.disabled = true;
    const userBubble = addBubble('user', question);
    history.push({ role: 'user', text: question });
    const typing = addTyping();
    const payload = { messages: history.slice(-CONFIG.maxHistory), context: ctx };

    try {
      const data = mode === 'browser' ? await askInBrowser(payload) : await askServer(payload);
      typing.remove();
      const answer = data.answer || '…';
      history.push({ role: 'treeko', text: answer });
      const bubble = addBubble('treeko', answer);
      if (Array.isArray(data.sites) && data.sites.length) renderSites(bubble, data.sites);
      if (data.removedSites) {
        bubble.insertAdjacentHTML('beforeend', `<p class="treeko-meta">${data.removedSites} suggested spot(s) outside the analysis area were left out.</p>`);
      }
      // Model metadata label
      if (data.model) {
        bubble.insertAdjacentHTML('beforeend', `<p class="treeko-meta">✦ Answered by AI (${escapeHtml(data.model)})</p>`);
      }
      if (Array.isArray(data.sources) && data.sources.length) {
        bubble.insertAdjacentHTML('beforeend', `<p class="treeko-meta">Sources: ${data.sources.map(escapeHtml).join(' · ')}</p>`);
      }
    } catch (err) {
      typing.remove();
      history.pop(); // the question was not answered; it can be retried
      const bubble = addBubble('treeko', err.message || 'Something went wrong.', 'error');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'treeko-retry';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        bubble.remove();
        userBubble.remove(); // re-asked below, so it isn't shown twice
        ask(question);
      });
      bubble.appendChild(retry);
      if (mode === 'browser' && /key was rejected/i.test(err.message || '')) showKeyCard();
    } finally {
      busy = false;
      sendBtn.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  // ---------------------------------------------------------------------
  // Planting sites: list in the chat + pins on the map
  // ---------------------------------------------------------------------
  function clearSites() {
    sitesLayer?.clearLayers();
  }

  function renderSites(bubble, sites) {
    if (typeof L !== 'undefined' && typeof map !== 'undefined') {
      sitesLayer ??= L.layerGroup().addTo(map);
      sitesLayer.clearLayers();
    }
    const list = document.createElement('ol');
    list.className = 'treeko-sites';
    sites.forEach((s, i) => {
      const marker = sitesLayer && L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: 'treeko-site-pin', html: `<span>${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        title: s.name,
      }).bindPopup(`<strong>${escapeHtml(s.name)}</strong><br>${fmtCoord(s.lat, s.lng)}<br>${escapeHtml(s.reason)}`)
        .addTo(sitesLayer);

      const li = document.createElement('li');
      li.innerHTML = `
        <div class="treeko-site-name">${escapeHtml(s.name)}</div>
        <div class="treeko-site-coords">${fmtCoord(s.lat, s.lng)}${s.distanceKm != null ? ` · ${s.distanceKm} km from centre` : ''}</div>
        ${s.reason ? `<div class="treeko-site-reason">${escapeHtml(s.reason)}</div>` : ''}
        ${s.species?.length ? `<div class="treeko-site-species">🌱 ${s.species.map(escapeHtml).join(', ')}</div>` : ''}
        <div class="treeko-site-actions">
          <button type="button" data-act="map">Show on map</button>
          <button type="button" data-act="copy">Copy coordinates</button>
        </div>`;
      li.querySelector('[data-act="map"]').addEventListener('click', () => showSite(s, marker));
      li.querySelector('[data-act="copy"]').addEventListener('click', e => copyCoords(s, e.currentTarget));
      list.appendChild(li);
    });
    bubble.appendChild(list);
  }

  function showSite(site, marker) {
    if (typeof map === 'undefined') return;
    const toggle = $('toggle-globe');
    const in3d = !!toggle?.checked;
    map.setView([site.lat, site.lng], 14, { animate: !in3d });
    if (in3d && !window.ForestGlobeTransition?.isRunning?.()) {
      toggle.checked = false; // back to the 2D map (with the 3D → 2D animation), zoomed to the site
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      const openWhenSettled = () => {
        if (window.ForestGlobeTransition?.isRunning?.()) return setTimeout(openWhenSettled, 200);
        let done = false;
        const openIt = () => { if (!done) { done = true; marker?.openPopup(); } };
        map.once('moveend', openIt); // after the final zoom-in to the site
        setTimeout(openIt, 1600);    // or straight away if no zoom was needed
      };
      setTimeout(openWhenSettled, 200);
    } else {
      marker?.openPopup();
    }
  }

  async function copyCoords(site, el) {
    const text = fmtCoord(site.lat, site.lng);
    try {
      await navigator.clipboard.writeText(text);
      el.textContent = 'Copied ✓';
    } catch {
      el.textContent = text; // clipboard blocked: show it so it can be copied by hand
    }
    setTimeout(() => { el.textContent = 'Copy coordinates'; }, 2000);
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-haspopup', 'dialog');
  window.addEventListener('treeko:open', () => {
    if (panel && !panel.classList.contains('hidden')) close();
    else open();
  });

  window.ForestTreekoChat = { open, close, ask, _test: { renderMarkdown, currentContext, escapeHtml, whenModeKnown, savedKey } };
})();
