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
 * Serve config.js with the per-app access list emptied.
 *
 * That list names the real owner, so suites that sign in as invented accounts
 * would otherwise be refused at the door. Access control itself is covered in
 * invite.test.mjs, against a config with a list in it.
 */
export async function stubOpenAccess(page) {
  await page.route('**/js/config.js', async (route) => {
    const source = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
    const opened = source.replace(/(\n\s*allowedEmails:\s*)\[[^\]]*\]/, '$1[]');
    if (!/allowedEmails:\s*\[\]/.test(opened)) {
      throw new Error('could not empty the access list — config.js shape changed');
    }
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: opened });
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

/**
 * Route the Gemini API: model discovery is answered automatically, and
 * `onGenerate` handles the generateContent calls the test actually cares about.
 */
export async function stubGemini(page, onGenerate, { models = FAKE_MODELS } = {}) {
  await page.route('**/generativelanguage.googleapis.com/**', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(models),
      });
    }
    return onGenerate(route);
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
 * Seed a signed-in session so a test can drive the app itself.
 *
 * Now that real Supabase credentials are committed the sign-in gate is live,
 * so every suite exercising the listing flow has to get past it. An unexpired
 * session is accepted without any network call, which keeps these tests off
 * the network — the gate itself is covered in auth.test.mjs.
 *
 * Call before `page.goto`.
 */
export async function signIn(page, email = 'robert@imetrobert.com', { profile = TEST_PROFILE } = {}) {
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
