/** Shared test harness: a static file server and a browser launcher. */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

/** Serve the site root on `port`. */
export async function serve(port) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(port, r));
  return { server, origin: `http://localhost:${port}` };
}

/**
 * Chromium ships preinstalled in this environment at a fixed path; fall back
 * to Playwright's own download when running anywhere else.
 */
export function launch() {
  const preinstalled = '/opt/pw-browsers/chromium';
  return chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
}

/**
 * Read js/config.js with Supabase credentials swapped for test stubs.
 *
 * Matches whatever value is already there rather than only an empty string, so
 * these tests keep pointing at the stub server once real credentials are
 * committed — otherwise they would quietly start hitting live Supabase.
 */
export function configWithSupabase(url, anonKey) {
  const source = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  const swapped = source
    .replace(/(\n\s*url:\s*)'[^']*'/, `$1'${url}'`)
    .replace(/(\n\s*anonKey:\s*)'[^']*'/, `$1'${anonKey}'`);

  if (!swapped.includes(`'${url}'`) || !swapped.includes(`'${anonKey}'`)) {
    throw new Error('configWithSupabase failed to inject test credentials — config.js shape changed.');
  }
  return swapped;
}

/**
 * Answer the shared per-app access check.
 *
 * The app asks the project's app_session() function on every entry — one call
 * answering both "may they in?" and "as what?" — so a suite that leaves it
 * unanswered would reach for the real Supabase project, and, because the check
 * fails closed, be refused at the door.
 *
 * `allowed: false` stands in for an account that has no grant for this app.
 * `allowed: 'error'` stands in for the project being unreachable, which must
 * also refuse rather than wave the visitor through.
 *
 * `role` defaults to app_admin because most suites drive the owner's own
 * account. Pass 'member' for an ordinary seller.
 */
export async function stubAppAccess(page, allowed = true, { role = 'app_admin', legacy = false } = {}) {
  const json = (route, status, body) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/rest/v1/rpc/app_session', async (route) => {
    // `legacy` stands in for a project that has not run supabase/session.sql
    // yet: the function is simply not there, and the app has to cope.
    if (legacy) return json(route, 404, { message: 'Could not find the function' });
    if (allowed === 'error') return json(route, 500, {});
    return json(route, 200, {
      access: Boolean(allowed),
      // No grant means no role, which is what the database returns too.
      role: allowed ? role : null,
    });
  });

  // Still answered, because the app falls back to it when app_session is
  // missing. Most suites never reach this route.
  await page.route('**/rest/v1/rpc/has_app_access', async (route) => {
    if (allowed === 'error') return json(route, 500, {});
    return json(route, 200, Boolean(allowed));
  });
}

/**
 * Collect console errors and uncaught exceptions into `problems`.
 *
 * Chromium logs "Failed to load resource" for every non-2xx response. The
 * failure tests provoke those deliberately, so that noise is filtered out —
 * what matters is that the app catches them, which those tests assert
 * directly. Genuine script errors still come through.
 */
export function watchForErrors(page, problems) {
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (text.includes('Failed to load resource')) return;
    problems.push(`console: ${text}`);
  });
}

/**
 * A realistic ListModels payload: two usable generations, a retired one, and
 * several models the app must filter out because they cannot read a photo.
 */
export const FAKE_MODELS = {
  models: [
    { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash-preview-11-2026', displayName: 'Gemini 3 Flash Preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash-lite', displayName: 'Gemini 3 Flash Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/imagen-4.0-generate', displayName: 'Imagen', supportedGenerationMethods: ['predict'] },
    { name: 'models/veo-3.0-generate', displayName: 'Veo', supportedGenerationMethods: ['predictLongRunning'] },
    { name: 'models/gemini-3-flash-native-audio', displayName: 'Native Audio', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-3-27b-it', displayName: 'Gemma', supportedGenerationMethods: ['generateContent'] },
  ],
};

/** The model the ranking should settle on for FAKE_MODELS. */
export const BEST_FAKE_MODEL = 'gemini-3-flash';

/** What a seller starts the day with, unless a test says otherwise. */
export const DEFAULT_QUOTA = { used: 0, limit: 25, remaining: 25 };

/**
 * The headers the Edge Function puts on every reply, including its failures.
 * The app reads the day's figures from these rather than asking separately.
 *
 * `Access-Control-Expose-Headers` is not decoration: the app is served from a
 * different origin than the project, and a browser will not let script read a
 * custom response header across origins unless the server says it may. Without
 * it the figures are invisible to the app and the count silently never moves,
 * which is exactly the bug this line exists to keep out.
 */
export const quotaHeaders = (quota = DEFAULT_QUOTA) => ({
  'Content-Type': 'application/json',
  'Access-Control-Expose-Headers': 'X-Runs-Remaining, X-Runs-Limit, X-Runs-Used',
  'X-Runs-Remaining': String(quota.remaining),
  'X-Runs-Limit': String(quota.limit),
  'X-Runs-Used': String(quota.used),
});

/**
 * Route the Edge Function that now stands between the app and Gemini.
 *
 * The browser no longer talks to Google at all, so what a test intercepts is
 * one POST to `functions/v1/generate` carrying an action. Model discovery and
 * the quota question are answered here; `onGenerate` handles the generation
 * calls the test actually cares about.
 */
export async function stubGemini(page, onGenerate, { models = FAKE_MODELS, quota = DEFAULT_QUOTA } = {}) {
  await page.route('**/functions/v1/generate', async (route) => {
    const body = route.request().postDataJSON() || {};
    const json = (payload) =>
      route.fulfill({ status: 200, headers: quotaHeaders(quota), body: JSON.stringify(payload) });

    if (body.action === 'quota') return json(quota);
    if (body.action === 'listModels') return json(models);
    return onGenerate(route);
  });
}

/**
 * Answer the quota question alone, leaving generation to whatever else the
 * suite has routed.
 *
 * Seeded for every signed-in test because the app asks on entry: without it
 * each page load would reach for the real project. `route.fallback()` keeps
 * this independent of the order the stubs are registered in.
 */
export async function stubQuota(page, quota = DEFAULT_QUOTA) {
  await page.route('**/functions/v1/generate', async (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.action !== 'quota') return route.fallback();
    await route.fulfill({ status: 200, headers: quotaHeaders(quota), body: JSON.stringify(quota) });
  });
}

/**
 * In-memory stand-in for the `profiles` table, one store per page.
 *
 * Profiles now live in Supabase, so tests that drive the app have to answer
 * PostgREST or every page load would reach for the real project. This keeps
 * them offline while still exercising the real read/write path rather than the
 * offline fallback.
 */
const profileStores = new WeakMap();

/**
 * A complete profile for suites that are testing something else.
 *
 * A new account now starts blank on purpose, which blocks listing generation
 * until it is filled in — so every suite that exercises the flow needs a
 * usable profile in place. These are the values the other suites assert on.
 */
export const TEST_PROFILE = {
  location: {
    city: 'Côte Saint-Luc, QC',
    postalCode: 'H4V 2L5',
    market: 'Montreal and Greater Montreal',
    country: 'Canada',
  },
  money: { currency: 'CAD', locale: 'en-CA', payment: 'cash or Interac e-Transfer' },
  logistics: { pickupOnly: true, notes: '' },
  household: { smoking: 'Smoke-free home', pets: 'No pets in the home' },
  voice: {
    tone: 'Professional and factual',
    allowEmojis: false,
    primaryLanguage: 'English',
    secondLanguage: 'French',
    secondLanguageNotice: '(Description en français ci-dessous)',
  },
  standingInstructions: '',
};

export function profileStore(page) {
  if (!profileStores.has(page)) profileStores.set(page, {});
  return profileStores.get(page);
}

async function stubProfilesTable(page) {
  const store = profileStore(page);
  await page.route('**/rest/v1/profiles**', async (route) => {
    const request = route.request();
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (request.method() === 'GET') {
      const id = (new URL(request.url()).searchParams.get('user_id') || '').replace(/^eq\./, '');
      const data = store[decodeURIComponent(id)];
      return json(200, data ? [{ data }] : []);
    }
    if (request.method() === 'POST') {
      const rows = [].concat(request.postDataJSON());
      for (const row of rows) store[row.user_id] = row.data;
      return json(201, []);
    }
    return json(200, []);
  });
}

/**
 * In-memory stand-in for the `app_settings` table.
 *
 * The app asks for the owner's model choice on entry, so a suite that leaves it
 * unanswered would reach for the real project. Writes are kept, so a test can
 * save as the owner and then assert what a member inherits.
 */
const settingsStores = new WeakMap();

export function settingsStore(page) {
  if (!settingsStores.has(page)) settingsStores.set(page, { model: '' });
  return settingsStores.get(page);
}

export async function stubAppSettings(page, { missing = false, readOnly = false } = {}) {
  const store = settingsStore(page);
  await page.route('**/rest/v1/app_settings*', async (route) => {
    const request = route.request();
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // `missing` stands in for a project that has not run settings.sql yet.
    if (missing) return json(404, { message: 'relation "public.app_settings" does not exist' });

    if (request.method() === 'GET') {
      const key = (new URL(request.url()).searchParams.get('key') || '').replace(/^eq\./, '');
      const value = store[decodeURIComponent(key)];
      return json(200, value === undefined ? [] : [{ value }]);
    }
    // What the row level security policy does to a member who writes anyway.
    if (readOnly) return json(403, { message: 'new row violates row-level security policy' });

    for (const row of [].concat(request.postDataJSON())) store[row.key] = row.value;
    return json(201, []);
  });
}

/**
 * Seed a signed-in session so a test can drive the app itself.
 *
 * Now that real Supabase credentials are committed the sign-in gate is live,
 * so every suite exercising the listing flow has to get past it. An unexpired
 * session is accepted without any network call, which keeps these tests off
 * the network — the gate itself is covered in auth.test.mjs.
 *
 * Call before `page.goto`.
 */
export async function signIn(
  page,
  email = 'robert@imetrobert.com',
  { profile = TEST_PROFILE, appAccess = true, quota = DEFAULT_QUOTA, role = 'app_admin' } = {},
) {
  await page.addInitScript((who) => {
    localStorage.setItem('fbmg.session', JSON.stringify({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      // The id doubles as the profile-store key, so tests can address a row
      // by the address they signed in with.
      user: { id: who, email: who },
    }));
  }, email);
  await stubProfilesTable(page);
  // The app checks its per-app grant before showing anything, so a seeded
  // session is not enough on its own.
  await stubAppAccess(page, appAccess, { role });
  // It also asks how many runs are left, on entry, before anything is spent.
  await stubQuota(page, quota);
  // And which model the owner picked for everyone.
  await stubAppSettings(page, { readOnly: role !== 'app_admin' });
  // A usable profile by default; pass `{ profile: null }` to test a new account.
  if (profile) profileStore(page)[email] = profile;
}

/**
 * Seed a profile for the signed-in account before the page loads.
 * Partial overrides are fine — the app merges them over the defaults.
 */
export async function seedProfile(page, overrides = {}, account = 'robert@imetrobert.com') {
  // Straight into the stubbed table: that is where the app reads from now.
  profileStore(page)[account] = overrides;
}

/** Wrap a JSON payload the way generateContent returns it. */
export const asGeminiReply = (payload) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
});

/** Print results and exit non-zero if anything failed. */
export function report(name, problems) {
  if (problems.length) {
    console.error(`\n${name} FAILURES:\n` + problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`\n${name}: all checks passed.`);
}
