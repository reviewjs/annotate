// @ts-check
// End-to-end tests for the remote store against the reference server
// (examples/annotate-server.cjs), started in-process on a random port.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAnnotateServer } = require('../examples/annotate-server.cjs');

const ORIGIN = 'http://localhost:4200';
const REVIEW = 'rvw_e2e';
let server, api, directory;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'annotate-e2e-'));
  server = createAnnotateServer({
    dataDir: directory,
    writesPerMinute: 10000,
    reviews: [{
      id: REVIEW, name: 'E2E review', note: 'Check the pricing copy', origins: [ORIGIN],
      authors: ['rvr_owner'],
      invites: [
        { token: 'inv_owner', reviewer: { id: 'rvr_owner', name: 'Owner' } },
        { token: 'inv_alice', reviewer: { id: 'rvr_alice', name: 'Alice' } },
        { token: 'inv_bob', reviewer: { id: 'rvr_bob', name: 'Bob' } },
        { token: 'inv_revoked', reviewer: { id: 'rvr_gone', name: 'Gone' }, revoked: true },
      ],
    }],
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

let pageCounter = 0;
// Each test gets its own page key so server state never leaks between tests.
function fixturePath() { return `/__remote/${test.info().project.name}/${Date.now().toString(36)}-${pageCounter++}`; }

async function openReview(page, route, { invite } = {}) {
  await page.addInitScript(() => {
    window.__events = [];
    ['annotate:auth', 'annotate:sync'].forEach(name => window.addEventListener(name, e => window.__events.push({ name, detail: e.detail })));
  });
  const query = new URLSearchParams({ api, review: REVIEW, page: route });
  if (invite) query.set('an_invite', invite);
  await page.goto('/tests/fixtures/remote?' + query);
  await page.waitForFunction(() => !!window.Annotate);
  await page.evaluate(() => window.Annotate.open());
}
async function waitForAuth(page) {
  await page.waitForFunction(() => window.__events.some(e => e.name === 'annotate:auth'));
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
async function serverComments(route, includeDeleted) {
  const data = server.annotate.review(REVIEW);
  return Object.values(data.comments).filter(c => c.page === route && (includeDeleted || !c.deletedAt));
}
async function waitForServer(route, predicate, timeout = 10000) {
  const until = Date.now() + timeout;
  for (;;) {
    const list = await serverComments(route, true);
    if (predicate(list)) return list;
    if (Date.now() > until) throw new Error('server never matched: ' + JSON.stringify(list));
    await new Promise(r => setTimeout(r, 100));
  }
}

test('invite link: token is persisted and stripped, identity comes from the server, writes land', async ({ page }) => {
  const route = fixturePath();
  await openReview(page, route, { invite: 'inv_alice' });
  await waitForAuth(page);
  expect(new URL(page.url()).searchParams.get('an_invite')).toBeNull();
  expect(await page.evaluate(id => localStorage.getItem('annotate:invite:' + id), REVIEW)).toBe('inv_alice');
  await expect(page.locator('#__an_namewrap')).toHaveCount(0);

  await addPin(page, 'Price looks wrong');
  const [stored] = await waitForServer(route, list => list.length === 1);
  expect(stored.author).toBe('Alice');
  expect(stored.authorId).toBe('rvr_alice');
  expect(stored.text).toBe('Price looks wrong');
  expect(stored.page).toBe(route);
  await expect(page.locator('#__an_syncnote')).toHaveAttribute('data-state', 'idle');
  expect(Object.keys(stored).some(k => k.startsWith('__'))).toBe(false);
});

test('commenting before the invite exchange returns waits for it instead of asking for a name', async ({ page }) => {
  const route = fixturePath();
  // Hold the session exchange so the reviewer posts before their name is known.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(api + '/**/session', async r => { await held; await r.continue(); });
  await openReview(page, route, { invite: 'inv_alice' });
  await page.keyboard.press('p');
  await page.locator('#title').click();
  const composer = page.locator('#__an_compose');
  await composer.locator('textarea').fill('Posted before sign-in finished');
  await composer.locator('.an-primary').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#__an_namewrap')).toHaveCount(0);
  release();
  await expect(page.locator('.an-card', { hasText: 'Posted before sign-in finished' })).toHaveCount(1);
  const [stored] = await waitForServer(route, list => list.length === 1);
  expect(stored.author).toBe('Alice');
  expect(stored.authorId).toBe('rvr_alice');
  await expect(page.locator('#__an_namewrap')).toHaveCount(0);
});

test('revoked invite falls back to local-only mode with a visible message', async ({ page }) => {
  const route = fixturePath();
  await openReview(page, route, { invite: 'inv_revoked' });
  await expect(page.locator('.an-toast', { hasText: 'no longer valid' })).toBeVisible();
  await expect(page.locator('#__an_syncnote')).toHaveCount(0);
  expect(await page.evaluate(() => window.Annotate.syncState().state)).toBe('local');
});

test('offline create survives reload and lands once the server is reachable', async ({ page }) => {
  const route = fixturePath();
  await openReview(page, route, { invite: 'inv_alice' });
  await waitForAuth(page);
  await page.route(api + '/**', r => r.abort('internetdisconnected'));
  await addPin(page, 'Written offline');
  await expect(page.locator('#__an_syncnote')).toHaveAttribute('data-state', 'offline');
  const queued = await page.evaluate(id => JSON.parse(localStorage.getItem('annotate:queue:' + id)), REVIEW);
  expect(queued.map(op => op.t)).toEqual(['put']);
  expect(await serverComments(route)).toHaveLength(0);

  await page.unroute(api + '/**');
  await page.reload();
  await page.waitForFunction(() => !!window.Annotate);
  const [stored] = await waitForServer(route, list => list.length === 1);
  expect(stored.text).toBe('Written offline');
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem('annotate:queue:' + id) || '[]').length, REVIEW)).toBe(0);
});

test('reviewer lifecycle: private comments, owner addresses and disposes, reviewer sees it, reopens, edits, deletes', async ({ browser, baseURL }) => {
  const route = fixturePath();
  const alice = await (await browser.newContext({ baseURL })).newPage();
  const bob = await (await browser.newContext({ baseURL })).newPage();
  const owner = await (await browser.newContext({ baseURL })).newPage();
  try {
    await openReview(alice, route, { invite: 'inv_alice' });
    await openReview(bob, route, { invite: 'inv_bob' });
    await openReview(owner, route, { invite: 'inv_owner' });
    await Promise.all([waitForAuth(alice), waitForAuth(bob), waitForAuth(owner)]);
    await expect(alice.locator('#__an_syncnote')).toContainText('Only you and the review owner');

    await addPin(alice, 'Alice private concern');
    await addPin(bob, 'Bob private concern');
    await waitForServer(route, list => list.length === 2);

    // The owner sees both; each reviewer keeps seeing only their own, poll after poll.
    await expect(owner.locator('.an-card')).toHaveCount(2, { timeout: 5000 });
    await bob.waitForTimeout(1600);
    await expect(bob.locator('.an-card')).toHaveCount(1);
    await expect(bob.locator('.an-card', { hasText: 'Alice private concern' })).toHaveCount(0);
    await expect(alice.locator('.an-card', { hasText: 'Bob private concern' })).toHaveCount(0);
    expect(await bob.evaluate(() => window.Annotate.comments().map(c => c.text))).toEqual(['Bob private concern']);
    await expect(alice.locator('.an-mini', { hasText: 'Assign to me' })).toHaveCount(0);

    // The owner takes Alice's comment on, replies, and resolves it.
    const ownerCard = owner.locator('.an-card', { hasText: 'Alice private concern' });
    await ownerCard.hover();
    await ownerCard.locator('.an-mini', { hasText: 'Assign to me' }).click();
    await ownerCard.locator('select.an-status').selectOption('in_progress');
    const aliceCard = alice.locator('.an-card', { hasText: 'Alice private concern' });
    await expect(aliceCard.locator('.an-assignee')).toHaveText('Assigned to Owner', { timeout: 5000 });
    await expect(aliceCard.locator('.an-sbadge')).toHaveText('In progress');
    await ownerCard.locator('.an-mini', { hasText: 'Reply' }).click();
    await ownerCard.locator('.an-replybox textarea').fill('Fixed in the next deploy');
    await ownerCard.locator('.an-replybox .an-primary').click();
    await expect(aliceCard.locator('.an-reply')).toContainText('Fixed in the next deploy', { timeout: 5000 });
    await expect(aliceCard.locator('.an-newpill')).toBeVisible();
    await expect(aliceCard.locator('select.an-status')).toHaveCount(0);  // reviewers do not triage
    await aliceCard.locator('.an-newpill').click();
    await expect(aliceCard.locator('.an-newpill')).toHaveCount(0);

    // The owner disposes of it. Alice is told, and the card stays under Open until she has seen it.
    await ownerCard.hover();
    await ownerCard.locator('.an-mini', { hasText: 'Resolve' }).click();
    await expect(alice.locator('.an-toast', { hasText: 'The review owner updated 1 of your comments' }).last()).toBeVisible({ timeout: 5000 });
    await expect(aliceCard.locator('.an-disposal')).toContainText('Resolved by Owner');
    await expect(aliceCard.locator('.an-newpill')).toBeVisible();
    const [stored] = (await waitForServer(route, list => list.some(c => c.text === 'Alice private concern' && c.status === 'resolved')))
      .filter(c => c.text === 'Alice private concern');
    expect(stored.resolvedBy).toBe('rvr_owner');
    expect(stored.assignee).toEqual({ id: 'rvr_owner', name: 'Owner' });
    await aliceCard.locator('.an-newpill').click();
    await expect(aliceCard).toHaveCount(0);   // seen, closed: off the Open list
    await expect(bob.locator('.an-card')).toHaveCount(1);

    // Alice disagrees: reopens from the Resolved list and edits her comment.
    await alice.locator('.an-chip[data-f="resolved"]').click();
    await aliceCard.hover();
    await aliceCard.locator('.an-mini', { hasText: 'Reopen' }).click();
    await alice.locator('.an-chip[data-f="open"]').click();
    await aliceCard.hover();
    await aliceCard.locator('.an-mini', { hasText: 'Edit' }).click();
    await aliceCard.locator('.an-editbox textarea').fill('Alice private concern, still broken on mobile');
    await aliceCard.locator('.an-editbox .an-primary').click();
    await waitForServer(route, list => list.some(c => c.id === stored.id && c.status === 'open' && c.editedAt && c.text.endsWith('mobile')));
    // Her own changes are not "updates" to her.
    await alice.waitForTimeout(1600);
    await expect(alice.locator('.an-newpill')).toHaveCount(0);

    // History shows the whole lifecycle from the server's log.
    const editedCard = alice.locator('.an-card', { hasText: 'still broken on mobile' });
    await editedCard.hover();
    await editedCard.locator('.an-histbtn').click();
    const history = editedCard.locator('.an-hlist li');
    await expect(history).toHaveCount(7);
    await expect(history.nth(0)).toContainText('You raised this comment');
    await expect(editedCard.locator('.an-hlist')).toContainText('Owner assigned it to Owner');
    await expect(editedCard.locator('.an-hlist')).toContainText('Owner replied');
    await expect(editedCard.locator('.an-hlist')).toContainText('Owner changed status: In progress → Resolved');
    await expect(history.nth(5)).toContainText('You changed status: Resolved → Open');
    await expect(history.nth(6)).toContainText('You edited the comment');

    // Finally she withdraws it entirely.
    await editedCard.locator('[title="Delete"]').click();
    await alice.evaluate(() => window.Annotate.submit());
    await waitForServer(route, list => list.some(c => c.id === stored.id && c.deletedAt));
    await expect(owner.locator('.an-card', { hasText: 'still broken on mobile' })).toHaveCount(0, { timeout: 5000 });

    const events = server.annotate.review(REVIEW).activity[stored.id].map(e => e.kind);
    // Assignment and status may coalesce into one queued PUT; order within it is the server's.
    expect([events[0], ...events.slice(1, 3).sort(), ...events.slice(3)])
      .toEqual(['created', 'assigned', 'status', 'replied', 'status', 'status', 'edited', 'deleted']);
  } finally {
    await Promise.all([alice, bob, owner].map(p => p.context().close()));
  }
});

test('a remote delete removes the comment and a stale offline edit cannot resurrect it', async ({ browser, baseURL }) => {
  const route = fixturePath();
  const alice = await (await browser.newContext({ baseURL })).newPage();
  const alice2 = await (await browser.newContext({ baseURL })).newPage();
  try {
    await openReview(alice, route, { invite: 'inv_alice' });
    await openReview(alice2, route, { invite: 'inv_alice' });
    await waitForAuth(alice);
    await waitForAuth(alice2);
    await addPin(alice, 'Short-lived');
    const card2 = alice2.locator('.an-card', { hasText: 'Short-lived' });
    await expect(card2).toHaveCount(1, { timeout: 5000 });

    // The second tab goes offline and edits; meanwhile the first deletes.
    await alice2.route(api + '/**', r => r.abort('internetdisconnected'));
    await card2.hover();
    await card2.locator('.an-mini', { hasText: 'Resolve' }).click();
    const card1 = alice.locator('.an-card', { hasText: 'Short-lived' });
    await card1.hover();
    await card1.locator('[title="Delete"]').click();
    await alice.evaluate(() => window.Annotate.submit());   // ends the undo window
    await waitForServer(route, list => list.length === 1 && !!list[0].deletedAt);

    await alice2.unroute(api + '/**');
    await alice2.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(alice2.locator('.an-toast', { hasText: 'already deleted' })).toBeVisible({ timeout: 10000 });
    await alice2.locator('.an-chip[data-f="all"]').click();
    await expect(alice2.locator('.an-card', { hasText: 'Short-lived' })).toHaveCount(0);
    const [tomb] = await serverComments(route, true);
    expect(tomb.deletedAt).toBeTruthy();
    expect(tomb.status).toBe('open');
  } finally {
    await alice.context().close();
    await alice2.context().close();
  }
});

test('undo inside the window cancels the held delete', async ({ page }) => {
  const route = fixturePath();
  await openReview(page, route, { invite: 'inv_alice' });
  await waitForAuth(page);
  await addPin(page, 'Keep me');
  await waitForServer(route, list => list.length === 1);
  const card = page.locator('.an-card', { hasText: 'Keep me' });
  await card.hover();
  await card.locator('[title="Delete"]').click();
  await page.locator('.an-toast .an-taction', { hasText: 'Undo' }).click();
  await expect(page.locator('.an-card', { hasText: 'Keep me' })).toHaveCount(1);
  await page.waitForTimeout(6500);
  const list = await serverComments(route, true);
  expect(list).toHaveLength(1);
  expect(list[0].deletedAt).toBeUndefined();
  await expect(page.locator('.an-card', { hasText: 'Keep me' })).toHaveCount(1);
});

test('offline reply, then delete and undo: the reply still reaches the server', async ({ page }) => {
  const route = fixturePath();
  await openReview(page, route, { invite: 'inv_alice' });
  await waitForAuth(page);
  await addPin(page, 'Undo keeps my reply');
  await waitForServer(route, list => list.length === 1);
  await page.route(api + '/**', r => r.abort('internetdisconnected'));
  const card = page.locator('.an-card', { hasText: 'Undo keeps my reply' });
  await card.locator('.an-mini', { hasText: 'Reply' }).click();
  await card.locator('.an-replybox textarea').fill('Queued while offline');
  await card.locator('.an-replybox .an-primary').click();
  await card.hover();
  await card.locator('[title="Delete"]').click();
  await page.locator('.an-toast .an-taction', { hasText: 'Undo' }).click();
  await page.unroute(api + '/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const [stored] = await waitForServer(route, list => list.length === 1 && list[0].replies.length === 1);
  expect(stored.deletedAt).toBeUndefined();
  expect(stored.replies[0].text).toBe('Queued while offline');
  await page.waitForTimeout(1500);   // a poll or two later the reply is still shown
  await expect(page.locator('.an-card .an-reply')).toContainText('Queued while offline');
});

test('429 with Retry-After: 2 delays the retry', async ({ page }) => {
  const route = fixturePath();
  const puts = [];
  page.on('request', request => { if (request.method() === 'PUT') puts.push(Date.now()); });
  await openReview(page, route, { invite: 'inv_alice' });
  await waitForAuth(page);
  server.annotate.throttle(1, 2);
  await addPin(page, 'Throttled');
  await waitForServer(route, list => list.length === 1);
  expect(puts.length).toBe(2);
  expect(puts[1] - puts[0]).toBeGreaterThanOrEqual(1900);
});

test('typing a reply during a poll keeps the text, focus and open box', async ({ browser, baseURL }) => {
  const route = fixturePath();
  const alice = await (await browser.newContext({ baseURL })).newPage();
  const owner = await (await browser.newContext({ baseURL })).newPage();
  try {
    await openReview(alice, route, { invite: 'inv_alice' });
    await openReview(owner, route, { invite: 'inv_owner' });
    await waitForAuth(alice);
    await waitForAuth(owner);
    await addPin(alice, 'Discuss');
    const aliceCard = alice.locator('.an-card', { hasText: 'Discuss' });
    await aliceCard.locator('.an-mini', { hasText: 'Reply' }).click();
    const box = aliceCard.locator('.an-replybox textarea');
    await box.pressSequentially('Half-written thou');

    // The owner changes the status, so Alice's next poll re-renders the panel.
    const ownerCard = owner.locator('.an-card', { hasText: 'Discuss' });
    await expect(ownerCard).toHaveCount(1, { timeout: 5000 });
    await ownerCard.locator('select.an-status').selectOption('in_progress');
    await expect(aliceCard.locator('.an-sbadge')).toHaveText('In progress', { timeout: 5000 });

    await expect(box).toBeVisible();
    await expect(box).toHaveValue('Half-written thou');
    await expect(box).toBeFocused();
    await alice.keyboard.type('ght');
    await expect(box).toHaveValue('Half-written thought');
  } finally {
    await alice.context().close();
    await owner.context().close();
  }
});

test('expired session re-exchanges once and the write still lands', async ({ page }) => {
  const route = fixturePath();
  await openReview(page, route, { invite: 'inv_alice' });
  await waitForAuth(page);
  server.annotate.expireSessions();
  await addPin(page, 'After expiry');
  await waitForServer(route, list => list.length === 1);
  const sessions = await page.evaluate(() => window.__events.filter(e => e.name === 'annotate:auth').length);
  expect(sessions).toBe(2);
});

test('exports are schema v2 and never carry runtime keys', async ({ page }) => {
  const route = fixturePath();
  await openReview(page, route, { invite: 'inv_alice' });
  await waitForAuth(page);
  await addPin(page, 'Exported');
  const payload = await page.evaluate(() => window.Annotate.submit());
  expect(payload.schema).toBe(2);
  expect(payload.comments).toHaveLength(1);
  const keys = JSON.stringify(payload).match(/"__[a-zA-Z]+"/g);
  expect(keys).toBeNull();
  expect(payload.comments[0]).toMatchObject({ schema: 2, status: 'open', authorId: 'rvr_alice', visibility: 'shared' });
});
