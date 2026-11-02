/**
 * Earth Intelligence Platform — shared Gemma 4 client (gemma.js)
 * ==============================================================
 * One place that talks to Gemma 4, used by Treeko (Forest Eyes), Aqua (River Eyes)
 * and the Hazard Lens. Server-side only: keys come from the .env file.
 *
 * Providers, tried in this order:
 *   1. Amazon Bedrock  (Gemma 4)  — if BEDROCK_API_KEY and BEDROCK_MODEL_ID are set
 *   2. Gemini API      (Gemma 4)  — GEMINI_API_KEY + GEMMA_MODELS
 *   3. Gemini API      (Gemini)   — only if GEMINI_FALLBACK_MODEL is set
 * Gemma 4 on the free Gemini API often answers "500", hangs or refuses at random, so every
 * attempt is time-capped and retried inside one overall budget. Every answer reports which
 * provider/model produced it, so the UI can be honest about it.
 */
'use strict';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const HEDGE_MS = Number(process.env.GEMMA_HEDGE_MS) || 15000; // start a 2nd Gemma attempt if the 1st is this slow

const settings = () => ({
  geminiKey: (process.env.GEMINI_API_KEY || '').trim(),
  gemmaModels: (process.env.GEMMA_MODELS || 'gemma-4-26b-a4b-it,gemma-4-31b-it')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Gemini backup models, comma-separated: each has its own free-tier quota, so a second one helps
  fallbacks: (process.env.GEMINI_FALLBACK_MODEL || '').split(',').map(x => x.trim()).filter(Boolean),
  bedrockKey: (process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK || '').trim(),
  bedrockRegion: (process.env.BEDROCK_REGION || 'us-east-1').trim(),
  bedrockModel: (process.env.BEDROCK_MODEL_ID || '').trim(),
  attempts: Number(process.env.GEMMA_ATTEMPTS) || 3,
  // Each attempt is capped, and so is the whole call (the chat UIs give up at ~75 s).
  timeoutMs: Number(process.env.GEMMA_TIMEOUT_MS) || 35000,
  budgetMs: Number(process.env.GEMMA_BUDGET_MS) || 70000,
});

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildPlan(cfg) {
  const plan = [];
  if (cfg.bedrockKey && cfg.bedrockModel) {
    plan.push(...Array(2).fill({ provider: 'bedrock', model: cfg.bedrockModel }));
  }
  if (cfg.geminiKey) {
    // first model, then each other model once (so a hedged 2nd attempt uses a different model),
    // then the first model's remaining attempts
    const [first, ...others] = cfg.gemmaModels;
    if (first) {
      plan.push({ provider: 'gemini', model: first });
      for (const model of others) plan.push({ provider: 'gemini', model });
      plan.push(...Array(Math.max(0, cfg.attempts - 1)).fill({ provider: 'gemini', model: first }));
    }
    for (const model of cfg.fallbacks) plan.push({ provider: 'gemini', model, fallback: true });
  }
  return plan;
}

/** What the server is set up to use (for /api/health — never includes keys). */
function describe() {
  return buildPlan(settings())
    .filter((s, i, a) => a.findIndex(x => x.provider === s.provider && x.model === s.model) === i)
    .map(s => (s.fallback ? 'backup model' : `${s.provider === 'gemini' ? 'google-ai-studio' : s.provider}:${s.model}`));
}

/**
 * @param {object} req
 * @param {string} [req.system]    System prompt (prepended to the first user turn: Gemma has no system role)
 * @param {Array}  req.contents    Gemini-style contents: [{role:'user'|'model', parts:[{text}|{inline_data:{mime_type,data}}]}]
 * @param {object} [req.schema]    JSON schema → JSON answer
 * @param {number} [req.timeoutMs] Per-attempt timeout (raised to the configured minimum)
 * @returns {Promise<{text:string, model:string, provider:string}>}
 */
/**
 * jsonMode (with a schema): 'schema' = constrained decoding (default), 'prompt' = the schema is
 * only described in the prompt. GEMMA_JSON_MODE overrides it for every caller.
 */
async function generate({ system, contents, schema, timeoutMs, jsonMode } = {}, fetchImpl = fetch) {
  const cfg = settings();
  const plan = buildPlan(cfg);
  if (!plan.length) throw httpError(503, 'AI is not set up: add GEMINI_API_KEY (or a Bedrock key) to the server settings.');
  if (!Array.isArray(contents) || !contents.length) throw httpError(400, 'Nothing to send to the model.');

  const turns = withSystem(contents, system, schema);
  const deadline = Date.now() + cfg.budgetMs;
  const gemmaSteps = plan.filter(s => !s.fallback);
  const backups = plan.filter(s => s.fallback);
  // Keep 30 s of the budget for the backup, if there is one.
  const gemmaDeadline = deadline - (backups.length ? 30000 : 0);
  const perAttemptMs = Math.max(timeoutMs || 0, cfg.timeoutMs);
  const call = (step, ms, signal) => (step.provider === 'bedrock'
    ? callBedrock(step.model, turns, cfg, ms, fetchImpl, signal)
    : callGemini(step.model, turns, schema, cfg.geminiKey, ms, fetchImpl, signal, process.env.GEMMA_JSON_MODE || jsonMode)
  ).then(text => {
    // Gemma sometimes gets stuck repeating itself ("type-type-type-…"): count it as a failed attempt
    if (looksDegenerate(text)) throw Object.assign(new Error('Answer was stuck repeating itself'), { retry: true });
    // In 'prompt' JSON mode nothing forces valid JSON, so check it (constrained answers too: cheap)
    if (schema) {
      try { parseJson(text); } catch { throw Object.assign(new Error('Answer was not valid JSON'), { retry: true }); }
    }
    return text;
  });
  const answer = (step, text) => {
    // The backup model is reported generically: the UI only names Gemma models.
    const isGemma = step.model.startsWith('gemma');
    return { text, model: isGemma ? step.model : 'backup model', provider: step.provider === 'gemini' ? 'google-ai-studio' : step.provider, gemma: isGemma };
  };
  let lastErr;

  // 1. Gemma 4, hedged: Gemma on the free API sometimes hangs, so if an attempt has not answered
  //    after HEDGE_MS a second one starts next to it (at most 2 at once); the first good answer
  //    wins and the other is cancelled. A failure starts the next attempt straight away.
  if (gemmaSteps.length) {
    const result = await new Promise(resolve => {
      const running = new Set();
      const dead = new Set(); // models that failed for good (missing, bad request…)
      let next = 0, done = false, hedgeTimer = null;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(hedgeTimer);
        for (const c of running) c.abort();
        resolve(value);
      };
      const launch = () => {
        if (done) return;
        while (next < gemmaSteps.length && dead.has(gemmaSteps[next].model)) next++;
        const left = gemmaDeadline - Date.now();
        if (next >= gemmaSteps.length || left < 5000) { if (!running.size) finish(null); return; }
        const step = gemmaSteps[next++];
        const ctl = new AbortController();
        running.add(ctl);
        clearTimeout(hedgeTimer);
        hedgeTimer = setTimeout(() => { if (running.size < 2) launch(); }, HEDGE_MS);
        call(step, Math.min(perAttemptMs, left), ctl.signal).then(
          text => { running.delete(ctl); finish(answer(step, text)); },
          err => {
            running.delete(ctl);
            if (done) return;
            lastErr = err;
            const retryable = RETRYABLE.has(err.upstreamStatus) || err.retry || err.name === 'TimeoutError' || err.name === 'AbortError';
            console.warn(`[gemma] ${step.provider}:${step.model} failed (${err.upstreamStatus || err.name}: ${String(err.message).slice(0, 120)})`);
            if (!retryable) dead.add(step.model);
            setTimeout(launch, 300);
          });
      };
      launch();
    });
    if (result) return result;
  }

  // 2. Backup models, one after another, with whatever time is left
  for (const step of backups) {
    const left = deadline - Date.now();
    if (left < 5000) break;
    try {
      return answer(step, await call(step, Math.min(left, 20000)));
    } catch (err) {
      lastErr = err;
      console.warn(`[gemma] ${step.provider}:${step.model} failed (${err.upstreamStatus || err.name}: ${String(err.message).slice(0, 120)})`);
      await sleep(300);
    }
  }
  const s = lastErr?.upstreamStatus;
  if (s === 401 || s === 403) throw httpError(502, 'The AI key was rejected. Check the keys in the server settings.');
  if (s === 429) throw httpError(502, 'Too many AI requests right now (rate limit). Try again in a minute.');
  throw httpError(502, 'The AI model could not answer right now. Please try again.');
}

/** True for answers stuck in a loop: words or phrases repeated back to back, or very little variety. */
function looksDegenerate(text) {
  const s = String(text || '');
  if (/(\b[a-z]{2,20}[\s,.;:-]+)\1{7,}/i.test(s)) return true;
  // a phrase three times in a row: "near-neutral, near-neutral, near-neutral"
  if (/([a-z][^\n]{10,80}?[\s,.;:-]+)\1{2,}/i.test(s)) return true;
  // other signs of the same failure: "enough-to-study-the-category-of-the", long runs of blanks
  // after a word (JSON indentation follows a newline, so it does not count)
  if (/\b[a-z]+(?:-[a-z]+){5,}/i.test(s) || /\S {12,}/.test(s)) return true;
  const words = s.toLowerCase().match(/[a-z]{2,}/g) || [];
  return words.length > 120 && new Set(words).size / words.length < 0.2;
}

/** Gemma has no system role: put the instructions (and the JSON contract) in the first user turn. */
function withSystem(contents, system, schema) {
  const header = [
    system,
    schema && `Reply with ONLY a JSON object (no markdown fences) matching this JSON schema:\n${JSON.stringify(schema)}`,
  ].filter(Boolean).join('\n\n');
  if (!header) return contents;
  const [first, ...rest] = contents;
  return [{ ...first, parts: [{ text: `${header}\n\n---\n\n` }, ...first.parts] }, ...rest];
}

/** Aborts on the caller's signal or after ms, whichever comes first. */
function timeoutSignal(ms, signal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function callGemini(model, contents, schema, apiKey, timeoutMs, fetchImpl, signal, jsonMode) {
  // 'prompt' mode exists for Treeko: with the schema enforced (constrained decoding) Gemma 4 26B
  // looped in 7 of 8 test answers to "What is the soil profile?" ("slightly acidic to neutral,
  // slightly acidic to neutral, …"); asked for JSON in the prompt only, with Google's recommended
  // Gemma sampling, in 0 of 4. The Hazard Lens answered faster with the schema, so it keeps it.
  // The schema text is always in the prompt too (withSystem).
  const body = { contents };
  const isGemma = model.startsWith('gemma');
  // the Gemini backup keeps the schema unless GEMMA_JSON_MODE=prompt is set for everything
  const promptOnly = jsonMode === 'prompt' && (isGemma || process.env.GEMMA_JSON_MODE === 'prompt');
  if (promptOnly && isGemma) {
    // Minimal thinking: by default Gemma 4 wrote 1000-1500 hidden "thought" tokens first
    // (27-38 s per answer, and they count against maxOutputTokens); minimal answered in 6-7 s.
    body.generationConfig = { temperature: 1.0, topP: 0.95, topK: 64, maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'minimal' } };
  }
  if (schema && !promptOnly) {
    body.generationConfig = { ...body.generationConfig, responseMimeType: 'application/json', responseJsonSchema: schema };
  }
  // Gemini backup: minimal "thinking" answers in ~2-3 s instead of 5-15 s
  if (model.startsWith('gemini')) {
    body.generationConfig = { ...body.generationConfig, thinkingConfig: { thinkingLevel: 'minimal' } };
  }
  // Every answer is capped (Aqua had no cap): long essays cost quota and are never needed here
  body.generationConfig = { maxOutputTokens: 4096, ...body.generationConfig };
  const res = await fetchImpl(GEMINI_API + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs, signal),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${res.status}`), { upstreamStatus: res.status });

  const candidate = data?.candidates?.[0];
  const finish = candidate?.finishReason;
  // Gemma 4 may return its reasoning as parts flagged "thought": never show those.
  const text = (candidate?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text || (finish && finish !== 'STOP')) {
    // RECITATION / MAX_TOKENS / empty answers are random with Gemma: just try again.
    throw Object.assign(new Error(`No usable answer (${finish || data?.promptFeedback?.blockReason || 'empty'})`), { retry: true });
  }
  return text;
}

/** Amazon Bedrock Converse API with a Bedrock API key (bearer token) — no AWS SDK needed. */
async function callBedrock(modelId, contents, cfg, timeoutMs, fetchImpl, signal) {
  const messages = contents.map(c => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: c.parts.map(p => p.inline_data
      ? { image: { format: String(p.inline_data.mime_type || 'image/jpeg').split('/')[1].replace('jpg', 'jpeg'), source: { bytes: p.inline_data.data } } }
      : { text: p.text || '' }),
  }));
  const url = `https://bedrock-runtime.${cfg.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.bedrockKey}` },
    body: JSON.stringify({ messages, inferenceConfig: { maxTokens: 2048, temperature: 0.4 } }),
    signal: timeoutSignal(timeoutMs, signal),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.message || `HTTP ${res.status}`), { upstreamStatus: res.status });
  // Skip reasoning blocks; keep only the answer text.
  const text = (data?.output?.message?.content || []).map(b => b.text || '').join('').trim();
  if (!text) throw Object.assign(new Error(`Empty answer (${data?.stopReason || 'unknown'})`), { retry: true });
  return text;
}

/** Parses a JSON answer, tolerating ```json fences or a sentence around the object. */
function parseJson(text) {
  const clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(clean);
  } catch (err) {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a < 0 || b <= a) throw err;
    return JSON.parse(clean.slice(a, b + 1));
  }
}

module.exports = { generate, parseJson, describe, settings, looksDegenerate };
