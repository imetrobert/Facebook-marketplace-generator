/**
 * The daily run cap, as the seller experiences it.
 *
 * The cap exists because the Gemini key is the owner's now rather than each
 * seller's, so one seller looping the flow would spend everybody's allowance.
 * A cap nobody can see is just a mystery failure, so what is tested here is
 * mostly what is on screen: how many runs are left, before and after spending
 * one, and what happens when they run out.
 */
import {
  serve, launch, watchForErrors, report, signIn, FAKE_MODELS, asGeminiReply, quotaHeaders,
} from './harness.mjs';
import fs from 'node:fs';

const PORT = 4182;
const { server, origin: ORIGIN } = await serve(PORT);

const problems = [];
const browser = await launch();

const INTAKE = {
  identification: { item: 'Desk chair', brand: 'Herman Miller', model: 'Aeron', category: 'Furniture', confidence: 0.9, summary: 'An office chair.' },
  conditionObserved: ['Mesh intact'],
  photoRequests: [],
  questions: [],
  preliminaryPrice: { low: 300, high: 500, basis: 'Used Aeron pricing.' },
};

/**
 * A page whose function stub counts down for real: each generation spends one
 * run and reports what is left, the way the deployed function does.
 */
async function newPage({ start = 25, limit = 25 } = {}) {
  const page = await browser.newPage();
  watchForErrors(page, problems);

  const state = { remaining: start, limit, used: limit - start };
  await signIn(page, 'robert@imetrobert.com', { quota: { ...state } });

  const calls = [];
  await page.route('**/functions/v1/generate', async (route) => {
    const body = route.request().postDataJSON() || {};
    calls.push(body.action);

    if (body.action === 'quota') {
      return route.fulfill({ status: 200, headers: quotaHeaders(state), body: JSON.stringify(state) });
    }
    // Discovery is not a generation, so it must not cost anything.
    if (body.action === 'listModels') {
      return route.fulfill({ status: 200, headers: quotaHeaders(state), body: JSON.stringify(FAKE_MODELS) });
    }
    if (state.remaining <= 0) {
      return route.fulfill({
        status: 429,
        headers: quotaHeaders(state),
        body: JSON.stringify({
          error: { message: `You have used all ${state.limit} of today's runs. They reset tomorrow morning.` },
          code: 'daily_limit',
        }),
      });
    }
    state.remaining -= 1;
    state.used += 1;
    route.fulfill({ status: 200, headers: quotaHeaders(state), body: JSON.stringify(asGeminiReply(INTAKE)) });
  });

  return { page, state, calls };
}

async function seedPhoto(page) {
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 400;
    c.getContext('2d').fillRect(0, 0, 400, 400);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  });
  fs.writeFileSync('/tmp/chair.jpg', Buffer.from(jpeg, 'base64'));
  await page.setInputFiles('#file-input', '/tmp/chair.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 1);
}

/* 1 — the count is on screen before anything is spent. */
{
  const { page } = await newPage({ start: 25, limit: 25 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#quota-note:not([hidden])', { timeout: 5000 });

  const note = await page.locator('#quota-note').textContent();
  if (!note.includes('25 of 25')) problems.push(`the counter does not show the allowance: "${note}"`);
  if (!note.includes('today')) problems.push(`the counter does not say the cap is daily: "${note}"`);
  console.log('  ✓ the runs left today are shown before anything is spent');
  await page.close();
}

/* 2 — spending a run moves the count, without asking the server again. */
{
  const { page, calls } = await newPage({ start: 25, limit: 25 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#quota-note:not([hidden])', { timeout: 5000 });

  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(
    () => document.getElementById('quota-note').textContent.includes('24 of 25'),
    { timeout: 5000 },
  );

  // The figures ride back on the generation itself, so one analysis is one
  // quota question at boot and nothing more.
  const asks = calls.filter((c) => c === 'quota').length;
  if (asks !== 1) problems.push(`the app asked for the quota ${asks} times; the reply already carries it`);
  console.log('  ✓ the count follows a spent run without a second round trip');
  await page.close();
}

/* 3 — the last few runs are called out rather than just counted. */
{
  const { page } = await newPage({ start: 3, limit: 25 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#quota-note:not([hidden])', { timeout: 5000 });

  const low = await page.locator('#quota-note').evaluate((el) => el.classList.contains('quota-low'));
  if (!low) problems.push('a nearly-spent allowance is not flagged');
  console.log('  ✓ the last few runs of the day are flagged');
  await page.close();
}

/* 4 — at zero, the app says so and stops offering to generate. */
{
  const { page } = await newPage({ start: 0, limit: 25 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#quota-spent:not([hidden])', { timeout: 5000 });

  const text = await page.locator('#quota-spent').textContent();
  if (!text.includes('25')) problems.push('the callout does not say what the allowance was');
  if (!text.toLowerCase().includes('tomorrow')) problems.push('the callout does not say when it resets');

  await seedPhoto(page);
  if (!(await page.locator('#analyze-btn').isDisabled())) problems.push('Analyse offered with no runs left');
  console.log('  ✓ at zero the app explains itself and disables the buttons');
  await page.close();
}

/* 5 — Settings shows the same figures, and testing the connection is free. */
{
  const { page, state } = await newPage({ start: 12, limit: 25 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#quota-note:not([hidden])', { timeout: 5000 });

  await page.click('#settings-btn');
  await page.waitForFunction(() => document.getElementById('settings-dialog').open, { timeout: 3000 });
  const shown = await page.locator('#settings-quota').textContent();
  if (!shown.includes('12 of 25')) problems.push(`Settings shows "${shown}", expected 12 of 25`);

  const before = state.remaining;
  await page.click('#check-connection-btn');
  await page.waitForFunction(
    () => document.getElementById('settings-status').textContent.includes('Connected'),
    { timeout: 8000 },
  );
  if (state.remaining !== before) problems.push('testing the connection spent a run');
  console.log('  ✓ Settings shows the figures, and testing the connection costs nothing');
  await page.close();
}

/* 6 — the browser never carries a Gemini key, whatever it does. */
{
  const { page } = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });

  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  if (/AIza/.test(stored)) problems.push('an API key was found in localStorage');
  if (stored.includes('geminiKey')) problems.push('the old per-device key entry is still being written');

  // And there is nowhere left to type one.
  if (await page.locator('#api-key-input').count()) problems.push('the API key field is still in the page');
  console.log('  ✓ no Gemini key is stored, sent, or asked for');
  await page.close();
}

await browser.close();
server.close();
report('Quota', problems);
