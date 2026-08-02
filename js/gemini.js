/**
 * Minimal Gemini REST client for the browser.
 *
 * The API key lives in localStorage on the seller's own device and is sent
 * directly from the browser to Google. Nothing transits a server of ours,
 * because there isn't one — this is a static site.
 */

import { MODELS } from './config.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const KEY_STORAGE = 'fbmg.geminiKey';

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

function describeFailure(status, body) {
  const apiMessage = body?.error?.message || '';
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
export async function generate({ task, prompt, assets, schema, temperature = 0.4, signal, onRetry }) {
  const primary = MODELS[task] || MODELS.listing;
  const models = primary === MODELS.fallback ? [primary] : [primary, MODELS.fallback];
  const apiKey = getApiKey();
  if (!apiKey) throw new GeminiError('No Gemini API key set. Open Settings and paste your key.');

  let lastError;
  for (const [modelIndex, model] of models.entries()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await callModel({ model, apiKey, prompt, assets, schema, temperature, signal });
      } catch (err) {
        lastError = err;
        if (err.name === 'AbortError') throw err;
        if (!(err instanceof GeminiError) || !err.retryable) {
          // A bad key or a rejected request will fail identically on the
          // fallback model, so stop rather than burning another call.
          if (err instanceof GeminiError && err.status >= 400 && err.status < 500) throw err;
          break;
        }
        const isLastTry = attempt === 2 && modelIndex === models.length - 1;
        if (isLastTry) throw err;
        const waitMs = 2 ** attempt * 1500;
        onRetry?.(`${err.message} Retrying in ${Math.round(waitMs / 1000)}s…`);
        await sleep(waitMs);
      }
    }
  }
  throw lastError ?? new GeminiError('Gemini request failed.');
}

/** Cheap key validation so Settings can confirm the key before a real run. */
export async function verifyKey(apiKey) {
  const response = await fetch(`${ENDPOINT}?pageSize=1`, {
    headers: { 'x-goog-api-key': apiKey.trim() },
  });
  if (response.ok) return true;
  const body = await response.json().catch(() => null);
  throw new GeminiError(describeFailure(response.status, body), { status: response.status });
}
