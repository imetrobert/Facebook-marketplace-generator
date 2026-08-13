/**
 * Failure-path test: a refused request, the daily cap, rate limiting with
 * retry, cancellation, malformed JSON, oversized uploads, and the Supabase
 * sign-in gate.
 */
import {
  serve, launch, configWithSupabase, watchForErrors, report, FAKE_MODELS, signIn,
  quotaHeaders, DEFAULT_QUOTA,
} from './harness.mjs';
import fs from 'node:fs';

const PORT = 4175;
const { server, origin: ORIGIN } = await serve(PORT);


const problems = [];
const browser = await launch();

async function newPage({ quota = DEFAULT_QUOTA } = {}) {
  const page = await browser.newPage();
  watchForErrors(page, problems);
  await signIn(page, 'robert@imetrobert.com', { quota });
  return page;
}

/**
 * Answer the function the way the real one does: discovery and the quota
 * question handled, generation left to the test.
 *
 * `onGenerate` gets the route and the parsed body. Everything carries the quota
 * headers, because the real function puts them on failures too.
 */
async function stubFunction(page, onGenerate, { quota = DEFAULT_QUOTA, models = FAKE_MODELS } = {}) {
  await page.route('**/functions/v1/generate', async (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.action === 'quota') {
      return route.fulfill({ status: 200, headers: quotaHeaders(quota), body: JSON.stringify(quota) });
    }
    if (body.action === 'listModels') {
      return route.fulfill({ status: 200, headers: quotaHeaders(quota), body: JSON.stringify(models) });
    }
    return onGenerate(route, body);
  });
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

/* 1 — with the day's runs gone, nothing is even attempted. */
{
  const spent = { used: 25, limit: 25, remaining: 0 };
  const page = await newPage({ quota: spent });
  let attempted = false;
  await stubFunction(page, (route) => {
    attempted = true;
    route.fulfill({
      status: 429,
      headers: quotaHeaders(spent),
      body: JSON.stringify({ error: { message: 'You have used all 25 of today\'s runs.' }, code: 'daily_limit' }),
    });
  }, { quota: spent });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

  // The callout explains it before the seller has touched anything.
  if (!(await page.locator('#quota-spent').isVisible())) {
    problems.push('no explanation shown when the day\'s runs are gone');
  }
  await seedPhoto(page);
  if (!(await page.locator('#analyze-btn').isDisabled())) {
    problems.push('Analyse stayed enabled with no runs left');
  }
  await page.waitForTimeout(400);
  if (attempted) problems.push('a generation was attempted with no runs left');
  console.log('  ✓ no runs left disables the button and sends nothing');
  await page.close();
}

/* 1b — a cap reached mid-session is reported and not retried.
 *
 * 429 normally means "wait and try again", and the app does retry those. The
 * cap uses the same status but carries a code, and must fail immediately: no
 * amount of retrying produces another run today. */
{
  const page = await newPage();
  let calls = 0;
  const spent = { used: 25, limit: 25, remaining: 0 };
  await stubFunction(page, (route) => {
    calls += 1;
    route.fulfill({
      status: 429,
      headers: quotaHeaders(spent),
      body: JSON.stringify({
        error: { message: 'You have used all 25 of today\'s runs. They reset tomorrow morning.' },
        code: 'daily_limit',
      }),
    });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForFunction(() => !document.getElementById('app-error').hidden, { timeout: 8000 });

  const msg = await page.locator('#app-error').textContent();
  if (!msg.includes('reset tomorrow')) problems.push(`cap message unhelpful: ${msg}`);
  if (calls !== 1) problems.push(`the cap was retried ${calls} times; it must fail immediately`);
  // And the refusal itself updates the count, so the buttons lock straight away.
  await page.waitForSelector('#quota-spent:not([hidden])', { timeout: 3000 });
  if (!(await page.locator('#analyze-btn').isDisabled())) {
    problems.push('Analyse stayed enabled after the cap was hit');
  }
  console.log('  ✓ hitting the cap fails fast, explains itself, and locks the buttons');
  await page.close();
}

/* 2 — a request Gemini refuses must say so in plain language and not retry. */
{
  const page = await newPage();
  let calls = 0;
  await stubFunction(page, (route) => {
    calls += 1;
    route.fulfill({
      status: 400,
      headers: quotaHeaders(),
      body: JSON.stringify({ error: { message: 'Invalid argument: contents is required.' } }),
    });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForFunction(() => !document.getElementById('app-error').hidden, { timeout: 8000 });
  const msg = await page.locator('#app-error').textContent();
  if (!msg.includes('rejected')) problems.push(`bad-key message unhelpful: ${msg}`);
  if (calls !== 1) problems.push(`a 400 was retried ${calls} times; should fail fast`);
  if (!(await page.locator('#busy').isHidden())) problems.push('busy overlay stuck after error');
  console.log('  ✓ a rejected request fails fast with a clear message, overlay clears');
  await page.close();
}

/* 3 — 429 retries, then succeeds. */
{
  const page = await newPage();
  let calls = 0;
  await stubFunction(page, (route) => {
    calls += 1;
    if (calls === 1) {
      // Google's own rate limit, with no cap code — the retryable kind.
      return route.fulfill({ status: 429, headers: quotaHeaders(), body: JSON.stringify({ error: { message: 'Quota exceeded' } }) });
    }
    route.fulfill({
      status: 200, headers: quotaHeaders(),
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
  await stubFunction(page, async () => {
    /* the generation never resolves, so cancel has something to abort */
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
  await stubFunction(page, (route) => {
    route.fulfill({
      status: 200,
      headers: quotaHeaders(),
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'this is not json at all' }] }, finishReason: 'STOP' }] }),
    });
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
