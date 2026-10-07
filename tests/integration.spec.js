// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('public integration contract', () => {
  test('keeps the host html element unchanged', async ({ page }) => {
    await page.route('**/__html_isolation', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html class="host-theme" style="--host-token: untouched"><head><title>Host</title><script defer src="/annotate.js" data-project="html-isolation"></script></head><body><main>Host content</main></body></html>',
    }));
    await page.goto('/__html_isolation');
    await page.waitForFunction(() => !!window.Annotate);
    const result = await page.evaluate(() => ({
      before: { className: 'host-theme', style: '--host-token: untouched' },
      after: {
        className: document.documentElement.className,
        style: document.documentElement.getAttribute('style'),
      },
      host: document.querySelector('#__an_host'),
    }));
    expect(result.after).toEqual(result.before);
    expect(result.host).not.toBeNull();
  });

  test('published API has no test hooks and can destroy and reinitialize cleanly', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.Annotate);
    const initial = await page.evaluate(() => ({
      testHooks: Object.keys(window.Annotate).filter(key => key.startsWith('_annotate')),
      hasInit: typeof window.Annotate.init === 'function',
      hasDestroy: typeof window.Annotate.destroy === 'function',
    }));
    expect(initial.testHooks).toEqual([]);
    expect(initial.hasInit).toBe(true);
    expect(initial.hasDestroy).toBe(true);

    const cycle = await page.evaluate(() => {
      const first = window.Annotate.init({ project: 'integration-cycle' });
      const beforeDestroy = document.querySelectorAll('#__an_bar').length;
      first.destroy();
      const afterDestroy = document.querySelectorAll('#__an_bar, #__an_panel, #__an_host').length;
      const second = window.Annotate.init({ project: 'integration-cycle' });
      const afterReinit = document.querySelectorAll('#__an_bar').length;
      second.destroy();
      return { beforeDestroy, afterDestroy, afterReinit };
    });
    expect(cycle.beforeDestroy).toBe(1);
    expect(cycle.afterDestroy).toBe(0);
    expect(cycle.afterReinit).toBe(1);
  });

  test('history hooks are opt-in, refresh remains available, and destroy preserves a later router wrapper', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.Annotate);
    const result = await page.evaluate(() => {
      window.Annotate.destroy();
      const original = history.pushState;
      const manual = window.Annotate.init({ project: 'spa-off-contract', spa: false });
      const untouched = history.pushState === original;
      history.pushState({}, '', '/manual-route');
      const beforeRefresh = window.Annotate.config.page;
      manual.refresh();
      const afterRefresh = window.Annotate.config.page;
      manual.destroy();

      const originalAfterManual = history.pushState;
      const automatic = window.Annotate.init({ project: 'spa-on-contract', spa: true });
      automatic.destroy();
      const restoredOnDestroy = history.pushState === originalAfterManual;

      const nextAutomatic = window.Annotate.init({ project: 'spa-on-contract', spa: true });
      const annotateWrapper = history.pushState;
      const laterRouterWrapper = function () { return annotateWrapper.apply(this, arguments); };
      history.pushState = laterRouterWrapper;
      nextAutomatic.destroy();
      return {
        untouched,
        beforeRefresh,
        afterRefresh,
        restoredOnDestroy,
        preservedLaterWrapper: history.pushState === laterRouterWrapper,
      };
    });
    expect(result.untouched).toBe(true);
    expect(result.beforeRefresh).toBe('/');
    expect(result.afterRefresh).toBe('/manual-route');
    expect(result.restoredOnDestroy).toBe(true);
    expect(result.preservedLaterWrapper).toBe(true);
  });

  test('ES module imports are named and side-effect free until init', async ({ page }) => {
    await page.route('**/__esm', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>ESM</title></head><body><main>Host</main></body></html>',
    }));
    await page.goto('/__esm');
    const imported = await page.evaluate(async () => {
      const mod = await import('/annotate.mjs');
      const beforeInit = document.querySelectorAll('#__an_host').length;
      const hasNamedExports = typeof mod.init === 'function' && typeof mod.destroy === 'function';
      mod.init({ project: 'esm-contract' });
      const afterInit = document.querySelectorAll('#__an_host').length;
      mod.destroy();
      const afterDestroy = document.querySelectorAll('#__an_host').length;
      return { beforeInit, hasNamedExports, afterInit, afterDestroy, hasGlobal: !!window.Annotate };
    });
    expect(imported).toEqual({
      beforeInit: 0,
      hasNamedExports: true,
      afterInit: 1,
      afterDestroy: 0,
      hasGlobal: false,
    });
  });

  test('opt-in SPA mode follows history and isolates comments by route', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.Annotate);
    await page.evaluate(() => {
      window.Annotate.destroy();
      const controller = window.Annotate.init({ project: 'spa-contract', spa: true });
      const now = new Date().toISOString();
      localStorage.setItem('annotate:spa-contract', JSON.stringify({ comments: [{
        id: 'route-a', page: 'spa-contract:/', type: 'note', author: 'Test',
        text: 'Route A feedback', color: '#f59e0b', resolved: false, replies: [],
        createdAt: now, updatedAt: now,
      }] }));
      controller.refresh();
    });
    await expect.poll(() => page.evaluate(() => window.Annotate.comments().map(c => c.text)))
      .toEqual(['Route A feedback']);

    await page.evaluate(() => history.pushState({}, '', '/route-b'));
    await expect.poll(() => page.evaluate(() => window.Annotate.comments().length)).toBe(0);
    expect(await page.evaluate(() => window.Annotate.config.page)).toBe('/route-b');
  });

  test('SPA navigation immediately switches comments before submitting feedback', async ({ page }) => {
    const received = [];
    await page.route('**/feedback', async route => {
      received.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, body: '{}' });
    });
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const controller = window.Annotate.init({ project: 'spa-submit', spa: true, postUrl: '/feedback' });
      const now = new Date().toISOString();
      localStorage.setItem('annotate:spa-submit', JSON.stringify({ comments: [
        { id: 'old', page: 'spa-submit:/', text: 'Previous page' },
        { id: 'new', page: 'spa-submit:/next', text: 'Current page' },
      ].map(c => ({ ...c, type: 'note', author: 'Test', color: '#f59e0b',
        resolved: false, replies: [], createdAt: now, updatedAt: now })) }));
      controller.refresh();
      history.pushState({}, '', '/next');
      const ids = controller.comments().map(c => c.id);
      await controller.submit();
      return ids;
    });
    expect(result).toEqual(['new']);
    expect(received).toHaveLength(1);
    expect(received[0].page).toBe('spa-submit:/next');
    expect(received[0].comments.map(c => c.id)).toEqual(['new']);
  });

  test('SPA navigation cancels an old draft before a same-turn save', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.Annotate);
    await page.evaluate(() => {
      localStorage.setItem('an-author', 'Route reviewer');
      window.Annotate.init({ project: 'spa-save-race', spa: true, startOpen: true });
      window.Annotate.setTool('pin');
    });
    await page.locator('.hero h1').click();
    await page.locator('#__an_compose textarea').fill('Old page draft');
    await page.evaluate(() => {
      history.pushState({}, '', '/after-nav');
      document.querySelector('#__an_compose .an-primary').click();
    });
    const comments = await page.evaluate(() => JSON.parse(localStorage.getItem('annotate:spa-save-race') || '{"comments":[]}').comments);
    expect(comments).toEqual([]);
    await expect(page.locator('#__an_compose')).not.toHaveClass(/an-show/);
  });

  test('reapplies highlights after content replacement without wrapping host text', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.Annotate);
    await page.evaluate(() => {
      window.Annotate.destroy();
      const controller = window.Annotate.init({ project: 'dynamic-contract' });
      const target = document.createElement('p');
      target.id = 'late-content';
      target.textContent = 'A phrase rendered after startup';
      document.body.appendChild(target);
      const now = new Date().toISOString();
      localStorage.setItem('annotate:dynamic-contract', JSON.stringify({ comments: [{
        id: 'late-highlight', page: 'dynamic-contract:/', type: 'highlight',
        author: 'Test', text: 'Late phrase', color: '#f59e0b',
        anchor: { prefix: 'A ', exact: 'phrase rendered after startup', suffix: '' },
        resolved: false, replies: [], createdAt: now, updatedAt: now,
      }] }));
      controller.refresh();
      controller.enable();
    });
    const firstMarker = await page.locator('rect.an-highlight[data-an="late-highlight"]').elementHandle();
    expect(firstMarker).not.toBeNull();

    await page.evaluate(() => {
      const target = document.querySelector('#late-content');
      target.replaceChildren(document.createTextNode('The content changed and the quote disappeared'));
    });
    await expect(page.locator('rect.an-highlight[data-an="late-highlight"]')).toHaveCount(0);
    await page.evaluate(() => {
      const target = document.querySelector('#late-content');
      target.replaceChildren(document.createTextNode('A phrase rendered after startup'));
    });
    await expect(page.locator('rect.an-highlight[data-an="late-highlight"]')).toHaveCount(1);
    expect(await firstMarker.evaluate(el => el.isConnected)).toBe(false);
    const hostMarkup = await page.locator('#late-content').evaluate(el => el.innerHTML);
    expect(hostMarkup).not.toContain('<mark');
  });

  test('POSTs exported feedback JSON and preserves comments when the server rejects it', async ({ page }) => {
    const received = [];
    await page.route('**/feedback', async route => {
      received.push({ method: route.request().method(), body: route.request().postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto('/');
    await page.waitForFunction(() => !!window.Annotate);
    await page.evaluate(() => {
      window.Annotate.destroy();
      const controller = window.Annotate.init({ project: 'post-contract', postUrl: '/feedback' });
      const now = new Date().toISOString();
      localStorage.setItem('annotate:post-contract', JSON.stringify({ comments: [{
        id: 'post-1', page: 'post-contract:/', type: 'note', author: 'Test',
        text: 'Please review this', color: '#f59e0b', resolved: false, replies: [],
        createdAt: now, updatedAt: now,
      }] }));
      controller.refresh();
    });
    const posted = await page.evaluate(() => window.Annotate.submit());
    expect(posted.comments).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('POST');
    expect(received[0].body.comments[0].text).toBe('Please review this');

    await page.unroute('**/feedback');
    await page.route('**/feedback', route => route.fulfill({ status: 503, body: 'offline' }));
    await expect(page.evaluate(() => window.Annotate.submit())).rejects.toThrow();
    expect(await page.evaluate(() => window.Annotate.comments().map(c => c.text)))
      .toEqual(['Please review this']);
  });

  test('share destination expands page, count, and summary placeholders', async ({ page }) => {
    await page.context().route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Issue form</p>' }));
    await page.goto('/');
    await page.waitForFunction(() => !!window.Annotate);
    await page.evaluate(() => {
      window.Annotate.destroy();
      const controller = window.Annotate.init({
        project: 'share-contract',
        shareEmail: 'https://example.test/issues/new?title={page}&body={summary}&count={count}',
      });
      const now = new Date().toISOString();
      localStorage.setItem('annotate:share-contract', JSON.stringify({ comments: [{
        id: 'share-1', page: 'share-contract:/', type: 'note', author: 'Test',
        text: 'Button label is unclear', color: '#f59e0b', resolved: false, replies: [],
        createdAt: now, updatedAt: now,
      }] }));
      controller.refresh();
      controller.open();
    });
    await page.locator('#__an_panel .an-fbtn[title^="Send comments"]').click();
    const [opened] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('#__an_sharebox button', { hasText: 'Open channel' }).click(),
    ]);
    await opened.waitForURL(/example\.test\/issues\/new/);
    const url = new URL(opened.url());
    expect(url.searchParams.get('title')).toContain('/');
    expect(url.searchParams.get('body')).toContain('Button label is unclear');
    expect(url.searchParams.get('count')).toBe('1');
  });
});
