/**
 * Auth test: drives the Supabase REST gate against a stubbed auth server —
 * sign-in, wrong password, session persistence, expiry refresh, recovery
 * redirect, and sign-out.
 */
import { serve, launch, configWithSupabase, watchForErrors, report } from './harness.mjs';

const PORT = 4176;
const { server, origin: ORIGIN } = await serve(PORT);

const SUPA = 'https://stub.supabase.co';


const problems = [];
const browser = await launch();

const USER = { id: 'u1', email: 'rsimonmtl@gmail.com' };
const tokenBody = (expiresIn = 3600, tag = 'v1') => ({
  access_token: `access-${tag}`, refresh_token: `refresh-${tag}`,
  expires_in: expiresIn, expires_at: Math.floor(Date.now() / 1000) + expiresIn, user: USER,
});

async function newPage() {
  const page = await browser.newPage();
  watchForErrors(page, problems);
  const hits = [];

  await page.route('**/js/config.js', async (route) => {
    const body = configWithSupabase(SUPA, 'anon-key-abc');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });

  await page.route(`${SUPA}/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = route.request().postDataJSON?.() || {};
    hits.push(`${method} ${url.pathname}${url.search}`);

    if (route.request().headers().apikey !== 'anon-key-abc') {
      problems.push(`missing apikey header on ${url.pathname}`);
    }

    const json = (status, payload) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });

    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      return body.password === 'correct-horse'
        ? json(200, tokenBody())
        : json(400, { error_description: 'Invalid login credentials' });
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      return body.refresh_token === 'refresh-v1'
        ? json(200, tokenBody(3600, 'v2'))
        : json(400, { error_description: 'Invalid Refresh Token' });
    }
    if (url.pathname === '/auth/v1/logout') return json(204, {});
    if (url.pathname === '/auth/v1/user') {
      const bearer = route.request().headers().authorization || '';
      return bearer.includes('recovery-token') ? json(200, USER) : json(401, { msg: 'bad token' });
    }
    return json(404, {});
  });

  return { page, hits };
}

/* 1 — wrong password is reported and does not unlock the app. */
{
  const { page } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#auth-view:not([hidden])');
  await page.fill('#signin-email', USER.email);
  await page.fill('#signin-password', 'wrong');
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector('#signin-error:not([hidden])', { timeout: 5000 });
  const msg = await page.locator('#signin-error').textContent();
  if (!msg.includes('Invalid login credentials')) problems.push(`unhelpful sign-in error: ${msg}`);
  if (await page.locator('#app-view').isVisible()) problems.push('app unlocked despite a bad password');
  console.log('  ✓ wrong password rejected with the server message, app stays locked');
  await page.close();
}

/* 2 — correct password unlocks and persists across a reload. */
{
  const { page, hits } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.fill('#signin-email', USER.email);
  await page.fill('#signin-password', 'correct-horse');
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 5000 });
  if (!(await page.locator('#user-chip').textContent()).includes('rsimonmtl')) {
    problems.push('signed-in email not shown');
  }
  if (!(await page.locator('#signout-btn').isVisible())) problems.push('sign-out button hidden while signed in');
  console.log('  ✓ correct password unlocks the app and shows the account');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 5000 });
  if (hits.filter((h) => h.includes('grant_type=password')).length !== 1) {
    problems.push('reload re-authenticated instead of reusing the stored session');
  }
  console.log('  ✓ session survives a reload without re-authenticating');

  /* 3 — sign out clears it. */
  await page.click('#signout-btn');
  await page.waitForSelector('#auth-view:not([hidden])', { timeout: 5000 });
  if (!hits.some((h) => h.includes('/auth/v1/logout'))) problems.push('sign-out never called the server');
  const stored = await page.evaluate(() => localStorage.getItem('fbmg.session'));
  if (stored) problems.push('sign-out left the session in localStorage');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  if (await page.locator('#app-view').isVisible()) problems.push('app still unlocked after sign-out and reload');
  console.log('  ✓ sign-out clears the session server-side and locally');
  await page.close();
}

/* 4 — an expired stored token is refreshed on boot, not treated as valid. */
{
  const { page, hits } = await newPage();
  await page.addInitScript(() => {
    localStorage.setItem('fbmg.session', JSON.stringify({
      accessToken: 'access-v1', refreshToken: 'refresh-v1',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      user: { id: 'u1', email: 'rsimonmtl@gmail.com' },
    }));
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 5000 });
  if (!hits.some((h) => h.includes('grant_type=refresh_token'))) {
    problems.push('expired token was accepted without a refresh');
  }
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('fbmg.session')).accessToken);
  if (token !== 'access-v2') problems.push(`refreshed token not stored (got ${token})`);
  console.log('  ✓ expired session is refreshed on boot and the new token stored');
  await page.close();
}

/* 5 — a dead refresh token forces sign-in rather than silently proceeding. */
{
  const { page } = await newPage();
  await page.addInitScript(() => {
    localStorage.setItem('fbmg.session', JSON.stringify({
      accessToken: 'access-old', refreshToken: 'revoked',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      user: { id: 'u1', email: 'rsimonmtl@gmail.com' },
    }));
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#auth-view:not([hidden])', { timeout: 5000 });
  if (await page.locator('#app-view').isVisible()) problems.push('revoked refresh token still unlocked the app');
  console.log('  ✓ revoked refresh token sends the user back to sign-in');
  await page.close();
}

/* 6 — a password-recovery redirect signs in and scrubs the token from the URL. */
{
  const { page } = await newPage();
  await page.goto(
    `${ORIGIN}/#access_token=recovery-token&refresh_token=r-recovery&expires_in=3600&type=recovery`,
    { waitUntil: 'networkidle' },
  );
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 5000 });
  if (page.url().includes('access_token')) problems.push('access token left in the URL after sign-in');
  console.log('  ✓ recovery redirect signs in and scrubs the token from the URL');
  await page.close();
}

/* 7 — the removed magic-link button must not reappear. */
{
  const { page } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#auth-view:not([hidden])');
  if (await page.locator('#magic-link-btn').count()) problems.push('magic-link button is still in the markup');
  const buttons = await page.locator('#signin-form button').allTextContents();
  if (buttons.length !== 1 || !buttons[0].includes('Sign in')) {
    problems.push(`sign-in form should offer only Sign in, found: ${buttons.join(', ')}`);
  }
  console.log('  ✓ sign-in form offers password only, no magic-link button');
  await page.close();
}

/* 8 — the real committed config must gate the site, with no stubs at all.
   Every other check here swaps in a fake project; this one validates what
   actually ships. A signed-out visit resolves locally, so nothing leaves the
   machine and no request reaches the live project. */
{
  const page = await browser.newPage();
  const offsite = [];
  // Fail loudly rather than quietly talking to production.
  await page.route('**supabase.co/**', (route) => {
    offsite.push(route.request().url());
    route.abort();
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  if (!(await page.locator('#auth-view').isVisible())) {
    problems.push('the shipped config does not gate the site — anyone with the URL gets straight in');
  }
  if (await page.locator('#app-view').isVisible()) {
    problems.push('the app is reachable without signing in');
  }
  if (offsite.length) problems.push(`signed-out load contacted Supabase: ${offsite[0]}`);

  const config = await page.evaluate(async () => (await import('/js/config.js')).SUPABASE);
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.url)) {
    problems.push(`shipped Supabase URL looks wrong: ${config.url}`);
  }
  if (!/^(sb_publishable_|eyJ)/.test(config.anonKey)) {
    problems.push('shipped key is not a publishable/anon key');
  }
  if (/sb_secret_|service_role/.test(config.anonKey)) {
    problems.push('A SECRET KEY HAS BEEN COMMITTED — rotate it immediately');
  }
  console.log('  ✓ the shipped config gates the site and carries a publishable key only');
  await page.close();
}

await browser.close();
server.close();

report('Auth', problems);
