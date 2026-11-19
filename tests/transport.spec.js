// @ts-check
// The `transport` option lets a database adapter (Firebase, ...) stand in for
// the HTTP backend. These tests drive the core with an in-memory transport.
const { test, expect } = require('@playwright/test');

async function open(page, query = '') {
  await page.addInitScript(() => {
    window.__events = [];
    window.addEventListener('annotate:sync', e => window.__events.push(e.detail));
  });
  await page.goto('/tests/fixtures/transport' + query);
  await page.waitForFunction(() => !!window.Annotate && window.__t.requests.some(r => r.path === '/session'));
  await page.evaluate(() => window.Annotate.open());
}

test('requests go through the transport, never fetch', async ({ page }) => {
  const outside = [];
  page.on('request', r => { if (/\/v1\/annotate\//.test(r.url())) outside.push(r.url()); });
  await open(page);
  await page.keyboard.press('p');
  await page.locator('#title').click();
  const composer = page.locator('#__an_compose');
  await composer.locator('textarea').fill('Through the transport');
  await composer.locator('.an-primary').click();
  await expect(page.locator('.an-card', { hasText: 'Through the transport' })).toHaveCount(1);
  await page.waitForFunction(() => window.__t.requests.some(r => r.method === 'PUT'));
  const put = await page.evaluate(() => window.__t.requests.find(r => r.method === 'PUT'));
  expect(put.path).toMatch(/^\/comments\/c/);
  expect(put.body.page).toBe('/t');
  expect(outside).toEqual([]);
});

test('a pushed snapshot shows up live, without polling', async ({ page }) => {
  await open(page);
  await page.waitForFunction(() => window.__t.subs.length === 1);
  expect(await page.evaluate(() => window.__t.subs[0].page)).toBe('/t');
  await page.evaluate(() => window.__t.subs[0].push([window.__wire('cpush1', 'Pushed live', '/t')]));
  await expect(page.locator('.an-card', { hasText: 'Pushed live' })).toHaveCount(1);
  // The slow safety-net poll has not fired (pollInterval is 60 s).
  expect(await page.evaluate(() => window.__t.requests.filter(r => r.method === 'GET').length)).toBeLessThanOrEqual(1);
  // A later snapshot without the comment means it was deleted elsewhere.
  await page.evaluate(() => window.__t.subs[0].push([]));
  await expect(page.locator('.an-card', { hasText: 'Pushed live' })).toHaveCount(0);
});

test('reports live sync state', async ({ page }) => {
  await open(page);
  await page.waitForFunction(() => window.__t.subs.length === 1);
  const state = await page.evaluate(() => window.Annotate.syncState());
  expect(state.live).toBe(true);
});

test('without subscribe the transport is polled like HTTP', async ({ page }) => {
  await open(page, '?nosub=1');
  await page.waitForFunction(() => window.__t.requests.some(r => r.method === 'GET'));
  expect(await page.evaluate(() => window.__t.subs.length)).toBe(0);
  expect((await page.evaluate(() => window.Annotate.syncState())).live).toBe(false);
});

test('subscription failure falls back to local mode', async ({ page }) => {
  await open(page);
  await page.waitForFunction(() => window.__t.subs.length === 1);
  await page.evaluate(() => window.__t.subs[0].fail(new Error('permission-denied')));
  await page.waitForFunction(() => window.__events.some(e => e.state === 'local'));
  expect(await page.evaluate(() => window.__t.unsubscribed)).toBeGreaterThanOrEqual(1);
});

test('SPA navigation resubscribes to the new page', async ({ page }) => {
  await open(page, '?spa=1');
  await page.waitForFunction(() => window.__t.subs.length === 1);
  await page.evaluate(() => history.pushState({}, '', '/tests/fixtures/other'));
  await page.waitForFunction(() => window.__t.subs.length === 2);
  const subs = await page.evaluate(() => window.__t.subs.map(s => ({ page: s.page, live: s.live })));
  expect(subs[0].live).toBe(false);
  expect(subs[1]).toEqual({ page: '/tests/fixtures/other', live: true });
});

test('destroy unsubscribes and tears the transport down', async ({ page }) => {
  await open(page);
  await page.waitForFunction(() => window.__t.subs.length === 1);
  await page.evaluate(() => window.Annotate.destroy());
  expect(await page.evaluate(() => window.__t.subs[0].live)).toBe(false);
  expect(await page.evaluate(() => window.__t.destroyed)).toBe(1);
});
