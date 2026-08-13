/**
 * Follow-up questions: the Unknown and Other options added to every choice
 * question, and how each one reaches the listing prompt.
 */
import {
  serve, launch, watchForErrors, report, signIn,
  FAKE_MODELS, stubGemini, asGeminiReply,
} from './harness.mjs';
import fs from 'node:fs';

const PORT = 4178;
const { server, origin: ORIGIN } = await serve(PORT);

const problems = [];
const browser = await launch();

const Q_CARD = 'What storage size is printed on the included micro SD card?';
const Q_BATT = 'Are batteries included for both wireless controllers?';
const Q_BOX = 'Is the original packaging or box included?';

const INTAKE = {
  identification: { item: 'Retro games console', brand: 'Game Stick', model: 'Lite 4K', category: 'Video Games & Consoles', confidence: 0.85, summary: 'A plug-and-play retro console.' },
  conditionObserved: ['Powers on with green indicator light'],
  photoRequests: [],
  questions: [
    { id: 'q1', question: Q_CARD, why: 'Capacity drives value.', type: 'choice', options: ['32 GB', '64 GB', '128 GB', 'No card included'], placeholder: '' },
    { id: 'q2', question: Q_BATT, why: 'Saves messaging.', type: 'choice', options: ['Yes, included', 'No, requires AAA batteries'], placeholder: '' },
    { id: 'q3', question: Q_BOX, why: 'Boxed items sell faster.', type: 'choice', options: ['Yes, full original box', 'No, unit only'], placeholder: '' },
  ],
  preliminaryPrice: { low: 25, high: 40, basis: 'Local retro bundle pricing.' },
};

const LISTING = {
  title: 'Game Stick Lite 4K Retro Console with Two Wireless Controllers',
  titleAlternatives: ['Retro Games Console, Game Stick Lite 4K, 2 Controllers'],
  titleRationale: 'Names the product and the headline inclusion.',
  price: 30,
  pricing: { listAt: 30, acceptAbove: 25, walkAwayFloor: 20, marketRange: '$25-$40', strategy: 'Room to move.', repriceAfterDays: 7, repriceTo: 25 },
  category: 'Video Games & Consoles', condition: 'Used - good', brand: 'Game Stick',
  description: 'Game Stick Lite 4K retro console.\n\nPickup only.',
  descriptionSecondary: '', tags: ['retro', 'console'], photoOrder: ['Console and controllers'],
  buyerFaq: [], warnings: [],
};

let listingPrompts = [];

async function newPage() {
  const page = await browser.newPage();
  watchForErrors(page, problems);
  await signIn(page);
  await stubGemini(page, (route) => {
    const text = (route.request().postDataJSON().payload.contents[0].parts.find((p) => p.text)?.text) || '';
    const isListing = text.includes('HOW TO WRITE THE TITLE');
    if (isListing) listingPrompts.push(text);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(asGeminiReply(isListing ? LISTING : INTAKE)),
    });
  });
  return page;
}

async function toQuestions(page) {
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 400;
    c.getContext('2d').fillRect(0, 0, 400, 400);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  });
  fs.writeFileSync('/tmp/stick.jpg', Buffer.from(jpeg, 'base64'));
  await page.setInputFiles('#file-input', '/tmp/stick.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 1);
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-2:not([hidden])', { timeout: 10000 });
}

/** The chips of the nth question block. */
const chipsOf = (page, n) => page.locator('.question').nth(n).locator('.choice');
/** One chip by its exact label, so tests do not depend on chip ordering. */
const chip = (page, n, label) =>
  page.locator('.question').nth(n).getByRole('button', { name: label, exact: true });

/* 1 — every choice question gains exactly one Unknown and one Other. */
{
  const page = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await toQuestions(page);

  for (const [index, expected] of [4, 2, 2].entries()) {
    const labels = await chipsOf(page, index).allTextContents();
    if (labels.length !== expected + 2) {
      problems.push(`question ${index + 1} has ${labels.length} chips, expected ${expected + 2}`);
    }
    if (labels.filter((l) => l === 'Unknown').length !== 1) problems.push(`question ${index + 1} missing a single Unknown chip`);
    if (labels.filter((l) => l === 'Other').length !== 1) problems.push(`question ${index + 1} missing a single Other chip`);
    if (labels.at(-2) !== 'Unknown' || labels.at(-1) !== 'Other') {
      problems.push(`question ${index + 1} chip order wrong: ${labels.join(', ')}`);
    }
  }
  console.log('  ✓ every choice question gains Unknown and Other, after the real options');

  // The free-text box stays hidden until Other is chosen.
  if (await page.locator('.question').first().locator('.other-input').isVisible()) {
    problems.push('the Other text box is visible before Other is selected');
  }
  console.log('  ✓ the Other text box is hidden until it is needed');
  await page.close();
}

/* 2 — Unknown, Other and a plain option each reach the prompt correctly. */
{
  listingPrompts = [];
  const page = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await toQuestions(page);

  // Q1: an answer the model never offered.
  await chip(page, 0, 'Other').click();
  const otherBox = page.locator('.question').nth(0).locator('.other-input');
  await otherBox.waitFor({ state: 'visible', timeout: 3000 });
  await otherBox.fill('256 GB');

  // Q2: a normal option.
  await chip(page, 1, 'Yes, included').click();

  // Q3: genuinely does not know.
  await chip(page, 2, 'Unknown').click();

  await page.click('#generate-btn');
  await page.waitForSelector('#step-3:not([hidden])', { timeout: 10000 });

  const prompt = listingPrompts[0] || '';
  if (!prompt.includes(`${Q_CARD}\n  Seller's answer: 256 GB`)) {
    problems.push('the Other free-text answer did not reach the prompt');
  }
  if (!prompt.includes(`${Q_BATT}\n  Seller's answer: Yes, included`)) {
    problems.push('a normal option did not reach the prompt');
  }
  if (!prompt.includes('DOES NOT KNOW')) problems.push('the unknown section is missing from the prompt');
  if (!prompt.includes(Q_BOX)) problems.push('the unknown question is not named in the prompt');
  // An unknown must never look like an answer.
  if (prompt.includes(`${Q_BOX}\n  Seller's answer:`)) {
    problems.push('an unknown was passed through as if it were an answer');
  }
  if (!prompt.includes('Do not state a value')) problems.push('the unknown-handling instructions are missing');
  console.log('  ✓ Other, a plain option, and Unknown each reach the prompt distinctly');

  // Payment must be instructed in full, never just one method.
  if (!prompt.includes('cash or Interac e-Transfer')) {
    problems.push('the prompt does not require cash or Interac to be stated');
  }
  // Collapse the prompt's line wrapping so the check does not depend on it.
  const flat = prompt.replace(/\s+/g, ' ');
  if (!flat.includes('State every payment method every time')) {
    problems.push('the prompt does not insist on stating every payment method');
  }
  if (!flat.includes('Do not offer any payment method not listed above')) {
    problems.push('the prompt does not rule out unlisted payment methods');
  }
  console.log('  ✓ the prompt requires both cash and Interac to be stated');

  // This listing has no French, so the notice must not appear.
  const body = await page.locator('.out-field', { hasText: 'DESCRIPTION' }).first().locator('.out-body').textContent();
  if (body.includes('français')) problems.push('the French notice appeared on an English-only listing');
  console.log('  ✓ no French notice when the listing is English-only');
  await page.close();
}

/* 3 — with nothing marked unknown, the extra instructions stay out of the prompt. */
{
  listingPrompts = [];
  const page = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await toQuestions(page);
  await chip(page, 0, '64 GB').click();
  await page.click('#generate-btn');
  await page.waitForSelector('#step-3:not([hidden])', { timeout: 10000 });

  const prompt = listingPrompts[0] || '';
  if (prompt.includes('DOES NOT KNOW')) {
    problems.push('unknown-handling instructions leaked in when nothing was marked unknown');
  }
  console.log('  ✓ the unknown instructions appear only when something is actually unknown');
  await page.close();
}

/* 4 — the chips behave like a single-choice group. */
{
  const page = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await toQuestions(page);
  await chip(page, 0, '32 GB').click();
  await chip(page, 0, 'Unknown').click();           // replaces the previous pick
  if (await page.locator('.question').nth(0).locator('.choice.selected').count() !== 1) {
    problems.push('two chips selected at once');
  }
  const selected = await page.locator('.question').nth(0).locator('.choice.selected').textContent();
  if (selected !== 'Unknown') problems.push(`selection did not move, still on ${selected}`);

  // Choosing Other after Unknown reveals the box; going back hides it again.
  await chip(page, 0, 'Other').click();
  const box = page.locator('.question').nth(0).locator('.other-input');
  await box.waitFor({ state: 'visible', timeout: 3000 });
  await chip(page, 0, '32 GB').click();
  if (await box.isVisible()) problems.push('the Other box stayed open after another option was chosen');

  // Tapping the selected chip again clears it.
  await chip(page, 0, '32 GB').click();
  if (await page.locator('.question').nth(0).locator('.choice.selected').count() !== 0) {
    problems.push('tapping the selected chip did not clear it');
  }
  console.log('  ✓ chips act as one group: Unknown, Other and clearing all behave');
  await page.close();
}

/* 5 — Skip clears an Unknown rather than reporting it. */
{
  listingPrompts = [];
  const page = await newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await toQuestions(page);
  await chip(page, 2, 'Unknown').click();
  await page.click('#skip-questions-btn');
  await page.waitForSelector('#step-3:not([hidden])', { timeout: 10000 });

  const prompt = listingPrompts[0] || '';
  if (prompt.includes('DOES NOT KNOW')) problems.push('Skip still reported an unknown');
  if (!prompt.includes('did not answer any of the questions')) {
    problems.push('Skip did not tell the model the questions went unanswered');
  }
  console.log('  ✓ Skip clears selections rather than reporting them as unknown');
  await page.close();
}

await browser.close();
server.close();

report('Questions', problems);
