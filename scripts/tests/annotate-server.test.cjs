// Conformance suite for the annotate wire protocol v1 (docs/backlog/wire-protocol.md).
//
// By default it starts examples/annotate-server.cjs on a random port with a
// temporary data directory. To check another backend, point it there:
//
//   API_URL=https://api.example.com ANNOTATE_REVIEW_ID=rvw_x ANNOTATE_ORIGIN=https://site.example \
//   ANNOTATE_INVITE_A=... ANNOTATE_INVITE_B=... ANNOTATE_INVITE_REVOKED=... ANNOTATE_INVITE_EXPIRED=... \
//   node --test scripts/tests/annotate-server.test.cjs
//
// Invites A and B must be two different reviewers without author rights;
// ANNOTATE_INVITE_AUTHOR must be an author of the review.
// Tests that need server control (forced 429, tombstone purge) run only locally.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAnnotateServer } = require('../../examples/annotate-server.cjs');

const external = !!process.env.API_URL;
const ORIGIN = process.env.ANNOTATE_ORIGIN || 'http://localhost:4200';
const REVIEW = process.env.ANNOTATE_REVIEW_ID || 'rvw_conformance';
const INVITES = {
  a: process.env.ANNOTATE_INVITE_A || 'inv_alice',
  b: process.env.ANNOTATE_INVITE_B || 'inv_bob',
  author: process.env.ANNOTATE_INVITE_AUTHOR || 'inv_owner',
  revoked: process.env.ANNOTATE_INVITE_REVOKED || 'inv_revoked',
  expired: process.env.ANNOTATE_INVITE_EXPIRED || 'inv_expired',
};
const RUN = randomUUID().slice(0, 8);
const PAGE = '/conformance/' + RUN;

let base, server, directory, clock = 0;

before(async () => {
  if (external) {
    base = process.env.API_URL.replace(/\/$/, '') + '/v1/annotate';
    return;
  }
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'annotate-server-'));
  server = createAnnotateServer({
    dataDir: directory,
    now: () => Date.now() + clock,
    purgeAfterDays: 30,
    writesPerMinute: 1000,
    reviews: [{
      id: REVIEW, name: 'Conformance', note: 'Check everything', pages: [PAGE], origins: [ORIGIN],
      authors: ['rvr_owner'],
      invites: [
        { token: INVITES.author, reviewer: { id: 'rvr_owner', name: 'Owner' } },
        { token: INVITES.a, reviewer: { id: 'rvr_alice', name: 'Alice' } },
        { token: INVITES.b, reviewer: { id: 'rvr_bob', name: 'Bob' } },
        { token: INVITES.revoked, reviewer: { id: 'rvr_gone', name: 'Gone' }, revoked: true },
        { token: INVITES.expired, reviewer: { id: 'rvr_old', name: 'Old' }, expiresAt: '2020-01-01T00:00:00Z' },
      ],
    }, {
      id: 'rvw_open', name: 'Open review', origins: [ORIGIN], open: true, invites: [],
    }],
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1/annotate`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

function call(method, route, { token, body, headers = {}, origin = ORIGIN, raw } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined) h['Content-Type'] = h['Content-Type'] || 'application/json';
  if (method !== 'GET' && method !== 'OPTIONS' && !h['Idempotency-Key']) h['Idempotency-Key'] = randomUUID();
  return fetch(base + route, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
}
async function json(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function session(invite) {
  const response = await call('POST', `/reviews/${REVIEW}/session`, { body: { invite } });
  assert.equal(response.status, 200);
  return json(response);
}
let seq = 0;
function newId() { return 'c' + RUN + (seq++).toString(36); }
function comment(id, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema: 2, id, page: PAGE, url: 'http://localhost:4200' + PAGE, type: 'pin', author: 'ignored', authorId: null,
    text: 'Fix this', color: '#f59e0b', anchor: null,
    geom: { kind: 'pin', selector: 'body', x: 0.25, y: 0.5, vw: 1280, vh: 720 },
    visibility: 'shared', status: 'open', resolved: false, resolvedBy: null, resolvedAt: null,
    assignee: null, assignedAt: null, replies: [], createdAt: now, updatedAt: now, editedAt: null,
    ...overrides,
  };
}
async function put(token, record, headers) {
  return call('PUT', `/reviews/${REVIEW}/comments/${record.id}`, { token, body: record, headers });
}

test('session exchange returns reviewer and review, and refuses bad invites', async () => {
  const alice = await session(INVITES.a);
  assert.equal(typeof alice.token, 'string');
  assert.ok(Date.parse(alice.expiresAt) > Date.now());
  assert.equal(typeof alice.reviewer.id, 'string');
  assert.equal(typeof alice.reviewer.name, 'string');
  assert.equal(alice.reviewer.role, 'reviewer');
  assert.equal((await session(INVITES.author)).reviewer.role, 'author');
  assert.equal(alice.review.id, REVIEW);
  assert.equal(typeof alice.review.note, 'string');
  const again = await session(INVITES.a);
  assert.equal(again.reviewer.id, alice.reviewer.id, 'an invite maps to one stable reviewer');
  assert.notEqual(again.token, alice.token);

  for (const [invite, code] of [['nope-' + RUN, 'invite_invalid'], [INVITES.revoked, 'invite_revoked'], [INVITES.expired, 'invite_expired']]) {
    const response = await call('POST', `/reviews/${REVIEW}/session`, { body: { invite } });
    assert.equal(response.status, 403, invite);
    assert.deepEqual(await json(response), { error: code });
  }
  const missing = await call('POST', '/reviews/rvw_missing_' + RUN + '/session', { body: { invite: INVITES.a } });
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).error, 'review_not_found');
});

test('open reviews accept a display name without an invite', { skip: external }, async () => {
  const response = await call('POST', '/reviews/rvw_open/session', { body: { name: 'Guest' } });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.reviewer.name, 'Guest');
  const closed = await call('POST', `/reviews/${REVIEW}/session`, { body: { name: 'Guest' } });
  assert.equal(closed.status, 403);
});

test('origin is checked on every request and CORS reflects only registered origins', async () => {
  const preflight = await call('OPTIONS', `/reviews/${REVIEW}/comments/x`, {
    headers: { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const allowed = preflight.headers.get('access-control-allow-headers').toLowerCase();
  for (const header of ['authorization', 'content-type', 'idempotency-key', 'if-none-match']) assert.ok(allowed.includes(header), header);
  const exposed = (preflight.headers.get('access-control-expose-headers') || '').toLowerCase();
  assert.ok(exposed.includes('etag') && exposed.includes('retry-after'));

  const foreign = await call('POST', `/reviews/${REVIEW}/session`, { body: { invite: INVITES.a }, origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await json(foreign)).error, 'origin_not_allowed');
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);

  const { token } = await session(INVITES.a);
  const foreignRead = await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(PAGE)}`, { token, origin: 'https://evil.example' });
  assert.equal(foreignRead.status, 403);
  const noOrigin = await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(PAGE)}`, { token, origin: null });
  assert.equal(noOrigin.status, 403);
});

test('requests without a valid session are 401', async () => {
  const anonymous = await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(PAGE)}`);
  assert.equal(anonymous.status, 401);
  const bogus = await call('PUT', `/reviews/${REVIEW}/comments/${newId()}`, { token: 'bogus', body: comment(newId()) });
  assert.equal(bogus.status, 401);
});

test('expired sessions are 401 and a fresh exchange recovers', { skip: external }, async () => {
  const { token } = await session(INVITES.a);
  server.annotate.expireSessions();
  const expired = await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(PAGE)}`, { token });
  assert.equal(expired.status, 401);
  const fresh = await session(INVITES.a);
  const ok = await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(PAGE)}`, { token: fresh.token });
  assert.equal(ok.status, 200);
});

test('PUT creates with server identity and timestamps, then updates', async () => {
  const alice = await session(INVITES.a);
  const id = newId();
  const created = await put(alice.token, comment(id, { author: 'Mallory', authorId: 'rvr_mallory', replies: [{ id: 'r1', text: 'x' }] }));
  assert.equal(created.status, 201);
  const stored = (await json(created)).comment;
  assert.equal(stored.schema, 2);
  assert.equal(stored.id, id);
  assert.equal(stored.author, alice.reviewer.name, 'author comes from the session');
  assert.equal(stored.authorId, alice.reviewer.id);
  assert.deepEqual(stored.replies, [], 'replies are ignored on PUT');
  assert.equal(stored.status, 'open');
  assert.equal(stored.resolved, false);
  assert.equal(stored.visibility, 'shared');
  assert.ok(Date.parse(stored.updatedAt));
  assert.equal(stored.editedAt, null);

  const edited = await put(alice.token, { ...stored, text: 'Fix this now' });
  assert.equal(edited.status, 200);
  const after = (await json(edited)).comment;
  assert.equal(after.text, 'Fix this now');
  assert.ok(after.updatedAt > stored.updatedAt);
  assert.ok(after.editedAt, 'editedAt is set when text changes');
});

test('Idempotency-Key replays the stored response', async () => {
  const alice = await session(INVITES.a);
  const id = newId();
  const key = randomUUID();
  const first = await put(alice.token, comment(id), { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  const firstBody = await json(first);
  const replay = await put(alice.token, comment(id, { text: 'different body, same key' }), { 'Idempotency-Key': key });
  assert.ok(replay.status === 200 || replay.status === 201);
  assert.deepEqual(await json(replay), firstBody);
});

test('GET lists the page in createdAt order with ETag and 304', async () => {
  const alice = await session(INVITES.a);
  const page = PAGE + '/list';
  const later = newId(), earlier = newId();
  await put(alice.token, comment(later, { page, createdAt: '2026-01-02T00:00:00.000Z' }));
  await put(alice.token, comment(earlier, { page, createdAt: '2026-01-01T00:00:00.000Z' }));
  await put(alice.token, comment(newId(), { page: page + '/other' }));
  const route = `/reviews/${REVIEW}/comments?page=${encodeURIComponent(page)}`;
  const listed = await call('GET', route, { token: alice.token });
  assert.equal(listed.status, 200);
  const etag = listed.headers.get('etag');
  assert.ok(etag);
  const { comments } = await json(listed);
  assert.deepEqual(comments.map(c => c.id), [earlier, later]);

  const unchanged = await call('GET', route, { token: alice.token, headers: { 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');

  await put(alice.token, { ...comments[0], text: 'changed' });
  const changed = await call('GET', route, { token: alice.token, headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
});

test('validation: unknown keys dropped, __ keys and bad values rejected, private never stored', async () => {
  const alice = await session(INVITES.a);
  const id = newId();
  const ok = await put(alice.token, { ...comment(id), extra: 'drop me', geom: { kind: 'pin', selector: 'body', x: 0.1, y: 0.2, junk: 1 } });
  assert.equal(ok.status, 201);
  const stored = (await json(ok)).comment;
  assert.equal('extra' in stored, false);
  assert.equal('junk' in stored.geom, false);

  const cases = [
    { __unanchored: 'lost' },
    { geom: { kind: 'pin', selector: 'body', x: 0.1, y: 0.2, __anchorMissing: true } },
    { color: 'red' },
    { color: 'url(javascript:alert(1))' },
    { type: 'bogus' },
    { text: 'x'.repeat(5001) },
    { status: 'done' },
    { visibility: 'private' },
    { type: 'highlight', anchor: null, geom: null },
    { type: 'shape', geom: { kind: 'pin', x: 0, y: 0 } },
    { geom: { kind: 'pin', selector: 'body', x: null, y: 0 } },
  ];
  for (const overrides of cases) {
    const response = await put(alice.token, comment(newId(), overrides));
    assert.equal(response.status, 422, JSON.stringify(overrides));
    const body = await json(response);
    assert.equal(body.error, 'invalid_comment');
    assert.deepEqual(Object.keys(body).filter(k => k !== 'error' && k !== 'message'), []);
  }
  const mismatch = await call('PUT', `/reviews/${REVIEW}/comments/${newId()}`, { token: alice.token, body: comment('other-id') });
  assert.equal(mismatch.status, 422);
  const badJson = await call('PUT', `/reviews/${REVIEW}/comments/${newId()}`, { token: alice.token, raw: '{', headers: { 'Content-Type': 'application/json' } });
  assert.equal(badJson.status, 400);
  assert.equal((await json(badJson)).error, 'invalid_json');
  const notJson = await call('PUT', `/reviews/${REVIEW}/comments/${newId()}`, { token: alice.token, raw: 'x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(notJson.status, 415);
  const huge = await put(alice.token, comment(newId(), { text: 'x'.repeat(300 * 1024) }));
  assert.equal(huge.status, 413);
  assert.equal((await json(huge)).error, 'too_large');
});

test('a 10,000-point pen stroke fits the body cap', async () => {
  const alice = await session(INVITES.a);
  const points = Array.from({ length: 10000 }, (_, i) => [Math.round(i / 10000 * 1e4) / 1e4, 0.5]);
  const response = await put(alice.token, comment(newId(), { type: 'pen', geom: { kind: 'pen', selector: 'body', points, vw: 1280, vh: 720 } }));
  assert.equal(response.status, 201);
});

test('visibility: reviewers see only their own comments; authors see all', async () => {
  const alice = await session(INVITES.a);
  const bob = await session(INVITES.b);
  const owner = await session(INVITES.author);
  const page = PAGE + '/private';
  const id = newId();
  const stored = (await json(await put(alice.token, comment(id, { page })))).comment;
  await call('POST', `/reviews/${REVIEW}/comments/${id}/replies`, { token: alice.token, body: { id: 'r-alice', text: 'context' } });
  const bobsOwn = newId();
  await put(bob.token, comment(bobsOwn, { page }));
  const list = token => call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(page)}`, { token }).then(json).then(b => b.comments.map(c => c.id));

  assert.deepEqual(await list(alice.token), [id]);
  assert.deepEqual(await list(bob.token), [bobsOwn], 'another reviewer never sees the comment');
  assert.deepEqual((await list(owner.token)).sort(), [id, bobsOwn].sort(), 'authors see every comment');
  const whole = await json(await call('GET', `/reviews/${REVIEW}/comments`, { token: bob.token }));
  assert.ok(whole.comments.every(c => c.authorId === bob.reviewer.id), 'the whole-review listing is filtered too');

  // Every route treats another reviewer's comment as out of reach, and none returns it.
  for (const body of [{ ...stored, text: 'hijack' }, { ...stored, status: 'resolved' }, { ...stored, updatedAt: '2000-01-01T00:00:00.000Z' }]) {
    const response = await put(bob.token, body);
    assert.equal(response.status, 403);
    assert.deepEqual(await json(response), { error: 'not_owner' });
  }
  const reply = await call('POST', `/reviews/${REVIEW}/comments/${id}/replies`, { token: bob.token, body: { id: 'r-bob', text: 'peek' } });
  assert.equal(reply.status, 404);
  assert.deepEqual(await json(reply), { error: 'comment_not_found' });
  const activity = await call('GET', `/reviews/${REVIEW}/comments/${id}/activity`, { token: bob.token });
  assert.equal(activity.status, 404);
  const removeReply = await call('DELETE', `/reviews/${REVIEW}/comments/${id}/replies/r-alice`, { token: bob.token });
  assert.equal(removeReply.status, 204);
  const deny = await call('DELETE', `/reviews/${REVIEW}/comments/${id}`, { token: bob.token });
  assert.equal(deny.status, 403);
  assert.deepEqual(await json(deny), { error: 'not_owner' });
  const after = (await json(await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(page)}`, { token: alice.token }))).comments[0];
  assert.equal(after.text, 'Fix this');
  assert.equal(after.status, 'open');
  assert.deepEqual(after.replies.map(r => r.id), ['r-alice']);
});

test('ownership: the creator edits and closes; only authors assign', async () => {
  const alice = await session(INVITES.a);
  const owner = await session(INVITES.author);
  const id = newId();
  const created = (await json(await put(alice.token, comment(id, { assignee: { id: 'rvr_alice', name: 'Alice' } })))).comment;
  assert.equal(created.assignee, null, 'a reviewer cannot self-assign on create');

  const selfAssign = await put(alice.token, { ...created, assignee: { id: alice.reviewer.id, name: alice.reviewer.name } });
  assert.equal(selfAssign.status, 403);
  assert.deepEqual(await json(selfAssign), { error: 'not_author' });

  const assigned = await put(owner.token, { ...created, assignee: { id: owner.reviewer.id, name: owner.reviewer.name }, status: 'in_progress' });
  assert.equal(assigned.status, 200);
  const record = (await json(assigned)).comment;
  assert.deepEqual(record.assignee, { id: owner.reviewer.id, name: owner.reviewer.name });
  assert.ok(record.assignedAt);
  assert.equal(record.status, 'in_progress');

  const withdrawn = await put(alice.token, { ...record, status: 'wont_fix' });
  assert.equal(withdrawn.status, 200, 'the creator may close their own comment');
  assert.equal((await json(withdrawn)).comment.assignee.id, owner.reviewer.id, 'an unchanged assignee is not a reviewer change');
});

test('lifecycle: status transitions stamp and clear resolution; resolved is derived', async () => {
  const alice = await session(INVITES.a);
  const owner = await session(INVITES.author);
  const id = newId();
  let record = (await json(await put(alice.token, comment(id)))).comment;

  record = (await json(await put(owner.token, { ...record, status: 'resolved' }))).comment;
  assert.equal(record.status, 'resolved');
  assert.equal(record.resolved, true);
  assert.equal(record.resolvedBy, owner.reviewer.id);
  assert.ok(record.resolvedAt);

  record = (await json(await put(alice.token, { ...record, status: 'open' }))).comment;
  assert.equal(record.resolved, false);
  assert.equal(record.resolvedBy, null);
  assert.equal(record.resolvedAt, null);

  record = (await json(await put(alice.token, { ...record, status: 'wont_fix' }))).comment;
  assert.equal(record.resolved, true, 'wont_fix is a closed state');
  assert.equal(record.resolvedBy, alice.reviewer.id);

  // 1.4 clients only know the boolean.
  const { status, ...legacyOpen } = { ...record, resolved: false };
  record = (await json(await put(alice.token, legacyOpen))).comment;
  assert.equal(record.status, 'open');
  const { status: _s, ...legacyClosed } = { ...record, resolved: true };
  record = (await json(await put(alice.token, legacyClosed))).comment;
  assert.equal(record.status, 'resolved');
  // Contradictory body: status wins, resolved is re-derived.
  record = (await json(await put(alice.token, { ...record, status: 'in_progress', resolved: true }))).comment;
  assert.equal(record.status, 'in_progress');
  assert.equal(record.resolved, false);
});

test('stale writes are 409 with the stored record', async () => {
  const alice = await session(INVITES.a);
  const owner = await session(INVITES.author);
  const id = newId();
  const original = (await json(await put(alice.token, comment(id)))).comment;
  const owners = (await json(await put(owner.token, { ...original, status: 'resolved' }))).comment;
  const stale = await put(alice.token, { ...original, text: 'edit from an old base' });
  assert.equal(stale.status, 409);
  const body = await json(stale);
  assert.equal(body.error, 'stale');
  assert.deepEqual(body.comment, owners);
  const rebased = await put(alice.token, { ...body.comment, text: 'edit from an old base' });
  assert.equal(rebased.status, 200);
  const merged = (await json(rebased)).comment;
  assert.equal(merged.text, 'edit from an old base');
  assert.equal(merged.status, 'resolved', 'the concurrent status change survives the re-applied edit');
});

test('replies append server-side, are idempotent by id, and delete by owner only', async () => {
  const alice = await session(INVITES.a);
  const owner = await session(INVITES.author);
  const id = newId();
  await put(alice.token, comment(id));
  const route = `/reviews/${REVIEW}/comments/${id}/replies`;
  const [one, two] = await Promise.all([
    call('POST', route, { token: alice.token, body: { id: 'r-a-' + RUN, text: 'first' } }),
    call('POST', route, { token: owner.token, body: { id: 'r-o-' + RUN, text: 'second', author: 'Spoof' } }),
  ]);
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  const repeat = await call('POST', route, { token: owner.token, body: { id: 'r-o-' + RUN, text: 'second' } });
  assert.equal(repeat.status, 200);
  const record = (await json(repeat)).comment;
  assert.deepEqual(record.replies.map(r => r.id).sort(), ['r-a-' + RUN, 'r-o-' + RUN].sort(), 'concurrent replies do not clobber');
  const ownersReply = record.replies.find(r => r.id === 'r-o-' + RUN);
  assert.equal(ownersReply.author, owner.reviewer.name);
  assert.equal(ownersReply.authorId, owner.reviewer.id);
  assert.equal(ownersReply.editedAt, null);

  const deny = await call('DELETE', `${route}/r-o-${RUN}`, { token: alice.token });
  assert.equal(deny.status, 403, 'a reviewer cannot delete an author reply on their own comment');
  const own = await call('DELETE', `${route}/r-a-${RUN}`, { token: alice.token });
  assert.equal(own.status, 204);
  const again = await call('DELETE', `${route}/r-a-${RUN}`, { token: alice.token });
  assert.equal(again.status, 204);
  const authorRemoves = await call('DELETE', `${route}/r-o-${RUN}`, { token: owner.token });
  assert.equal(authorRemoves.status, 204);

  const missing = await call('POST', `/reviews/${REVIEW}/comments/${newId()}/replies`, { token: alice.token, body: { id: 'r', text: 'x' } });
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).error, 'comment_not_found');
  const empty = await call('POST', route, { token: alice.token, body: { id: 'r-empty', text: '  ' } });
  assert.equal(empty.status, 422);
});

test('delete leaves a tombstone: hidden, 410 on later writes, visible with include=deleted', async () => {
  const alice = await session(INVITES.a);
  const page = PAGE + '/tomb';
  const id = newId();
  const stored = (await json(await put(alice.token, comment(id, { page })))).comment;
  const removed = await call('DELETE', `/reviews/${REVIEW}/comments/${id}`, { token: alice.token });
  assert.equal(removed.status, 204);
  assert.equal((await call('DELETE', `/reviews/${REVIEW}/comments/${id}`, { token: alice.token })).status, 204);
  assert.equal((await call('DELETE', `/reviews/${REVIEW}/comments/${newId()}`, { token: alice.token })).status, 204);

  const listed = await json(await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(page)}`, { token: alice.token }));
  assert.deepEqual(listed.comments, []);
  const withDeleted = await json(await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(page)}&include=deleted`, { token: alice.token }));
  assert.equal(withDeleted.comments.length, 1);
  assert.ok(withDeleted.comments[0].deletedAt);

  const resurrect = await put(alice.token, stored);
  assert.equal(resurrect.status, 410);
  assert.equal((await json(resurrect)).error, 'deleted');
  const reply = await call('POST', `/reviews/${REVIEW}/comments/${id}/replies`, { token: alice.token, body: { id: 'r1', text: 'late' } });
  assert.equal(reply.status, 410);
});

test('activity log tracks the full lifecycle', async () => {
  const alice = await session(INVITES.a);
  const owner = await session(INVITES.author);
  const id = newId();
  let record = (await json(await put(alice.token, comment(id)))).comment;
  record = (await json(await put(alice.token, { ...record, text: 'edited' }))).comment;
  record = (await json(await put(owner.token, { ...record, assignee: { id: owner.reviewer.id, name: owner.reviewer.name }, status: 'in_progress' }))).comment;
  await call('POST', `/reviews/${REVIEW}/comments/${id}/replies`, { token: owner.token, body: { id: 'r1', text: 'on it' } });
  record = (await json(await call('GET', `/reviews/${REVIEW}/comments?page=${encodeURIComponent(PAGE)}`, { token: alice.token }))).comments.find(c => c.id === id);
  await put(owner.token, { ...record, status: 'resolved' });
  await call('DELETE', `/reviews/${REVIEW}/comments/${id}`, { token: alice.token });

  const response = await call('GET', `/reviews/${REVIEW}/comments/${id}/activity`, { token: alice.token });
  assert.equal(response.status, 200);
  const { events } = await json(response);
  assert.deepEqual(events.map(e => e.kind), ['created', 'edited', 'status', 'assigned', 'replied', 'status', 'deleted']);
  assert.deepEqual(events[1].fields, ['text']);
  assert.deepEqual([events[2].from, events[2].to], ['open', 'in_progress']);
  assert.equal(events[3].to.id, owner.reviewer.id);
  assert.equal(events[4].replyId, 'r1');
  assert.deepEqual([events[5].from, events[5].to], ['in_progress', 'resolved']);
  assert.equal(events[6].by.id, alice.reviewer.id);
  for (const event of events) assert.ok(Date.parse(event.at));
  const missing = await call('GET', `/reviews/${REVIEW}/comments/${newId()}/activity`, { token: alice.token });
  assert.equal(missing.status, 404);
});

test('429 carries Retry-After and the write can be retried with the same key', { skip: external }, async () => {
  const alice = await session(INVITES.a);
  server.annotate.throttle(1, 2);
  const id = newId();
  const key = randomUUID();
  const limited = await put(alice.token, comment(id), { 'Idempotency-Key': key });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '2');
  assert.equal((await json(limited)).error, 'rate_limited');
  const retried = await put(alice.token, comment(id), { 'Idempotency-Key': key });
  assert.equal(retried.status, 201, 'a throttled request is not cached as the idempotent response');
});

test('tombstones are purged after the retention window and the id becomes free', { skip: external }, async () => {
  const alice = await session(INVITES.a);
  const id = newId();
  await put(alice.token, comment(id));
  await call('DELETE', `/reviews/${REVIEW}/comments/${id}`, { token: alice.token });
  clock = 31 * 86400000;
  try {
    // Purge runs when a review is loaded from disk; drop the in-memory copy.
    const fresh = createAnnotateServer({ dataDir: directory, now: () => Date.now() + clock, reviews: [] });
    assert.equal(fresh.annotate.review(REVIEW).comments[id], undefined);
    assert.equal(fresh.annotate.review(REVIEW).activity[id], undefined);
  } finally {
    clock = 0;
  }
});

test('error bodies never leak internals', async () => {
  const alice = await session(INVITES.a);
  const response = await call('GET', `/reviews/${REVIEW}/nope`, { token: alice.token });
  assert.equal(response.status, 404);
  const body = await json(response);
  assert.match(body.error, /^[a-z_]+$/);
});
