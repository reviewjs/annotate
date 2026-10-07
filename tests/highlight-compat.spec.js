const { test, expect } = require('@playwright/test');

async function loadHighlights(page, html, anchors) {
  await page.goto('/');
  await page.evaluate(({ html, anchors }) => {
    const host = document.createElement('div');
    host.id = 'highlight-compat-host';
    host.innerHTML = html;
    document.body.appendChild(host);
    const comments = anchors.map(({ id, anchor }) => ({
      id, type: 'highlight', author: 'Test', text: id, color: '#f59e0b',
      anchor, page: 'annotate-demo:/', resolved: false, replies: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    localStorage.setItem('annotate:annotate-demo', JSON.stringify({ comments }));
    window.Annotate.refresh();
  }, { html, anchors });
}

async function expectMarkerOnTarget(page, id) {
  // Read both boxes in one browser turn: resize/font callbacks may replace
  // SVG markers between separate automation calls.
  await expect.poll(() => page.evaluate(id => {
    const marker = document.querySelector('.an-highlight[data-an="' + id + '"]');
    if (!marker) return false;
    const target = document.querySelector('#target').getBoundingClientRect();
    const mark = marker.getBoundingClientRect();
    return mark.width > 0 && mark.height > 0 && mark.y >= target.y && mark.y < target.bottom;
  }, id)).toBe(true);
}

test('a saved quote from the legacy text stream finds the intended repeated phrase', async ({ page }) => {
  await loadHighlights(page,
    '<p id="first">alpha-finish</p>\n  <p id="target">target phrase</p><p>target phrase</p>',
    [{ id: 'legacy', anchor: { exact: 'target', prefix: 'alpha-finish', suffix: ' phrase' } }]);
  const marker = page.locator('.an-highlight[data-an="legacy"]');
  await expect(marker).toHaveCount(1);
  await expect(page.locator('.an-unanchored-pill')).toHaveCount(0);
  await expectMarkerOnTarget(page, 'legacy');
});

test('a saved quote with whitespace-only nodes keeps its modern context', async ({ page }) => {
  await loadHighlights(page,
    '<p>alpha-finish</p>\n  <p id="target">target phrase</p><p>target phrase</p>',
    [{ id: 'modern', anchor: { exact: 'target', prefix: 'alpha-finish\n  ', suffix: ' phrase' } }]);
  const marker = page.locator('.an-highlight[data-an="modern"]');
  await expect(marker).toHaveCount(1);
  await expectMarkerOnTarget(page, 'modern');
});

test('a repeated modern context stays ambiguous even if the legacy stream has one match', async ({ page }) => {
  await loadHighlights(page,
    '<p>start target end</p><p><span>start</span> <span>target</span> <span>end</span></p>',
    [{ id: 'ambiguous-modern', anchor: { exact: 'target', prefix: 'start ', suffix: ' end' } }]);
  await expect(page.locator('.an-highlight[data-an="ambiguous-modern"]')).toHaveCount(0);
  await expect(page.locator('.an-unanchored-pill')).toHaveCount(1);
});

test('visible display contents text is painted while hidden and transparent text is not', async ({ page }) => {
  await loadHighlights(page,
    '<p><span id="visible" style="display:contents">visible-content-token</span></p>' +
    '<p><span style="display:contents;visibility:hidden">hidden-content-token</span></p>' +
    '<p style="opacity:0"><span style="display:contents">transparent-content-token</span></p>',
    [
      { id: 'visible', anchor: { exact: 'visible-content-token', prefix: '', suffix: '' } },
      { id: 'hidden', anchor: { exact: 'hidden-content-token', prefix: '', suffix: '' } },
      { id: 'transparent', anchor: { exact: 'transparent-content-token', prefix: '', suffix: '' } },
    ]);
  await expect(page.locator('.an-highlight[data-an="visible"]')).toHaveCount(1);
  await expect(page.locator('.an-highlight[data-an="hidden"]')).toHaveCount(0);
  await expect(page.locator('.an-highlight[data-an="transparent"]')).toHaveCount(0);
});
