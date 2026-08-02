/**
 * The seller profile: everything about *who is selling* rather than about the
 * item or the deployment.
 *
 * This used to be hard-coded for one person. It is now a versioned document
 * with an async load/save API, deliberately shaped so it can move to a
 * per-user Supabase row without any caller changing: the storage functions are
 * the only place that knows where it lives.
 *
 * Profiles are keyed by account, so two people signing into the same browser
 * never see each other's details.
 */

import { SUPABASE } from './config.js';
import * as auth from './auth.js';

const STORAGE_PREFIX = 'fbmg.profile';

export const PROFILE_VERSION = 1;

/** Options offered in the UI. Kept here so the form and prompts agree. */
export const TONES = [
  'Professional and factual',
  'Warm and approachable',
  'Short and direct',
  'Detailed and thorough',
];

export const HOUSEHOLD_OPTIONS = {
  smoking: ['Prefer not to say', 'Smoke-free home', 'Someone smokes in the home'],
  pets: ['Prefer not to say', 'No pets in the home', 'Pets in the home'],
};

/**
 * Seeded with the original owner's details, so the app behaves exactly as it
 * did before anyone opens the profile screen. A new user overwrites all of it.
 */
export const DEFAULT_PROFILE = {
  version: PROFILE_VERSION,
  location: {
    city: 'Côte Saint-Luc, QC',
    postalCode: 'H4V 2L5',
    market: 'Montreal and Greater Montreal',
    country: 'Canada',
  },
  money: {
    currency: 'CAD',
    locale: 'en-CA',
    payment: 'cash or Interac e-Transfer',
  },
  logistics: {
    pickupOnly: true,
    notes: '',
  },
  household: {
    smoking: 'Smoke-free home',
    pets: 'No pets in the home',
  },
  voice: {
    tone: 'Professional and factual',
    allowEmojis: false,
    secondLanguage: 'French',
    secondLanguageNotice: '(Description en français ci-dessous)',
  },
  standingInstructions: '',
};

/** Notices for languages we can word correctly without asking. */
const KNOWN_NOTICES = {
  french: '(Description en français ci-dessous)',
  français: '(Description en français ci-dessous)',
  spanish: '(Descripción en español más abajo)',
  español: '(Descripción en español más abajo)',
  portuguese: '(Descrição em português abaixo)',
  italian: '(Descrizione in italiano più sotto)',
  german: '(Beschreibung auf Deutsch weiter unten)',
};

/** The standard notice for a language, or an empty string if we do not know it. */
export function noticeFor(language) {
  return KNOWN_NOTICES[String(language || '').trim().toLowerCase()] || '';
}

const clone = (value) =>
  (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

export const defaultProfile = () => clone(DEFAULT_PROFILE);

/**
 * Merge a stored profile over the defaults, one level into each section, so a
 * profile saved by an older version gains new fields instead of losing them.
 */
function withDefaults(stored) {
  const base = defaultProfile();
  if (!stored || typeof stored !== 'object') return base;

  for (const [section, value] of Object.entries(stored)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[section]) {
      Object.assign(base[section], value);
    } else if (value !== undefined && value !== null) {
      base[section] = value;
    }
  }
  base.version = PROFILE_VERSION;
  return base;
}

const keyFor = (account) => (account ? `${STORAGE_PREFIX}:${account}` : STORAGE_PREFIX);

/* ── Storage ──────────────────────────────────────────────────────
 *
 * The `profiles` table is the source of truth, so a seller's settings follow
 * them to any device. localStorage is kept as a per-account cache: the app
 * still opens and works with no network, and a failed save is never silent
 * data loss because the cache is written first.
 *
 * Row-level security means a signed-in user can only ever read or write their
 * own row — the isolation is enforced by the database, not by this file.
 */

const remoteEnabled = () => Boolean(SUPABASE.url && SUPABASE.anonKey);

const restUrl = (path) => `${SUPABASE.url.replace(/\/$/, '')}/rest/v1${path}`;

const restHeaders = (token) => ({
  apikey: SUPABASE.anonKey,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

function readCache(account) {
  try {
    return withDefaults(JSON.parse(localStorage.getItem(keyFor(account)) || 'null'));
  } catch {
    return defaultProfile();
  }
}

function writeCache(account, profile) {
  try {
    localStorage.setItem(keyFor(account), JSON.stringify(profile));
  } catch {
    /* private browsing or a full quota should not break saving */
  }
}

/**
 * @param {string} account signed-in address, used as the cache key so two
 *   people sharing a browser never see each other's settings.
 */
export async function loadProfile(account = '') {
  const cached = readCache(account);
  const userId = auth.getUserId();
  const token = auth.getAccessToken();
  if (!remoteEnabled() || !userId || !token) return cached;

  try {
    const response = await fetch(
      restUrl(`/profiles?select=data&user_id=eq.${encodeURIComponent(userId)}`),
      { headers: restHeaders(token) },
    );
    if (!response.ok) throw new Error(`profiles read failed (${response.status})`);

    const rows = await response.json();
    const remote = rows?.[0]?.data;
    // No row yet means a new account that has never saved. Their defaults
    // stand until they do, and the first save creates the row.
    if (!remote) return cached;

    const merged = withDefaults(remote);
    writeCache(account, merged);
    return merged;
  } catch {
    // Offline, blocked, or the table is not set up yet. The cache keeps the
    // app usable rather than presenting an empty profile.
    return cached;
  }
}

/**
 * Save, cache first then upstream.
 * @returns {Promise<{profile: object, synced: boolean, error: string}>}
 *   `synced` is false when only the local cache was written, so the UI can say
 *   so rather than claiming a save that did not reach the server.
 */
export async function saveProfile(profile, account = '') {
  const merged = withDefaults(profile);
  writeCache(account, merged);

  // With no Supabase configured there is nowhere else for it to go, so the
  // local write is the save — reporting it as unsynced would be misleading.
  if (!remoteEnabled()) return { profile: merged, synced: true, error: '' };

  const userId = auth.getUserId();
  const token = auth.getAccessToken();
  if (!userId || !token) {
    return { profile: merged, synced: false, error: 'you are not signed in' };
  }

  try {
    const response = await fetch(restUrl('/profiles'), {
      method: 'POST',
      headers: {
        ...restHeaders(token),
        // Upsert: one row per user, created on first save.
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        data: merged,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.message || `save failed (${response.status})`);
    }
    return { profile: merged, synced: true, error: '' };
  } catch (err) {
    return { profile: merged, synced: false, error: err.message };
  }
}

/**
 * The fields a listing cannot be written without. Returned as labels so the UI
 * can name them rather than showing a generic complaint.
 */
export function missingFields(profile) {
  const missing = [];
  if (!profile.location.city.trim()) missing.push('city');
  if (!profile.location.postalCode.trim()) missing.push('postal code');
  if (!profile.money.currency.trim()) missing.push('currency');
  if (!profile.money.payment.trim()) missing.push('payment methods');
  return missing;
}

/** Format an amount in the profile's currency. */
export function formatMoney(profile, amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat(profile.money.locale || 'en-CA', {
      style: 'currency',
      currency: profile.money.currency || 'CAD',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // An unknown currency code should degrade, not throw mid-render.
    return `${Math.round(amount)} ${profile.money.currency || ''}`.trim();
  }
}
