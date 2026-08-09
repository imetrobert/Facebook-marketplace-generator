/**
 * Invite links and self-serve sign-up.
 *
 * The gate here is deliberately modest — the code is checked in a browser the
 * visitor controls — so these checks are about the link doing what it should,
 * a wrong code getting nowhere, and the tool that produces the link being
 * correct. The real control is Supabase's own sign-up switch.
 */
import { serve, launch, configWithSupabase, watchForErrors, report, TEST_PROFILE } from './harness.mjs';
import crypto from 'node:crypto';

const PORT = 4182;
const { server, origin: ORIGIN } = await serve(PORT);

const problems = [];
const browser = await launch();

const SUPA = 'https://stub.supabase.co';
const CODE = 'welcome-sheldon';
const CODE_HASH = crypto.createHash('sha256').update(CODE).digest('hex');

/**
 * Serve config.js with the Supabase stub and an invite hash injected, so the
 * app runs exactly as it would with a code configured.
 */
// Access is granted by the project, not by this repository, so the stub answers
// has_app_access() directly. It defaults to allowed here so the invite checks
// are about invites; the three that are about access pass their own answer.
// `appAccess: 'error'` makes that call fail, standing in for an unreachable
// project.
async function newPage({ codeHash = CODE_HASH, appAccess = true } = {}) {
  const page = await browser.newPage();
  watchForErrors(page, problems);
  const hits = [];

  await page.route('**/js/config.js', async (route) => {
    let body = configWithSupabase(SUPA, 'anon-key-abc');
    body = body.replace(/(\n\s*codeHash:\s*)'[^']*'/, `$1'${codeHash}'`);
    if (codeHash && !body.includes(codeHash)) {
      throw new Error('could not inject the invite hash — config.js shape changed');
    }
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });

  await page.route(`${SUPA}/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = route.request().postDataJSON?.() || {};
    hits.push({ method, path: url.pathname, body });

    const json = (status, payload) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });

    if (url.pathname === '/auth/v1/signup') {
      if (String(body.password || '').length < 8) {
        return json(422, { msg: 'Password should be at least 8 characters' });
      }
      return json(200, {
        access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600,
        user: { id: body.email, email: body.email },
      });
    }
    if (url.pathname === '/rest/v1/rpc/has_app_access') {
      if (appAccess === 'error') return json(500, {});
      return json(200, Boolean(appAccess));
    }
    if (url.pathname === '/rest/v1/profiles') {
      return json(200, method === 'GET' ? [{ data: TEST_PROFILE }] : []);
    }
    return json(404, {});
  });

  return { page, hits };
}

/* 1 — a valid invite link opens account creation. */
{
  const { page } = await newPage();
  await page.goto(`${ORIGIN}/#invite=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signup-form:not([hidden])', { timeout: 5000 });

  if (await page.locator('#signin-form').isVisible()) problems.push('sign-in shown over the invite');
  if (page.url().includes('invite=')) problems.push('the invite code was left in the URL');
  console.log('  ✓ a valid invite link opens account creation and scrubs the code from the URL');
  await page.close();
}

/* 2 — a wrong code, or none, gets the ordinary sign-in page. */
{
  const { page, hits } = await newPage();
  await page.goto(`${ORIGIN}/#invite=not-the-code`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signin-form:not([hidden])', { timeout: 5000 });
  if (await page.locator('#signup-form').isVisible()) problems.push('a wrong invite code opened sign-up');
  if (hits.some((h) => h.path === '/auth/v1/signup')) problems.push('a wrong code still reached signup');
  await page.close();

  const plain = await newPage();
  await plain.page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await plain.page.waitForSelector('#signin-form:not([hidden])', { timeout: 5000 });
  if (await plain.page.locator('#signup-form').isVisible()) problems.push('sign-up shown with no invite');
  console.log('  ✓ a wrong code, or none at all, lands on ordinary sign-in');
  await plain.page.close();
}

/* 3 — with no hash configured, invites are off entirely. */
{
  const { page } = await newPage({ codeHash: '' });
  await page.goto(`${ORIGIN}/#invite=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signin-form:not([hidden])', { timeout: 5000 });
  if (await page.locator('#signup-form').isVisible()) {
    problems.push('sign-up opened even though invites are switched off');
  }
  console.log('  ✓ an empty codeHash turns invites off');
  await page.close();
}

/* 4 — creating an account signs them straight in. */
{
  const { page, hits } = await newPage();
  await page.goto(`${ORIGIN}/#invite=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signup-form:not([hidden])', { timeout: 5000 });

  await page.fill('#signup-email', 'sheldon@example.com');
  await page.fill('#signup-password', 'sheldons-password');
  await page.fill('#signup-confirm', 'sheldons-password');
  await page.click('#signup-form button[type="submit"]');
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 6000 });

  const signup = hits.find((h) => h.path === '/auth/v1/signup');
  if (signup?.body.email !== 'sheldon@example.com') problems.push('the wrong address was registered');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fbmg.session') || 'null'));
  if (stored?.accessToken !== 'new-access') problems.push('the new session was not stored');
  console.log('  ✓ creating an account signs them straight in');
  await page.close();
}

/* 5 — the form catches its own mistakes before calling Supabase. */
{
  const { page, hits } = await newPage();
  await page.goto(`${ORIGIN}/#invite=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signup-form:not([hidden])', { timeout: 5000 });

  await page.fill('#signup-email', 'sheldon@example.com');
  await page.fill('#signup-password', 'one-password');
  await page.fill('#signup-confirm', 'another-password');
  await page.click('#signup-form button[type="submit"]');
  await page.waitForSelector('#auth-error:not([hidden])', { timeout: 3000 });
  if (!(await page.locator('#auth-error').textContent()).includes('do not match')) {
    problems.push('mismatched passwords were not reported');
  }
  if (hits.some((h) => h.path === '/auth/v1/signup')) {
    problems.push('a mismatched password was still sent to Supabase');
  }
  console.log('  ✓ mismatched passwords are caught before anything is sent');

  // A short password is refused locally too.
  await page.fill('#signup-password', 'short');
  await page.fill('#signup-confirm', 'short');
  await page.click('#signup-form button[type="submit"]');
  await page.waitForTimeout(300);
  if (hits.some((h) => h.path === '/auth/v1/signup')) problems.push('a too-short password was still sent');
  console.log('  ✓ a too-short password is refused without a round trip');
  await page.close();
}

/* 6 — the invite tool produces a hash and link that actually work together. */
{
  const { page } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('fbmg.session', JSON.stringify({
      accessToken: 'access-v1', refreshToken: 'r',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'robert@imetrobert.com', email: 'robert@imetrobert.com' },
    }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#settings-btn');
  await page.waitForFunction(() => document.getElementById('settings-dialog').open, { timeout: 3000 });

  await page.click('.invite-tool summary');
  await page.fill('#invite-code', 'a-brand-new-code');
  await page.click('#invite-make-btn');
  await page.waitForSelector('#invite-out:not([hidden])', { timeout: 3000 });

  const hash = await page.locator('#invite-hash').inputValue();
  const link = await page.locator('#invite-link').inputValue();
  const expected = crypto.createHash('sha256').update('a-brand-new-code').digest('hex');
  if (hash !== expected) problems.push(`the tool hashed the code wrongly: ${hash}`);
  if (!link.includes('#invite=a-brand-new-code')) problems.push(`the link is malformed: ${link}`);
  console.log('  ✓ the invite tool hashes the code correctly and builds a matching link');

  // And the pair genuinely unlocks sign-up.
  const proof = await newPage({ codeHash: hash });
  await proof.page.goto(`${ORIGIN}/#invite=a-brand-new-code`, { waitUntil: 'networkidle' });
  await proof.page.waitForSelector('#signup-form:not([hidden])', { timeout: 5000 });
  console.log('  ✓ a link made by the tool opens sign-up against its own hash');
  await proof.page.close();
  await page.close();
}

/* 7 — an account for a sibling app is turned away from this one. */
{
  const { page } = await newPage({ appAccess: false });
  await page.goto(`${ORIGIN}/#invite=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signup-form:not([hidden])', { timeout: 5000 });

  // Signing up succeeds at Supabase — the account is real and shared across
  // every app on the project — but this app declines it.
  await page.fill('#signup-email', 'stranger@example.com');
  await page.fill('#signup-password', 'a-valid-password');
  await page.fill('#signup-confirm', 'a-valid-password');
  await page.click('#signup-form button[type="submit"]');
  await page.waitForSelector('#auth-error:not([hidden])', { timeout: 6000 });

  if (await page.locator('#app-view').isVisible()) {
    problems.push('an account with no grant for this app got in');
  }
  const message = await page.locator('#auth-error').textContent();
  if (!message.includes('does not have access')) problems.push(`unclear refusal: "${message}"`);
  if (!message.includes('Robert Simon')) problems.push('the refusal does not say who to ask');
  const session = await page.evaluate(() => localStorage.getItem('fbmg.session'));
  if (session) problems.push('the refused account was left signed in');
  console.log('  ✓ an account with no grant is refused and signed back out');
  await page.close();
}

/* 8 — a granted account is let in as normal. */
{
  const { page } = await newPage({ appAccess: true });
  await page.goto(`${ORIGIN}/#invite=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signup-form:not([hidden])', { timeout: 5000 });
  await page.fill('#signup-email', 'sheldon@example.com');
  await page.fill('#signup-password', 'a-valid-password');
  await page.fill('#signup-confirm', 'a-valid-password');
  await page.click('#signup-form button[type="submit"]');
  await page.waitForSelector('#app-view:not([hidden])', { timeout: 6000 });
  console.log('  ✓ a granted account is let in');
  await page.close();
}

/* 9 — an unreachable project refuses rather than waving the visitor through.
 *
 * The check that used to live here — "an empty allow list leaves the app open"
 * — no longer exists: access is a grant in the database, and its absence is
 * never an invitation. What matters now is which way the door swings when the
 * answer cannot be fetched at all. */
{
  const { page } = await newPage({ appAccess: 'error' });
  await page.goto(`${ORIGIN}/#invite=${encodeURIComponent(CODE)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signup-form:not([hidden])', { timeout: 5000 });
  await page.fill('#signup-email', 'anyone@example.com');
  await page.fill('#signup-password', 'a-valid-password');
  await page.fill('#signup-confirm', 'a-valid-password');
  await page.click('#signup-form button[type="submit"]');
  await page.waitForSelector('#auth-error:not([hidden])', { timeout: 6000 });

  if (await page.locator('#app-view').isVisible()) {
    problems.push('a failed access check let the visitor in');
  }
  const session = await page.evaluate(() => localStorage.getItem('fbmg.session'));
  if (session) problems.push('the refused account was left signed in');
  console.log('  ✓ an unreachable access check fails closed');
  await page.close();
}

await browser.close();
server.close();

report('Invite', problems);
