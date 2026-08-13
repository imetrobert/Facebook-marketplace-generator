/**
 * Gemini client for the browser, by way of our own Edge Function.
 *
 * Nothing here knows the API key. The browser sends the seller's Supabase
 * session to `functions/v1/generate`, which checks the same app grant row level
 * security checks, spends a run against their daily cap, and calls Google with
 * a key that never leaves the project. So a seller needs no Google account and
 * no key of their own — an invite and a password is the whole setup.
 *
 * The request and reply bodies are Gemini's own, wrapped in a thin envelope, so
 * the retry, ranking and error handling below are unchanged from when this file
 * called Google directly.
 */

import { MODEL_PREFERENCES, ADMINISTRATOR, SUPABASE } from './config.js';
import { getAccessToken } from './auth.js';

const ENDPOINT = `${SUPABASE.url.replace(/\/$/, '')}/functions/v1/generate`;
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

/* ── Talking to the function ────────────────────────────────────── */

/**
 * Every call goes through here: one POST, carrying the seller's session.
 *
 * Quota figures come back on the headers of every reply, including failures, so
 * the count on screen stays honest without a second round trip.
 */
async function callFunction(body, { signal } = {}) {
  const token = getAccessToken();
  if (!token) {
    throw new GeminiError('You are signed out. Sign in again to keep going.', { status: 401 });
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE.anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  const payload = await response.json().catch(() => null);
  rememberQuota(response);

  if (!response.ok) {
    // A cap that has been reached is not a rate limit to wait out — no amount
    // of retrying produces another run today — so it is marked non-retryable
    // and carries its own message rather than Google's.
    if (payload?.code === 'daily_limit') {
      throw new GeminiError(payload?.error?.message || 'Daily limit reached.', {
        status: response.status,
        dailyLimit: true,
      });
    }
    throw new GeminiError(describeFailure(response.status, payload), {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  return payload;
}

/** Ask which models the project's key can actually use. */
export async function listModels() {
  const data = await callFunction({ action: 'listModels' });
  return rankModels(data.models || []);
}

function readModelCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(MODEL_CACHE) || 'null');
    if (!cached?.ranked?.length) return null;
    const age = Date.now() - cached.at;
    if (age > MODEL_PREFERENCES.cacheHours * 3600_000) return null;
    return cached.ranked;
  } catch {
    return null;
  }
}

function writeModelCache(ranked) {
  localStorage.setItem(MODEL_CACHE, JSON.stringify({ at: Date.now(), ranked }));
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

/* ── The daily run cap ──────────────────────────────────────────── */

/**
 * What the seller has left today.
 *
 * Held in memory rather than localStorage on purpose: the count belongs to the
 * account, not the device, and the function is the only thing entitled to an
 * opinion about it. Null means nobody has told us yet.
 */
let quota = null;
const quotaListeners = new Set();

/** Called whenever the figures change, so the UI can follow without polling. */
export function onQuotaChange(listener) {
  quotaListeners.add(listener);
  return () => quotaListeners.delete(listener);
}

export function getQuota() {
  return quota;
}

function rememberQuota(response) {
  const remaining = response.headers.get('X-Runs-Remaining');
  const limit = response.headers.get('X-Runs-Limit');
  if (remaining === null || limit === null) return;

  quota = {
    remaining: Number(remaining),
    limit: Number(limit),
    used: Number(response.headers.get('X-Runs-Used') ?? Number(limit) - Number(remaining)),
  };
  for (const listener of quotaListeners) listener(quota);
}

/** Ask outright, for the count shown before the seller has run anything. */
export async function refreshQuota() {
  await callFunction({ action: 'quota' });
  return quota;
}

export class GeminiError extends Error {
  constructor(message, { status = 0, retryable = false, dailyLimit = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
    // Set when the run was refused by our own cap rather than by Google. The
    // app uses it to disable the buttons instead of just showing the error.
    this.dailyLimit = dailyLimit;
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
      return `Gemini rejected the request: ${apiMessage || 'bad request'}`;
    case 401:
      return 'Your session has expired. Sign in again.';
    case 403:
      // The key is the project's now, so a refusal here is about the account
      // rather than about anything the seller can fix themselves.
      return apiMessage || `This account is not allowed to generate listings. Ask ${ADMINISTRATOR}.`;
    case 429:
      return 'Gemini rate limit hit. Wait about a minute and try again.';
    case 503:
      return `Gemini is temporarily overloaded.`;
    default:
      return apiMessage || `Gemini request failed with status ${status}.`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel({ model, prompt, assets, schema, temperature, signal }) {
  const parts = [{ text: prompt }];
  for (const asset of assets) {
    if (asset.note) parts.push({ text: `Next image — ${asset.note}` });
    parts.push({ inline_data: { mime_type: asset.mimeType, data: asset.dataB64 } });
  }

  // The payload is Gemini's own; the function forwards it untouched, so the
  // prompt and schema stay here where they can be read alongside the app.
  const data = await callFunction(
    {
      action: 'generate',
      model,
      payload: {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      },
    },
    { signal },
  );

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
  let candidates = await resolveModels();
  if (!candidates.length) {
    throw new GeminiError(
      `No usable Gemini models are available right now. Ask ${ADMINISTRATOR} to check the project's key.`,
    );
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
        return await callModel({ model, prompt, assets, schema, temperature, signal });
      } catch (err) {
        lastError = err;
        if (err.name === 'AbortError') throw err;
        if (!(err instanceof GeminiError)) throw err;
        // Out of runs is out of runs. Trying a different model would spend a
        // request to be told the same thing.
        if (err.dailyLimit) throw err;

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
 * Confirm the whole path works: session, grant, key, and models.
 *
 * Replaces the old "test my key" button. There is no key to test any more, but
 * "can this account actually generate anything?" is still a useful question,
 * and it costs no runs — discovery is not a generation.
 */
export async function checkConnection() {
  const ranked = await listModels();
  if (!ranked.length) {
    throw new GeminiError(
      `The project's Gemini key cannot reach any model that reads photos. Ask ${ADMINISTRATOR} to check it.`,
    );
  }
  return ranked;
}
