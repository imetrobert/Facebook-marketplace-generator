/**
 * Layout: the page must never scroll sideways, and the top-bar controls must
 * be reachable without scrolling, at the narrowest phone widths in use.
 */
import { serve, launch, watchForErrors, report, signIn } from './harness.mjs';

const PORT = 4179;
const { server, origin: ORIGIN } = await serve(PORT);

const problems = [];
const browser = await launch();

/** iPhone SE, iPhone 12/13 mini, iPhone 15, and a small Android. */
const WIDTHS = [320, 360, 375, 390, 430];

async function open(width, { signedIn = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 780 } });
  watchForErrors(page, problems);
  if (signedIn) await signIn(page);
  await page.route('**/functions/v1/generate', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"models":[]}' }));
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  return page;
}

/* 1 — nothing overflows horizontally, and both controls sit on screen. */
for (const width of WIDTHS) {
  const page = await open(width);

  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    view: window.innerWidth,
  }));
  if (overflow.doc > overflow.view || overflow.body > overflow.view) {
    problems.push(`${width}px: page scrolls sideways (content ${Math.max(overflow.doc, overflow.body)}px in ${overflow.view}px)`);
  }

  for (const id of ['profile-btn', 'settings-btn']) {
    const button = page.locator(`#${id}`);
    if (!(await button.isVisible())) {
      problems.push(`${width}px: #${id} is not visible`);
      continue;
    }
    const box = await button.boundingBox();
    if (!box) {
      problems.push(`${width}px: #${id} has no box`);
      continue;
    }
    if (box.x < 0 || box.x + box.width > width) {
      problems.push(`${width}px: #${id} sits off screen (x ${Math.round(box.x)} to ${Math.round(box.x + box.width)})`);
    }
    // Comfortably tappable, not a 20px sliver.
    if (box.height < 30) problems.push(`${width}px: #${id} is only ${Math.round(box.height)}px tall`);
  }

  // The two controls must not overlap each other either.
  const profile = await page.locator('#profile-btn').boundingBox();
  const settings = await page.locator('#settings-btn').boundingBox();
  if (profile && settings && profile.x + profile.width > settings.x + 1) {
    problems.push(`${width}px: Profile and Settings overlap`);
  }

  await page.close();
}
console.log(`  ✓ no sideways scroll and both controls on screen at ${WIDTHS.join(', ')}px`);

/* 2 — the title gives way on a phone but survives on a wider screen. */
{
  const narrow = await open(375);
  if (await narrow.locator('.brand-name').isVisible()) {
    problems.push('the long title is still shown at 375px, which is what pushed the buttons off');
  }
  if (!(await narrow.locator('.brand-mark').isVisible())) {
    problems.push('the brand mark disappeared along with the title');
  }
  // A short wordmark stands in, so the bar does not look empty.
  const short = narrow.locator('.brand-name-short');
  if (!(await short.isVisible())) problems.push('no short wordmark on a phone');
  if ((await short.textContent()).trim() !== 'Marketplace') {
    problems.push(`unexpected short wordmark: ${await short.textContent()}`);
  }
  await narrow.close();

  const wide = await open(900);
  if (!(await wide.locator('.brand-name').isVisible())) {
    problems.push('the title is hidden on a wide screen, where there is room for it');
  }
  if (!(await wide.locator('#user-chip').isVisible())) {
    problems.push('the signed-in address is hidden on a wide screen');
  }
  if (await wide.locator('.brand-name-short').isVisible()) {
    problems.push('both wordmarks are shown at once on a wide screen');
  }
  await wide.close();
  console.log('  ✓ the title and address show on wide screens and stand down on phones');
}

/* 3 — the address is still reachable on a phone, via Settings. */
{
  const page = await open(375);
  if (await page.locator('#user-chip').isVisible()) {
    problems.push('the address chip is still in the top bar at 375px');
  }
  await page.click('#settings-btn');
  await page.waitForFunction(() => document.getElementById('settings-dialog').open, { timeout: 3000 });
  const account = await page.locator('#settings-account').textContent();
  if (!account.includes('robert@imetrobert.com')) {
    problems.push(`Settings does not show the signed-in account (got "${account}")`);
  }
  // Sign out left the bar to make room, so it must be reachable here.
  if (!(await page.locator('#signout-btn').isVisible())) {
    problems.push('Sign out is not reachable from Settings');
  }
  console.log('  ✓ the signed-in address and Sign out move into Settings');
  await page.close();
}

/* 4 — signed out, the whole bar stays away and nothing overflows. */
{
  const page = await open(360, { signedIn: false });

  // Profile and Settings mean nothing without an account behind them.
  if (await page.locator('#topbar').isVisible()) problems.push('the top bar shows before signing in');
  for (const id of ['profile-btn', 'settings-btn']) {
    if (await page.locator(`#${id}`).isVisible()) problems.push(`#${id} is reachable before signing in`);
  }

  await page.evaluate(() => document.getElementById('settings-dialog').showModal());
  if (await page.locator('#signout-btn').isVisible()) {
    problems.push('Sign out is offered while signed out');
  }
  await page.evaluate(() => document.getElementById('settings-dialog').close());
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (wide) problems.push('the sign-in screen scrolls sideways at 360px');
  console.log('  ✓ the signed-out screen fits too');
  await page.close();
}

/* 5 — the profile form, the longest in the app, fits a phone. */
{
  const page = await open(320);
  await page.click('#profile-btn');
  await page.waitForFunction(() => document.getElementById('profile-dialog').open, { timeout: 3000 });
  const overflow = await page.evaluate(() => {
    const d = document.getElementById('profile-dialog');
    return { dialog: d.scrollWidth, doc: document.documentElement.scrollWidth, view: window.innerWidth };
  });
  if (overflow.dialog > overflow.view) {
    problems.push(`profile form is ${overflow.dialog}px wide in a ${overflow.view}px viewport`);
  }
  if (overflow.doc > overflow.view) problems.push('the profile form makes the page scroll sideways');

  for (const id of ['pf-city', 'pf-payment', 'pf-standing', 'profile-save-btn']) {
    const box = await page.locator(`#${id}`).boundingBox();
    if (!box) {
      problems.push(`#${id} has no box in the profile form`);
    } else if (box.x < 0 || box.x + box.width > overflow.view) {
      problems.push(`#${id} sits off screen in the profile form`);
    }
  }
  console.log('  ✓ the profile form fits a 320px screen');
  await page.close();
}

await browser.close();
server.close();

report('Layout', problems);
