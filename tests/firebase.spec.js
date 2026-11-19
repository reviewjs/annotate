// @ts-check
// Live sync end to end: two real browsers on the Firestore + Auth emulators,
// the real security rules, and the real annotate.js. Run with
//   npm run test:firebase:e2e      (wraps firebase emulators:exec)
// and skipped when the emulator is not running.
const { test, expect } = require('@playwright/test');

test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'needs the Firebase emulators (npm run test:firebase:e2e)');
test.describe.configure({ mode: 'serial' });

let helpers, review, route;
test.beforeAll(async () => {
  helpers = await import('../scripts/tests/firebase-helpers.mjs');
  review = helpers.uniqueReview('e2e');
  route = `/fb/${test.info().project.name}/${Date.now().toString(36)}`;
  await helpers.seedReview(review, { name: 'E2E', open: true });
});
test.afterAll(async () => { if (helpers) await helpers.cleanup(); });

// A signed-in browser with Annotate running on the Firebase transport.
async function join(browser, { author = false, name = 'Rita' } = {}) {
  const context = await browser.newContext();
  // A named reviewer, so the first comment is not interrupted by the name prompt.
  await context.addInitScript(n => { try { localStorage.setItem('an-author', n); } catch (e) {} }, name);
  const page = await context.newPage();
  await page.goto('/tests/fixtures/firebase?' + new URLSearchParams({ review, page: route }));
  await page.waitForFunction(() => !!window.__signIn);
  const uid = await page.evaluate(() => window.__signIn());
  if (author) await helpers.seedReview(review, { name: 'E2E', open: true }, { [uid]: { role: 'author', name: 'Owner' } });
  await page.evaluate(() => window.__start());
  await page.waitForFunction(() => !!window.Annotate);
  await page.evaluate(() => window.Annotate.open());
  await page.waitForFunction(() => window.Annotate.syncState().live === true);
  return { context, page, uid };
}
async function addPin(page, text) {
  await page.keyboard.press('p');
  await page.locator('#title').click();
  const composer = page.locator('#__an_compose');
  await expect(composer).toHaveClass(/an-show/);
  await composer.locator('textarea').fill(text);
  await composer.locator('.an-primary').click();
  await expect(page.locator('.an-card', { hasText: text })).toHaveCount(1);
}
const statusOf = (page, text) => page.evaluate(t => (window.Annotate.comments().find(c => c.text === t) || {}).status, text);

test('a reviewer\'s comment reaches the author live, and the author\'s decision reaches the reviewer', async ({ browser }) => {
  const author = await join(browser, { author: true, name: 'Owner' });
  const reviewer = await join(browser, { name: 'Rita' });

  await addPin(reviewer.page, 'Headline is unclear');
  // No reload, no polling interval: the author's panel gets it pushed.
  await expect(author.page.locator('.an-card', { hasText: 'Headline is unclear' })).toHaveCount(1, { timeout: 10000 });

  const id = await author.page.evaluate(() => window.Annotate.comments().find(c => c.text === 'Headline is unclear').id);
  await author.page.evaluate(i => window.Annotate.setStatus(i, 'resolved'), id);
  await expect.poll(() => statusOf(reviewer.page, 'Headline is unclear'), { timeout: 10000 }).toBe('resolved');
  await author.context.close(); await reviewer.context.close();
});

test('another reviewer never sees it', async ({ browser }) => {
  const author = await join(browser, { author: true, name: 'Owner' });
  const rita = await join(browser, { name: 'Rita' });
  const sam = await join(browser, { name: 'Sam' });
  await addPin(rita.page, 'Rita only');
  await expect(author.page.locator('.an-card', { hasText: 'Rita only' })).toHaveCount(1, { timeout: 10000 });
  await sam.page.waitForTimeout(1500);
  expect(await sam.page.evaluate(() => window.Annotate.comments().length)).toBe(0);
  await expect(sam.page.locator('.an-card', { hasText: 'Rita only' })).toHaveCount(0);
  for (const u of [author, rita, sam]) await u.context.close();
});
