/**
 * Auth test: drives the Supabase REST gate against a stubbed auth server —
 * sign-in, wrong password, session persistence, expiry refresh, recovery
 * redirect, and sign-out.
 */
import { serve, launch, configWithSupabase, watchForErrors, report, TEST_PROFILE } from './harness.mjs';

const PORT = 4176;
const { server, origin: ORIGIN } = await serve(PORT);

const SUPA = 'https://stub.supabase.co';


const problems = [];
const browser = await launch();

const USER = { id: 'u1', email: 'robert@imetrobert.com' };
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
    if (url.pathname === '/auth/v1/signup') {
      return json(200, { ...tokenBody(), user: { id: body.email, email: body.email } });
    }
    if (url.pathname === '/auth/v1/recover') return json(200, {});
    if (url.pathname === '/auth/v1/user' && method === 'PUT') return json(200, USER);
    // This suite is about the sign-in gate, so the per-app grant is always
    // present — a signed-in account still has to clear it before the app
    // appears. Refusal and failure are covered in invite.test.mjs.
    if (url.pathname === '/rest/v1/rpc/has_app_access') return json(200, true);
    // A complete profile, so signing in lands in the app rather than on the
    // first-run welcome. The profile itself is covered in profile.test.mjs.
    if (url.pathname === '/rest/v1/profiles') {
      return json(200, method === 'GET' ? [{ data: TEST_PROFILE }] : []);
    }
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
  await page.waitForSelector('#auth-error:not([hidden])', { timeout: 5000 });
  const msg = await page.locator('#auth-error').textContent();
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
  if (!(await page.locator('#topbar').isVisible())) problems.push('the top bar did not appear after signing in');
  if (!(await page.locator('#user-chip').textContent()).includes('robert@imetrobert.com')) {
    problems.push('signed-in email not shown');
  }
  // Sign out lives in Settings now, so the top bar stays narrow on a phone.
  await page.click('#settings-btn');
  await page.waitForFunction(() => document.getElementById('settings-dialog').open, { timeout: 3000 });
  if (!(await page.locator('#signout-btn').isVisible())) problems.push('sign-out missing from Settings while signed in');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('settings-dialog').open, { timeout: 3000 });
  console.log('  ✓ correct password unlocks the app and shows the account');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 5000 });
  if (hits.filter((h) => h.includes('grant_type=password')).length !== 1) {
    problems.push('reload re-authenticated instead of reusing the stored session');
  }
  console.log('  ✓ session survives a reload without re-authenticating');

  /* 3 — sign out closes the dialog it was opened from, and clears everything. */
  await page.click('#settings-btn');
  await page.waitForFunction(() => document.getElementById('settings-dialog').open, { timeout: 3000 });
  await page.click('#signout-btn');
  await page.waitForSelector('#auth-view:not([hidden])', { timeout: 5000 });

  // Sign out is reached from inside Settings; leaving that dialog open left the
  // sign-in page sitting behind a modal.
  if (await page.evaluate(() => document.getElementById('settings-dialog').open)) {
    problems.push('Settings stayed open over the sign-in page after signing out');
  }
  if (await page.locator('#user-chip').isVisible()) {
    problems.push("the signed-out user's address is still shown");
  }
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
      user: { id: 'u1', email: 'robert@imetrobert.com' },
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
      user: { id: 'u1', email: 'robert@imetrobert.com' },
    }));
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#auth-view:not([hidden])', { timeout: 5000 });
  if (await page.locator('#app-view').isVisible()) problems.push('revoked refresh token still unlocked the app');
  console.log('  ✓ revoked refresh token sends the user back to sign-in');
  await page.close();
}

/* 6 — a recovery link stops at "choose a new password", not inside the app. */
{
  const { page } = await newPage();
  await page.goto(
    `${ORIGIN}/#access_token=recovery-token&refresh_token=r-recovery&expires_in=3600&type=recovery`,
    { waitUntil: 'networkidle' },
  );
  await page.waitForSelector('#newpass-form:not([hidden])', { timeout: 5000 });
  if (await page.locator('#app-view').isVisible()) {
    problems.push('a recovery link went straight into the app, leaving the reset half done');
  }
  if (page.url().includes('access_token')) problems.push('access token left in the URL');
  console.log('  ✓ a recovery link lands on the new-password step, not in the app');

  // Setting the password completes it and lets them in.
  await page.fill('#newpass-password', 'a-much-better-password');
  await page.fill('#newpass-confirm', 'a-much-better-password');
  await page.click('#newpass-form button[type="submit"]');
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 5000 });
  console.log('  ✓ saving the new password completes the reset and signs them in');
  await page.close();
}

/* 6b — mismatched passwords are caught before anything is sent. */
{
  const { page, hits } = await newPage();
  await page.goto(
    `${ORIGIN}/#access_token=recovery-token&refresh_token=r-recovery&expires_in=3600&type=recovery`,
    { waitUntil: 'networkidle' },
  );
  await page.waitForSelector('#newpass-form:not([hidden])', { timeout: 5000 });
  await page.fill('#newpass-password', 'one-password-here');
  await page.fill('#newpass-confirm', 'a-different-one');
  await page.click('#newpass-form button[type="submit"]');
  await page.waitForSelector('#auth-error:not([hidden])', { timeout: 3000 });
  if (!(await page.locator('#auth-error').textContent()).includes('do not match')) {
    problems.push('mismatched passwords were not reported');
  }
  if (hits.some((h) => h.startsWith('PUT'))) problems.push('a mismatched password was still sent');
  console.log('  ✓ mismatched passwords are caught before anything is sent');
  await page.close();
}

/* 6c — asking for a reset says the same thing whoever the address belongs to. */
{
  const { page, hits } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.click('#forgot-btn');
  await page.waitForSelector('#reset-form:not([hidden])', { timeout: 3000 });
  await page.fill('#reset-email', 'someone@example.com');
  await page.click('#reset-form button[type="submit"]');
  await page.waitForSelector('#auth-note:not([hidden])', { timeout: 5000 });

  const note = await page.locator('#auth-note').textContent();
  if (!note.includes('If that address has an account')) {
    problems.push(`the reset message reveals whether the account exists: "${note}"`);
  }
  if (!hits.some((h) => h.includes('/auth/v1/recover'))) problems.push('no reset was requested');
  if (!(await page.locator('#signin-form').isVisible())) problems.push('did not return to sign in');
  console.log('  ✓ a reset request is sent, and the reply does not reveal who has an account');
  await page.close();
}

/* 7 — the removed magic-link button must not reappear. */
{
  const { page } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#auth-view:not([hidden])');
  if (await page.locator('#magic-link-btn').count()) problems.push('magic-link button is still in the markup');
  const buttons = await page.locator('#signin-form button').allTextContents();
  if (!buttons.some((b) => b.includes('Sign in'))) problems.push('no Sign in button');
  if (!buttons.some((b) => b.includes('forgot'))) problems.push('no way to recover a password');
  console.log('  ✓ sign-in offers a password and a way to recover it, with no magic link');
  await page.close();
}

/* 7b — signing out leaves nothing of the previous user behind. */
{
  const { page } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.fill('#signin-email', USER.email);
  await page.fill('#signin-password', 'correct-horse');
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 5000 });

  // Leave some work on screen, as a real session would.
  await page.evaluate(() => {
    document.getElementById('user-note').value = 'IKEA dresser, bought 2021';
  });

  await page.click('#settings-btn');
  await page.waitForFunction(() => document.getElementById('settings-dialog').open, { timeout: 3000 });
  await page.click('#signout-btn');
  await page.waitForSelector('#auth-view:not([hidden])', { timeout: 5000 });

  for (const id of ['settings-dialog', 'profile-dialog', 'welcome-dialog']) {
    if (await page.evaluate((d) => document.getElementById(d).open, id)) {
      problems.push(`#${id} was left open over the sign-in page`);
    }
  }
  if (await page.locator('#topbar').isVisible()) problems.push('the top bar stayed after signing out');
  const note = await page.locator('#user-note').inputValue();
  if (note !== '') problems.push(`the previous user's note survived sign-out: "${note}"`);
  if ((await page.locator('.thumb').count()) !== 0) problems.push("the previous user's photos survived sign-out");
  console.log('  ✓ signing out closes every dialog and clears the previous session');
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

  // The app id is how a grant in the project's app_access table finds this
  // deployment. Ship the wrong one and every account is refused, including the
  // owner's, because no grant can ever match it.
  const app = await page.evaluate(async () => (await import('/js/config.js')).APP);
  if (app?.id !== 'fb-marketplace') {
    problems.push(`shipped app id is not the one grants are issued against: ${app?.id}`);
  }
  console.log('  ✓ the shipped config gates the site and carries a publishable key only');
  await page.close();
}

await browser.close();
server.close();

report('Auth', problems);
