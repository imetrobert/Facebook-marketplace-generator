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

/**
 * @param {string} account signed-in address, so profiles do not mix on a
 *   shared browser. Omit for the single-user case.
 */
export async function loadProfile(account = '') {
  try {
    return withDefaults(JSON.parse(localStorage.getItem(keyFor(account)) || 'null'));
  } catch {
    return defaultProfile();
  }
}

export async function saveProfile(profile, account = '') {
  const merged = withDefaults(profile);
  localStorage.setItem(keyFor(account), JSON.stringify(merged));
  return merged;
}

export async function resetProfile(account = '') {
  localStorage.removeItem(keyFor(account));
  return defaultProfile();
}

/** Has this account ever saved a profile, or is it still running on defaults? */
export function hasSavedProfile(account = '') {
  return localStorage.getItem(keyFor(account)) !== null;
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
