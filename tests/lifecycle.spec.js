const { test, expect } = require('@playwright/test');

async function documentWith(page, content) {
  await page.route('**/lifecycle-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body>' + content + '</body></html>',
  }));
  await page.goto('/lifecycle-fixture');
}

test('destroy before DOM readiness prevents delayed boot', async ({ page }) => {
  await documentWith(page, '<script src="/annotate.js"></script><script>Annotate.destroy()</script><p>Host</p>');
  await expect(page.locator('#__an_host')).toHaveCount(0);
  await page.evaluate(() => Annotate.init({ startOpen: true }));
  await expect(page.locator('#__an_bar')).toBeVisible();
});

test('collapsed review launcher recovers after body replacement', async ({ page }) => {
  await documentWith(page, '<script src="/annotate.js" data-theme="dark" data-project="body-swap"></script>');
  await expect(page.locator('#__an_launch')).toBeVisible();
  await page.waitForTimeout(350); // Let startup load/font/resize callbacks finish.
  await page.evaluate(() => { const body = document.createElement('body'); body.textContent = 'New host body'; document.body.replaceWith(body); });
  await expect(page.locator('#__an_launch')).toBeVisible();
  await expect(page.locator('#__an_host')).toHaveCount(1);
});

test('reinit retains original script configuration', async ({ page }) => {
  await documentWith(page, '<script src="/annotate.js" data-theme="dark" data-project="retained"></script>');
  expect(await page.evaluate(() => { Annotate.destroy(); Annotate.init(); return Annotate.config.project; })).toBe('retained');
  await expect(page.locator('#__an_host')).toHaveClass(/an-dark/);
});

test('ES module imports do not auto boot and replacement modules keep one instance', async ({ page }) => {
  await documentWith(page, '<p>ES module host</p>');
  const before = await page.evaluate(async () => {
    window.firstModule = await import('/annotate.mjs?first');
    return document.querySelectorAll('#__an_host').length;
  });
  expect(before).toBe(0);
  const result = await page.evaluate(async () => {
    firstModule.init({ project: 'hmr', spa: true, startOpen: true });
    const second = await import('/annotate.mjs?second');
    second.init({ project: 'hmr', spa: true, startOpen: true });
    const roots = document.querySelectorAll('#__an_host').length;
    second.destroy();
    return { roots, after: document.querySelectorAll('#__an_host').length };
  });
  expect(result).toEqual({ roots: 1, after: 0 });
});
