/**
 * Model discovery: ranking, filtering, caching, the manual override, and
 * recovery when Google retires the model the app was using.
 */
import {
  serve, launch, watchForErrors, report, signIn,
  FAKE_MODELS, BEST_FAKE_MODEL, stubGemini, asGeminiReply, quotaHeaders, DEFAULT_QUOTA,
} from './harness.mjs';
import fs from 'node:fs';

const PORT = 4177;
const { server, origin: ORIGIN } = await serve(PORT);

const problems = [];
const browser = await launch();

const INTAKE = {
  identification: { item: 'Retro game console', brand: 'Game Stick', model: 'Lite 4K', category: 'Video Games & Consoles', confidence: 0.8, summary: 'A plug-and-play retro console.' },
  conditionObserved: ['Box shows two controllers'],
  photoRequests: [],
  questions: [],
  preliminaryPrice: { low: 25, high: 45, basis: 'Common retro stick pricing.' },
};

async function newPage() {
  const page = await browser.newPage();
  watchForErrors(page, problems);
  await signIn(page);
  return page;
}

async function seedPhoto(page) {
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 400;
    c.getContext('2d').fillRect(0, 0, 400, 400);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  });
  fs.writeFileSync('/tmp/console.jpg', Buffer.from(jpeg, 'base64'));
  await page.setInputFiles('#file-input', '/tmp/console.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 1);
}

/** Which model a request asked for. The function takes it in the body now. */
const modelOf = (route) => route.request().postDataJSON()?.model;

/* 1 — ranking picks the newest stable flash model and drops the unusable ones. */
{
  const page = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  const ranked = await page.evaluate(
    async (models) => (await import('/js/gemini.js')).rankModels(models),
    FAKE_MODELS.models,
  );
  const ids = ranked.map((m) => m.id);

  if (ids[0] !== BEST_FAKE_MODEL) problems.push(`ranking chose ${ids[0]}, expected ${BEST_FAKE_MODEL}`);
  for (const bad of ['text-embedding-004', 'imagen-4.0-generate', 'veo-3.0-generate', 'gemma-3-27b-it', 'gemini-3-flash-native-audio']) {
    if (ids.includes(bad)) problems.push(`ranking kept an unusable model: ${bad}`);
  }
  // Newer beats older, and stable beats preview within the same generation.
  if (ids.indexOf('gemini-3-flash') > ids.indexOf('gemini-2.5-flash')) {
    problems.push('an older generation outranked a newer one');
  }
  if (ids.indexOf('gemini-3-flash') > ids.indexOf('gemini-3-flash-preview-11-2026')) {
    problems.push('a preview build outranked the stable release');
  }
  if (ids.indexOf('gemini-3-flash') > ids.indexOf('gemini-3-flash-lite')) {
    problems.push('flash-lite outranked flash');
  }
  console.log(`  ✓ ranking: ${ids.join(' > ')}`);
  await page.close();
}

/* 2 — the ranked winner is the model actually called. */
{
  const page = await newPage();
  const used = [];
  await stubGemini(page, (route) => {
    used.push(modelOf(route));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(asGeminiReply(INTAKE)) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
  if (used[0] !== BEST_FAKE_MODEL) problems.push(`called ${used[0]}, expected ${BEST_FAKE_MODEL}`);
  console.log(`  ✓ discovery picks ${used[0]} with no model name hard-coded`);
  await page.close();
}

/* 3 — the exact failure seen in production recovers instead of surfacing. */
{
  const page = await newPage();
  const used = [];
  // The app has a stale cache naming a model Google has since retired.
  await page.addInitScript(() => {
    localStorage.setItem('fbmg.modelCache', JSON.stringify({
      at: Date.now(),
      key: 'test-key-123',
      ranked: [{ id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', version: 2.5, tier: 'flash', stable: true }],
    }));
  });
  await stubGemini(page, (route) => {
    const model = modelOf(route);
    used.push(model);
    if (model === 'gemini-2.5-flash') {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use a newer model for the latest features and improvements.' } }),
      });
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(asGeminiReply(INTAKE)) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 15000 });

  if (!(await page.locator('#app-error').isHidden())) {
    problems.push(`retired model surfaced an error: ${await page.locator('#app-error').textContent()}`);
  }
  if (used[0] !== 'gemini-2.5-flash') problems.push('the stale cached model was not tried first');
  if (used.at(-1) !== BEST_FAKE_MODEL) problems.push(`recovered onto ${used.at(-1)}, expected ${BEST_FAKE_MODEL}`);
  if (used.filter((m) => m === 'gemini-2.5-flash').length !== 1) {
    problems.push(`retired model was called ${used.filter((m) => m === 'gemini-2.5-flash').length} times; should be tried once`);
  }
  console.log(`  ✓ retired model recovers silently: ${used.join(' → ')}`);

  // The refreshed cache must no longer name the dead model.
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('fbmg.modelCache')).ranked.map((m) => m.id));
  if (cached[0] !== BEST_FAKE_MODEL) problems.push(`cache not refreshed, still starts with ${cached[0]}`);
  console.log('  ✓ the stale cache is replaced, so the next run starts current');
  await page.close();
}

/* 4 — the list is cached rather than re-fetched on every generation. */
{
  const page = await newPage();
  let listCalls = 0;
  await page.route('**/functions/v1/generate', (route) => {
    const action = route.request().postDataJSON()?.action;
    if (action === 'quota') {
      return route.fulfill({ status: 200, headers: quotaHeaders(), body: JSON.stringify(DEFAULT_QUOTA) });
    }
    if (action === 'listModels') {
      listCalls += 1;
      return route.fulfill({ status: 200, headers: quotaHeaders(), body: JSON.stringify(FAKE_MODELS) });
    }
    route.fulfill({ status: 200, headers: quotaHeaders(), body: JSON.stringify(asGeminiReply(INTAKE)) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
  await page.click('#back-to-1');
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
  if (listCalls !== 1) problems.push(`model list fetched ${listCalls} times across two runs; should be cached`);
  console.log('  ✓ the model list is fetched once and cached');
  await page.close();
}

/* 5 — the Settings dropdown lists the usable models and the override is honoured. */
{
  const page = await newPage();
  const used = [];
  await stubGemini(page, (route) => {
    used.push(modelOf(route));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(asGeminiReply(INTAKE)) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

  await page.click('#settings-btn');
  await page.waitForFunction(
    () => document.querySelectorAll('#model-select option').length > 1,
    { timeout: 5000 },
  );
  const options = await page.locator('#model-select option').allTextContents();
  if (!options[0].includes(BEST_FAKE_MODEL)) {
    problems.push(`automatic option should name the winner, got "${options[0]}"`);
  }
  if (options.some((o) => o.includes('imagen') || o.includes('embedding'))) {
    problems.push('unusable models leaked into the dropdown');
  }
  if (!options.some((o) => o.includes('preview'))) {
    problems.push('preview builds should be offered but labelled');
  }
  console.log(`  ✓ dropdown offers ${options.length - 1} usable models, best named in the automatic option`);

  await page.selectOption('#model-select', 'gemini-3-pro');
  await page.click('#save-settings-btn');
  await page.waitForFunction(() => !document.getElementById('settings-dialog').open, { timeout: 3000 });

  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
  if (used[0] !== 'gemini-3-pro') problems.push(`override ignored; called ${used[0]}`);
  console.log('  ✓ a chosen model overrides the automatic pick');
  await page.close();
}

/* 6 — a project key that can reach nothing usable says so rather than failing
 * obscurely. The seller cannot fix this one, so the message names who can. */
{
  const page = await newPage();
  await stubGemini(page, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }), {
    models: { models: [{ name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] },
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await seedPhoto(page);
  await page.click('#analyze-btn');
  await page.waitForFunction(() => !document.getElementById('app-error').hidden, { timeout: 10000 });
  const message = await page.locator('#app-error').textContent();
  if (!message.includes('No usable Gemini models')) {
    problems.push(`unhelpful message when no model can be reached: ${message}`);
  }
  if (!message.includes('Robert Simon')) {
    problems.push('the message does not name who can fix it');
  }
  console.log('  ✓ no reachable model gets a plain explanation naming who to ask');
  await page.close();
}

await browser.close();
server.close();
report('Models', problems);
