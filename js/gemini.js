/**
 * Minimal Gemini REST client for the browser.
 *
 * The API key lives in localStorage on the seller's own device and is sent
 * directly from the browser to Google. Nothing transits a server of ours,
 * because there isn't one — this is a static site.
 */

import { MODEL_PREFERENCES } from './config.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const KEY_STORAGE = 'fbmg.geminiKey';
const MODEL_CACHE = 'fbmg.modelCache';
const MODEL_OVERRIDE = 'fbmg.model';

/**
 * Families that cannot do what this app needs: embeddings, retrieval, media
 * generation, speech, and the tuning-oriented variants. Everything else in the
 * Gemini line is multimodal enough to read a photo.
 */
const UNSUITABLE = /embedding|aqa|imagen|veo|tts|audio|live|image-generation|robotics|learnlm|gemma|computer-use/i;

/** "gemini-2.5-flash" -> 2.5, "gemini-3-pro-preview" -> 3. */
function versionOf(id) {
  const m = id.match(/gemini-(\d+)(?:[.-](\d+))?/);
  if (!m) return 0;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
}

function tierOf(id) {
  // Check the most specific name first: "flash-lite" also contains "flash".
  if (/flash-lite/i.test(id)) return 'flash-lite';
  if (/flash/i.test(id)) return 'flash';
  if (/pro/i.test(id)) return 'pro';
  return 'other';
}

const isStable = (id) => !/(preview|exp|experimental)/i.test(id);

/** Strip the "models/" prefix the API returns. */
const bareId = (name) => name.replace(/^models\//, '');

/**
 * Rank usable models best-first, without knowing any specific model name:
 * newest version wins, then the preferred family, then stable over preview,
 * then the shortest name (the plain alias rather than a dated build).
 */
export function rankModels(models) {
  const { tiers, preferStable } = MODEL_PREFERENCES;
  return models
    .map((m) => (typeof m === 'string' ? { name: m, supportedGenerationMethods: ['generateContent'] } : m))
    .filter((m) => {
      const id = bareId(m.name || '');
      return (
        id.startsWith('gemini-') &&
        !UNSUITABLE.test(id) &&
        (m.supportedGenerationMethods || []).includes('generateContent')
      );
    })
    .map((m) => {
      const id = bareId(m.name);
      return {
        id,
        displayName: m.displayName || id,
        version: versionOf(id),
        tier: tierOf(id),
        stable: isStable(id),
      };
    })
    .sort(
      (a, b) =>
        b.version - a.version ||
        (tiers[b.tier] ?? 0) - (tiers[a.tier] ?? 0) ||
        (preferStable ? Number(b.stable) - Number(a.stable) : 0) ||
        a.id.length - b.id.length,
    );
}

/** Ask the key which models it can actually use. */
export async function listModels(apiKey = getApiKey()) {
  const response = await fetch(`${ENDPOINT}?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey.trim() },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new GeminiError(describeFailure(response.status, body), { status: response.status });
  }
  const data = await response.json();
  return rankModels(data.models || []);
}

function readModelCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(MODEL_CACHE) || 'null');
    if (!cached?.ranked?.length) return null;
    const age = Date.now() - cached.at;
    if (age > MODEL_PREFERENCES.cacheHours * 3600_000) return null;
    if (cached.key !== getApiKey()) return null;
    return cached.ranked;
  } catch {
    return null;
  }
}

function writeModelCache(ranked) {
  localStorage.setItem(MODEL_CACHE, JSON.stringify({ at: Date.now(), key: getApiKey(), ranked }));
}

export function getModelOverride() {
  return localStorage.getItem(MODEL_OVERRIDE) || '';
}

export function setModelOverride(id) {
  if (id) localStorage.setItem(MODEL_OVERRIDE, id);
  else localStorage.removeItem(MODEL_OVERRIDE);
}

/** Drop the cached list so the next run re-discovers. */
export function forgetModels() {
  localStorage.removeItem(MODEL_CACHE);
}

/**
 * The models to try, best first. A manual override goes to the front but the
 * discovered list still follows it, so a stale override cannot brick the app.
 */
export async function availableModels({ refresh = false } = {}) {
  let ranked = refresh ? null : readModelCache();
  if (!ranked) {
    ranked = await listModels();
    if (ranked.length) writeModelCache(ranked);
  }
  return ranked;
}

export async function resolveModels({ refresh = false } = {}) {
  const ids = (await availableModels({ refresh })).map((m) => m.id);
  const override = getModelOverride();
  return override ? [override, ...ids.filter((id) => id !== override)] : ids;
}

export function getApiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

export function setApiKey(key) {
  const trimmed = key.trim();
  if (trimmed) localStorage.setItem(KEY_STORAGE, trimmed);
  else localStorage.removeItem(KEY_STORAGE);
}

export class GeminiError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Google retires models on its own schedule, and a retired one fails with a
 * 404 or a 400 saying it is gone. Both mean "try a different model", not
 * "give up" — the caller re-discovers the list and moves on.
 */
export function isModelUnavailable(status, message = '') {
  return (
    status === 404 ||
    /no longer available|not found|does not exist|is not supported|deprecated/i.test(message)
  );
}

function describeFailure(status, body) {
  const apiMessage = body?.error?.message || '';
  if (isModelUnavailable(status, apiMessage)) {
    return 'That Gemini model is no longer available. Open Settings and tap "Refresh models".';
  }
  switch (status) {
    case 400:
      return /api key/i.test(apiMessage)
        ? 'That Gemini API key was rejected. Check it in Settings.'
        : `Gemini rejected the request: ${apiMessage || 'bad request'}`;
    case 401:
    case 403:
      return 'That Gemini API key is not authorised. Create a new one at aistudio.google.com/apikey and paste it into Settings.';
    case 429:
      return 'Gemini free-tier rate limit hit. Wait about a minute and try again.';
    case 503:
      return 'Gemini is temporarily overloaded.';
    default:
      return apiMessage || `Gemini request failed with status ${status}.`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel({ model, apiKey, prompt, assets, schema, temperature, signal }) {
  const parts = [{ text: prompt }];
  for (const asset of assets) {
    if (asset.note) parts.push({ text: `Next image — ${asset.note}` });
    parts.push({ inline_data: { mime_type: asset.mimeType, data: asset.dataB64 } });
  }

  const response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new GeminiError(describeFailure(response.status, body), {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];

  if (!candidate) {
    const blocked = data.promptFeedback?.blockReason;
    throw new GeminiError(
      blocked
        ? `Gemini declined to analyse these images (${blocked}). Try different photos.`
        : 'Gemini returned an empty response.',
    );
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new GeminiError('Gemini ran out of room before finishing. Try again with fewer photos.');
  }

  const text = (candidate.content?.parts || []).map((p) => p.text || '').join('');
  if (!text.trim()) throw new GeminiError('Gemini returned no usable content.');

  try {
    return JSON.parse(text);
  } catch {
    // Structured output should make this impossible, but a truncated or
    // fence-wrapped reply is recoverable often enough to be worth trying.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
    throw new GeminiError('Gemini returned malformed JSON. Try again.');
  }
}

/**
 * Run a request with retries on transient failures, falling back to a second
 * model if the primary one keeps refusing.
 */
/** How many different models to fall through before giving up. */
const MAX_MODELS_TRIED = 3;

export async function generate({ prompt, assets, schema, temperature = 0.4, signal, onRetry }) {
  const apiKey = getApiKey();
  if (!apiKey) throw new GeminiError('No Gemini API key set. Open Settings and paste your key.');

  let candidates = await resolveModels();
  if (!candidates.length) {
    throw new GeminiError('Your Gemini key cannot access any usable models. Check it at aistudio.google.com/apikey.');
  }

  const dead = new Set();
  let rediscovered = false;
  let lastError;

  const nextModel = () => candidates.find((id) => !dead.has(id));

  while (dead.size < MAX_MODELS_TRIED) {
    const model = nextModel();
    if (!model) break;
    let moveOn = false;

    for (let attempt = 0; attempt < 3 && !moveOn; attempt += 1) {
      try {
        return await callModel({ model, apiKey, prompt, assets, schema, temperature, signal });
      } catch (err) {
        lastError = err;
        if (err.name === 'AbortError') throw err;
        if (!(err instanceof GeminiError)) throw err;

        // A retired model means the cached list is stale. Mark it dead so the
        // refreshed list cannot hand it back, then re-discover once.
        if (isModelUnavailable(err.status, err.message)) {
          dead.add(model);
          if (!rediscovered) {
            rediscovered = true;
            onRetry?.('That model has been retired. Finding a current one…');
            forgetModels();
            try {
              candidates = await resolveModels({ refresh: true });
            } catch {
              /* keep the stale list and fall through to the next entry */
            }
          }
          moveOn = true;
          break;
        }

        if (!err.retryable) {
          // A bad key or malformed request fails identically everywhere, so
          // stop rather than burning calls on every model in the list.
          if (err.status >= 400 && err.status < 500) throw err;
          dead.add(model);
          moveOn = true;
          break;
        }

        if (attempt === 2) {
          dead.add(model);
          moveOn = true;
          break;
        }
        const waitMs = 2 ** attempt * 1500;
        onRetry?.(`${err.message} Retrying in ${Math.round(waitMs / 1000)}s…`);
        await sleep(waitMs);
      }
    }
  }
  throw lastError ?? new GeminiError('Gemini request failed.');
}

/**
 * Cheap key validation for Settings. Doubles as model discovery, so testing a
 * key also refreshes the list it can use.
 */
export async function verifyKey(apiKey) {
  const response = await fetch(`${ENDPOINT}?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey.trim() },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new GeminiError(describeFailure(response.status, body), { status: response.status });
  }
  const data = await response.json();
  const ranked = rankModels(data.models || []);
  if (!ranked.length) {
    throw new GeminiError('That key works, but it cannot access any models that can read photos.');
  }
  return ranked;
}
