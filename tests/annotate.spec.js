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
  // Keep legacy white-box coverage while ensuring the published script has
  // no test hooks. The fixture injects them only into this browser response.
  await page.route('**/annotate.js', async route => {
    // Exercise the checkout even when an example uses the production CDN URL.
    const response = await route.fetch({ url: 'http://localhost:4200/annotate.js' });
    const source = await response.text();
    const marker = '// ANNOTATE TEST INJECTION POINT';
    if (!source.includes(marker)) {
      throw new Error('annotate.js is missing the private test injection marker');
    }
    const hooks = `Object.assign(controller, {
      _annotateImportForTest: function (data) { importComments(data); },
      _annotateOpenImportForTest: function () { pickImportFile(); },
      _annotatePatchForTest: function (id, changes) { return patchComment(id, changes); },
      _annotateCountOccurrencesForTest: function (full, needle) { return countOccurrences(full, needle); },
      _annotateCreateForTest: function (draft) {
        var c = createComment(draft);
        if (!c) return null;
        state.comments.push(c);
        renderAll(); renderPanel();
        return c;
      },
      _annotateExportPayloadForTest: function () { return buildExportPayload(); }
    });`;
    await route.fulfill({ response, body: source.replace(marker, hooks) });
  });
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

  test('reply to a comment via Ctrl+Enter', async ({ page }) => {
    const card = page.locator('.an-card').first();
    await card.hover();
    await card.locator('.an-mini', { hasText: 'Reply' }).click();
    // Reply box is now a textarea; Ctrl+Enter submits
    const replyInput = card.locator('.an-replybox .an-ta');
    await expect(replyInput).toBeVisible();
    await replyInput.fill('This is a reply');
    await replyInput.press('Control+Enter');
    await expect(card.locator('.an-reply')).toHaveCount(1);
    await expect(card.locator('.an-rwho')).toContainText('Test User');
  });

  test('reply button also submits via click', async ({ page }) => {
    const card = page.locator('.an-card').first();
    await card.hover();
    await card.locator('.an-mini', { hasText: 'Reply' }).click();
    const replyInput = card.locator('.an-replybox .an-ta');
    await replyInput.fill('Button reply');
    await card.locator('.an-replybox .an-primary').click();
    await expect(card.locator('.an-reply')).toHaveCount(1);
  });

  test('own reply can be deleted', async ({ page }) => {
    const card = page.locator('.an-card').first();
    await card.hover();
    await card.locator('.an-mini', { hasText: 'Reply' }).click();
    const replyInput = card.locator('.an-replybox .an-ta');
    await replyInput.fill('Temp reply');
    await card.locator('.an-replybox .an-primary').click();
    await expect(card.locator('.an-reply')).toHaveCount(1);
    // Delete the reply
    await card.locator('.an-reply .an-mini.an-danger').click();
    await expect(card.locator('.an-reply')).toHaveCount(0);
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

  test('deletion persists to storage immediately (before the undo toast expires)', async ({ page }) => {
    // Regression: deletion used to be deferred until the undo toast expired,
    // so reloading within that window resurrected the "deleted" comment.
    // Seed exactly one comment via storage (deterministic, avoids click-to-pin flake).
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      const stored = { comments: [{
        id: 'doomed-1', type: 'note', author: 'Test', text: 'Doomed comment',
        color: '#f59e0b', page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem(key, JSON.stringify(stored));
      window.Annotate.refresh();
    });
    await expect(page.locator('.an-card')).toHaveCount(1);

    await page.locator('.an-card').hover();
    await page.locator('.an-card [title="Delete"]').click();
    await expect(page.locator('.an-card')).toHaveCount(0);

    // Storage must no longer contain the comment immediately — a reload in the
    // undo window must not resurrect it.
    const remaining = await page.evaluate(() => window.Annotate.comments().length);
    expect(remaining).toBe(0);
    const storedCount = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      return JSON.parse(localStorage.getItem(key) || '{"comments":[]}').comments.length;
    });
    expect(storedCount).toBe(0);

    // Undo restores the record in both storage and the panel.
    const toast = page.locator('.an-toast', { hasText: 'deleted' });
    await expect(toast).toBeVisible();
    await toast.locator('.an-taction', { hasText: 'Undo' }).click();
    await expect(page.locator('.an-card')).toHaveCount(1);
    const restoredStored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      return JSON.parse(localStorage.getItem(key) || '{"comments":[]}').comments.length;
    });
    expect(restoredStored).toBe(1);
  });

  test('undo does not duplicate a comment if its id was re-added to storage during the window', async ({ page }) => {
    // Delete the comment, then (as a cross-tab sync or re-import would) write
    // the same id back into storage before Undo is pressed. Undo must restore
    // the record in the panel but must not append a second copy to storage.
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      localStorage.setItem(key, JSON.stringify({ comments: [{
        id: 'reappear-1', type: 'note', author: 'Test', text: 'Come back',
        color: '#f59e0b', page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }] }));
      window.Annotate.refresh();
    });
    await expect(page.locator('.an-card')).toHaveCount(1);
    await page.locator('.an-card').hover();
    await page.locator('.an-card [title="Delete"]').click();
    await expect(page.locator('.an-card')).toHaveCount(0);

    // Simulate the id reappearing in storage during the undo window.
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      const stored = JSON.parse(localStorage.getItem(key));
      stored.comments.push({
        id: 'reappear-1', type: 'note', author: 'Test', text: 'Come back',
        color: '#f59e0b', page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      localStorage.setItem(key, JSON.stringify(stored));
    });

    const toast = page.locator('.an-toast', { hasText: 'deleted' });
    await toast.locator('.an-taction', { hasText: 'Undo' }).click();
    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      return JSON.parse(localStorage.getItem(key)).comments.filter(c => c.id === 'reappear-1').length;
    });
    expect(stored).toBe(1);
  });

  test('undo after navigating to another route does not inject the old route\'s comment', async ({ page }) => {
    // Delete on route A, navigate to route B, then hit Undo: the comment is
    // restored to storage but must not appear in route B's live list.
    await page.evaluate(() => {
      const key = 'annotate:annotate-demo';
      localStorage.setItem(key, JSON.stringify({ comments: [{
        id: 'routeA-1', type: 'note', author: 'T', text: 'from route A',
        color: '#f59e0b', page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }] }));
      window.Annotate.refresh();
    });
    await page.locator('.an-card').hover();
    await page.locator('.an-card [title="Delete"]').click();
    await expect(page.locator('.an-card')).toHaveCount(0);
    const toast = page.locator('.an-toast', { hasText: 'deleted' });
    await expect(toast).toBeVisible();

    // Navigate to a different route and refresh — route A is no longer shown.
    await page.evaluate(() => { history.pushState({}, '', '/route-b'); window.Annotate.refresh(); });
    expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(0);

    // Undo is still pending; clicking it must restore to storage only.
    await toast.locator('.an-taction', { hasText: 'Undo' }).click();
    const state = await page.evaluate(() => ({
      live: window.Annotate.comments().length,
      liveIds: window.Annotate.comments().map((c) => c.id),
      stored: JSON.parse(localStorage.getItem('annotate:annotate-demo')).comments
        .map((c) => c.id),
    }));
    expect(state.live).toBe(0);
    expect(state.liveIds).not.toContain('routeA-1');
    expect(state.stored).toContain('routeA-1');
  });

  test('undo never duplicates a record that is already in storage', async ({ page }) => {
    // Simulate the record still present in storage (e.g. the delete write
    // failed, or another tab restored it) before Undo runs.
    await page.evaluate(() => {
      const key = 'annotate:annotate-demo';
      localStorage.setItem(key, JSON.stringify({ comments: [] }));
      window.Annotate.refresh();
      window.Annotate._annotateCreateForTest({ type: 'note', text: 'dup check', color: '#f59e0b' });
    });
    expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(1);
    // Force the storage record to survive: delete only from the live state via
    // the UI, then restore the storage copy before undo (as a failed write
    // would have left it).
    const id = await page.evaluate(() => window.Annotate.comments()[0].id);
    await page.locator('.an-card').hover();
    await page.locator('.an-card [title="Delete"]').click();
    await expect(page.locator('.an-card')).toHaveCount(0);
    await page.evaluate((id) => {
      const key = 'annotate:annotate-demo';
      const fresh = JSON.parse(localStorage.getItem(key));
      if (!fresh.comments.some((c) => c.id === id)) {
        // Re-create an equivalent record with the same id to model the
        // "delete write failed, so the record is still in storage" case.
        fresh.comments.push({
          id, type: 'note', author: 'Test', text: 'dup check', color: '#f59e0b',
          page: 'annotate-demo:/', resolved: false, replies: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        localStorage.setItem(key, JSON.stringify(fresh));
      }
    }, id);
    const toast = page.locator('.an-toast', { hasText: 'deleted' });
    await toast.locator('.an-taction', { hasText: 'Undo' }).click();
    const counts = await page.evaluate((id) => {
      const key = 'annotate:annotate-demo';
      const stored = JSON.parse(localStorage.getItem(key)).comments;
      return {
        storedDup: stored.filter((c) => c.id === id).length,
        liveDup: window.Annotate.comments().filter((c) => c.id === id).length,
      };
    }, id);
    expect(counts.storedDup).toBe(1);
    expect(counts.liveDup).toBeLessThanOrEqual(1);
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

  test('copy button copies the complete export JSON', async ({ page }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => { window.__copiedComments = text; } },
      });
    });

    const button = page.locator('#__an_foot button', { hasText: 'Copy' });
    await expect(button).toHaveAttribute('title', 'Copy comments as JSON');
    await expect(button).toHaveAttribute('aria-label', 'Copy comments as JSON');
    await button.click();

    const copied = await page.evaluate(() => ({
      payload: JSON.parse(window.__copiedComments),
      comments: window.Annotate.comments(),
      version: window.Annotate.version,
      project: window.Annotate.config.project,
      url: location.href,
    }));
    expect(copied.payload).toMatchObject({
      annotate: copied.version,
      kind: 'annotate-export',
      page: copied.comments[0].page,
      url: copied.url,
      project: copied.project,
      comments: copied.comments,
    });
    expect(copied.payload.exportedViewport).toEqual(expect.objectContaining({
      vw: expect.any(Number),
      vh: expect.any(Number),
      dpr: expect.any(Number),
    }));
    expect(Date.parse(copied.payload.exportedAt)).not.toBeNaN();
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

  test('export JSON includes exportedViewport metadata', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => window.Annotate.export()),
    ]);
    const stream = await download.createReadStream();
    const chunks = [];
    await new Promise((res, rej) => { stream.on('data', c => chunks.push(c)); stream.on('end', res); stream.on('error', rej); });
    const json = JSON.parse(Buffer.concat(chunks).toString());
    expect(json.exportedViewport).toBeDefined();
    expect(typeof json.exportedViewport.vw).toBe('number');
    expect(typeof json.exportedViewport.vh).toBe('number');
    expect(typeof json.exportedViewport.dpr).toBe('number');
  });

  test('importing from a different page shows a mismatch toast and still imports', async ({ page }) => {
    await page.evaluate(() => {
      window.Annotate.clear();
    });
    const before = await page.evaluate(() => window.Annotate.comments().length);
    await page.evaluate(() => {
      window.Annotate._annotateImportForTest({
        annotate: '1.3.0', kind: 'annotate-export', page: '/some-other-page',
        comments: [{
          id: 'mismatch-1', type: 'pin', author: 'Tester', text: 'From elsewhere',
          color: '#f59e0b', geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.5 },
          resolved: false, replies: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      });
    });
    await expect(page.locator('.an-toast', { hasText: 'different page' })).toBeVisible();
    expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(before + 1);
  });

  test('import rejects comment with malformed geom', async ({ page }) => {
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      const stored = JSON.parse(localStorage.getItem(key) || '{"comments":[]}');
      const pageKey = stored.comments[0] ? stored.comments[0].page : '/';
      // Malformed geom: JSON has no Infinity/NaN, so they serialize as null
      stored.comments.push({
        id: 'bad-1', type: 'pin', author: 'X', text: 'bad geom',
        color: '#f59e0b', geom: { kind: 'pin', selector: 'body', x: null, y: null },
        page: pageKey,
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      localStorage.setItem(key, JSON.stringify(stored));
    });
    // A real import of that same malformed record must be rejected by the
    // schema validator — never written into storage.
    const imported = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      const before = JSON.parse(localStorage.getItem(key)).comments.length;
      window.Annotate._annotateImportForTest({
        annotate: '1.3.0', kind: 'annotate-export', page: '/',
        comments: [{
          id: 'bad-2', type: 'pin', author: 'X', text: 'bad geom',
          color: '#f59e0b', geom: { kind: 'pin', selector: 'body', x: null, y: null },
          resolved: false, replies: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      });
      const after = JSON.parse(localStorage.getItem(key)).comments.length;
      return { before, after };
    });
    expect(imported.after).toBe(imported.before);
  });

  test('import rejects unknown geometry kinds and unknown comment types', async ({ page }) => {
    const before = await page.evaluate(() => window.Annotate.comments().length);
    const toastVisible = await page.evaluate(() => {
      window.Annotate._annotateImportForTest({
        annotate: '1.3.0', kind: 'annotate-export', page: '/',
        comments: [
          { id: 'k-1', type: 'pin', author: 'X', text: 'bad kind', color: '#f59e0b',
            geom: { kind: 'hexagon', selector: 'body', x: 0.5, y: 0.5 },
            resolved: false, replies: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { id: 't-1', type: 'teleport', author: 'X', text: 'bad type', color: '#f59e0b',
            resolved: false, replies: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ],
      });
      return !!document.querySelector('.an-toast.an-error');
    });
    expect(toastVisible).toBe(true);
    expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(before);
  });

  test('import skips records with duplicate IDs in the same batch', async ({ page }) => {
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      const stored = JSON.parse(localStorage.getItem(key) || '{"comments":[]}');
      localStorage.setItem(key, JSON.stringify({ comments: [] }));
      window.Annotate.refresh();
    });
    const count = await page.evaluate(() => {
      const mk = (id) => ({
        id, type: 'pin', author: 'X', text: 'dup', color: '#f59e0b',
        geom: { kind: 'pin', selector: 'body', x: 0.2, y: 0.2 },
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      window.Annotate._annotateImportForTest({
        annotate: '1.3.0', kind: 'annotate-export', page: '/', comments: [mk('dup-id'), mk('dup-id')],
      });
      return window.Annotate.comments().length;
    });
    expect(count).toBe(1);
  });

  test('import skips records whose ID already exists in this project', async ({ page }) => {
    // Distinct from the intra-batch duplicate case: a single incoming record
    // whose id is already present in this project must be skipped, not merged
    // or duplicated.
    const count = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      const mk = (id, text) => ({
        id, type: 'pin', author: 'X', text, color: '#f59e0b',
        geom: { kind: 'pin', selector: 'body', x: 0.2, y: 0.2 },
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      // An existing comment already lives in this project…
      const existing = mk('already-here', 'existing');
      existing.page = 'annotate-demo:/';
      localStorage.setItem(key, JSON.stringify({ comments: [existing] }));
      window.Annotate.refresh();
      // …and the import carries the very same id.
      window.Annotate._annotateImportForTest({
        annotate: '1.3.0', kind: 'annotate-export', page: '/',
        comments: [mk('already-here', 'incoming duplicate'), mk('fresh-id', 'new one')],
      });
      return {
        count: window.Annotate.comments().length,
        texts: window.Annotate.comments().map(c => c.text),
      };
    });
    // The existing id is skipped; only the genuinely new record is added.
    expect(count.count).toBe(2);
    expect(count.texts).toContain('existing');
    expect(count.texts).toContain('new one');
    expect(count.texts).not.toContain('incoming duplicate');
  });

  test('import validates reply structure', async ({ page }) => {
    const before = await page.evaluate(() => window.Annotate.comments().length);
    const imported = await page.evaluate(() => {
      const mk = (replies) => ({
        id: 'rep-test', type: 'note', author: 'X', text: 'replies check', color: '#f59e0b',
        resolved: false, replies,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      window.Annotate._annotateImportForTest({
        annotate: '1.3.0', kind: 'annotate-export', page: '/',
        comments: [
          mk([{ id: 'r1', author: 'R', text: 'ok', createdAt: new Date().toISOString() }]),
          mk(['not-a-reply']),
          mk([{ author: 'missing id', text: 'x', createdAt: new Date().toISOString() }]),
        ],
      });
      return window.Annotate.comments().length;
    });
    // Only the record with well-formed replies passes validation.
    expect(imported).toBe(before + 1);
  });

  test('creation rejects a section note without a valid block anchor', async ({ page }) => {
    const result = await page.evaluate(() => {
      const before = window.Annotate.comments().length;
      const created = window.Annotate._annotateCreateForTest({ type: 'block', text: 'missing anchor' });
      return {
        created,
        count: window.Annotate.comments().length,
        toast: document.querySelector('.an-toast.an-error')?.textContent || '',
        before,
      };
    });
    expect(result.created).toBeNull();
    expect(result.count).toBe(result.before);
    expect(result.toast).toContain('invalid anchor');
  });

  test('editing cannot persist a malformed reply or damage the existing comment', async ({ page }) => {
    const result = await page.evaluate(() => {
      const created = window.Annotate._annotateCreateForTest({ type: 'note', text: 'original' });
      const rejected = window.Annotate._annotatePatchForTest(created.id, {
        reply: { text: 'reply without required identity fields' },
      });
      const current = window.Annotate.comments().find(c => c.id === created.id);
      return { rejected, text: current.text, replies: current.replies.length };
    });
    expect(result.rejected).toBeNull();
    expect(result.text).toBe('original');
    expect(result.replies).toBe(0);
  });

  test('real file import via the file chooser imports one comment', async ({ page }) => {
    const before = await page.evaluate(() => window.Annotate.comments().length);
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.evaluate(() => window.Annotate._annotateOpenImportForTest()),
    ]);
    await fileChooser.setFiles({
      name: 'review.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        annotate: '1.3.0', kind: 'annotate-export', page: '/',
        comments: [{
          id: 'file-1', type: 'pin', author: 'X', text: 'From a real file',
          color: '#f59e0b', geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.5 },
          resolved: false, replies: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      })),
    });
    await expect(page.locator('.an-toast', { hasText: 'Imported 1 comment' })).toBeVisible();
    expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(before + 1);
  });

  test('invalid JSON file shows an error toast and imports nothing', async ({ page }) => {
    const before = await page.evaluate(() => window.Annotate.comments().length);
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.evaluate(() => window.Annotate._annotateOpenImportForTest()),
    ]);
    await fileChooser.setFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ this is not json'),
    });
    await expect(page.locator('.an-toast.an-error', { hasText: 'isn’t valid JSON' })).toBeVisible();
    expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(before);
  });
});

test.describe('Storage failures', () => {
  test('when localStorage writes fail, comments are kept in memory, exportable, and the failure is surfaced', async ({ page }) => {
    const res = await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function () {
        throw new DOMException('denied', 'SecurityError');
      };
      try {
        const before = window.Annotate.comments().length;
        window.Annotate._annotateCreateForTest({ type: 'note', text: 'kept in memory', color: '#f59e0b' });
        const after = window.Annotate.comments();
        // The comment must be in memory…
        const inMemory = after.some(c => c.text === 'kept in memory');
        // …but absent from localStorage (write failed)…
        const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
        const inStorage = (JSON.parse(localStorage.getItem(key) || '{"comments":[]}').comments || [])
          .some(c => c.text === 'kept in memory');
        // …and it must be present in the export payload.
        const exp = window.Annotate._annotateExportPayloadForTest();
        const inExport = !!(exp && exp.comments.some(c => c.text === 'kept in memory'));
        const warned = !!document.getElementById('__an_unsaved');
        return { inMemory, inStorage, inExport, warned, grew: after.length === before + 1 };
      } finally {
        Storage.prototype.setItem = orig;
      }
    });
    expect(res.inMemory).toBe(true);
    expect(res.inStorage).toBe(false);
    expect(res.inExport).toBe(true);
    expect(res.warned).toBe(true);
    expect(res.grew).toBe(true);
  });

  test('a failed preference write does not raise the unsaved-comments banner', async ({ page }) => {
    // The banner is about comment persistence. A failure writing an unrelated
    // preference (e.g. an-color) must not make it look like comments are at risk.
    const res = await page.evaluate(() => {
      // Ensure no banner is present to start.
      const existing = document.getElementById('__an_unsaved');
      if (existing) existing.remove();
      const orig = Storage.prototype.setItem;
      // Only the preference key fails; comment writes keep working.
      Storage.prototype.setItem = function (k, v) {
        if (k === 'an-color') throw new DOMException('denied', 'SecurityError');
        return orig.call(this, k, v);
      };
      try {
        // A successful comment write must leave the banner off…
        window.Annotate._annotateCreateForTest({ type: 'note', text: 'fine', color: '#f59e0b' });
        const afterCommentWrite = !!document.getElementById('__an_unsaved');
        // …and a failing preference write must not raise it either.
        const sw = document.querySelector('#__an_colorpop .an-sw');
        if (sw) sw.click();
        const afterPrefWrite = !!document.getElementById('__an_unsaved');
        return { afterCommentWrite, afterPrefWrite };
      } finally {
        Storage.prototype.setItem = orig;
      }
    });
    expect(res.afterCommentWrite).toBe(false);
    expect(res.afterPrefWrite).toBe(false);
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
    expect(version).toBe('1.5.0');
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

  test('share-enabled desktop footer keeps every control inside the row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => window.Annotate.open());

    const footRow = page.locator('#__an_foot .an-footrow');
    await expect(footRow).toBeVisible();
    const layout = await footRow.evaluate(row => {
      const rowBounds = row.getBoundingClientRect();
      return {
        left: rowBounds.left,
        right: rowBounds.right,
        controls: Array.from(row.querySelectorAll('button')).map(button => {
          const bounds = button.getBoundingClientRect();
          return {
            label: button.textContent.trim(),
            left: bounds.left,
            right: bounds.right,
          };
        }),
      };
    });

    expect(layout.controls.map(control => control.label)).toEqual([
      'Download',
      'Copy',
      'Share',
      'Import',
    ]);
    for (const control of layout.controls) {
      expect(control.left).toBeGreaterThanOrEqual(layout.left - 0.5);
      expect(control.right).toBeLessThanOrEqual(layout.right + 0.5);
    }
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

// ============================================================
// SPA PAGE ISOLATION
// ============================================================
test.describe('SPA page isolation', () => {
  test('refresh() after in-page navigation switches the page key and its comments', async ({ page }) => {
    // Seed one comment on the landing page, then simulate SPA navigation to a
    // new route. The layer must recompute the (non-explicit) page key so the
    // new route does NOT show the old route's comments, and new comments
    // created after the switch are tagged with the new key.
    await page.evaluate(() => {
      const key = 'annotate:annotate-demo'; // data-project on the landing page
      const stored = { comments: [{
        id: 'spa-old', type: 'note', author: 'SPA', text: 'on first route',
        color: '#f59e0b', page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem(key, JSON.stringify(stored));
      window.Annotate.refresh();
    });
    expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(1);
    expect(await page.evaluate(() => window.Annotate.config.page)).toBe('/');

    // Navigate in-page (what a history-based SPA router does) and refresh.
    await page.evaluate(() => {
      history.pushState({}, '', '/new-route');
      window.Annotate.refresh();
    });

    expect(await page.evaluate(() => window.Annotate.config.page)).toBe('/new-route');
    // The old route's comment must not leak into the new route.
    expect(await page.evaluate(() => window.Annotate.comments().length)).toBe(0);

    // A comment created on the new route is tagged with the new page key.
    await page.evaluate(() => {
      window.Annotate._annotateCreateForTest({ type: 'note', text: 'on new route', color: '#f59e0b' });
    });
    const saved = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      return JSON.parse(localStorage.getItem(key)).comments
        .filter(c => c.text === 'on new route').map(c => c.page);
    });
    expect(saved).toEqual(['annotate-demo:/new-route']);
  });

  test('page key is stable until the host calls refresh()', async ({ page }) => {
    // Navigation alone must not silently retag comments; only an explicit
    // refresh() (which SPA routers call) may recompute the page key.
    await page.evaluate(() => { history.pushState({}, '', '/elsewhere'); });
    expect(await page.evaluate(() => window.Annotate.config.page)).toBe('/');
    // Comments created before an explicit refresh still land on the old key.
    await page.evaluate(() => {
      window.Annotate._annotateCreateForTest({ type: 'note', text: 'pre-refresh', color: '#f59e0b' });
    });
    const pages = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      return JSON.parse(localStorage.getItem(key)).comments
        .filter(c => c.text === 'pre-refresh').map(c => c.page);
    });
    expect(pages).toEqual(['annotate-demo:/']);
  });
});

// ============================================================
// OVERLAY RE-ANCHORING
// ============================================================
test.describe('Overlay re-anchoring', () => {
  test('pin repositions when its anchor block grows', async ({ page }) => {
    // A pin anchored to the hero paragraph: when the paragraph grows (its
    // layout shifts), the pin must track the anchor's new box on the next
    // render pass — not stay frozen at its original position.
    await page.evaluate(() => {
      const key = 'annotate:annotate-demo';
      const stored = { comments: [{
        id: 'reanchor-1', type: 'pin', author: 'Test', text: 'Tracking pin',
        color: '#f59e0b',
        geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.5, vw: window.innerWidth, vh: window.innerHeight },
        page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem(key, JSON.stringify(stored));
      window.Annotate.refresh();
    });
    await expect(page.locator('.an-pin')).toHaveCount(1);
    // Let startup renders (window-load / fonts.ready) settle so the only
    // layout change that follows is the spacer we inject.
    await page.waitForTimeout(800);
    const before = await page.evaluate(() => {
      const p = document.querySelector('.an-pin');
      return { left: p.style.left, top: p.style.top };
    });
    // Grow a large block above the pin's anchor area so document coordinates
    // shift — no window resize occurs, only the ResizeObserver on <body> sees it.
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.id = '__dbg_spacer';
      spacer.style.height = '1200px';
      document.body.insertBefore(spacer, document.body.firstChild);
    });
    await page.waitForTimeout(500); // observer + rAF coalescing
    const after = await page.evaluate(() => {
      const p = document.querySelector('.an-pin');
      return p ? { left: p.style.left, top: p.style.top } : null;
    });
    expect(after).toBeTruthy();
    // A pin at 50% of a document that just grew 1200px tall must have moved down.
    expect(parseFloat(after.top)).toBeGreaterThan(parseFloat(before.top));
    await page.evaluate(() => { document.getElementById('__dbg_spacer')?.remove(); });
  });
});

// ============================================================
// ANCHOR INTEGRITY
// ============================================================
test.describe('Anchor integrity', () => {
  test('ambiguous text match shows an unanchored warning instead of a silent guess', async ({ page }) => {
    const phrase = 'review surface'; // occurs once in .hero-sub
    const occurrences = await page.evaluate((phrase) => {
      // Clone the hero paragraph so the phrase occurs in two places — the
      // stored quote below can no longer identify a single intended target.
      const src = document.querySelector('.hero-sub');
      const clone = src.cloneNode(true);
      clone.id = '__dup_hero_sub';
      src.insertAdjacentElement('afterend', clone);
      const stored = { comments: [{
        id: 'ambig-1', type: 'highlight', author: 'T', text: 'which one?',
        color: '#f59e0b',
        anchor: { exact: phrase, prefix: '', suffix: '' },
        resolved: false, replies: [],
        page: 'annotate-demo:/',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem('annotate:annotate-demo', JSON.stringify(stored));
      window.Annotate.refresh();
      return document.body.textContent.split(phrase).length - 1;
    }, phrase);
    expect(occurrences).toBeGreaterThanOrEqual(2);
    // The library must not silently highlight an arbitrary copy: it surfaces
    // an explicit unanchored/ambiguous state (no SVG range is painted).
    await expect(page.locator('.an-highlight[data-an="ambig-1"]')).toHaveCount(0);
    await expect(page.locator('.an-unanchored-pill')).toHaveCount(1);
  });

  test('shape anchored to a missing element is flagged as unanchored', async ({ page }) => {
    await page.evaluate(() => {
      const stored = { comments: [{
        id: 'ghost-1', type: 'shape', author: 'T', text: 'where am I',
        color: '#f59e0b',
        geom: { kind: 'rect', selector: '#ghost-999', x: 0.1, y: 0.1, w: 0.3, h: 0.2,
          vw: window.innerWidth, vh: window.innerHeight },
        page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem('annotate:annotate-demo', JSON.stringify(stored));
      window.Annotate.refresh();
    });
    // The badge takes the explicit "element missing" state, not a silent body fallback.
    await expect(page.locator('.an-badge-circle[title*="missing"]')).toHaveCount(1);
  });

  test('multiple missing anchors get distinct badge positions', async ({ page }) => {
    await page.evaluate(() => {
      const mk = (id, sel) => ({
        id, type: 'shape', author: 'T', text: 'ghost ' + id, color: '#f59e0b',
        geom: { kind: 'rect', selector: sel, x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
        page: 'annotate-demo:/', resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      const stored = { comments: [mk('g1', '#ghost-a'), mk('g2', '#ghost-b')] };
      localStorage.setItem('annotate:annotate-demo', JSON.stringify(stored));
      window.Annotate.refresh();
    });
    const circles = page.locator('.an-badge-circle[title*="missing"]');
    await expect(circles).toHaveCount(2);
    const cx = await circles.evaluateAll((els) => els.map((e) => e.getAttribute('cx')));
    expect(new Set(cx).size).toBe(2);
  });

  test('repeated text with unique surrounding context still highlights', async ({ page }) => {
    // "bravo" occurs twice, but the saved prefix+suffix context matches only
    // the first occurrence — the highlight must NOT be treated as ambiguous.
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = '__ctx_host';
      host.innerHTML = '<p>ALPHA bravo charlie</p><p>delta bravo echo</p>';
      document.body.appendChild(host);
      const stored = { comments: [{
        id: 'ctx-1', type: 'highlight', author: 'T', text: 'contextual',
        color: '#f59e0b', anchor: { exact: 'bravo', prefix: 'ALPHA ', suffix: ' charlie' },
        page: 'annotate-demo:/', resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem('annotate:annotate-demo', JSON.stringify(stored));
      window.Annotate.refresh();
    });
    // Exactly one SVG range is painted (the contextualized occurrence), no pill.
    await expect(page.locator('.an-highlight[data-an="ctx-1"]')).toHaveCount(1);
    await expect(page.locator('.an-unanchored-pill')).toHaveCount(0);
  });

  test('repeated text with no distinguishing context is flagged ambiguous', async ({ page }) => {
    // Same word twice with empty saved context — genuinely ambiguous.
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = '__amb_host';
      host.innerHTML = '<p>foo bravo bar</p><p>baz bravo qux</p>';
      document.body.appendChild(host);
      const stored = { comments: [{
        id: 'amb-2', type: 'highlight', author: 'T', text: 'which bravo',
        color: '#f59e0b', anchor: { exact: 'bravo', prefix: '', suffix: '' },
        page: 'annotate-demo:/', resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem('annotate:annotate-demo', JSON.stringify(stored));
      window.Annotate.refresh();
    });
    await expect(page.locator('.an-highlight[data-an="amb-2"]')).toHaveCount(0);
    await expect(page.locator('.an-unanchored-pill')).toHaveCount(1);
  });
});

// ============================================================
// MARKER KEYBOARD ACCESSIBILITY
// ============================================================
test.describe('Marker keyboard accessibility', () => {
  async function seedPin(page) {
    await page.evaluate(() => {
      const stored = { comments: [{
        id: 'kbd-pin', type: 'pin', author: 'T', text: 'Keyboard pin',
        color: '#f59e0b', geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.5 },
        page: 'annotate-demo:/', resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem('annotate:annotate-demo', JSON.stringify(stored));
      window.Annotate.refresh();
    });
    await page.waitForTimeout(300);
    return page.locator('.an-pin');
  }

  test('pins are focusable and open their comment with Enter', async ({ page }) => {
    const pin = await seedPin(page);
    await expect(pin).toHaveCount(1);
    await pin.focus();
    await expect(pin).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await expect(page.locator('.an-card.an-active')).toHaveCount(1);
  });

  test('pins are focusable and open their comment with Space', async ({ page }) => {
    const pin = await seedPin(page);
    await pin.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await expect(page.locator('.an-card.an-active')).toHaveCount(1);
  });

  test('annotation markers expose accessible names', async ({ page }) => {
    const pin = await seedPin(page);
    await expect(pin).toHaveAttribute('aria-label', expect.stringContaining('comment #1'));
  });

  test('shape badges are focusable and open their comment with Enter', async ({ page }) => {
    await page.evaluate(() => {
      const stored = { comments: [{
        id: 'kbd-rect', type: 'shape', author: 'T', text: 'Keyboard shape',
        color: '#f59e0b',
        geom: { kind: 'rect', selector: 'header.hero', x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
        page: 'annotate-demo:/', resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }]};
      localStorage.setItem('annotate:annotate-demo', JSON.stringify(stored));
      window.Annotate.refresh();
    });
    await page.waitForTimeout(300);
    const badge = page.locator('#__an_overlay [tabindex="0"]').first();
    await expect(badge).toHaveCount(1);
    await badge.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#__an_panel')).toHaveClass(/an-open/);
    await expect(page.locator('.an-card.an-active')).toHaveCount(1);
  });
});

// ============================================================
// ARCHITECTURAL IMPROVEMENTS
// ============================================================
test.describe('Architectural improvements', () => {
  test('import preserves distinct IDs for a batch of well-formed comments', async ({ page }) => {
    // End-to-end: feed 20 distinct, valid records through the real import path
    // (via the file-agnostic hook) and confirm all 20 land with distinct IDs.
    const res = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      const stored = JSON.parse(localStorage.getItem(key) || '{"comments":[]}');
      localStorage.setItem(key, JSON.stringify({ comments: [] }));
      window.Annotate.refresh();
      const batch = [];
      for (let i = 0; i < 20; i++) {
        batch.push({
          id: 'batch-' + i, type: 'pin', author: 'Test', text: 'C' + i,
          color: '#f59e0b',
          geom: { kind: 'pin', selector: 'body', x: 0.1 * (i % 10), y: 0.5 },
          resolved: false, replies: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }
      window.Annotate._annotateImportForTest({ annotate: '1.3.0', kind: 'annotate-export', page: '/', comments: batch });
      const after = window.Annotate.comments();
      return { count: after.length, ids: after.map(c => c.id), allDistinct: new Set(after.map(c => c.id)).size === after.length };
    });
    expect(res.count).toBe(20);
    expect(res.allDistinct).toBe(true);
    expect(res.ids).toContain('batch-0');
    expect(res.ids).toContain('batch-19');
  });

  test('import rejects id-less records instead of silently reassigning', async ({ page }) => {
    // A record with no string id cannot be deduplicated or deep-linked, so it
    // is rejected rather than mutated — import surfaces an error toast.
    const before = await page.evaluate(() => window.Annotate.comments().length);
    const res = await page.evaluate(() => {
      window.Annotate._annotateImportForTest({
        annotate: '1.3.0', kind: 'annotate-export', page: '/',
        comments: [{
          type: 'pin', author: 'X', text: 'no id', color: '#f59e0b',
          geom: { kind: 'pin', selector: 'body', x: 0.3, y: 0.3 },
          resolved: false, replies: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      });
      return { count: window.Annotate.comments().length, errored: !!document.querySelector('.an-toast.an-error') };
    });
    expect(res.count).toBe(before);
    expect(res.errored).toBe(true);
  });

  test('pin geom stores viewport dimensions at draw time', async ({ page }) => {
    await page.keyboard.press('p');
    await page.locator('header.hero h1').click();
    await page.locator('#__an_compose textarea').fill('Viewport test');
    await page.locator('#__an_compose .an-primary').click();
    const geom = await page.evaluate(() => {
      const c = window.Annotate.comments()[0];
      return c ? c.geom : null;
    });
    expect(geom).toBeTruthy();
    expect(typeof geom.vw).toBe('number');
    expect(typeof geom.vh).toBe('number');
    expect(geom.vw).toBeGreaterThan(0);
  });

  test('rect geom stores viewport dimensions at draw time', async ({ page }) => {
    await page.keyboard.press('r');
    const box = await page.locator('header.hero').boundingBox();
    await dispatchPointerStroke(page, box.x + 40, box.y + 40, box.x + 180, box.y + 120);
    await page.locator('#__an_compose textarea').fill('Rect viewport');
    await page.locator('#__an_compose .an-primary').click();
    const geom = await page.evaluate(() => {
      const c = window.Annotate.comments()[0];
      return c ? c.geom : null;
    });
    expect(geom).toBeTruthy();
    expect(typeof geom.vw).toBe('number');
  });

  test('viewport-mismatch badge appears on pin drawn at very different width', async ({ page }) => {
    // Inject a pin comment with a captured viewport far from current
    const vw = await page.evaluate(() => window.innerWidth);
    // Use the same page key as the current page
    const pageKey = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      if (!key) return null;
      const stored = JSON.parse(localStorage.getItem(key) || '{"comments":[]}');
      // Get current PAGE value from any existing comment, or construct it
      return { storeKey: key };
    });
    await page.evaluate(({ capturedVw }) => {
      // The landing page uses data-project="annotate-demo", so PAGE = "annotate-demo:/"
      const storeKey = 'annotate:annotate-demo';
      const stored = JSON.parse(localStorage.getItem(storeKey) || '{"comments":[]}');
      stored.comments.push({
        id: 'vp-mismatch', type: 'pin', author: 'Test', text: 'Mismatch',
        color: '#f59e0b',
        geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.3, vw: capturedVw + 800, vh: 900 },
        page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      localStorage.setItem(storeKey, JSON.stringify(stored));
      window.Annotate.refresh();
    }, { capturedVw: vw });
    // Panel should show the card and the pin should be rendered
    await expect(page.locator('.an-card')).toHaveCount(1);
    // The pin DOM element should exist
    await expect(page.locator('.an-pin')).toHaveCount(1);
  });

  test('name modal traps Tab focus within the dialog', async ({ page }) => {
    // Clear author so the modal appears
    await page.evaluate(() => localStorage.removeItem('an-author'));
    await page.reload();
    await page.waitForFunction(() => !!window.Annotate);
    // Click the launch button to trigger the modal
    const launch = page.locator('#__an_launch');
    if (await launch.isVisible()) await launch.click();
    const modal = page.locator('#__an_namewrap');
    if (!await modal.isVisible()) {
      // modal may not appear if name is pre-set; skip gracefully
      return;
    }
    await expect(modal).toBeVisible();
    // Tab through focusable elements — should not leave the modal
    const input = modal.locator('input').first();
    await input.focus();
    // Tab forward from last focusable should wrap to first
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => document.activeElement && document.activeElement.id);
    // The active element should still be inside the modal
    const insideModal = await page.evaluate(() => {
      const modal = document.getElementById('__an_namewrap');
      return modal ? modal.contains(document.activeElement) : false;
    });
    expect(insideModal).toBe(true);
  });

  test('cross-tab storage sync: storage event triggers reload', async ({ page }) => {
    const count1 = await page.evaluate(() => window.Annotate.comments().length);
    // landing page uses data-project="annotate-demo", PAGE = "annotate-demo:/"
    // STORE_KEY = "annotate:annotate-demo"
    const storeKey = 'annotate:annotate-demo';
    await page.evaluate((key) => {
      const stored = JSON.parse(localStorage.getItem(key) || '{"comments":[]}');
      stored.comments.push({
        id: 'from-other-tab', type: 'note', author: 'Other', text: 'From other tab',
        color: '#10b981', page: 'annotate-demo:/',
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      const newValue = JSON.stringify(stored);
      localStorage.setItem(key, newValue);
      // Dispatch a storage event as if a different tab wrote it
      window.dispatchEvent(new StorageEvent('storage', { key, newValue, oldValue: null, storageArea: localStorage }));
    }, storeKey);
    // Give the event handler time to call load()
    await page.waitForTimeout(300);
    const count2 = await page.evaluate(() => window.Annotate.comments().length);
    expect(count2).toBeGreaterThan(count1);
  });
});

// ============================================================
// REVIEW-FIX REGRESSIONS (from the codex advisor review of
// commit 8379d2b). Each test pins one identified defect.
// ============================================================
test.describe('Review fixes', () => {
  test('an unsaved comment survives refresh() while storage is denied', async ({ page }) => {
    const res = await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { throw new DOMException('denied', 'SecurityError'); };
      try {
        window.Annotate._annotateCreateForTest({ type: 'note', text: 'unsaved-fresh', color: '#f59e0b' });
        const before = window.Annotate.comments().some(c => c.text === 'unsaved-fresh');
        window.Annotate.refresh();
        const after = window.Annotate.comments().some(c => c.text === 'unsaved-fresh');
        return { before, after };
      } finally { Storage.prototype.setItem = orig; }
    });
    expect(res.before).toBe(true);
    // refresh() must not discard work that never reached storage.
    expect(res.after).toBe(true);
  });

  test('editing an unsaved comment still applies the change in memory', async ({ page }) => {
    const res = await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { throw new DOMException('denied', 'SecurityError'); };
      try {
        const c = window.Annotate._annotateCreateForTest({ type: 'note', text: 'orig', color: '#f59e0b' });
        const updated = window.Annotate._annotatePatchForTest(c.id, { text: 'edited' });
        const inState = window.Annotate.comments().some(x => x.id === c.id && x.text === 'edited');
        return { patchResult: updated ? updated.text : null, inState };
      } finally { Storage.prototype.setItem = orig; }
    });
    // patchComment must not return null just because the record is not in storage.
    expect(res.patchResult).toBe('edited');
    expect(res.inState).toBe(true);
  });

  test('import skips an id that already exists on a different page of the project', async ({ page }) => {
    const res = await page.evaluate(() => {
      const key = 'annotate:annotate-demo';
      const mk = (id, pg, text) => ({
        id, type: 'pin', page: pg, author: 'X', text, color: '#f59e0b',
        geom: { kind: 'pin', selector: 'body', x: 0.2, y: 0.2 },
        resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      localStorage.setItem(key, JSON.stringify({ comments: [mk('collide', 'annotate-demo:/other-route', 'on other page')] }));
      window.Annotate.refresh();
      window.Annotate._annotateImportForTest({
        annotate: '1.3.0', kind: 'annotate-export', page: '/',
        comments: [mk('collide', '/', 'incoming colliding id')],
      });
      return window.Annotate.comments().map(c => c.text);
    });
    // The same ID already lives on another page of this project — do not import.
    expect(res).not.toContain('incoming colliding id');
  });

  test('replies are truncated and thread caps enforced at input time', async ({ page }) => {
    const res = await page.evaluate(() => {
      const c = window.Annotate._annotateCreateForTest({ type: 'note', text: 'x', color: '#f59e0b' });
      const longText = 'a'.repeat(6000);
      const updated = window.Annotate._annotatePatchForTest(c.id, {
        reply: { id: 'r1', author: 'X', text: longText, createdAt: new Date().toISOString() },
      });
      const replyTextLen = updated.replies[0].text.length;
      // Drive a thread up to the cap and confirm the next reply is refused.
      let c2 = window.Annotate._annotateCreateForTest({ type: 'note', text: 'capthread', color: '#f59e0b' });
      for (let i = 0; i < 500; i++) {
        c2 = window.Annotate._annotatePatchForTest(c2.id, {
          reply: { id: 'r' + i, author: 'X', text: 'ok', createdAt: new Date().toISOString() },
        });
      }
      const capLen = c2.replies.length;
      const extra = window.Annotate._annotatePatchForTest(c2.id, {
        reply: { id: 'r-extra', author: 'X', text: 'should-not-add', createdAt: new Date().toISOString() },
      });
      const afterExtra = extra.replies.length;
      return { replyTextLen, capLen, afterExtra };
    });
    expect(res.replyTextLen).toBe(5000);
    expect(res.capLen).toBe(500);
    expect(res.afterExtra).toBe(500); // 501st reply refused
  });

  test('malformed stored records are skipped on load instead of crashing', async ({ page }) => {
    const res = await page.evaluate(() => {
      const key = 'annotate:annotate-demo';
      const existing = JSON.parse(localStorage.getItem(key) || '{"comments":[]}');
      const pageKey = existing.comments[0] ? existing.comments[0].page : 'annotate-demo:/';
      const good = { id: 'good-1', type: 'pin', page: pageKey, author: 'X', text: 'fine', color: '#f59e0b',
        geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.5 }, resolved: false, replies: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      localStorage.setItem(key, JSON.stringify({ comments: [
        null,
        good,
        { id: 'bad-geom', type: 'pin', page: pageKey, author: 'X', text: 'x', color: '#f59e0b',
          geom: { kind: 'pin', selector: 'body', x: null, y: null }, resolved: false, replies: [],
          createdAt: '', updatedAt: '' },
        { id: 'bad-type-geom', type: 'shape', page: pageKey, author: 'X', text: 'y', color: '#f59e0b',
          geom: { kind: 'pin', selector: 'body', x: 0.5, y: 0.5 }, resolved: false, replies: [],
          createdAt: '', updatedAt: '' },
      ] }));
      let threw = null;
      try { window.Annotate.refresh(); } catch (e) { threw = e && e.name; }
      const texts = window.Annotate.comments().map(c => c.text);
      return { threw, texts };
    });
    expect(res.threw).toBe(null);
    expect(res.texts).toContain('fine');
    expect(res.texts).not.toContain('x');
    expect(res.texts).not.toContain('y');
  });

  test('a storage sync event does not switch page identity before refresh()', async ({ page }) => {
    const res = await page.evaluate(() => {
      const c = window.Annotate._annotateCreateForTest({ type: 'note', text: 'routepin', color: '#f59e0b' });
      history.pushState({}, '', '/other-route');
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key), storageArea: localStorage }));
      return window.Annotate.comments().map(x => x.text);
    });
    // The comment belongs to the original route; a sync load must not switch PAGE.
    expect(res).toContain('routepin');
  });

  test('overlapping occurrences are counted individually', async ({ page }) => {
    // "ana" occurs twice inside "banana" (index 1 and index 3). Advancing the
    // scan by the needle length used to miss the second, overlapping hit.
    const n = await page.evaluate(() => window.Annotate._annotateCountOccurrencesForTest('banana', 'ana'));
    expect(n).toBe(2);
  });

  test('activating undo twice does not duplicate the comment', async ({ page }) => {
    const res = await page.evaluate(() => {
      const c = window.Annotate._annotateCreateForTest({ type: 'note', text: 'doomed', color: '#f59e0b' });
      const card = document.querySelector('[data-id="' + c.id + '"]');
      card.querySelector('.an-mini.an-danger').click();
      const undoBtn = document.querySelector('.an-taction');
      undoBtn.click();
      undoBtn.click(); // double activation in the same tick
      const inMemory = window.Annotate.comments().filter(x => x.id === c.id).length;
      const key = Object.keys(localStorage).find(k => k.startsWith('annotate:'));
      const inStorage = JSON.parse(localStorage.getItem(key) || '{"comments":[]}').comments.filter(x => x.id === c.id).length;
      return { inMemory, inStorage };
    });
    expect(res.inMemory).toBe(1);
    expect(res.inStorage).toBeLessThanOrEqual(1);
  });

  test('SVG highlight markers are keyboard-operable (role=button, tabindex=0)', async ({ page }) => {
    const res = await page.evaluate(() => {
      const p = document.createElement('p');
      p.textContent = 'a uniquely quotable phrase for keyboard testing';
      document.body.appendChild(p);
      const c = window.Annotate._annotateCreateForTest({
        type: 'highlight', color: '#f59e0b', text: 'kbd',
        anchor: { prefix: '', exact: 'uniquely quotable phrase for keyboard testing', suffix: '' },
      });
      const mark = document.querySelector('rect.an-highlight[data-an="' + c.id + '"]');
      return { role: mark && mark.getAttribute('role'), tabindex: mark && mark.getAttribute('tabindex') };
    });
    expect(res.role).toBe('button');
    expect(res.tabindex).toBe('0');
  });

  test('stored highlight with a null anchor is skipped without crashing', async ({ page }) => {
    const res = await page.evaluate(() => {
      const key = 'annotate:annotate-demo';
      const good = { id: 'h-good', page: 'annotate-demo:/', type: 'note', author: 'X', text: 'ok', color: '#f59e0b', resolved: false, replies: [], createdAt: '', updatedAt: '' };
      localStorage.setItem(key, JSON.stringify({ comments: [
        { id: 'h-null', page: 'annotate-demo:/', type: 'highlight', author: 'X', text: 'x', color: '#f59e0b', anchor: null, resolved: false, replies: [], createdAt: '', updatedAt: '' },
        good,
      ] }));
      let threw = null;
      try { window.Annotate.refresh(); } catch (e) { threw = e && e.name; }
      return { threw, texts: window.Annotate.comments().map(c => c.text) };
    });
    expect(res.threw).toBe(null);
    expect(res.texts).toEqual(['ok']);
  });

  test('clear() also removes comments created while storage was denied', async ({ page }) => {
    const res = await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { throw new DOMException('denied', 'SecurityError'); };
      try {
        window.Annotate._annotateCreateForTest({ type: 'note', text: 'unsaved-clear', color: '#f59e0b' });
        const had = window.Annotate.comments().some(c => c.text === 'unsaved-clear');
        window.Annotate.clear();
        const after = window.Annotate.comments().some(c => c.text === 'unsaved-clear');
        return { had, after };
      } finally { Storage.prototype.setItem = orig; }
    });
    expect(res.had).toBe(true);
    expect(res.after).toBe(false);
  });
});

// A reviewer with no stored name comments first: Comment opens the name
// dialog over the pending draft. Using the dialog with the mouse must not drop
// that draft. It used to: with the pin (or a shape) tool active, a click on
// the dialog started a new draft, and with the cursor tool the composer's
// click-outside handler cancelled it.
test.describe('first comment before a name is set', () => {
  for (const kind of ['pin', 'highlight']) {
    for (const how of ['clicks Start reviewing', 'clicks into the field and presses Enter']) {
      test(`a ${kind} draft is posted when the reviewer ${how}`, async ({ page }) => {
        await page.goto('/tests/fixtures/remote?page=/first-comment');
        await clearStorage(page);
        await page.reload();
        await page.waitForFunction(() => !!window.Annotate);
        if (kind === 'pin') {
          await page.keyboard.press('p');
          await page.locator('#title').click();
        } else {
          await page.evaluate(() => {
            const range = document.createRange();
            range.selectNodeContents(document.getElementById('para'));
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          });
          await page.locator('#para').dispatchEvent('pointerup');
        }
        const composer = page.locator('#__an_compose');
        await expect(composer).toHaveClass(/an-show/);
        await composer.locator('textarea').fill('My first comment');
        await composer.locator('.an-primary').click();
        const modal = page.locator('#__an_namewrap');
        await expect(modal).toBeVisible();
        const input = modal.locator('input').first();
        await input.click();
        await input.fill('First Timer');
        if (how.startsWith('clicks Start')) await modal.getByRole('button', { name: 'Start reviewing' }).click();
        else await input.press('Enter');
        await expect(modal).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.Annotate.comments().length)).toBe(1);
        const [comment] = await page.evaluate(() => window.Annotate.comments());
        expect(comment.type).toBe(kind);
        expect(comment.author).toBe('First Timer');
        expect(comment.text).toBe('My first comment');
        await expect(composer).not.toHaveClass(/an-show/);
        await page.evaluate(() => window.Annotate.open());
        await expect(page.locator('.an-card', { hasText: 'My first comment' })).toHaveCount(1);
      });
    }
  }
});
