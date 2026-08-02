/**
 * Guided paste: the one-field-at-a-time flow used on a phone.
 *
 * The thing that must not break is the loop — copy, switch to Facebook, paste,
 * come back to the *next* field — so most of these checks are about ordering,
 * advancing, and what actually lands on the clipboard.
 */
import {
  serve, launch, watchForErrors, report, signIn,
  stubGemini, asGeminiReply,
} from './harness.mjs';
import fs from 'node:fs';

const PORT = 4181;
const { server, origin: ORIGIN } = await serve(PORT);

const problems = [];
const browser = await launch();

const INTAKE = {
  identification: { item: 'Dresser', brand: 'IKEA', model: 'Malm', category: 'Furniture', confidence: 0.9, summary: 'A dresser.' },
  conditionObserved: [], photoRequests: [], questions: [],
  preliminaryPrice: { low: 60, high: 110, basis: 'Local range.' },
};

const LISTING = {
  title: 'IKEA Malm 6-Drawer Dresser, White, 80x48x123 cm',
  titleAlternatives: ['White 6-Drawer Dresser, IKEA Malm'],
  titleRationale: 'Brand first.',
  price: 95,
  pricing: { listAt: 95, acceptAbove: 80, walkAwayFloor: 65, marketRange: '$70-$120', strategy: 'Room to move.', repriceAfterDays: 7, repriceTo: 80 },
  category: 'Furniture', condition: 'Used - good', brand: 'IKEA',
  description: 'IKEA Malm six-drawer dresser in white.\n\nPickup only in Côte Saint-Luc.',
  descriptionFr: 'Commode IKEA Malm à six tiroirs, blanche.',
  tags: ['ikea', 'malm', 'dresser'],
  photoOrder: ['Full front view', 'Angled three-quarter shot', 'Close-up of the scratch'],
  buyerFaq: [], warnings: [],
};

async function openListing({ listing = LISTING } = {}) {
  const page = await browser.newPage();
  watchForErrors(page, problems);
  await signIn(page);
  await page.addInitScript(() => localStorage.setItem('fbmg.geminiKey', 'test-key-123'));
  await stubGemini(page, (route) => {
    const text = route.request().postDataJSON().contents[0].parts.find((p) => p.text)?.text || '';
    const isListing = text.includes('HOW TO WRITE THE TITLE');
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(asGeminiReply(isListing ? listing : INTAKE)),
    });
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 300;
    c.getContext('2d').fillRect(0, 0, 300, 300);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  });
  fs.writeFileSync('/tmp/guided.jpg', Buffer.from(jpeg, 'base64'));
  await page.setInputFiles('#file-input', '/tmp/guided.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 1);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
  await page.click('#generate-btn');
  await page.waitForSelector('#step-3:not([hidden])', { timeout: 10000 });
  return page;
}

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const label = (page) => page.locator('#guided-label').textContent();

/* 1 — the steps follow Facebook's own form order. */
{
  const page = await openListing();
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');

  if (await page.locator('#listing-view').isVisible()) {
    problems.push('the full list is still shown while guided paste is running');
  }

  const seen = [];
  for (let i = 0; i < 20; i += 1) {
    if (await page.locator('#guided-done').isVisible()) break;
    seen.push((await label(page)).trim());
    await page.click('#guided-skip-btn');
  }

  // This order is taken from the Marketplace app's own New listing form.
  // There is no Brand field on it, so there is no Brand step.
  const expected = [
    'Add your photos', 'Title', 'Price', 'Category', 'Condition',
    'Description', 'Location', 'Tags', 'Set the meetup preference',
  ];
  if (seen.join(' > ') !== expected.join(' > ')) {
    problems.push(`step order wrong:\n    got      ${seen.join(' > ')}\n    expected ${expected.join(' > ')}`);
  }
  console.log(`  ✓ steps follow the Marketplace form order (${seen.length} of them)`);

  if (!(await page.locator('#guided-done').isVisible())) problems.push('never reached the finish screen');
  console.log('  ✓ walking to the end reaches a finish screen');
  await page.close();
}

/* 2 — copying advances, and puts the right thing on the clipboard. */
{
  const page = await openListing();
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');

  // Photos first: nothing to copy, so the button just moves on.
  if ((await page.locator('#guided-copy-btn').textContent()).trim() !== 'Done, continue') {
    problems.push('the photo step offers a copy button despite having nothing to copy');
  }
  await page.click('#guided-copy-btn');
  if ((await label(page)).trim() !== 'Title') problems.push('the photo step did not advance');

  await page.click('#guided-copy-btn');
  if ((await clipboard(page)) !== LISTING.title) problems.push('the title was not copied');
  if ((await label(page)).trim() !== 'Price') problems.push('copying the title did not advance to Price');
  console.log('  ✓ copy puts the field on the clipboard and moves straight on');

  // Price must copy as a bare number, not "$95".
  const shown = await page.locator('#guided-value').textContent();
  await page.click('#guided-copy-btn');
  const copied = await clipboard(page);
  if (copied !== '95') problems.push(`price copied as "${copied}", expected the bare number`);
  if (!shown.includes('$95')) problems.push(`price shown as "${shown}", expected a readable amount`);
  console.log('  ✓ price shows as $95 but copies as 95, which is what the field accepts');
  await page.close();
}

/* 3 — the description carries the notice and the translation, as one paste. */
{
  const page = await openListing();
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');
  for (let i = 0; i < 12; i += 1) {
    if ((await label(page)).trim() === 'Description') break;
    await page.click('#guided-skip-btn');
  }
  await page.click('#guided-copy-btn');
  const copied = await clipboard(page);
  if (!copied.startsWith('(Description en français ci-dessous)')) {
    problems.push('the description copy is missing the heads-up line');
  }
  if (!copied.includes('Commode IKEA')) problems.push('the description copy is missing the French summary');
  if (!copied.includes('IKEA Malm six-drawer')) problems.push('the description copy is missing the English body');
  console.log('  ✓ the description copies as one block: notice, English, translation');
  await page.close();
}

/* 4 — Back, Skip and Exit behave. */
{
  const page = await openListing();
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');

  if (!(await page.locator('#guided-back-btn').isDisabled())) {
    problems.push('Back is available on the first step');
  }
  await page.click('#guided-skip-btn');
  await page.click('#guided-skip-btn');
  if ((await label(page)).trim() !== 'Price') problems.push('skipping twice did not land on Price');
  await page.click('#guided-back-btn');
  if ((await label(page)).trim() !== 'Title') problems.push('Back did not return to Title');
  console.log('  ✓ Back and Skip move one step at a time');

  await page.click('#guided-exit-btn');
  if (!(await page.locator('#listing-view').isVisible())) problems.push('Exit did not restore the full list');
  if (await page.locator('#guided').isVisible()) problems.push('the guided panel stayed visible after Exit');

  // Re-entering starts from the top rather than where it was left.
  await page.click('#guided-start-btn');
  if ((await label(page)).trim() !== 'Add your photos') problems.push('re-entering did not start from the first step');
  console.log('  ✓ Exit restores the full list, and re-entering starts fresh');
  await page.close();
}

/* 5 — progress is honest. */
{
  const page = await openListing();
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');

  const first = await page.locator('#guided-progress').textContent();
  if (first.trim() !== '1 of 9') problems.push(`progress read "${first}", expected "1 of 9"`);
  const startWidth = await page.locator('#guided-bar-fill').evaluate((el) => el.style.width);
  await page.click('#guided-skip-btn');
  const nextWidth = await page.locator('#guided-bar-fill').evaluate((el) => el.style.width);
  if (parseFloat(nextWidth) <= parseFloat(startWidth || '0')) problems.push('the progress bar did not move');
  console.log('  ✓ the counter and bar track real progress');
  await page.close();
}

/* 6 — optional fields drop out rather than showing empty steps. */
{
  const page = await openListing({
    listing: { ...LISTING, brand: '', tags: [], photoOrder: [], descriptionFr: '' },
  });
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');

  const seen = [];
  for (let i = 0; i < 20; i += 1) {
    if (await page.locator('#guided-done').isVisible()) break;
    seen.push((await label(page)).trim());
    await page.click('#guided-skip-btn');
  }
  const expected = ['Title', 'Price', 'Category', 'Condition', 'Description', 'Location', 'Set the meetup preference'];
  if (seen.join(' > ') !== expected.join(' > ')) {
    problems.push(`empty fields were not dropped: ${seen.join(' > ')}`);
  }
  console.log('  ✓ absent tags and photo order produce no empty steps');
  await page.close();
}

/* 7 — it fits the phone it was built for. */
{
  const page = await browser.newPage({ viewport: { width: 320, height: 780 } });
  watchForErrors(page, problems);
  await signIn(page);
  await page.addInitScript(() => localStorage.setItem('fbmg.geminiKey', 'test-key-123'));
  await stubGemini(page, (route) => {
    const text = route.request().postDataJSON().contents[0].parts.find((p) => p.text)?.text || '';
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(asGeminiReply(text.includes('HOW TO WRITE THE TITLE') ? LISTING : INTAKE)),
    });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', '/tmp/guided.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 1);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
  await page.click('#generate-btn');
  await page.waitForSelector('#step-3:not([hidden])', { timeout: 10000 });
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');

  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) {
    problems.push('guided paste makes a 320px screen scroll sideways');
  }
  const box = await page.locator('#guided-copy-btn').boundingBox();
  if (!box || box.height < 48) problems.push(`the main button is only ${Math.round(box?.height || 0)}px tall`);
  if (box && (box.x < 0 || box.x + box.width > 320)) problems.push('the main button sits off screen');
  console.log(`  ✓ fits a 320px screen with a ${Math.round(box.height)}px tap target`);
  await page.close();
}

/* 8 — location copies what the Marketplace search box actually matches. */
{
  const page = await openListing();
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');
  for (let i = 0; i < 12; i += 1) {
    if ((await label(page)).trim() === 'Location') break;
    await page.click('#guided-skip-btn');
  }

  const shown = await page.locator('#guided-value').textContent();
  if (!shown.includes('Côte Saint-Luc') || !shown.includes('H4V 2L5')) {
    problems.push(`location should show the full address for checking, saw "${shown}"`);
  }
  await page.click('#guided-copy-btn');
  const copied = await clipboard(page);
  if (copied !== 'H4V') {
    problems.push(`location copied "${copied}"; the field searches on the first part of the code only`);
  }
  console.log('  ✓ location shows the full code but copies H4V, which is what the search matches');
  await page.close();
}

/* 9 — a seller who delivers gets no pickup-only instruction. */
{
  const page = await openListing();
  await page.evaluate(() => {
    const key = 'fbmg.profile:rsimonmtl@gmail.com';
    const p = JSON.parse(localStorage.getItem(key) || '{}');
    p.logistics = { ...(p.logistics || {}), pickupOnly: false };
    localStorage.setItem(key, JSON.stringify(p));
  });
  await page.route('**/rest/v1/profiles**', (route) => route.abort());
  await page.reload({ waitUntil: 'networkidle' });

  // Regenerate so a listing exists on the reloaded page.
  await page.setInputFiles('#file-input', '/tmp/guided.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 1);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
  await page.click('#generate-btn');
  await page.waitForSelector('#step-3:not([hidden])', { timeout: 10000 });
  await page.click('#guided-start-btn');
  await page.waitForSelector('#guided:not([hidden])');

  const seen = [];
  for (let i = 0; i < 20; i += 1) {
    if (await page.locator('#guided-done').isVisible()) break;
    seen.push((await label(page)).trim());
    await page.click('#guided-skip-btn');
  }
  if (seen.includes('Set the meetup preference')) {
    problems.push('a seller who delivers was told to tick Door pickup');
  }
  console.log('  ✓ the pickup-only instruction only appears for pickup-only sellers');
  await page.close();
}

await browser.close();
server.close();

report('Guided', problems);
