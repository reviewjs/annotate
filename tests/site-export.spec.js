// @ts-check
// Multi-page review: one download carries every page of the project, and
// importing it puts each comment back on the page it was made on.
const { test, expect } = require('@playwright/test');

const PAGES = ['/__site/a', '/__site/b', '/__site/c'];

function comment(id, page, text) {
  const now = new Date().toISOString();
  return {
    id, page, url: 'http://localhost:4200' + page.replace(/^[^:]*:/, ''), type: 'note', author: 'Rev',
    text, color: '#f59e0b', resolved: false, replies: [], createdAt: now, updatedAt: now,
  };
}

test.beforeEach(async ({ page }) => {
  // Same private hook injection as annotate.spec.js: the published script
  // carries no test hooks, so only this browser's copy gets one.
  await page.route('**/annotate.js', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = '// ANNOTATE TEST INJECTION POINT';
    if (!source.includes(marker)) throw new Error('annotate.js is missing the private test injection marker');
    const hooks = 'Object.assign(controller, { _annotateImportForTest: function (data) { importComments(data); } });';
    await route.fulfill({ response, body: source.replace(marker, hooks) });
  });
  await page.route('**/__site/*', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><main><h1>Site page</h1><p>Body copy.</p></main></body></html>',
  }));
  await page.goto(PAGES[0]);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('an-author', 'Rev'); });
});

async function boot(page, path, project) {
  await page.goto(path);
  await page.addScriptTag({ url: '/annotate.js' });
  await page.waitForFunction(() => !!window.Annotate);
  await page.evaluate(project => {
    window.Annotate.destroy();
    window.Annotate.init({ project });
  }, project);
}

async function download(page, trigger) {
  const [file] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const fs = require('node:fs/promises');
  return JSON.parse(await fs.readFile(await file.path(), 'utf8'));
}

test('site export carries every page and import restores each comment to its own page', async ({ page }) => {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const mk = (id, path, text) => ({ id, page: 'site:' + path, url: location.origin + path, type: 'note', author: 'Rev',
      text, color: '#f59e0b', resolved: false, replies: [], createdAt: now, updatedAt: now });
    localStorage.setItem('annotate:site', JSON.stringify({ comments: [
      mk('a1', '/__site/a', 'On A'), mk('b1', '/__site/b', 'On B'), mk('b2', '/__site/b', 'Also B'),
      mk('x1', '/__site/x', 'Other'),
    ] }));
    localStorage.setItem('annotate:elsewhere', JSON.stringify({ comments: [mk('e1', '/__site/a', 'Wrong project')] }));
  });
  await boot(page, PAGES[0], 'site');

  const pageOnly = await download(page, () => page.evaluate(() => window.Annotate.export()));
  expect(pageOnly.scope).toBeUndefined();
  expect(pageOnly.comments.map(c => c.id)).toEqual(['a1']);

  const site = await download(page, () => page.evaluate(() => window.Annotate.export({ scope: 'site' })));
  expect(site.scope).toBe('site');
  expect(site.project).toBe('site');
  expect(site.comments.map(c => c.id).sort()).toEqual(['a1', 'b1', 'b2', 'x1']);

  // Import into a fresh browser under a different project name: every
  // comment lands on its own path, re-keyed to the importing project.
  await page.evaluate(() => localStorage.clear());
  await boot(page, PAGES[2], 'renamed');
  await page.evaluate(data => window.Annotate._annotateImportForTest(data), site);
  await expect(page.locator('.an-toast', { hasText: 'Imported 4 comments across 3 pages' })).toBeVisible();
  expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(0);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('annotate:renamed')).comments
    .map(c => [c.id, c.page]).sort());
  expect(stored).toEqual([
    ['a1', 'renamed:/__site/a'], ['b1', 'renamed:/__site/b'], ['b2', 'renamed:/__site/b'], ['x1', 'renamed:/__site/x'],
  ]);

  await boot(page, PAGES[1], 'renamed');
  expect(await page.evaluate(() => window.Annotate.comments().map(c => c.text).sort())).toEqual(['Also B', 'On B']);

  // Importing the same file again adds nothing.
  await page.evaluate(data => window.Annotate._annotateImportForTest(data), site);
  await expect(page.locator('.an-toast', { hasText: 'Nothing new to import' })).toBeVisible();
});

test('a page export still lands on the importing page', async ({ page }) => {
  await boot(page, PAGES[1], 'legacy');
  await page.evaluate(data => window.Annotate._annotateImportForTest(data), {
    annotate: '1.5.3', kind: 'annotate-export', page: 'legacy:/__site/a', project: 'legacy',
    comments: [comment('p1', 'legacy:/__site/a', 'From A')],
  });
  expect(await page.evaluate(() => window.Annotate.comments().map(c => [c.id, c.page])))
    .toEqual([['p1', 'legacy:/__site/b']]);
});

test('the footer offers an all-pages download only when other pages have comments', async ({ page }) => {
  await boot(page, PAGES[0], 'foot');
  await page.evaluate(() => window.Annotate.open());
  const allPages = page.locator('#__an_foot [data-action="download-site"]');
  await expect(allPages).toHaveCount(0);

  await page.evaluate(() => {
    const now = new Date().toISOString();
    localStorage.setItem('annotate:foot', JSON.stringify({ comments: [
      { id: 'f1', page: 'foot:/__site/a', type: 'note', author: 'Rev', text: 'Here', color: '#f59e0b', resolved: false, replies: [], createdAt: now, updatedAt: now },
      { id: 'f2', page: 'foot:/__site/b', type: 'note', author: 'Rev', text: 'There', color: '#f59e0b', resolved: false, replies: [], createdAt: now, updatedAt: now },
    ] }));
    window.Annotate.refresh();
  });
  await expect(allPages).toHaveText(/All pages \(2 comments, 2 pages\)/);
  const data = await download(page, () => allPages.click());
  expect(data.scope).toBe('site');
  expect(data.comments.map(c => c.id).sort()).toEqual(['f1', 'f2']);
});
