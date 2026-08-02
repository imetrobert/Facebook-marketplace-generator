/**
 * Supabase email/password gate, using the same project as the other
 * imetrobert.com tools.
 *
 * This talks to the Supabase auth REST API with plain fetch rather than
 * pulling supabase-js from a CDN. That keeps the gate working with no
 * third-party script on the critical path, and means a CDN outage cannot
 * silently unlock the app.
 *
 * If js/config.js has no Supabase credentials the gate is skipped entirely,
 * so the site still works before it is wired up.
 */

import { SUPABASE } from './config.js';

const SESSION_STORAGE = 'fbmg.session';
/** Refresh this many seconds before the token actually expires. */
const REFRESH_MARGIN = 60;

let session = null;
let refreshTimer = null;
let onChange = null;

export function isEnabled() {
  return Boolean(SUPABASE.url && SUPABASE.anonKey);
}

const authUrl = (p) => `${SUPABASE.url.replace(/\/$/, '')}/auth/v1${p}`;

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE) || 'null');
  } catch {
    return null;
  }
}

function saveSession(next) {
  session = next;
  if (next) localStorage.setItem(SESSION_STORAGE, JSON.stringify(next));
  else localStorage.removeItem(SESSION_STORAGE);
  scheduleRefresh();
}

async function post(path, body, extraHeaders = {}) {
  const response = await fetch(authUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE.anonKey,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data?.error_description || data?.msg || data?.message || `Sign-in failed (${response.status}).`;
    throw new Error(message);
  }
  return data;
}

function toSession(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // expires_at is seconds since epoch; fall back to expires_in when absent.
    expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    user: data.user ?? null,
  };
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!session?.refreshToken) return;
  const seconds = session.expiresAt - Math.floor(Date.now() / 1000) - REFRESH_MARGIN;
  refreshTimer = setTimeout(refresh, Math.max(10, seconds) * 1000);
}

async function refresh() {
  if (!session?.refreshToken) return null;
  try {
    const data = await post('/token?grant_type=refresh_token', { refresh_token: session.refreshToken });
    saveSession(toSession(data));
    return session.user;
  } catch {
    // The refresh token is spent or revoked — force a fresh sign-in.
    saveSession(null);
    onChange?.(null);
    return null;
  }
}

/**
 * @returns {Promise<{enabled:boolean, user:object|null, error:string|null}>}
 */
export async function init(handler) {
  onChange = handler;
  if (!isEnabled()) return { enabled: false, user: null, error: null };

  session = loadSession();
  if (!session) return { enabled: true, user: null, error: null };

  // An expired token is refreshed before we trust the stored user.
  if (session.expiresAt - REFRESH_MARGIN <= Math.floor(Date.now() / 1000)) {
    const user = await refresh();
    return { enabled: true, user, error: null };
  }

  scheduleRefresh();
  return { enabled: true, user: session.user, error: null };
}

export async function signIn(email, password) {
  const data = await post('/token?grant_type=password', { email: email.trim(), password });
  saveSession(toSession(data));
  return session.user;
}

export async function signOut() {
  if (session?.accessToken) {
    await post('/logout', {}, { Authorization: `Bearer ${session.accessToken}` }).catch(() => {});
  }
  saveSession(null);
}

/**
 * Supabase email flows — password recovery and address confirmation — redirect
 * back here with the tokens in the URL fragment. Consume them so the link
 * signs the user in, then scrub the fragment so a shared or bookmarked URL
 * cannot leak a live token.
 */
export async function consumeRedirect() {
  if (!isEnabled() || !window.location.hash.includes('access_token')) return null;

  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  history.replaceState(null, '', window.location.pathname + window.location.search);
  if (!accessToken) return null;

  const response = await fetch(authUrl('/user'), {
    headers: { apikey: SUPABASE.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;

  saveSession({
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + Number(params.get('expires_in') || 3600),
    user: await response.json(),
  });
  return session.user;
}
