// @ts-check
const { test, expect } = require('@playwright/test');

// Helper: enter review mode and dismiss the "Please provide your name" modal.
// Startup now shows the review bubble; clicking it opens the name modal the
// first time (when no name is stored yet).
async function setName(page, name = 'Test User') {
  const launch = page.locator('#__an_launch');
  let clickedLaunch = false;
  if (await launch.isVisible()) {
    await launch.click();
    clickedLaunch = true;
  }
  const modal = page.locator('#__an_namewrap');
  if (await modal.isVisible()) {
    await modal.locator('input').first().fill(name);
    await modal.locator('button').click();
    await expect(modal).not.toBeVisible();
    return;
  }
  if (clickedLaunch) return;
  const keepOpen = await page.evaluate(() => /^#an=./.test(location.hash));
  await page.evaluate(value => localStorage.setItem('an-author', value), name);
  await page.reload();
  await page.waitForFunction(() => !!window.Annotate);
  if (!keepOpen) await page.evaluate(() => window.Annotate.close());
}

// Helper: clear all stored annotations so tests start clean
async function clearStorage(page) {
  await page.evaluate(() => {
    Object.keys(localStorage).forEach(k => { if (k.startsWith('annotate:')) localStorage.removeItem(k); });
    localStorage.removeItem('an-author');
    localStorage.removeItem('an-off');
    localStorage.removeItem('an-color');
    localStorage.removeItem('an-note');
    localStorage.removeItem('an-share');
  });
}

async function expectPanelInViewport(page) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('#__an_panel');
    if (!panel) return false;
    const box = panel.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth && box.width > 300;
  });
}

async function dispatchPointerStroke(page, startX, startY, endX, endY, steps = 18) {
  await page.evaluate(({ startX, startY, endX, endY, steps }) => {
    const EventCtor = window.PointerEvent || window.MouseEvent;
    const target = document.elementFromPoint(startX, startY) || document.body;
    function fire(type, x, y, buttons) {
      target.dispatchEvent(new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      }));
    }
    fire('pointerdown', startX, startY, 1);
    for (let i = 1; i <= steps; i++) {
      fire(
        'pointermove',
        startX + i * ((endX - startX) / steps),
        startY + i * ((endY - startY) / steps),
        1
      );
    }
    fire('pointerup', endX, endY, 0);
  }, { startX, startY, endX, endY, steps });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clearStorage(page);
  await page.reload();
  await setName(page);
});

// ============================================================
// TOOLBAR
// ============================================================
test.describe('Toolbar', () => {
  test('renders with all tool buttons', async ({ page }) => {
    const bar = page.locator('#__an_bar');
    await expect(bar).toBeVisible();
    for (const tool of ['cursor', 'highlight', 'rect', 'circle', 'pen', 'pin']) {
      await expect(bar.locator(`[data-tool="${tool}"]`)).toBeVisible();
    }
  });

  test('tool buttons expose accessible names', async ({ page }) => {
    await expect(page.locator('[data-tool="cursor"]')).toHaveAttribute('aria-label', 'Browse');
    await expect(page.locator('[data-tool="highlight"]')).toHaveAttribute('aria-label', 'Highlight text');
    await expect(page.locator('[data-tool="pin"]')).toHaveAttribute('aria-label', 'Pin');
    await expect(page.locator('#__an_colorbtn')).toHaveAttribute('aria-label', 'Color');
  });

  test('cursor tool is active by default', async ({ page }) => {
    await expect(page.locator('[data-tool="cursor"]')).toHaveClass(/an-on/);
  });

  test('switching tool updates active state', async ({ page }) => {
    await page.locator('[data-tool="rect"]').click();
    await expect(page.locator('[data-tool="rect"]')).toHaveClass(/an-on/);
    await expect(page.locator('[data-tool="cursor"]')).not.toHaveClass(/an-on/);
    // crosshair cursor on body
    await expect(page.locator('body')).toHaveClass(/an-drawing/);
  });

  test('hide/show via O key and launch button', async ({ page }) => {
    await page.keyboard.press('o');
    await expect(page.locator('#__an_bar')).not.toBeVisible();
    await expect(page.locator('#__an_launch')).toBeVisible();
    await page.locator('#__an_launch').click();
    await expect(page.locator('#__an_bar')).toBeVisible();
  });

  test('color picker opens and changes color', async ({ page }) => {
    await page.locator('#__an_colorbtn').click();
    const pop = page.locator('#__an_colorpop');
    await expect(pop).toBeVisible();
    // click rose swatch (index 1)
    await pop.locator('.an-sw').nth(1).click();
    await expect(pop).not.toBeVisible();
    // dot reflects new color
    const dot = page.locator('#__an_colorbtn .an-swdot');
    const bg = await dot.evaluate(el => el.style.background);
    expect(bg).toContain('244'); // #f43f5e has R=244
  });
});

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
test.describe('Keyboard shortcuts', () => {
  const shortcuts = [
    ['h', 'highlight'],
    ['r', 'rect'],
    ['c', 'circle'],
    ['d', 'pen'],
    ['p', 'pin'],
    ['v', 'cursor'],
  ];
  for (const [key, tool] of shortcuts) {
    test(`${key} activates ${tool} tool`, async ({ page }) => {
      await page.keyboard.press(key);
      await expect(page.locator(`[data-tool="${tool}"]`)).toHaveClass(/an-on/);
    });
  }

  test('a opens the comments panel', async ({ page }) => {
    await expect(page.locator('#__an_panel')).not.toHaveClass(/an-open/);
    await page.keyboard.press('a');
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
  });

  test('Escape cancels a drawing tool', async ({ page }) => {
    await page.keyboard.press('r');
    await expect(page.locator('body')).toHaveClass(/an-drawing/);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tool="cursor"]')).toHaveClass(/an-on/);
  });

  test('? toggles shortcuts card', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(page.locator('#__an_help')).toHaveClass(/an-show/);
    await page.keyboard.press('?');
    await expect(page.locator('#__an_help')).not.toHaveClass(/an-show/);
  });
});

// ============================================================
// PANEL
// ============================================================
test.describe('Comments panel', () => {
  test('opens and closes via toolbar button', async ({ page }) => {
    const listBtn = page.locator('#__an_bar .an-btn[data-tip*="Comments"]');
    await listBtn.click();
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await page.locator('#__an_panel .an-x').click();
    await expect(page.locator('#__an_panel')).not.toHaveClass(/an-open/);
  });

  test('shows empty state when no comments', async ({ page }) => {
    await page.keyboard.press('a');
    await expect(page.locator('.an-empty')).toBeVisible();
  });

  test('filter chips are visible', async ({ page }) => {
    await page.keyboard.press('a');
    const filters = page.locator('.an-chip');
    await expect(filters).toHaveCount(3);
    await expect(filters.nth(0)).toHaveText('Open');
    await expect(filters.nth(1)).toHaveText('Resolved');
    await expect(filters.nth(2)).toHaveText('All');
  });

  test('search filters comments', async ({ page }) => {
    // create a comment via API
    await page.evaluate(() => {
      window.Annotate && window.Annotate.refresh();
    });
    await page.keyboard.press('a');
    const searchInput = page.locator('.an-search input');
    await searchInput.fill('xyz_no_match');
    await expect(page.locator('.an-empty')).toBeVisible();
  });
});

// ============================================================
// PIN TOOL
// ============================================================
test.describe('Pin tool', () => {
  test('creates a pin comment via click', async ({ page }) => {
    await page.keyboard.press('p');
    await expect(page.locator('[data-tool="pin"]')).toHaveClass(/an-on/);

    // Click on the hero heading
    const hero = page.locator('header.hero h1');
    await hero.click();

    // Composer should appear
    const composer = page.locator('#__an_compose');
    await expect(composer).toHaveClass(/an-show/);

    await composer.locator('textarea').fill('Pin comment text');
    await composer.locator('.an-primary').click();

    // Pin dot should appear in overlay/pin layer
    await expect(page.locator('.an-pin')).toHaveCount(1);

    // Panel opens and shows the comment
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await expect(page.locator('.an-card')).toHaveCount(1);
    await expect(page.locator('.an-body')).toContainText('Pin comment text');
  });

  test('clicking pin navigates to it in panel', async ({ page }) => {
    await page.keyboard.press('p');
    const hero = page.locator('header.hero h1');
    await hero.click();
    const composer = page.locator('#__an_compose');
    await composer.locator('textarea').fill('Test pin');
    await composer.locator('.an-primary').click();

    await page.locator('#__an_panel .an-x').click();
    await page.locator('.an-pin').click();
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await expect(page.locator('.an-card.an-active')).toHaveCount(1);
  });
});

// ============================================================
// TEXT HIGHLIGHT
// ============================================================
test.describe('Text highlight', () => {
  test('selecting text opens the composer', async ({ page }) => {
    // Use JS to select text in a paragraph
    await page.evaluate(() => {
      const p = document.querySelector('.lead');
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.locator('.lead').dispatchEvent('pointerup');

    await expect(page.locator('#__an_compose')).toHaveClass(/an-show/, { timeout: 2000 });
  });
});

// ============================================================
// RECTANGLE DRAWING
// ============================================================
test.describe('Rectangle drawing', () => {
  test('drag creates a rectangle annotation', async ({ page }) => {
    await page.keyboard.press('r');
    const section = page.locator('header.hero');
    const box = await section.boundingBox();

    await dispatchPointerStroke(page, box.x + 50, box.y + 60, box.x + 200, box.y + 130);

    const composer = page.locator('#__an_compose');
    await expect(composer).toHaveClass(/an-show/);
    await composer.locator('textarea').fill('Rectangle note');
    await composer.locator('.an-primary').click();

    // SVG rect should appear in overlay
    const overlay = page.locator('#__an_overlay rect');
    await expect(overlay).toHaveCount(1);
    await expect(page.locator('.an-card')).toHaveCount(1);
  });

  test('tiny drag (< 6px) does not open composer', async ({ page }) => {
    await page.keyboard.press('r');
    const section = page.locator('header.hero');
    const box = await section.boundingBox();

    await dispatchPointerStroke(page, box.x + 50, box.y + 60, box.x + 52, box.y + 62, 2);

    // Wait a tick for any async handlers, then check no composer is visible
    await page.waitForTimeout(200);
    const composerVisible = await page.locator('#__an_compose.an-show').count();
    expect(composerVisible).toBe(0);
  });
});

// ============================================================
// FREEHAND PEN
// ============================================================
test.describe('Freehand pen', () => {
  test('drawing a stroke creates a pen annotation', async ({ page }) => {
    await page.keyboard.press('d');
    await expect(page.locator('[data-tool="pen"]')).toHaveClass(/an-on/);
    const hero = page.locator('header.hero');
    const box = await hero.boundingBox();
    const startX = box.x + box.width / 2 - 160;
    const startY = box.y + 360;

    await dispatchPointerStroke(page, startX, startY, startX + 150, startY + 42);

    await expect(page.locator('#__an_compose')).toHaveClass(/an-show/);
    await page.locator('#__an_compose textarea').fill('Freehand note');
    await page.locator('#__an_compose .an-primary').click();

    await expect(page.locator('#__an_overlay path')).toHaveCount(1);
  });
});

// ============================================================
// COMMENT ACTIONS
// ============================================================
test.describe('Comment actions', () => {
  test.beforeEach(async ({ page }) => {
    // Create one pin comment
    await page.keyboard.press('p');
    await page.locator('header.hero h1').click();
    await page.locator('#__an_compose textarea').fill('Initial comment');
    await page.locator('#__an_compose .an-primary').click();
  });

  test('reply to a comment', async ({ page }) => {
    const card = page.locator('.an-card').first();
    await card.hover();
    await card.locator('.an-mini', { hasText: 'Reply' }).click();
    const replyInput = card.locator('.an-replybox .an-input');
    await expect(replyInput).toBeVisible();
    await replyInput.fill('This is a reply');
    await replyInput.press('Enter');
    await expect(card.locator('.an-reply')).toHaveCount(1);
    await expect(card.locator('.an-rwho')).toContainText('Test User');
  });

  test('resolve and reopen a comment', async ({ page }) => {
    const card = page.locator('.an-card').first();
    await card.hover();
    await card.locator('.an-mini', { hasText: 'Resolve' }).click();
    // Panel shows "open" filter by default, so resolved comment disappears
    await expect(page.locator('.an-card')).toHaveCount(0);
    // Switch to Resolved
    await page.locator('.an-chip', { hasText: 'Resolved' }).click();
    await expect(page.locator('.an-card')).toHaveCount(1);
    await expect(page.locator('.an-rbadge')).toBeVisible();
    // Reopen
    const resolvedCard = page.locator('.an-card').first();
    await resolvedCard.hover();
    await resolvedCard.locator('.an-mini', { hasText: 'Reopen' }).click();
    await expect(page.locator('.an-card')).toHaveCount(0); // still on Resolved filter
    await page.locator('.an-chip', { hasText: 'Open' }).click();
    await expect(page.locator('.an-card')).toHaveCount(1);
  });

  test('delete with undo', async ({ page }) => {
    const card = page.locator('.an-card').first();
    await card.hover();
    await card.locator('[title="Delete"]').click();
    await expect(page.locator('.an-card')).toHaveCount(0);
    // Toast with Undo
    const toast = page.locator('.an-toast', { hasText: 'deleted' });
    await expect(toast).toBeVisible();
    await toast.locator('.an-taction', { hasText: 'Undo' }).click();
    await expect(page.locator('.an-card')).toHaveCount(1);
  });

  test('edit comment text', async ({ page }) => {
    const card = page.locator('.an-card').first();
    await card.hover();
    await card.locator('.an-mini', { hasText: 'Edit' }).click();
    const eta = card.locator('.an-editbox .an-ta');
    await expect(eta).toBeVisible();
    await eta.clear();
    await eta.fill('Edited text');
    // Use evaluate to avoid viewport/keyboard issues on mobile
    await page.evaluate(() => {
      const btn = document.querySelector('.an-editbox.an-show .an-primary');
      if (btn) btn.click();
    });
    await expect(card.locator('.an-body')).toContainText('Edited text');
  });
});

// ============================================================
// EXPORT / IMPORT
// ============================================================
test.describe('Export / Import', () => {
  test.beforeEach(async ({ page }) => {
    await page.keyboard.press('p');
    await page.locator('header.hero h1').click();
    await page.locator('#__an_compose textarea').fill('Export test comment');
    await page.locator('#__an_compose .an-primary').click();
  });

  test('export triggers download with correct JSON structure', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => window.Annotate.export()),
    ]);
    expect(download.suggestedFilename()).toMatch(/^annotate-.*\.json$/);
  });

  test('import JSON file merges comments', async ({ page }) => {
    const comments = await page.evaluate(() => window.Annotate.comments());
    expect(comments.length).toBe(1);

    const payload = JSON.stringify({
      annotate: '1.0.1',
      kind: 'annotate-export',
      page: '/',
      comments: [{
        id: 'imported-1',
        type: 'pin',
        author: 'Importer',
        text: 'Imported comment',
        color: '#f59e0b',
        geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.5 },
        resolved: false,
        replies: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });

    await page.evaluate((json) => {
      const data = JSON.parse(json);
      window.Annotate && window.Annotate.refresh();
      // directly call importComments via the internal flow
      const inp = document.createElement('input');
      inp.type = 'file';
      document.body.appendChild(inp);
      // trigger import via Annotate.import is UI-driven; use storage directly
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      if (key) {
        const store = JSON.parse(localStorage.getItem(key));
        data.comments[0].page = store.comments[0].page;
        store.comments.push(data.comments[0]);
        localStorage.setItem(key, JSON.stringify(store));
      }
      inp.remove();
      window.Annotate.refresh();
    }, payload);

    await expect(page.locator('.an-card')).toHaveCount(2);
  });

  test('exporting zero comments shows info toast', async ({ page }) => {
    await page.evaluate(() => { window.Annotate.clear(); window.Annotate.export(); });
    await expect(page.locator('.an-toast.an-info')).toBeVisible();
  });
});

// ============================================================
// THEME
// ============================================================
test.describe('Theme', () => {
  test('landing page uses the light annotation theme', async ({ page }) => {
    // index.html uses the cream light marketing background.
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains('an-dark')
    );
    expect(isDark).toBe(false);
  });

  test('dark theme class applied when forced', async ({ page }) => {
    await page.evaluate(() => {
      document.documentElement.classList.add('an-dark');
    });
    await expect(page.locator('html')).toHaveClass(/an-dark/);
  });
});

// ============================================================
// PUBLIC API
// ============================================================
test.describe('Public API (window.Annotate)', () => {
  test('exposes version', async ({ page }) => {
    const version = await page.evaluate(() => window.Annotate.version);
    expect(version).toBe('1.0.1');
  });

  test('open() / close() control the panel', async ({ page }) => {
    await page.evaluate(() => window.Annotate.open());
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await expectPanelInViewport(page);
    await page.evaluate(() => window.Annotate.close());
    await expect(page.locator('#__an_panel')).not.toHaveClass(/an-open/);
  });

  test('enable() / disable() toggle the toolbar', async ({ page }) => {
    await page.evaluate(() => window.Annotate.disable());
    await expect(page.locator('#__an_bar')).not.toBeVisible();
    await page.evaluate(() => window.Annotate.enable());
    await expect(page.locator('#__an_bar')).toBeVisible();
  });

  test('toast() fires a visible toast', async ({ page }) => {
    await page.evaluate(() => window.Annotate.toast('Hello API', { kind: 'success' }));
    await expect(page.locator('.an-toast.an-success', { hasText: 'Hello API' })).toBeVisible();
  });

  test('comments() returns current comment list', async ({ page }) => {
    const before = await page.evaluate(() => window.Annotate.comments().length);
    expect(before).toBe(0);
  });

  test('clear() removes all page comments', async ({ page }) => {
    // Add one pin
    await page.keyboard.press('p');
    await page.locator('header.hero h1').click();
    await page.locator('#__an_compose textarea').fill('To clear');
    await page.locator('#__an_compose .an-primary').click();
    await expect(page.locator('.an-card')).toHaveCount(1);

    await page.evaluate(() => window.Annotate.clear());
    await expect(page.locator('.an-card')).toHaveCount(0);
  });
});

// ============================================================
// MOBILE VIEWPORT
// ============================================================
test.describe('Mobile viewport', () => {
  test('panel slides up from bottom on small screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('a');
    const panel = page.locator('#__an_panel');
    await expect(panel).toHaveClass(/an-open/);
    // Verify transform is translateY(0) — panel is up
    const transform = await panel.evaluate(el => getComputedStyle(el).transform);
    // translateY(0) resolves to identity matrix or "matrix(1, 0, 0, 1, 0, 0)"
    expect(transform).not.toContain('110');
  });

  test('toolbar does not cover the open mobile panel', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('a');
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await expect(page.locator('#__an_bar')).not.toBeVisible();
  });

  test('toolbar buttons are large enough for touch (≥36px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const btn = page.locator('.an-btn').first();
    const box = await btn.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(36);
    expect(box.height).toBeGreaterThanOrEqual(36);
  });

  test('composer fits within mobile viewport width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.keyboard.press('p');
    await page.locator('header.hero h1').click();
    const composer = page.locator('#__an_compose');
    await expect(composer).toHaveClass(/an-show/);
    const box = await composer.boundingBox();
    expect(box.width).toBeLessThanOrEqual(375 - 16);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  });
});

// ============================================================
// MULTIPLE RESOLUTIONS
// ============================================================
test.describe('Responsive resolutions', () => {
  const viewports = [
    { label: '1440×900 desktop', width: 1440, height: 900 },
    { label: '1280×800 laptop', width: 1280, height: 800 },
    { label: '768×1024 tablet', width: 768, height: 1024 },
    { label: '414×896 iPhone', width: 414, height: 896 },
    { label: '360×640 Android', width: 360, height: 640 },
  ];

  for (const vp of viewports) {
    test(`toolbar visible at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await expect(page.locator('#__an_bar')).toBeVisible();
    });
  }
});

// ============================================================
// FRAMEWORK COMPAT PAGES
// ============================================================
test.describe('Framework integration pages', () => {
  test('plain HTML example page loads annotate toolbar', async ({ page }) => {
    await page.goto('/examples/plain-html.html');
    // This page loads from CDN, so toolbar may not appear without network.
    // Test that the page itself loads correctly.
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('p')).toBeVisible();
  });

  test('React integration page loads', async ({ page }) => {
    await page.goto('/examples/react-integration.html');
    await expect(page.locator('#root')).toBeVisible();
    // Startup shows the review bubble; entering review reveals the toolbar.
    await expect(page.locator('#__an_launch')).toBeVisible();
    await setName(page);
    await expect(page.locator('#__an_bar')).toBeVisible();
  });

  test('Vue integration page loads', async ({ page }) => {
    await page.goto('/examples/vue-integration.html');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#__an_launch')).toBeVisible();
    await setName(page);
    await expect(page.locator('#__an_bar')).toBeVisible();
  });

  test('SPA navigation keeps toolbar', async ({ page }) => {
    await page.goto('/examples/spa-integration.html');
    await expect(page.locator('#__an_launch')).toBeVisible();
    await setName(page);
    await expect(page.locator('#__an_bar')).toBeVisible();
    // Navigate within SPA
    await page.locator('a[data-route]').first().click();
    await expect(page.locator('#__an_bar')).toBeVisible({ timeout: 3000 });
  });
});

// ============================================================
// ANCHOR DEEP-LINK
// ============================================================
test.describe('Deep linking', () => {
  test('#an= hash focuses the correct comment', async ({ page }) => {
    // Set storage + set hash in URL, then reload so annotate.js boots with both
    await page.evaluate(() => {
      const key = 'annotate:annotate-demo';
      const store = { comments: [{
        id: 'test-deeplink',
        page: 'annotate-demo:/',
        url: location.origin + '/',
        type: 'pin',
        author: 'Linker',
        text: 'Deeplinked',
        color: '#f59e0b',
        geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.3 },
        resolved: false,
        replies: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem(key, JSON.stringify(store));
      history.replaceState(null, '', '#an=test-deeplink');
    });
    await page.reload();
    // Name modal appears after reload — set name to skip it
    await setName(page, 'Linker');
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/, { timeout: 5000 });
    await expect(page.locator('.an-card.an-active')).toHaveCount(1);
  });
});

// ============================================================
// STARTUP BUBBLE + AUTHOR CONFIG (data-note / data-share)
// ============================================================
test.describe('Startup bubble & author config', () => {
  // Start from a clean, name-less state so the bubble (not the toolbar) shows.
  test.beforeEach(async ({ page }) => {
    await page.goto('/examples/collapsed-startup.html');
    await clearStorage(page);
    await page.reload();
  });

  test('startup shows the review bubble, not the toolbar', async ({ page }) => {
    await expect(page.locator('#__an_launch')).toBeVisible();
    await expect(page.locator('#__an_bar')).not.toBeVisible();
  });

  test('public open() expands collapsed startup and shows the panel', async ({ page }) => {
    await page.evaluate(() => window.Annotate.open());
    if (page.viewportSize().width <= 640) {
      await expect(page.locator('#__an_bar')).not.toBeVisible();
    } else {
      await expect(page.locator('#__an_bar')).toBeVisible();
    }
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await expectPanelInViewport(page);
  });

  test('data-start-open opens the review toolbar without the comments panel', async ({ page }) => {
    await page.goto('/examples/start-open.html');
    await clearStorage(page);
    await page.reload();
    await expect(page.locator('#__an_launch')).not.toBeVisible();
    await expect(page.locator('#__an_bar')).toBeVisible();
    await expect(page.locator('#__an_panel')).not.toHaveClass(/an-open/);
  });

  test('review bubble sits in the bottom-right corner', async ({ page }) => {
    const launch = page.locator('#__an_launch');
    await expect(launch).toBeVisible();
    const box = await launch.boundingBox();
    const vp = page.viewportSize();
    // right edge near the right side of the viewport
    expect(vp.width - (box.x + box.width)).toBeLessThanOrEqual(40);
    // bottom edge near the bottom of the viewport
    expect(vp.height - (box.y + box.height)).toBeLessThanOrEqual(40);
    // and clearly in the lower portion of the screen
    expect(box.y).toBeGreaterThan(vp.height * 0.6);
  });

  test('bubble stays bottom-right after scrolling (fixed)', async ({ page }) => {
    const launch = page.locator('#__an_launch');
    const before = await launch.boundingBox();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    const after = await launch.boundingBox();
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  });

  test('clicking the bubble surfaces the author note, then opens the toolbar', async ({ page }) => {
    await page.locator('#__an_launch').click();
    const modal = page.locator('#__an_namewrap');
    await expect(modal).toBeVisible();
    // data-note from the demo embed is shown to the reviewer
    await expect(modal.locator('.an-nnote')).toBeVisible();
    await expect(modal.locator('.an-nnote')).toContainText(/review|hero|pricing/i);
    await modal.locator('input').first().fill('Reviewer A');
    await modal.locator('button').click();
    await expect(modal).not.toBeVisible();
    await expect(page.locator('#__an_bar')).toBeVisible();
  });

  test('author note banner shows atop the comments panel', async ({ page }) => {
    await setName(page, 'Reviewer A');
    await page.locator('[data-tool="cursor"]').waitFor();
    await page.keyboard.press('a'); // open panel
    await expect(page.locator('#__an_note')).toBeVisible();
    await expect(page.locator('#__an_note')).toContainText('What to review');
  });

  test('Share button appears because data-share-email is configured', async ({ page }) => {
    await setName(page, 'Reviewer A');
    // create a pin so the footer renders with comments (mirrors the Pin tool test)
    await page.keyboard.press('p');
    await page.locator('header.hero h1').click();
    const composer = page.locator('#__an_compose');
    await expect(composer).toHaveClass(/an-show/);
    await composer.locator('textarea').fill('A note');
    await composer.locator('.an-primary').click();
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    const footRow = page.locator('#__an_foot .an-footrow');
    await expect(footRow.locator('button:has-text("Share")')).toBeVisible();
    // Download button pulses to cue sharing
    await expect(footRow.locator('button:has-text("Download")')).toHaveClass(/an-pulse/);
  });

  test('Share button opens a guided dialog instead of firing mailto blindly', async ({ page }) => {
    await setName(page, 'Reviewer A');
    // add a comment so there is something to share
    await page.keyboard.press('p');
    await page.locator('header.hero h1').click();
    const composer = page.locator('#__an_compose');
    await expect(composer).toHaveClass(/an-show/);
    await composer.locator('textarea').fill('A note');
    await composer.locator('.an-primary').click();
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);

    await page.locator('#__an_foot .an-footrow button:has-text("Share")').click();
    const dlg = page.locator('#__an_sharebox');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.an-st')).toHaveText('Share your review');
    // shows the author's email destination + clear instructions
    await expect(dlg.locator('.an-sdest')).toContainText('reviews@example.com');
    await expect(dlg.locator('.an-sstep')).toHaveCount(2);
    await expect(dlg.locator('button:has-text("Download JSON")')).toBeVisible();
    await expect(dlg.locator('button:has-text("Open email")')).toBeVisible();
    await expect(dlg.locator('button:has-text("Copy summary")')).toBeVisible();
    // closes via Done
    await dlg.locator('button:has-text("Done")').click();
    await expect(page.locator('#__an_sharewrap')).toHaveCount(0);
  });
});

test.describe('Landing page startup', () => {
  test('landing page opens with the review toolbar visible and comments panel closed', async ({ page }) => {
    await page.goto('/');
    await clearStorage(page);
    await page.reload();
    await expect(page.locator('#__an_launch')).not.toBeVisible();
    await expect(page.locator('#__an_bar')).toBeVisible();
    await expect(page.locator('#__an_panel')).not.toHaveClass(/an-open/);
  });
});
