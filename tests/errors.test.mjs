/**
 * Failure-path test: bad key, rate limiting with retry, cancellation,
 * malformed JSON, oversized uploads, and the Supabase sign-in gate.
 */
import { serve, launch, configWithSupabase, watchForErrors, report, FAKE_MODELS, signIn } from './harness.mjs';
import fs from 'node:fs';

const PORT = 4175;
const { server, origin: ORIGIN } = await serve(PORT);


const problems = [];
const browser = await launch();

async function newPage({ key = 'test-key-123' } = {}) {
  const page = await browser.newPage();
  watchForErrors(page, problems);
  await signIn(page);
  await page.addInitScript((k) => { if (k) localStorage.setItem('fbmg.geminiKey', k); }, key);
  return page;
}

async function seedPhoto(page) {
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 400;
    const x = c.getContext('2d');
    x.fillStyle = '#888'; x.fillRect(0, 0, 400, 400);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  });
  fs.writeFileSync('/tmp/item.jpg', Buffer.from(jpeg, 'base64'));
  await page.setInputFiles('#file-input', '/tmp/item.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 1);
}

/* 1 — no key at all should not even attempt a request. */
{
  const page = await newPage({ key: '' });
  let attempted = false;
  await page.route('**/generativelanguage.googleapis.com/**', (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MODELS) });
    }
    attempted = true;
    r.abort();
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

  // With no key stored, the first-run prompt must be up and must offer a
  // working way to go and get one.
  if (!(await page.locator('#setup-prompt').isVisible())) {
    problems.push('first-run setup prompt not shown when no key is stored');
  }
  const keyLink = page.locator('#setup-prompt a.btn-link');
  if ((await keyLink.getAttribute('href')) !== 'https://aistudio.google.com/apikey') {
    problems.push(`setup prompt link points somewhere unexpected: ${await keyLink.getAttribute('href')}`);
  }
  if ((await keyLink.getAttribute('target')) !== '_blank') {
    problems.push('key link should open in a new tab so the app is not navigated away');
  }
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForTimeout(600);
  if (attempted) problems.push('a request was sent with no API key');
  if (!(await page.locator('#app-error').textContent()).includes('No Gemini API key')) {
    problems.push('missing-key error not surfaced on analyse');
  }
  console.log('  ✓ missing key blocks the request and explains why');
  await page.close();
}

/* 1b — the setup prompt routes into Settings and clears once a key is saved. */
{
  const page = await newPage({ key: '' });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

  await page.click('#setup-settings-btn');
  await page.waitForFunction(() => document.getElementById('settings-dialog').open, { timeout: 3000 });

  const dialogLink = page.locator('#settings-dialog a.btn-link');
  if ((await dialogLink.getAttribute('href')) !== 'https://aistudio.google.com/apikey') {
    problems.push('settings dialog is missing the get-a-key link');
  }
  if (!(await dialogLink.isVisible())) problems.push('get-a-key link is not visible in settings');
  console.log('  ✓ setup prompt opens Settings, which also links out to get a key');

  await page.fill('#api-key-input', 'AIza-pasted-by-hand');
  await page.click('#save-settings-btn');
  await page.waitForSelector('#setup-prompt', { state: 'hidden', timeout: 3000 });
  const stored = await page.evaluate(() => localStorage.getItem('fbmg.geminiKey'));
  if (stored !== 'AIza-pasted-by-hand') problems.push(`key not stored (got ${stored})`);

  // And it must stay gone on the next visit.
  await page.reload({ waitUntil: 'networkidle' });
  if (await page.locator('#setup-prompt').isVisible()) {
    problems.push('setup prompt came back after a key was saved');
  }
  console.log('  ✓ saving a key stores it and clears the prompt for good');
  await page.close();
}

/* 2 — a rejected key must say so in plain language and not retry. */
{
  const page = await newPage();
  let calls = 0;
  await page.route('**/generativelanguage.googleapis.com/**', (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MODELS) });
    }
    calls += 1;
    r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForFunction(() => !document.getElementById('app-error').hidden, { timeout: 8000 });
  const msg = await page.locator('#app-error').textContent();
  if (!msg.includes('rejected')) problems.push(`bad-key message unhelpful: ${msg}`);
  if (calls !== 1) problems.push(`bad key was retried ${calls} times; should fail fast`);
  if (!(await page.locator('#busy').isHidden())) problems.push('busy overlay stuck after error');
  console.log('  ✓ rejected key fails fast with a clear message, overlay clears');
  await page.close();
}

/* 3 — 429 retries, then succeeds. */
{
  const page = await newPage();
  let calls = 0;
  await page.route('**/generativelanguage.googleapis.com/**', (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MODELS) });
    }
    calls += 1;
    if (calls === 1) {
      return r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Quota exceeded' } }) });
    }
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        identification: { item: 'Lamp', brand: '', model: '', category: 'Home Decor', confidence: 0.7, summary: 'A lamp.' },
        conditionObserved: [], photoRequests: [], questions: [],
        preliminaryPrice: { low: 10, high: 20, basis: 'Low value item.' },
      }) }] }, finishReason: 'STOP' }] }),
    });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForSelector('#busy-text', { state: 'attached' });
  await page.waitForFunction(() => document.getElementById('busy-text').textContent.includes('Retrying'), { timeout: 8000 });
  console.log('  ✓ rate limit shows a retry countdown instead of failing');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 15000 });
  if (calls !== 2) problems.push(`expected 2 calls after one 429, got ${calls}`);
  console.log('  ✓ retry recovers and reaches step 2');
  await page.close();
}

/* 4 — cancel must abort in flight and clear the overlay. */
{
  const page = await newPage();
  await page.route('**/generativelanguage.googleapis.com/**', async (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MODELS) });
    }
    /* the generateContent call never resolves, so cancel has something to abort */
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForSelector('#busy:not([hidden])');
  await page.click('#cancel-btn');
  await page.waitForSelector('#busy', { state: 'hidden', timeout: 5000 });
  if (!(await page.locator('#app-error').isHidden())) problems.push('cancelling raised a spurious error');
  if (!(await page.locator('#step-1').isVisible())) problems.push('cancel did not leave the user on step 1');
  console.log('  ✓ cancel aborts cleanly with no error banner');
  await page.close();
}

/* 5 — malformed JSON is reported, not thrown. */
{
  const page = await newPage();
  await page.route('**/generativelanguage.googleapis.com/**', (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MODELS) });
    }
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'this is not json at all' }] }, finishReason: 'STOP' }] }) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForFunction(() => !document.getElementById('app-error').hidden, { timeout: 20000 });
  if (!(await page.locator('#app-error').textContent()).includes('malformed')) {
    problems.push('malformed JSON not reported clearly');
  }
  console.log('  ✓ malformed model output surfaces a readable error');
  await page.close();
}

/* 6 — upload cap is enforced and explained. */
{
  const page = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 300;
    c.getContext('2d').fillRect(0, 0, 300, 300);
    return c.toDataURL('image/jpeg', 0.7).split(',')[1];
  });
  const files = [];
  for (let i = 0; i < 15; i++) {
    const f = `/tmp/bulk-${i}.jpg`;
    fs.writeFileSync(f, Buffer.from(jpeg, 'base64'));
    files.push(f);
  }
  await page.setInputFiles('#file-input', files);
  await page.waitForSelector('#media-errors:not([hidden])', { timeout: 25000 });
  const count = await page.locator('.thumb').count();
  if (count !== 12) problems.push(`upload cap not enforced: ${count} thumbnails`);
  if (!(await page.locator('#media-errors').textContent()).includes('left out')) {
    problems.push('upload cap not explained to the user');
  }
  console.log(`  ✓ upload capped at 12 images with an explanation (${count} kept of 15)`);
  await page.close();
}

/* 7 — a non-media file is rejected by name. */
{
  const page = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  fs.writeFileSync('/tmp/receipt.txt', 'not an image');
  await page.setInputFiles('#file-input', '/tmp/receipt.txt');
  await page.waitForSelector('#media-errors:not([hidden])', { timeout: 8000 });
  if (!(await page.locator('#media-errors').textContent()).includes('receipt.txt')) {
    problems.push('unsupported file not named in the error');
  }
  if (await page.locator('.thumb').count() !== 0) problems.push('unsupported file produced a thumbnail');
  console.log('  ✓ unsupported files rejected by name');
  await page.close();
}

/* 8 — with Supabase configured, the app must sit behind the sign-in gate. */
{
  const page = await browser.newPage();
  await page.route('**/js/config.js', async (route) => {
    const body = configWithSupabase('https://example.supabase.co', 'test-anon-key');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const authVisible = await page.locator('#auth-view').isVisible();
  const appVisible = await page.locator('#app-view').isVisible();
  if (!authVisible || appVisible) {
    problems.push(`gate failed: auth visible=${authVisible}, app visible=${appVisible}`);
  } else {
    console.log('  ✓ configuring Supabase puts the app behind the sign-in gate');
  }
  await page.close();
}

await browser.close();
server.close();

report('Errors', problems);
