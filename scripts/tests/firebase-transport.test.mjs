// Conformance of the Firebase transport against docs/backlog/wire-protocol.md,
// run on the Firestore + Auth emulators with the real security rules.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { call, cleanup, makeUser, seedReview, sleep, uniqueReview, until, wire } from "./firebase-helpers.mjs";

after(cleanup);

async function room({ authorFirst = true } = {}) {
  const review = uniqueReview();
  const author = await makeUser(review);
  const alice = await makeUser(review);
  const bob = await makeUser(review);
  await seedReview(review, { name: "Pricing", note: "Check copy", pages: ["/p"], open: true }, { [author.uid]: { role: "author", name: "Owner" } });
  for (const u of [author, alice, bob]) assert.equal((await call(u, "POST", "/session", {})).status, 200);
  return { review, author, alice, bob };
}

describe("session", () => {
  test("unknown review is 404", async () => {
    const u = await makeUser("rvw_missing_" + Date.now());
    assert.equal((await call(u, "POST", "/session", {})).body.error, "review_not_found");
    assert.equal((await call(u, "POST", "/session", {})).status, 404);
  });
  test("an invite-only review refuses strangers, a closed one says so", async () => {
    const a = uniqueReview(), b = uniqueReview();
    await seedReview(a, { name: "Private", open: false });
    await seedReview(b, { name: "Done", open: true, closed: true });
    const u = await makeUser(a), v = await makeUser(b);
    assert.deepEqual([(await call(u, "POST", "/session", {})).status, (await call(u, "POST", "/session", {})).body.error], [403, "invite_invalid"]);
    assert.equal((await call(v, "POST", "/session", {})).body.error, "review_closed");
  });
  test("an open review admits a reviewer with their name; an author keeps the author role", async () => {
    const { author, alice } = await room();
    const named = await call(alice, "POST", "/session", { name: "  Alice  " });
    assert.equal(named.status, 200);
    assert.deepEqual(named.body.reviewer, { id: alice.uid, name: "Alice", role: "reviewer" });
    assert.equal(named.body.review.note, "Check copy");
    assert.equal((await call(author, "POST", "/session", {})).body.reviewer.role, "author");
  });
});

describe("comments", () => {
  test("create 201, identical resend 200, edit sets editedAt, derived fields", async () => {
    const { alice } = await room();
    const body = wire("c1", "/p");
    const created = await call(alice, "PUT", "/comments/c1", body);
    assert.equal(created.status, 201);
    assert.equal(created.body.comment.authorId, alice.uid);
    assert.equal(created.body.comment.status, "open");
    assert.equal(created.body.comment.editedAt, null);
    const base = created.body.comment.updatedAt;
    assert.equal((await call(alice, "PUT", "/comments/c1", { ...body, updatedAt: base })).status, 200);
    const edited = await call(alice, "PUT", "/comments/c1", { ...body, text: "Changed", updatedAt: base });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.comment.text, "Changed");
    assert.ok(edited.body.comment.editedAt);
    assert.ok(edited.body.comment.updatedAt > base);
  });
  test("a stale base is 409 with the stored comment", async () => {
    const { alice } = await room();
    const body = wire("c1", "/p");
    const c = (await call(alice, "PUT", "/comments/c1", body)).body.comment;
    await call(alice, "PUT", "/comments/c1", { ...body, text: "second", updatedAt: c.updatedAt });
    const stale = await call(alice, "PUT", "/comments/c1", { ...body, text: "third", updatedAt: c.updatedAt });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "stale");
    assert.equal(stale.body.comment.text, "second");
  });
  test("status is derived: closing stamps resolvedBy/At, reopening clears them, 1.4 `resolved` maps", async () => {
    const { alice } = await room();
    const body = wire("c1", "/p");
    let c = (await call(alice, "PUT", "/comments/c1", body)).body.comment;
    c = (await call(alice, "PUT", "/comments/c1", { ...body, status: "wont_fix", updatedAt: c.updatedAt })).body.comment;
    assert.deepEqual([c.status, c.resolved, c.resolvedBy], ["wont_fix", true, alice.uid]);
    assert.ok(c.resolvedAt);
    const legacy = { ...body }; delete legacy.status;
    c = (await call(alice, "PUT", "/comments/c1", { ...legacy, resolved: false, updatedAt: c.updatedAt })).body.comment;
    assert.deepEqual([c.status, c.resolved, c.resolvedBy, c.resolvedAt], ["open", false, null, null]);
  });
  test("a pen stroke survives Firestore's no-nested-arrays rule", async () => {
    const { alice } = await room();
    const geom = { kind: "pen", selector: "#title", points: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]], vw: 1000, vh: 800 };
    const put = await call(alice, "PUT", "/comments/pen1", wire("pen1", "/p", { type: "pen", geom }));
    assert.equal(put.status, 201);
    assert.deepEqual(put.body.comment.geom.points, geom.points);
    const list = await call(alice, "GET", "/comments?page=%2Fp");
    assert.deepEqual(list.body.comments[0].geom, geom);
  });
  test("delete leaves a tombstone: gone from lists, later writes are 410, delete is idempotent", async () => {
    const { alice } = await room();
    await call(alice, "PUT", "/comments/c1", wire("c1", "/p"));
    assert.equal((await call(alice, "DELETE", "/comments/c1")).status, 204);
    assert.equal((await call(alice, "DELETE", "/comments/c1")).status, 204);
    assert.equal((await call(alice, "DELETE", "/comments/never")).status, 204);
    assert.deepEqual((await call(alice, "GET", "/comments?page=%2Fp")).body.comments, []);
    assert.equal((await call(alice, "PUT", "/comments/c1", wire("c1", "/p"))).status, 410);
    assert.equal((await call(alice, "POST", "/comments/c1/replies", { id: "r1", text: "x" })).status, 410);
  });
  test("validation: bad color 422, oversized body 413, __ keys refused", async () => {
    const { alice } = await room();
    const bad = await call(alice, "PUT", "/comments/c1", wire("c1", "/p", { color: "red" }));
    assert.deepEqual([bad.status, bad.body.error, bad.body.message], [422, "invalid_comment", "color"]);
    assert.equal((await call(alice, "PUT", "/comments/c1", wire("c1", "/p", { text: "x".repeat(5001) }))).status, 422);
    const huge = wire("c1", "/p", { geom: { kind: "pen", selector: "#a", points: Array.from({ length: 40000 }, (_, i) => [i, i]), vw: 1, vh: 1 } });
    assert.equal((await call(alice, "PUT", "/comments/c1", huge)).status, 413);
    assert.equal((await call(alice, "PUT", "/comments/c1", { ...wire("c1", "/p"), __x: 1 })).status, 422);
    assert.equal((await call(alice, "PUT", "/comments/other", wire("c1", "/p"))).status, 422);
  });
});

describe("visibility and roles", () => {
  test("every member sees every comment; the page filter still applies", async () => {
    const { alice, bob, author } = await room();
    await call(alice, "PUT", "/comments/ca", wire("ca", "/p"));
    await call(bob, "PUT", "/comments/cb", wire("cb", "/p"));
    await call(bob, "PUT", "/comments/cc", wire("cc", "/other"));
    const ids = async (u, q) => (await call(u, "GET", "/comments" + q)).body.comments.map((c) => c.id).sort();
    for (const u of [alice, bob, author]) {
      assert.deepEqual(await ids(u, "?page=%2Fp"), ["ca", "cb"]);
      assert.deepEqual(await ids(u, "?page=%2Fother"), ["cc"]);
      assert.deepEqual(await ids(u, ""), ["ca", "cb", "cc"]);
    }
  });
  test("someone else's comment: any member may reply and read its history, but not edit, resolve or delete it", async () => {
    const { alice, bob, author } = await room();
    const made = (await call(alice, "PUT", "/comments/ca", wire("ca", "/p"))).body.comment;
    // Writes stay with the owner and the authors.
    assert.equal((await call(bob, "PUT", "/comments/ca", wire("ca", "/p", { text: "hijack", updatedAt: made.updatedAt }))).body.error, "not_owner");
    assert.equal((await call(bob, "PUT", "/comments/ca", wire("ca", "/p", { status: "resolved", updatedAt: made.updatedAt }))).body.error, "not_owner");
    assert.equal((await call(bob, "DELETE", "/comments/ca")).body.error, "not_owner");
    // Reads and replies are open to every member.
    const replied = await call(bob, "POST", "/comments/ca/replies", { id: "rb", text: "Agreed" });
    assert.equal(replied.status, 201);
    assert.deepEqual(replied.body.comment.replies.map((r) => [r.id, r.authorId]), [["rb", bob.uid]]);
    assert.equal((await call(bob, "POST", "/comments/ca/replies", { id: "rb", text: "Agreed" })).status, 200);   // idempotent
    const log = await call(bob, "GET", "/comments/ca/activity");
    assert.deepEqual(log.body.events.map((e) => e.kind), ["created", "replied"]);
    // The comment itself is untouched, and its owner and authors see the reply.
    const seen = (await call(alice, "GET", "/comments?page=%2Fp")).body.comments[0];
    assert.deepEqual([seen.text, seen.status, seen.replies.length], ["Hello", "open", 1]);
    // Removing a reply is a write: only its author on their own comment, or an author.
    assert.equal((await call(bob, "DELETE", "/comments/ca/replies/rb")).body.error, "not_owner");
    assert.equal((await call(alice, "DELETE", "/comments/ca/replies/rb")).body.error, "not_owner");
    assert.equal((await call(author, "DELETE", "/comments/ca/replies/rb")).status, 204);
    // A deleted comment still answers 410 to a reply.
    await call(alice, "DELETE", "/comments/ca");
    assert.equal((await call(bob, "POST", "/comments/ca/replies", { id: "r2", text: "late" })).status, 410);
  });
  test("only authors assign: reviewer's create ignores it, an update is 403 not_author, the author's works", async () => {
    const { alice, author } = await room();
    const assignee = { id: author.uid, name: "Owner" };
    const made = await call(alice, "PUT", "/comments/c1", wire("c1", "/p", { assignee }));
    assert.equal(made.status, 201);
    assert.equal(made.body.comment.assignee, null);
    const c = made.body.comment;
    const denied = await call(alice, "PUT", "/comments/c1", wire("c1", "/p", { assignee, updatedAt: c.updatedAt }));
    assert.deepEqual([denied.status, denied.body.error], [403, "not_author"]);
    const ok = await call(author, "PUT", "/comments/c1", wire("c1", "/p", { assignee, status: "in_progress", updatedAt: c.updatedAt }));
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.comment.assignee, ok.body.comment.status], [assignee, "in_progress"]);
    assert.ok(ok.body.comment.assignedAt);
    assert.equal(ok.body.comment.authorId, alice.uid);   // the creator stays the creator
  });
  test("an author's reply is visible to the reviewer; reply ids are idempotent", async () => {
    const { alice, author } = await room();
    await call(alice, "PUT", "/comments/c1", wire("c1", "/p"));
    const first = await call(author, "POST", "/comments/c1/replies", { id: "r1", text: "On it" });
    assert.equal(first.status, 201);
    assert.equal((await call(author, "POST", "/comments/c1/replies", { id: "r1", text: "On it" })).status, 200);
    const seen = (await call(alice, "GET", "/comments?page=%2Fp")).body.comments[0];
    assert.deepEqual(seen.replies.map((r) => [r.id, r.authorId, r.text]), [["r1", author.uid, "On it"]]);
    assert.equal((await call(alice, "DELETE", "/comments/c1/replies/r1")).body.error, "not_owner");   // not their reply
    assert.equal((await call(author, "DELETE", "/comments/c1/replies/r1")).status, 204);
    assert.deepEqual((await call(alice, "GET", "/comments?page=%2Fp")).body.comments[0].replies, []);
    assert.equal((await call(alice, "POST", "/comments/c1/replies", { id: "r2", text: "  " })).status, 422);
  });
  test("activity logs every accepted change, oldest first", async () => {
    const { alice, author } = await room();
    const body = wire("c1", "/p");
    let c = (await call(alice, "PUT", "/comments/c1", body)).body.comment;
    c = (await call(alice, "PUT", "/comments/c1", { ...body, text: "v2", updatedAt: c.updatedAt })).body.comment;
    c = (await call(author, "PUT", "/comments/c1", { ...body, text: "v2", status: "resolved", updatedAt: c.updatedAt })).body.comment;
    await call(author, "POST", "/comments/c1/replies", { id: "r1", text: "done" });
    const log = await call(alice, "GET", "/comments/c1/activity");
    assert.deepEqual(log.body.events.map((e) => e.kind), ["created", "edited", "status", "replied"]);
    assert.deepEqual(log.body.events[1].fields, ["text"]);
    assert.deepEqual([log.body.events[2].from, log.body.events[2].to, log.body.events[2].by.id], ["open", "resolved", author.uid]);
  });
});

describe("live subscription", () => {
  test("pushes the visible list on every change and stops on unsubscribe", async () => {
    const { alice, author } = await room();
    const seen = [];
    const off = alice.transport.subscribe("/p", (list) => seen.push(list.map((c) => c.id + ":" + c.text)), (e) => assert.fail(e));
    await until(() => seen.length >= 1);
    assert.deepEqual(seen.at(-1), []);
    await call(alice, "PUT", "/comments/c1", wire("c1", "/p"));
    await until(() => seen.at(-1)?.join() === "c1:Hello");
    // Another member's comment and reply reach Alice too.
    await call(author, "PUT", "/comments/by-author", wire("by-author", "/p"));
    await until(() => seen.at(-1)?.slice().sort().join() === "by-author:Hello,c1:Hello");
    await call(alice, "DELETE", "/comments/by-author").then((r) => assert.equal(r.body.error, "not_owner"));
    await call(author, "DELETE", "/comments/by-author");
    await until(() => seen.at(-1)?.join() === "c1:Hello");
    await call(alice, "DELETE", "/comments/c1");
    await until(() => seen.at(-1).length === 0);
    off();
    const n = seen.length;
    await call(alice, "PUT", "/comments/c2", wire("c2", "/p"));
    await sleep(400);
    assert.equal(seen.length, n);
  });
  test("another reviewer's reply is pushed to the comment's owner", async () => {
    const { alice, bob } = await room();
    await call(alice, "PUT", "/comments/c1", wire("c1", "/p"));
    let latest = [];
    const off = alice.transport.subscribe("/p", (list) => { latest = list; }, (e) => assert.fail(e));
    await until(() => latest.length === 1);
    await call(bob, "POST", "/comments/c1/replies", { id: "r1", text: "from Bob" });
    await until(() => latest[0].replies.length === 1);
    assert.deepEqual(latest[0].replies.map((r) => [r.text, r.authorId]), [["from Bob", bob.uid]]);
    off();
  });
  test("a refused subscription reports through onError", async () => {
    const review = uniqueReview();
    await seedReview(review, { name: "Private", open: false });
    const stranger = await makeUser(review);
    const error = await new Promise((resolve) => stranger.transport.subscribe("/p", () => {}, resolve));
    assert.ok(error);
  });
});
