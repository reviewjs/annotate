// Reference backend for the annotate wire protocol v1 (docs/backlog/wire-protocol.md).
// Zero dependencies. Stores one JSON file per review on disk.
//
// Run:
//   ANNOTATE_CONFIG=./annotate-reviews.json DATA_DIR=./annotate-data node examples/annotate-server.cjs
//
// ANNOTATE_CONFIG is a JSON file:
//   { "reviews": [{
//       "id": "rvw_demo", "name": "Demo review", "note": "Check the pricing copy",
//       "pages": ["/pricing"], "origins": ["http://localhost:4200"],
//       "open": false,              // true allows { name } sessions without an invite
//       "closed": false,            // true refuses new sessions (403 review_closed)
//       "authors": ["rvr_owner"],   // reviewer ids with author rights: see every comment, assign, reply, delete
//       "invites": [{ "token": "inv_alice", "reviewer": { "id": "rvr_alice", "name": "Alice" },
//                     "expiresAt": null, "revoked": false }]
//   }] }
//
// Other environment variables: PORT (8787), HOST (127.0.0.1), PURGE_AFTER_DAYS (30),
// WRITES_PER_MINUTE (60), ANNOTATE_THROTTLE ("<count>:<retryAfterSeconds>" forces
// that many 429 responses on writes, for client testing).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT = 5000;
const MAX_REPLIES = 500;
const MAX_ACTIVITY = 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const TYPES = new Set(['highlight', 'shape', 'pin', 'pen', 'block', 'note']);
const STATUSES = new Set(['open', 'in_progress', 'resolved', 'wont_fix']);
const CLOSED = new Set(['resolved', 'wont_fix']);
const GEOM_KINDS = { shape: ['rect', 'circle'], pin: ['pin'], pen: ['pen'], block: ['block'] };
const ALLOW_HEADERS = 'Authorization, Content-Type, Idempotency-Key, If-None-Match';

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status; this.code = code; this.detail = message; this.extra = extra;
  }
}

function isIso(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function hasDunder(value) {
  if (Array.isArray(value)) return value.some(hasDunder);
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some(key => key.startsWith('__') || hasDunder(value[key]));
}
function invalid(field) { return new HttpError(422, 'invalid_comment', field); }

function cleanGeom(type, geom) {
  if (type === 'highlight' || type === 'note') {
    if (geom !== null && geom !== undefined) throw invalid('geom');
    return null;
  }
  if (!geom || typeof geom !== 'object' || !(GEOM_KINDS[type] || []).includes(geom.kind)) throw invalid('geom');
  const out = { kind: geom.kind };
  if (geom.selector !== undefined) {
    if (typeof geom.selector !== 'string' || geom.selector.length >= 4096) throw invalid('geom.selector');
    out.selector = geom.selector;
  }
  if (geom.kind === 'block' && !(out.selector && out.selector.trim())) throw invalid('geom.selector');
  const numbers = geom.kind === 'pin' ? ['x', 'y'] : geom.kind === 'rect' || geom.kind === 'circle' ? ['x', 'y', 'w', 'h'] : [];
  for (const key of numbers) {
    if (!finite(geom[key])) throw invalid('geom.' + key);
    out[key] = geom[key];
  }
  if (geom.kind === 'pen') {
    if (!Array.isArray(geom.points) || geom.points.length < 2 || geom.points.length > 10000 ||
        !geom.points.every(p => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]))) {
      throw invalid('geom.points');
    }
    out.points = geom.points.map(p => [p[0], p[1]]);
  }
  if (geom.kind !== 'block') {
    for (const key of ['vw', 'vh']) {
      if (geom[key] === undefined) continue;
      if (!finite(geom[key])) throw invalid('geom.' + key);
      out[key] = geom[key];
    }
  }
  return out;
}

function cleanAnchor(type, anchor) {
  if (anchor === null || anchor === undefined) {
    if (type === 'highlight') throw invalid('anchor');
    return null;
  }
  if (typeof anchor !== 'object' || typeof anchor.exact !== 'string' || !anchor.exact.trim() ||
      anchor.exact.length > 100000 || typeof anchor.prefix !== 'string' || typeof anchor.suffix !== 'string' ||
      anchor.prefix.length > 10000 || anchor.suffix.length > 10000) {
    throw invalid('anchor');
  }
  return { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix };
}

function cleanAssignee(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 ||
      !(value.id === null || value.id === undefined || (typeof value.id === 'string' && ID_RE.test(value.id)))) {
    throw invalid('assignee');
  }
  return { id: value.id || null, name: value.name.trim() };
}

// Validates a PUT body and returns only the client-owned fields, allowlisted.
function cleanIncoming(body, id) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('body');
  if (hasDunder(body)) throw invalid('__keys');
  if (body.id !== undefined && body.id !== id) throw invalid('id');
  if (body.schema !== undefined && body.schema !== 1 && body.schema !== 2) throw invalid('schema');
  if (body.visibility !== undefined && body.visibility !== 'shared') throw invalid('visibility');
  if (!TYPES.has(body.type)) throw invalid('type');
  if (typeof body.page !== 'string' || !body.page || body.page.length > 2048) throw invalid('page');
  if (body.url !== undefined && (typeof body.url !== 'string' || body.url.length > 4096)) throw invalid('url');
  if (typeof body.text !== 'string' || body.text.length > MAX_TEXT) throw invalid('text');
  if (typeof body.color !== 'string' || !COLOR_RE.test(body.color)) throw invalid('color');
  if (body.status !== undefined && !STATUSES.has(body.status)) throw invalid('status');
  if (body.resolved !== undefined && typeof body.resolved !== 'boolean') throw invalid('resolved');
  if (body.createdAt !== undefined && !isIso(body.createdAt)) throw invalid('createdAt');
  if (body.updatedAt !== undefined && !isIso(body.updatedAt)) throw invalid('updatedAt');
  return {
    page: body.page,
    url: typeof body.url === 'string' ? body.url : '',
    type: body.type,
    text: body.text,
    color: body.color,
    anchor: cleanAnchor(body.type, body.anchor),
    geom: cleanGeom(body.type, body.geom),
    status: body.status,
    resolved: body.resolved,
    assignee: body.assignee === undefined ? undefined : cleanAssignee(body.assignee),
    createdAt: body.createdAt,
    base: body.updatedAt,
  };
}

function publicComment(record) {
  const { deletedAt, ...rest } = record;
  return deletedAt ? record : rest;
}

function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Strictly increasing server clock so two writes in one millisecond still
// produce distinct updatedAt values (the stale check depends on ordering).
function makeClock(now) {
  let last = 0;
  return () => {
    let t = now();
    if (t <= last) t = last + 1;
    last = t;
    return new Date(t).toISOString();
  };
}

function createAnnotateServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || 'annotate-data');
  const reviews = new Map((options.reviews || []).map(r => [r.id, r]));
  const now = options.now || Date.now;
  const stamp = makeClock(now);
  const purgeAfterMs = (options.purgeAfterDays === undefined ? 30 : options.purgeAfterDays) * 86400000;
  const writesPerMinute = options.writesPerMinute || 60;
  const sessions = new Map();          // token -> { reviewId, reviewer, expiresAt }
  const idempotency = new Map();       // reviewId:reviewerId:key -> { at, status, body }
  const writeLog = new Map();          // token -> [timestamps]
  const cache = new Map();             // reviewId -> { comments, activity }
  const queues = new Map();            // reviewId -> Promise (serialized writes)
  let throttle = { count: 0, retryAfter: 1 };
  if (options.throttle) throttle = { ...options.throttle };

  function reviewFile(reviewId) { return path.join(dataDir, encodeURIComponent(reviewId) + '.json'); }
  function loadReview(reviewId) {
    if (cache.has(reviewId)) return cache.get(reviewId);
    let data;
    try { data = JSON.parse(fs.readFileSync(reviewFile(reviewId), 'utf8')); } catch (error) { data = null; }
    if (!data || typeof data !== 'object') data = {};
    data.comments = data.comments && typeof data.comments === 'object' ? data.comments : {};
    data.activity = data.activity && typeof data.activity === 'object' ? data.activity : {};
    purge(data);
    cache.set(reviewId, data);
    return data;
  }
  function purge(data) {
    const cutoff = now() - purgeAfterMs;
    for (const [id, record] of Object.entries(data.comments)) {
      if (record.deletedAt && Date.parse(record.deletedAt) < cutoff) {
        delete data.comments[id];
        delete data.activity[id];
      }
    }
  }
  async function saveReview(reviewId) {
    const data = loadReview(reviewId);
    await fsp.mkdir(dataDir, { recursive: true });
    const file = reviewFile(reviewId);
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(data, null, 2));
    await fsp.rename(temp, file);
  }
  // One write at a time per review keeps read-modify-write consistent.
  function serialized(reviewId, task) {
    const previous = queues.get(reviewId) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(reviewId, next.catch(() => {}));
    return next;
  }
  function record(data, id, event) {
    const list = data.activity[id] || (data.activity[id] = []);
    list.push(event);
    if (list.length > MAX_ACTIVITY) list.splice(0, list.length - MAX_ACTIVITY);
  }
  function isAuthor(review, reviewer) {
    return Array.isArray(review.authors) && review.authors.includes(reviewer.id);
  }
  // Reviewers see only their own comments; review authors see all of them.
  function canSee(review, reviewer, record) {
    return record.authorId === reviewer.id || isAuthor(review, reviewer);
  }

  function send(response, status, body, headers = {}) {
    if (body === undefined || status === 204 || status === 304) {
      response.writeHead(status, headers).end();
      return;
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    response.end(JSON.stringify(body));
  }

  async function readJson(request) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] || '')) {
      request.resume();
      throw new HttpError(415, 'unsupported_media_type');
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        request.resume();
        throw new HttpError(413, 'too_large');
      }
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) {
      throw new HttpError(400, 'invalid_json');
    }
  }

  function authenticate(request, reviewId) {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization || '');
    const session = match && sessions.get(match[1]);
    if (!session || session.reviewId !== reviewId) throw new HttpError(401, 'unauthorized');
    if (session.expiresAt <= now()) {
      sessions.delete(match[1]);
      throw new HttpError(401, 'session_expired');
    }
    return { token: match[1], reviewer: session.reviewer };
  }

  function rateLimit(token) {
    if (throttle.count > 0) {
      throttle.count--;
      throw new HttpError(429, 'rate_limited', undefined, { retryAfter: throttle.retryAfter });
    }
    const minuteAgo = now() - 60000;
    const recent = (writeLog.get(token) || []).filter(t => t > minuteAgo);
    if (recent.length >= writesPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + 60000 - now()) / 1000));
      throw new HttpError(429, 'rate_limited', undefined, { retryAfter });
    }
    recent.push(now());
    writeLog.set(token, recent);
  }

  // Replays the stored response for a repeated Idempotency-Key.
  async function idempotent(request, reviewId, reviewer, run) {
    const key = request.headers['idempotency-key'];
    if (!key) return run();
    if (typeof key !== 'string' || key.length > 200) throw new HttpError(400, 'invalid_idempotency_key');
    const slot = reviewId + ':' + reviewer.id + ':' + key;
    const cutoff = now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of idempotency) if (v.at < cutoff) idempotency.delete(k);
    const seen = idempotency.get(slot);
    if (seen) {
      if (seen.pending) return seen.pending;
      if (seen.status >= 400) throw Object.assign(new HttpError(seen.status, seen.body.error, seen.body.message), { extra: seen.body.comment ? { comment: seen.body.comment } : undefined });
      return { status: seen.status, body: seen.body };
    }
    const pending = run().then(result => {
      idempotency.set(slot, { at: now(), status: result.status, body: result.body });
      return result;
    }, error => {
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) {
        idempotency.set(slot, { at: now(), status: error.status, body: errorBody(error) });
      } else {
        idempotency.delete(slot);
      }
      throw error;
    });
    idempotency.set(slot, { at: now(), pending });
    return pending;
  }

  async function createSession(request, review) {
    const body = await readJson(request);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_body');
    if (review.closed) throw new HttpError(403, 'review_closed');
    let reviewer;
    if (typeof body.invite === 'string' && body.invite) {
      const invite = (review.invites || []).find(i => i.token === body.invite);
      if (!invite) throw new HttpError(403, 'invite_invalid');
      if (invite.revoked) throw new HttpError(403, 'invite_revoked');
      if (invite.expiresAt && Date.parse(invite.expiresAt) <= now()) throw new HttpError(403, 'invite_expired');
      reviewer = { id: invite.reviewer.id, name: invite.reviewer.name };
      reviewer.role = isAuthor(review, reviewer) ? 'author' : 'reviewer';
    } else if (review.open && typeof body.name === 'string' && body.name.trim() && body.name.length <= 80) {
      reviewer = { id: 'rvr_' + crypto.randomBytes(9).toString('base64url'), name: body.name.trim(), role: 'reviewer' };
    } else {
      throw new HttpError(403, 'invite_invalid');
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = now() + (options.sessionTtlMs || SESSION_TTL_MS);
    sessions.set(token, { reviewId: review.id, reviewer, expiresAt });
    return {
      status: 200,
      body: {
        token, expiresAt: new Date(expiresAt).toISOString(), reviewer,
        review: { id: review.id, name: review.name || '', note: review.note || '', pages: review.pages || [] },
      },
    };
  }

  function listComments(review, reviewer, url, request) {
    const data = loadReview(review.id);
    const page = url.searchParams.get('page');
    const includeDeleted = url.searchParams.get('include') === 'deleted';
    const comments = Object.values(data.comments)
      .filter(c => (page === null || c.page === page) && (includeDeleted || !c.deletedAt) && canSee(review, reviewer, c))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map(publicComment);
    const etag = '"' + crypto.createHash('sha256').update(JSON.stringify(comments)).digest('base64url').slice(0, 27) + '"';
    const match = (request.headers['if-none-match'] || '').split(',').map(s => s.trim().replace(/^W\//, ''));
    if (match.includes(etag)) return { status: 304, headers: { ETag: etag } };
    return { status: 200, body: { comments }, headers: { ETag: etag } };
  }

  function putComment(review, reviewer, id, body) {
    const incoming = cleanIncoming(body, id);
    return serialized(review.id, async () => {
      const data = loadReview(review.id);
      const stored = data.comments[id];
      if (stored && stored.deletedAt) throw new HttpError(410, 'deleted');
      const at = stamp();
      const by = { id: reviewer.id, name: reviewer.name };
      const nextStatus = incoming.status || (incoming.resolved === undefined
        ? (stored ? stored.status : 'open')
        : incoming.resolved ? (stored && CLOSED.has(stored.status) ? stored.status : 'resolved') : 'open');
      if (!stored) {
        const created = {
          schema: 2, id, page: incoming.page, url: incoming.url, type: incoming.type,
          author: reviewer.name, authorId: reviewer.id, text: incoming.text, color: incoming.color,
          anchor: incoming.anchor, geom: incoming.geom, visibility: 'shared',
          status: nextStatus, resolved: CLOSED.has(nextStatus),
          resolvedBy: CLOSED.has(nextStatus) ? reviewer.id : null, resolvedAt: CLOSED.has(nextStatus) ? at : null,
          assignee: isAuthor(review, reviewer) && incoming.assignee || null,
          assignedAt: isAuthor(review, reviewer) && incoming.assignee ? at : null,
          replies: [], createdAt: incoming.createdAt || at, updatedAt: at, editedAt: null,
        };
        data.comments[id] = created;
        record(data, id, { at, by, kind: 'created' });
        await saveReview(review.id);
        return { status: 201, body: { comment: created } };
      }
      // Checked before the stale check: a 409 would return the record.
      if (!canSee(review, reviewer, stored)) throw new HttpError(403, 'not_owner');
      if (incoming.base && Date.parse(stored.updatedAt) > Date.parse(incoming.base)) {
        throw new HttpError(409, 'stale', undefined, { comment: stored });
      }
      const changedFields = ['text', 'color', 'anchor', 'geom'].filter(k => !sameJson(stored[k], incoming[k]));
      if (incoming.assignee !== undefined && !sameJson(incoming.assignee, stored.assignee || null) && !isAuthor(review, reviewer)) {
        throw new HttpError(403, 'not_author');
      }
      if (stored.type !== incoming.type) throw invalid('type');
      const next = { ...stored, url: stored.url || incoming.url };
      for (const key of changedFields) next[key] = incoming[key];
      if (changedFields.includes('text')) next.editedAt = at;
      if (changedFields.length) record(data, id, { at, by, kind: 'edited', fields: changedFields });
      if (nextStatus !== stored.status) {
        next.status = nextStatus;
        next.resolved = CLOSED.has(nextStatus);
        next.resolvedBy = next.resolved ? reviewer.id : null;
        next.resolvedAt = next.resolved ? at : null;
        record(data, id, { at, by, kind: 'status', from: stored.status, to: nextStatus });
      }
      if (incoming.assignee !== undefined && !sameJson(incoming.assignee, stored.assignee || null)) {
        next.assignee = incoming.assignee;
        next.assignedAt = incoming.assignee ? at : null;
        record(data, id, { at, by, kind: 'assigned', from: stored.assignee || null, to: incoming.assignee });
      }
      if (sameJson(next, stored)) return { status: 200, body: { comment: stored } };
      next.updatedAt = at;
      data.comments[id] = next;
      await saveReview(review.id);
      return { status: 200, body: { comment: next } };
    });
  }

  function deleteComment(review, reviewer, id) {
    return serialized(review.id, async () => {
      const data = loadReview(review.id);
      const stored = data.comments[id];
      if (!stored || stored.deletedAt) return { status: 204 };
      if (!canSee(review, reviewer, stored)) throw new HttpError(403, 'not_owner');
      const at = stamp();
      data.comments[id] = { ...stored, deletedAt: at, updatedAt: at };
      record(data, id, { at, by: { id: reviewer.id, name: reviewer.name }, kind: 'deleted' });
      await saveReview(review.id);
      return { status: 204 };
    });
  }

  function addReply(review, reviewer, id, body) {
    if (!body || typeof body !== 'object' || hasDunder(body)) throw invalid('reply');
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) throw invalid('reply.id');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT) throw invalid('reply.text');
    return serialized(review.id, async () => {
      const data = loadReview(review.id);
      const stored = data.comments[id];
      if (!stored || !canSee(review, reviewer, stored)) throw new HttpError(404, 'comment_not_found');
      if (stored.deletedAt) throw new HttpError(410, 'deleted');
      if (stored.replies.some(r => r.id === body.id)) return { status: 200, body: { comment: stored } };
      if (stored.replies.length >= MAX_REPLIES) throw new HttpError(422, 'too_many_replies');
      const at = stamp();
      const reply = { id: body.id, author: reviewer.name, authorId: reviewer.id, text: body.text, createdAt: at, editedAt: null };
      const next = { ...stored, replies: stored.replies.concat(reply), updatedAt: at };
      data.comments[id] = next;
      record(data, id, { at, by: { id: reviewer.id, name: reviewer.name }, kind: 'replied', replyId: body.id });
      await saveReview(review.id);
      return { status: 201, body: { comment: next } };
    });
  }

  function deleteReply(review, reviewer, id, replyId) {
    return serialized(review.id, async () => {
      const data = loadReview(review.id);
      const stored = data.comments[id];
      const reply = stored && !stored.deletedAt && canSee(review, reviewer, stored) && stored.replies.find(r => r.id === replyId);
      if (!reply) return { status: 204 };
      if (reply.authorId !== reviewer.id && !isAuthor(review, reviewer)) throw new HttpError(403, 'not_owner');
      const at = stamp();
      data.comments[id] = { ...stored, replies: stored.replies.filter(r => r.id !== replyId), updatedAt: at };
      record(data, id, { at, by: { id: reviewer.id, name: reviewer.name }, kind: 'reply_deleted', replyId });
      await saveReview(review.id);
      return { status: 204 };
    });
  }

  function activity(review, reviewer, id) {
    const data = loadReview(review.id);
    if (!data.comments[id] || !canSee(review, reviewer, data.comments[id])) throw new HttpError(404, 'comment_not_found');
    return { status: 200, body: { events: data.activity[id] || [] } };
  }

  function errorBody(error) {
    const body = { error: error.code };
    if (error.detail && error.detail !== error.code) body.message = error.detail;
    if (error.extra && error.extra.comment) body.comment = error.extra.comment;
    return body;
  }

  async function route(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1' || parts[1] !== 'annotate' || parts[2] !== 'reviews' || !parts[3]) {
      throw new HttpError(404, 'not_found');
    }
    const review = reviews.get(parts[3]);
    const origin = request.headers.origin;
    // CORS reflects only registered origins; the check runs on every request.
    if (review && origin && (review.origins || []).includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Expose-Headers', 'ETag, Retry-After');
      response.setHeader('Access-Control-Max-Age', '600');
    }
    if (!review) throw new HttpError(404, 'review_not_found');
    if (!origin || !(review.origins || []).includes(origin)) throw new HttpError(403, 'origin_not_allowed');
    if (request.method === 'OPTIONS') return { status: 204 };

    const rest = parts.slice(4);
    const method = request.method;
    if (rest.length === 1 && rest[0] === 'session') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
      return createSession(request, review);
    }
    if (rest[0] !== 'comments') throw new HttpError(404, 'not_found');
    const { token, reviewer } = authenticate(request, review.id);
    if (rest.length === 1) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return listComments(review, reviewer, url, request);
    }
    const id = rest[1];
    if (!ID_RE.test(id)) throw new HttpError(404, 'comment_not_found');
    if (rest.length === 3 && rest[2] === 'activity' && method === 'GET') return activity(review, reviewer, id);
    const write = method === 'PUT' || method === 'POST' || method === 'DELETE';
    if (!write) throw new HttpError(405, 'method_not_allowed');
    rateLimit(token);
    if (rest.length === 2 && method === 'PUT') {
      const body = await readJson(request);
      return idempotent(request, review.id, reviewer, () => putComment(review, reviewer, id, body));
    }
    if (rest.length === 2 && method === 'DELETE') {
      return idempotent(request, review.id, reviewer, () => deleteComment(review, reviewer, id));
    }
    if (rest.length === 3 && rest[2] === 'replies' && method === 'POST') {
      const body = await readJson(request);
      return idempotent(request, review.id, reviewer, () => addReply(review, reviewer, id, body));
    }
    if (rest.length === 4 && rest[2] === 'replies' && method === 'DELETE') {
      if (!ID_RE.test(rest[3])) return { status: 204 };
      return idempotent(request, review.id, reviewer, () => deleteReply(review, reviewer, id, rest[3]));
    }
    throw new HttpError(404, 'not_found');
  }

  const server = http.createServer(async (request, response) => {
    try {
      const result = await route(request, response);
      send(response, result.status, result.body, result.headers);
    } catch (error) {
      if (!request.complete) request.resume();
      if (response.headersSent) { response.end(); return; }
      if (error instanceof HttpError) {
        const headers = {};
        if (error.extra && error.extra.retryAfter) headers['Retry-After'] = String(error.extra.retryAfter);
        send(response, error.status, errorBody(error), headers);
      } else {
        console.error('annotate-server error:', error);
        send(response, 500, { error: 'internal' });
      }
    }
  });
  // Control surface for tests and operators embedding the server in-process.
  server.annotate = {
    throttle(count, retryAfter = 1) { throttle = { count, retryAfter }; },
    expireSessions() { for (const session of sessions.values()) session.expiresAt = 0; },
    review(id) { return loadReview(id); },
  };
  return server;
}

if (require.main === module) {
  const configPath = process.env.ANNOTATE_CONFIG;
  if (!configPath) {
    console.error('Set ANNOTATE_CONFIG to a reviews JSON file (see the header of this file).');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const [count, retryAfter] = String(process.env.ANNOTATE_THROTTLE || '0:1').split(':').map(Number);
  const server = createAnnotateServer({
    reviews: config.reviews || [],
    dataDir: process.env.DATA_DIR || 'annotate-data',
    purgeAfterDays: process.env.PURGE_AFTER_DAYS ? Number(process.env.PURGE_AFTER_DAYS) : 30,
    writesPerMinute: process.env.WRITES_PER_MINUTE ? Number(process.env.WRITES_PER_MINUTE) : 60,
    throttle: { count: count || 0, retryAfter: retryAfter || 1 },
  });
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`annotate server: http://${host}:${port}/v1/annotate`));
}

module.exports = { createAnnotateServer };
