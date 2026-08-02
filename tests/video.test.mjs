/**
 * Video-path test: records a real clip in the browser, feeds it through the
 * app's file input, and checks that it is sampled into still frames and that
 * the seller's answers reach the second Gemini call.
 */
import { serve, launch, watchForErrors, report, FAKE_MODELS, signIn } from './harness.mjs';
import fs from 'node:fs';

const PORT = 4174;
const { server, origin: ORIGIN } = await serve(PORT);


const INTAKE = {
  identification: { item: 'Road bike', brand: 'Trek', model: 'FX 2', category: 'Bicycles', confidence: 0.8, summary: 'A hybrid bike.' },
  conditionObserved: ['Tyres inflated'],
  photoRequests: [],
  questions: [{ id: 'q1', question: 'What frame size is it?', why: 'Bike buyers filter on size.', type: 'text', options: [], placeholder: '54 cm' }],
  preliminaryPrice: { low: 200, high: 350, basis: 'Local hybrid bike range.' },
};
const LISTING = {
  title: 'Trek FX 2 Hybrid Bike, 54 cm Frame, Tuned and Ready to Ride',
  titleAlternatives: ['Trek FX 2 Hybrid Commuter Bike, 54 cm'],
  titleRationale: 'Brand-first.',
  price: 300,
  pricing: { listAt: 300, acceptAbove: 260, walkAwayFloor: 220, marketRange: '$250-$350', strategy: 'Room to negotiate.', repriceAfterDays: 10, repriceTo: 265 },
  category: 'Bicycles', condition: 'Used - good', brand: 'Trek',
  description: 'Trek FX 2 hybrid bike.\n\nFrame: 54 cm\n\nPickup only.',
  descriptionFr: '', tags: ['trek', 'bike'], photoOrder: ['Side profile'],
  buyerFaq: [], warnings: [],
};
const wrap = (p) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(p) }] }, finishReason: 'STOP' }] });

const browser = await launch();
const page = await browser.newPage();
await signIn(page);
const problems = [];
watchForErrors(page, problems);

let imageCounts = [];
let listingPrompts = [];
let call = 0;
await page.route('**/generativelanguage.googleapis.com/**', async (route) => {
  if (route.request().method() === 'GET') {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MODELS) });
  }
  const sent = route.request().postDataJSON();
  const parts = sent.contents[0].parts;
  imageCounts.push(parts.filter((p) => p.inline_data).length);
  const text = parts.find((p) => p.text)?.text || '';
  if (text.includes('HOW TO WRITE THE TITLE')) listingPrompts.push(text);
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(wrap(call++ === 0 ? INTAKE : LISTING)) });
});

await page.addInitScript(() => localStorage.setItem('fbmg.geminiKey', 'test-key-123'));
await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

// Record a genuine 3-second webm from an animated canvas.
const webm = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 480;
  const ctx = c.getContext('2d');
  const stream = c.captureStream(15);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start();
  for (let i = 0; i < 45; i++) {
    ctx.fillStyle = `hsl(${i * 8}, 60%, 55%)`;
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#111';
    ctx.font = '64px sans-serif';
    ctx.fillText(`f${i}`, 40, 240);
    await new Promise((r) => setTimeout(r, 33));
  }
  rec.stop();
  const blob = await new Promise((r) => { rec.onstop = () => r(new Blob(chunks, { type: 'video/webm' })); });
  const buf = new Uint8Array(await blob.arrayBuffer());
  return btoa(Array.from(buf, (b) => String.fromCharCode(b)).join(''));
});
fs.writeFileSync('/tmp/walkaround.webm', Buffer.from(webm, 'base64'));
console.log(`  · recorded ${(fs.statSync('/tmp/walkaround.webm').size / 1024).toFixed(0)} KB test video`);

await page.setInputFiles('#file-input', '/tmp/walkaround.webm');
await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 5, { timeout: 20000 });
console.log('  ✓ video sampled into 5 distinct still frames');

if (await page.locator('.thumb-badge').count() !== 5) problems.push('video frames not badged');

// Frames must actually differ — identical frames mean seeking silently failed.
const distinct = await page.evaluate(() =>
  new Set(Array.from(document.querySelectorAll('.thumb img'), (i) => i.src.slice(-400))).size);
if (distinct < 4) problems.push(`frames were not distinct (${distinct}/5 unique) — video seeking failed`);
console.log(`  ✓ ${distinct}/5 frames are visually distinct`);

await page.click('#analyze-btn');
await page.waitForSelector('#step-2:not([hidden])', { timeout: 15000 });

await page.fill('.question input', '54 cm');
await page.click('#generate-btn');
await page.waitForSelector('#step-3:not([hidden])', { timeout: 15000 });
console.log('  ✓ full flow completed from a video-only upload');

const firstListing = listingPrompts[0] || '';
if (!firstListing.includes('54 cm')) problems.push('the seller answer never reached the listing call');
if (!firstListing.includes("Seller's answer")) problems.push('answers block missing from listing prompt');
if (!firstListing.includes('H4V 2L5')) problems.push('postal code missing from listing prompt');
console.log('  ✓ seller answers and postal code carried into the listing prompt');

if (imageCounts[0] !== 5 || imageCounts[1] !== 5) problems.push(`image counts wrong: ${imageCounts}`);
console.log(`  ✓ both calls carried all 5 frames (${imageCounts})`);

// Second-language behaviour is covered in profile.test.mjs, which owns the
// profile that now controls it.

await browser.close();
server.close();

report('Video', problems);
