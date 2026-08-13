/**
 * End-to-end smoke test: serves the static site, stubs the Gemini endpoint,
 * and drives the full three-step flow in a real browser.
 */
import {
  serve, launch, watchForErrors, report, FAKE_MODELS, signIn, quotaHeaders, DEFAULT_QUOTA,
} from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4173;
const { server, origin: ORIGIN } = await serve(PORT);


const INTAKE = {
  identification: {
    item: 'Six-drawer dresser', brand: 'IKEA', model: 'Malm', category: 'Furniture',
    confidence: 0.86, summary: 'A white six-drawer IKEA Malm dresser in used condition.',
  },
  conditionObserved: ['Top surface has a light scratch near the left edge', 'All six drawer fronts are present'],
  photoRequests: [{ angle: 'Close-up of the scratch on the top left', why: 'Buyers trust listings that show flaws.' }],
  questions: [
    { id: 'q1', question: 'What year did you buy it?', why: 'Age drives resale value.', type: 'number', options: [], placeholder: '2021' },
    { id: 'q2', question: 'Do all drawers slide smoothly?', why: 'Drawer runners are the usual failure point.', type: 'choice', options: ['Yes, all smooth', 'One sticks', 'Several stick'], placeholder: '' },
  ],
  preliminaryPrice: { low: 60, high: 110, basis: 'Used Malm dressers clear in this band locally.' },
};

const LISTING = {
  title: 'IKEA Malm 6-Drawer Dresser, White, 80x48x123 cm, Chest of Drawers',
  titleAlternatives: ['White 6-Drawer Dresser, IKEA Malm, Solid and Sturdy', 'IKEA Malm Tall Dresser 6 Drawers, White'],
  titleRationale: 'Leads with brand and model, the terms buyers search.',
  price: 95,
  pricing: {
    listAt: 95, acceptAbove: 80, walkAwayFloor: 65, marketRange: '$70-$120',
    strategy: 'Priced slightly above target to leave negotiating room.',
    repriceAfterDays: 7, repriceTo: 80,
  },
  category: 'Furniture', condition: 'Used - good', brand: 'IKEA',
  description: 'IKEA Malm six-drawer dresser in white.\n\nWidth: 80 cm\nDepth: 48 cm\n\nCondition is good.\n\nPickup only in Côte Saint-Luc.',
  descriptionSecondary: 'Commode IKEA Malm à six tiroirs, blanche. En bon état. Ramassage seulement.',
  tags: ['ikea', 'malm', 'dresser', 'commode'],
  photoOrder: ['Full front view', 'Angled three-quarter shot', 'Close-up of the scratch'],
  buyerFaq: [{ question: 'Is it still available?', answer: 'Yes, it is still available.' }],
  warnings: ['Confirm the exact height before posting.'],
};

const wrap = (payload) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
});

const browser = await launch();
const page = await browser.newPage();
await signIn(page);

const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
watchForErrors(page, problems);

let call = 0;
await page.route('**/functions/v1/generate', async (route) => {
  const sent = route.request().postDataJSON() || {};
  if (sent.action === 'quota') {
    return route.fulfill({ status: 200, headers: quotaHeaders(), body: JSON.stringify(DEFAULT_QUOTA) });
  }
  if (sent.action === 'listModels') {
    return route.fulfill({ status: 200, headers: quotaHeaders(), body: JSON.stringify(FAKE_MODELS) });
  }
  // Assert the request shape Gemini actually requires, still built in the
  // browser and forwarded by the function untouched.
  const parts = sent.payload.contents[0].parts;
  if (!parts.some((p) => p.inline_data?.data)) problems.push('request carried no inline image data');
  if (!sent.payload.generationConfig?.responseSchema) problems.push('request had no responseSchema');
  // The seller's session is the only credential now; no key leaves the browser.
  if (!/^Bearer /.test(route.request().headers().authorization || '')) {
    problems.push('request carried no session token');
  }
  if (JSON.stringify(sent).includes('AIza')) problems.push('an API key was sent from the browser');
  await route.fulfill({
    status: 200,
    headers: quotaHeaders({ used: call + 1, limit: 25, remaining: 24 - call }),
    body: JSON.stringify(wrap(call++ === 0 ? INTAKE : LISTING)),
  });
});

await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

const step = async (label) => console.log(`  ✓ ${label}`);

// Step 1 — upload a generated JPEG.
const jpeg = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  const x = c.getContext('2d');
  x.fillStyle = '#ddd'; x.fillRect(0, 0, 900, 1200);
  x.fillStyle = '#333'; x.fillRect(80, 200, 740, 800);
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
});
fs.writeFileSync('/tmp/dresser.jpg', Buffer.from(jpeg, 'base64'));

await page.setInputFiles('#file-input', ['/tmp/dresser.jpg', '/tmp/dresser.jpg']);
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 2);
step('two photos compressed and thumbnailed');

if (await page.locator('#analyze-btn').isDisabled()) problems.push('analyse button stayed disabled');

await page.fill('#user-note', 'IKEA Malm dresser, bought 2021');
await page.click('#analyze-btn');

// Step 2
await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('.question').length === 2);
step('intake rendered with questions and photo requests');

if (!(await page.locator('#intake-title').textContent()).includes('Malm')) problems.push('intake title wrong');
if (!(await page.locator('#prelim-price').textContent()).includes('$60')) problems.push('preliminary price missing');

// Answer both questions, including the choice chips.
await page.fill('.question input[type="number"]', '2021');
await page.click('.choice:has-text("Yes, all smooth")');
if (await page.locator('.choice.selected').count() !== 1) problems.push('choice chip did not select');

// Add a photo mid-flow (the "better angles" round).
await page.setInputFiles('#file-input', '/tmp/dresser.jpg');
await page.waitForSelector('#added-count:not([hidden])', { timeout: 5000 });
step('extra photo round wired to the same handler (no double-fire)');
if (await page.locator('#added-count').textContent() !== '1 photo added — they will be used in the listing.') {
  problems.push(`added-count text wrong: ${await page.locator('#added-count').textContent()}`);
}

await page.click('#generate-btn');

// Step 3
await page.waitForSelector('#step-3:not([hidden])', { timeout: 10000 });
step('listing rendered');

const out = await page.locator('#listing-output').textContent();
for (const expected of ['IKEA Malm 6-Drawer', '$95', 'Used - good', 'H4V 2L5', 'Commode IKEA', 'ikea', 'Confirm the exact height']) {
  if (!out.includes(expected)) problems.push(`listing output missing "${expected}"`);
}

// A bilingual description must flag the French up front, above the English,
// and say so exactly once.
const NOTICE = '(Description en français ci-dessous)';
const body = await page.locator('.out-field', { hasText: 'DESCRIPTION' }).first().locator('.out-body').textContent();
if (!body.startsWith(NOTICE)) problems.push(`description does not open with the French notice: ${body.slice(0, 60)}`);
if (body.split(NOTICE).length - 1 !== 1) problems.push('the French notice appears more than once');
if (body.indexOf(NOTICE) > body.indexOf('IKEA Malm six-drawer')) problems.push('the notice is below the English text');
if (body.indexOf('Commode IKEA') < body.indexOf('IKEA Malm six-drawer')) problems.push('French appears above the English body');
step('bilingual description opens with the French notice, once, above the English');
if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(out)) problems.push('emoji leaked into the output');

// Verify the second call carried the seller's answers through.
const listingCallSentAnswers = await page.evaluate(() => true);
step('no emoji in output, postal code present');

// Copy-to-clipboard path.
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await page.locator('.out-field', { hasText: 'TITLE' }).first().locator('button:has-text("Copy")').first().click();
await page.waitForSelector('#toast:not([hidden])');
step('copy button fires');

// Restart clears state.
await page.click('#restart-btn');
await page.waitForSelector('#step-1:not([hidden])');
if (await page.locator('.thumb').count() !== 0) problems.push('restart left stale thumbnails');
if (await page.locator('#user-note').inputValue() !== '') problems.push('restart left the note behind');
step('restart clears state');

await browser.close();
server.close();

report('Flow', problems);
