// Firebase (Cloud Firestore) transport for @reviewjs/annotate.
//
// Implements the annotate wire protocol v1 (docs/backlog/wire-protocol.md)
// inside the browser on top of Firestore, and pushes the page's comments live
// with onSnapshot. Pair it with the security rules in examples/firebase/,
// which enforce who may see and change what; this file is not a trust
// boundary, the rules are.
//
//   import { initializeApp } from "firebase/app";
//   import Annotate from "@reviewjs/annotate";
//   import { firebaseTransport } from "@reviewjs/annotate/firebase";
//
//   const app = initializeApp({ /* your web config */ });
//   Annotate.init({ reviewId: "launch-review", transport: firebaseTransport({ app, reviewId: "launch-review" }) });
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  Timestamp, collection, doc, getDoc, getDocs, getFirestore, onSnapshot, query, runTransaction, setDoc, updateDoc, where,
} from "firebase/firestore";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const TYPES = ["highlight", "shape", "pin", "pen", "block", "note"];
const STATUSES = ["open", "in_progress", "resolved", "wont_fix"];
const GEOM_KINDS = ["rect", "circle", "pin", "pen", "block"];
const MAX_TEXT = 5000;
const MAX_REPLIES = 500;
const MAX_BODY = 256 * 1024;
const DAY = 86400000;

const isClosed = (status) => status === "resolved" || status === "wont_fix";
const iso = (ms) => new Date(ms).toISOString();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function reply(status, body, headers) {
  const h = { ...(headers || {}) };
  if (body === undefined) return new Response(null, { status, headers: h });
  h["Content-Type"] = "application/json";
  return new Response(JSON.stringify(body), { status, headers: h });
}
const fail = (status, error, message) => reply(status, message ? { error, message } : { error });

// Firestore rejects arrays of arrays, and a pen stroke is [[x, y], ...].
function encodeGeom(geom) {
  if (!geom || geom.kind !== "pen" || !Array.isArray(geom.points)) return geom ?? null;
  const { points, ...rest } = geom;
  return { ...rest, pointsFlat: points.flat() };
}
function decodeGeom(geom) {
  if (!geom || geom.kind !== "pen" || !Array.isArray(geom.pointsFlat)) return geom ?? null;
  const { pointsFlat, ...rest } = geom;
  const points = [];
  for (let i = 0; i + 1 < pointsFlat.length; i += 2) points.push([pointsFlat[i], pointsFlat[i + 1]]);
  return { ...rest, points };
}
// Stored document -> AnnotateComment.
function decode(data) {
  const { purgeAt, deletedAt, ...rest } = data;
  return { ...rest, geom: decodeGeom(rest.geom), replies: rest.replies || [] };
}

function normalizeAssignee(a) {
  if (!a || typeof a !== "object") return null;
  return { id: typeof a.id === "string" ? a.id : null, name: String(a.name || "").slice(0, 80) };
}
function validAnchor(a) {
  return a === null || a === undefined
    || (typeof a === "object" && ["exact", "prefix", "suffix"].every((k) => typeof a[k] === "string"));
}
function validGeom(g) {
  return g === null || g === undefined || (typeof g === "object" && GEOM_KINDS.includes(g.kind));
}
// Returns a 4xx Response for a bad body, or null when it is acceptable.
function validate(id, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(422, "invalid_comment", "body");
  if (JSON.stringify(body).length > MAX_BODY) return fail(413, "too_large");
  if (Object.keys(body).some((k) => k.startsWith("__"))) return fail(422, "invalid_comment", "__");
  if (body.id !== id || !ID.test(id)) return fail(422, "invalid_comment", "id");
  if (!TYPES.includes(body.type)) return fail(422, "invalid_comment", "type");
  if (typeof body.text !== "string" || body.text.length > MAX_TEXT) return fail(422, "invalid_comment", "text");
  if (typeof body.color !== "string" || !HEX.test(body.color)) return fail(422, "invalid_comment", "color");
  if (typeof body.page !== "string" || !body.page || body.page.length > 2000) return fail(422, "invalid_comment", "page");
  if (typeof body.url !== "string" || body.url.length > 4000) return fail(422, "invalid_comment", "url");
  if (body.status !== undefined && !STATUSES.includes(body.status)) return fail(422, "invalid_comment", "status");
  if (body.author !== undefined && (typeof body.author !== "string" || body.author.length > 80)) return fail(422, "invalid_comment", "author");
  if (!validAnchor(body.anchor)) return fail(422, "invalid_comment", "anchor");
  if (!validGeom(body.geom)) return fail(422, "invalid_comment", "geom");
  return null;
}

/**
 * @param {object} options
 * @param {import("firebase/app").FirebaseApp} options.app
 * @param {string} options.reviewId  Same value as the Annotate `reviewId` config.
 * @param {string} [options.root]    Top-level collection. Default "annotateReviews".
 * @param {import("firebase/firestore").Firestore} [options.firestore]
 * @param {import("firebase/auth").Auth} [options.auth]
 * @param {(auth: import("firebase/auth").Auth) => Promise<unknown>} [options.signIn]
 *        Called when nobody is signed in. Default: anonymous sign-in.
 * @param {number} [options.purgeAfterDays] Tombstone retention for a Firestore TTL policy on `purgeAt`. Default 30.
 */
export function firebaseTransport(options) {
  const { app, reviewId } = options || {};
  if (!reviewId || !ID.test(reviewId)) throw new Error("firebaseTransport: reviewId is required (letters, digits, _ and -)");
  const db = options.firestore || getFirestore(app);
  const auth = options.auth || getAuth(app);
  const root = options.root || "annotateReviews";
  const purgeMs = (options.purgeAfterDays ?? 30) * DAY;

  const reviewRef = doc(db, root, reviewId);
  const memberRef = (uid) => doc(db, root, reviewId, "members", uid);
  const commentsCol = collection(db, root, reviewId, "comments");
  const commentRef = (id) => doc(db, root, reviewId, "comments", id);
  const activityCol = (id) => collection(db, root, reviewId, "comments", id, "activity");

  let cached = null;   // { uid, role, name }

  async function signedInUser() {
    await auth.authStateReady();
    if (!auth.currentUser) {
      if (options.signIn) await options.signIn(auth); else await signInAnonymously(auth);
    }
    return auth.currentUser;
  }
  async function identity() {
    const user = await signedInUser();
    if (!user) return null;
    if (cached && cached.uid === user.uid) return cached;
    const m = await getDoc(memberRef(user.uid));
    cached = { uid: user.uid, role: m.exists() ? m.data().role : null, name: m.exists() ? m.data().name || "" : "" };
    return cached;
  }

  function event(me, at, kind, extra) {
    return { at, by: { id: me.uid, name: me.name || "" }, kind, ...(clone(extra) || {}) };
  }
  // updatedAt is the stale-check base, so it must only ever increase even if
  // this browser's clock is behind the one that wrote the document.
  function stamp(previous) {
    const now = Date.now(), prev = previous ? Date.parse(previous) : 0;
    return iso(Math.max(now, prev + 1));
  }

  // --- session -------------------------------------------------------------
  async function session(body) {
    const user = await signedInUser();
    if (!user) return fail(401, "unauthorized");
    const review = await getDoc(reviewRef);
    if (!review.exists()) return fail(404, "review_not_found");
    const info = review.data();
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    let m = await getDoc(memberRef(user.uid));
    if (!m.exists()) {
      if (info.closed === true) return fail(403, "review_closed");
      if (info.open !== true) return fail(403, "invite_invalid", "This review is invite-only. Ask its author to add you.");
      await setDoc(memberRef(user.uid), { role: "reviewer", name });
      m = await getDoc(memberRef(user.uid));
    } else if (name && m.data().name !== name) {
      await updateDoc(memberRef(user.uid), { name });
      m = await getDoc(memberRef(user.uid));
    }
    const member = m.data();
    if (info.closed === true && member.role !== "author") return fail(403, "review_closed");
    cached = { uid: user.uid, role: member.role, name: member.name || "" };
    return reply(200, {
      token: "firebase",
      expiresAt: iso(Date.now() + DAY),
      reviewer: { id: user.uid, name: cached.name, role: member.role === "author" ? "author" : "reviewer" },
      review: { id: reviewId, name: info.name || "", note: info.note || "", pages: info.pages || [] },
    });
  }

  // --- comments --------------------------------------------------------------
  function listQuery(page) {
    // Every member reads every comment in the review (the rules agree); only
    // writes are restricted to the comment's owner and the authors.
    return page ? query(commentsCol, where("page", "==", page)) : query(commentsCol);
  }
  function fromSnapshot(snap) {
    return snap.docs.map((d) => d.data()).filter((c) => !c.deletedAt).map(decode)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
  async function list(me, page) {
    return reply(200, { comments: fromSnapshot(await getDocs(listQuery(page))) });
  }

  async function put(me, id, body) {
    const bad = validate(id, body);
    if (bad) return bad;
    const isAuthor = me.role === "author";
    return runTransaction(db, async (tx) => {
      const ref = commentRef(id);
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        const t = iso(Date.now());
        const status = body.status || (body.resolved === true ? "resolved" : "open");
        const closed = isClosed(status);
        const assignee = isAuthor ? normalizeAssignee(body.assignee) : null;
        const c = clone({
          schema: 2, id, page: body.page, url: body.url, type: body.type,
          author: me.name || body.author || "", authorId: me.uid, text: body.text, color: body.color,
          anchor: body.anchor ?? null, geom: encodeGeom(body.geom), visibility: "shared",
          status, resolved: closed, resolvedBy: closed ? me.uid : null, resolvedAt: closed ? t : null,
          assignee, assignedAt: assignee ? t : null, replies: [],
          createdAt: typeof body.createdAt === "string" && body.createdAt.length <= 40 ? body.createdAt : t,
          updatedAt: t, editedAt: null, deletedAt: null,
        });
        tx.set(ref, c);
        tx.set(doc(activityCol(id)), event(me, t, "created"));
        return reply(201, { comment: decode(c) });
      }
      const cur = snap.data();
      if (cur.deletedAt) return fail(410, "deleted");
      if (!isAuthor && cur.authorId !== me.uid) return fail(403, "not_owner");
      if (typeof body.updatedAt === "string" && cur.updatedAt > body.updatedAt) {
        return reply(409, { error: "stale", comment: decode(cur) });
      }
      const wantAssignee = body.assignee === undefined ? normalizeAssignee(cur.assignee) : normalizeAssignee(body.assignee);
      const assigneeChanged = JSON.stringify(wantAssignee) !== JSON.stringify(normalizeAssignee(cur.assignee));
      if (assigneeChanged && !isAuthor) return fail(403, "not_author");

      const t = stamp(cur.updatedAt);
      const next = { ...cur };
      const events = [];
      const changed = [];
      for (const f of ["text", "color", "anchor", "geom"]) {
        const value = f === "geom" ? encodeGeom(body.geom) : body[f];
        if (value === undefined) continue;
        const v = clone(value ?? null);
        if (JSON.stringify(v) !== JSON.stringify(cur[f] ?? null)) { next[f] = v; changed.push(f); }
      }
      if (changed.includes("text")) next.editedAt = t;
      if (changed.length) events.push(event(me, t, "edited", { fields: changed }));

      const wantStatus = body.status || (body.resolved === true ? "resolved" : body.resolved === false ? "open" : cur.status);
      if (wantStatus !== cur.status) {
        const closed = isClosed(wantStatus);
        next.status = wantStatus; next.resolved = closed;
        next.resolvedBy = closed ? me.uid : null; next.resolvedAt = closed ? t : null;
        events.push(event(me, t, "status", { from: cur.status, to: wantStatus }));
      }
      if (assigneeChanged) {
        next.assignee = wantAssignee; next.assignedAt = wantAssignee ? t : null;
        events.push(event(me, t, "assigned", { from: normalizeAssignee(cur.assignee), to: wantAssignee }));
      }
      if (!events.length) return reply(200, { comment: decode(cur) });
      next.updatedAt = t;
      tx.set(ref, clone(next));
      events.forEach((e) => tx.set(doc(activityCol(id)), e));
      return reply(200, { comment: decode(next) });
    });
  }

  async function remove(me, id) {
    return runTransaction(db, async (tx) => {
      const ref = commentRef(id);
      const snap = await tx.get(ref);
      if (!snap.exists() || snap.data().deletedAt) return reply(204);
      const cur = snap.data();
      if (me.role !== "author" && cur.authorId !== me.uid) return fail(403, "not_owner");
      const now = Date.now(), t = stamp(cur.updatedAt);
      // The tombstone keeps only what is needed to refuse a stale write; the
      // content is gone.
      tx.set(ref, {
        schema: 2, id, page: cur.page, authorId: cur.authorId, createdAt: cur.createdAt,
        updatedAt: t, deletedAt: t, purgeAt: Timestamp.fromMillis(now + purgeMs),
      });
      tx.set(doc(activityCol(id)), event(me, t, "deleted"));
      return reply(204);
    });
  }

  async function addReply(me, id, body) {
    if (!body || typeof body.id !== "string" || !ID.test(body.id)) return fail(422, "invalid_reply", "id");
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_TEXT) return fail(422, "invalid_reply", "text");
    return runTransaction(db, async (tx) => {
      const ref = commentRef(id);
      const snap = await tx.get(ref);
      if (!snap.exists()) return fail(404, "comment_not_found");
      const cur = snap.data();
      if (cur.deletedAt) return fail(410, "deleted");
      // Any member may reply to any comment (a read of it, plus appending one reply).
      const replies = cur.replies || [];
      if (replies.some((r) => r.id === body.id)) return reply(200, { comment: decode(cur) });
      if (replies.length >= MAX_REPLIES) return fail(422, "too_many_replies");
      const t = stamp(cur.updatedAt);
      const next = {
        ...cur, updatedAt: t,
        replies: [...replies, { id: body.id, author: me.name || "", authorId: me.uid, text: body.text, createdAt: t, editedAt: null }],
      };
      tx.set(ref, next);
      tx.set(doc(activityCol(id)), event(me, t, "replied", { replyId: body.id }));
      return reply(201, { comment: decode(next) });
    });
  }

  async function removeReply(me, id, replyId) {
    return runTransaction(db, async (tx) => {
      const ref = commentRef(id);
      const snap = await tx.get(ref);
      if (!snap.exists()) return reply(204);
      const cur = snap.data();
      if (cur.deletedAt) return reply(204);
      const isAuthor = me.role === "author";
      const found = (cur.replies || []).find((r) => r.id === replyId);
      if (!found) return reply(204);
      // Removing a reply is a write. Authors may remove any; a reviewer may
      // only remove their own reply on their own comment (the rules let a
      // non-owner append replies, never remove them).
      if (!isAuthor && (cur.authorId !== me.uid || found.authorId !== me.uid)) return fail(403, "not_owner");
      const t = stamp(cur.updatedAt);
      tx.set(ref, { ...cur, updatedAt: t, replies: cur.replies.filter((r) => r.id !== replyId) });
      tx.set(doc(activityCol(id)), event(me, t, "reply_deleted", { replyId }));
      return reply(204);
    });
  }

  async function activity(me, id) {
    const snap = await getDoc(commentRef(id));
    if (!snap.exists() || snap.data().deletedAt) return fail(404, "comment_not_found");
    const events = await getDocs(query(activityCol(id)));
    const out = events.docs.map((d) => d.data()).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, 1000);
    return reply(200, { events: out });
  }

  // --- routing -----------------------------------------------------------------
  async function route(method, path, body) {
    const url = new URL(path, "http://annotate.invalid");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "session" && parts.length === 1 && method === "POST") return session(body || {});
    if (parts[0] !== "comments") return fail(404, "not_found");
    const me = await identity();
    if (!me) return fail(401, "unauthorized");
    if (!me.role) return fail(403, "forbidden", "Not a member of this review. Reload to join.");
    const id = parts[1];
    if (parts.length === 1 && method === "GET") return list(me, url.searchParams.get("page"));
    if (id && !ID.test(id)) return fail(404, "comment_not_found");
    if (parts.length === 2 && method === "PUT") return put(me, id, body);
    if (parts.length === 2 && method === "DELETE") return remove(me, id);
    if (parts.length === 3 && parts[2] === "activity" && method === "GET") return activity(me, id);
    if (parts.length === 3 && parts[2] === "replies" && method === "POST") return addReply(me, id, body);
    if (parts.length === 4 && parts[2] === "replies" && method === "DELETE") return removeReply(me, id, parts[3]);
    return fail(404, "not_found");
  }

  function fromError(e) {
    const code = e && e.code;
    if (code === "permission-denied") { cached = null; return fail(403, "forbidden"); }
    if (code === "unauthenticated") { cached = null; return fail(401, "unauthorized"); }
    if (code === "resource-exhausted") return reply(429, { error: "rate_limited" }, { "Retry-After": "5" });
    if (e && /maximum allowed size|too large/i.test(String(e.message))) return fail(413, "too_large");
    // Network trouble and anything unknown: let Annotate retry with backoff.
    throw e;
  }

  return {
    async request(method, path, init) {
      try { return await route(String(method).toUpperCase(), path, init && init.body); } catch (e) { return fromError(e); }
    },

    subscribe(page, onComments, onError) {
      let off = null, stopped = false;
      identity().then((me) => {
        if (stopped) return;
        if (!me || !me.role) { onError(new Error("not a member of this review")); return; }
        off = onSnapshot(listQuery(page), (snap) => { if (!stopped) onComments(fromSnapshot(snap)); },
          (error) => { if (!stopped) onError(error); });
      }, (error) => { if (!stopped) onError(error); });
      return () => { stopped = true; if (off) off(); };
    },

    // The app, Firestore and Auth instances belong to the integrator.
    destroy() { cached = null; },
  };
}

export default firebaseTransport;
