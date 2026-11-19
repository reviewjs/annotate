// The security rules are the trust boundary: a hostile client talks to
// Firestore directly, not through firebase.mjs. These tests do exactly that.
import { after, describe, test } from "node:test";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";
import { cleanup, seedReview, testEnv, uniqueReview } from "./firebase-helpers.mjs";

after(cleanup);

const comment = (id, uid, extra = {}) => ({ id, authorId: uid, page: "/p", text: "hi", status: "open", assignee: null, replies: [], deletedAt: null, ...extra });

async function setup(reviewData = { name: "R", open: true }) {
  const review = uniqueReview();
  await seedReview(review, reviewData, {
    author: { role: "author", name: "Owner" }, alice: { role: "reviewer", name: "Alice" }, bob: { role: "reviewer", name: "Bob" },
  });
  const env = await testEnv();
  const as = (uid) => env.authenticatedContext(uid).firestore();
  const path = (...p) => ["annotateReviews", review, ...p];
  return { review, as, path, env };
}

describe("comments", () => {
  test("every member reads and lists every comment; non-members read nothing", async () => {
    const { as, path, env } = await setup();
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), ...path("comments", "ca")), comment("ca", "alice"));
      await setDoc(doc(c.firestore(), ...path("comments", "cb")), comment("cb", "bob"));
    });
    const alice = as("alice");
    await assertSucceeds(getDoc(doc(alice, ...path("comments", "ca"))));
    await assertSucceeds(getDoc(doc(alice, ...path("comments", "cb"))));                                             // someone else's
    await assertSucceeds(getDocs(collection(alice, ...path("comments"))));                                           // unfiltered
    await assertSucceeds(getDocs(query(collection(alice, ...path("comments")), where("page", "==", "/p"))));
    await assertSucceeds(getDocs(collection(as("author"), ...path("comments"))));
    await assertSucceeds(getDoc(doc(alice, ...path("comments", "unused-id"))));                                      // creating is read-then-write
    const carol = as("carol");                                                                                       // signed in, not a member
    await assertFails(getDoc(doc(carol, ...path("comments", "ca"))));
    await assertFails(getDocs(collection(carol, ...path("comments"))));
    await assertFails(getDoc(doc(carol, ...path("comments", "unused-id"))));
    await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), ...path("comments"))));
  });
  test("a reviewer cannot forge authorId, assign, hard-delete, or take over a comment", async () => {
    const { as, path, env } = await setup();
    const alice = as("alice");
    await assertSucceeds(setDoc(doc(alice, ...path("comments", "c1")), comment("c1", "alice")));
    await assertFails(setDoc(doc(alice, ...path("comments", "c2")), comment("c2", "bob")));                          // forged author
    await assertFails(setDoc(doc(alice, ...path("comments", "c3")), comment("c3", "alice", { assignee: { id: "author", name: "O" } })));
    await assertFails(updateDoc(doc(alice, ...path("comments", "c1")), { assignee: { id: "author", name: "O" } }));
    await assertFails(updateDoc(doc(alice, ...path("comments", "c1")), { authorId: "bob" }));
    await assertFails(deleteDoc(doc(alice, ...path("comments", "c1"))));
    await assertSucceeds(updateDoc(doc(alice, ...path("comments", "c1")), { text: "edited", status: "resolved" }));
    await assertFails(updateDoc(doc(as("bob"), ...path("comments", "c1")), { text: "hijack" }));
    await assertFails(setDoc(doc(as("stranger"), ...path("comments", "c4")), comment("c4", "stranger")));              // not a member
  });
  test("an author can change any comment and assign it, but not hard-delete", async () => {
    const { as, path, env } = await setup();
    await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), ...path("comments", "ca")), comment("ca", "alice")));
    const author = as("author");
    await assertSucceeds(updateDoc(doc(author, ...path("comments", "ca")), { assignee: { id: "author", name: "O" }, status: "in_progress" }));
    await assertFails(updateDoc(doc(author, ...path("comments", "ca")), { authorId: "author" }));
    await assertFails(deleteDoc(doc(author, ...path("comments", "ca"))));
  });
  test("a tombstone cannot be revived", async () => {
    const { as, path, env } = await setup();
    await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), ...path("comments", "gone")), { id: "gone", authorId: "alice", page: "/p", deletedAt: "2026-01-01T00:00:00Z" }));
    await assertFails(setDoc(doc(as("alice"), ...path("comments", "gone")), comment("gone", "alice")));
    await assertFails(updateDoc(doc(as("author"), ...path("comments", "gone")), { text: "back" }));
  });
  test("a closed review accepts no writes", async () => {
    const { as, path } = await setup({ name: "R", open: true, closed: true });
    await assertFails(setDoc(doc(as("alice"), ...path("comments", "c1")), comment("c1", "alice")));
  });
});

describe("replies and activity on someone else's comment", () => {
  const reply = (id, uid, extra = {}) => ({ id, author: uid, authorId: uid, text: "hello", createdAt: "2026-01-01T00:00:00Z", editedAt: null, ...extra });
  async function withComment(data = {}, reviewData) {
    const ctx = await setup(reviewData);
    await ctx.env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), ...ctx.path("comments", "ca")), comment("ca", "alice", data)));
    return { ...ctx, ref: (uid) => doc(ctx.as(uid), ...ctx.path("comments", "ca")) };
  }

  test("a member may append exactly one reply of their own, and nothing else", async () => {
    const { ref } = await withComment({ replies: [reply("r0", "author")] });
    const bob = ref("bob"), old = [reply("r0", "author")];
    await assertSucceeds(updateDoc(bob, { replies: [...old, reply("r1", "bob")], updatedAt: "2026-02-01T00:00:00Z" }));
  });
  test("a member may add the first reply to a comment that has none", async () => {
    const { ref } = await withComment();
    await assertFails(updateDoc(ref("bob"), { replies: [reply("r1", "alice")] }));                                         // forged first reply
    await assertFails(updateDoc(ref("bob"), { replies: [reply("r1", "bob"), reply("r2", "bob")] }));                        // two at once
    await assertSucceeds(updateDoc(ref("bob"), { replies: [reply("r1", "bob")], updatedAt: "2026-02-01T00:00:00Z" }));
  });
  test("a reply cannot be forged, stacked, edited, removed or smuggled alongside another change", async () => {
    const { ref } = await withComment({ replies: [reply("r0", "author")] });
    const bob = ref("bob"), old = [reply("r0", "author")];
    await assertFails(updateDoc(bob, { replies: [...old, reply("r1", "alice")] }));                                       // someone else's name
    await assertFails(updateDoc(bob, { replies: [...old, reply("r1", "bob"), reply("r2", "bob")] }));                      // two at once
    await assertFails(updateDoc(bob, { replies: [reply("r0", "author", { text: "edited" }), reply("r1", "bob")] }));        // rewrites the thread
    await assertFails(updateDoc(bob, { replies: [] }));                                                                      // removes a reply
    await assertFails(updateDoc(bob, { replies: [...old, reply("r1", "bob", { extra: 1 })] }));                              // unknown key
    await assertFails(updateDoc(bob, { replies: [...old, reply("r1", "bob")], text: "hijacked" }));                          // plus an edit
    await assertFails(updateDoc(bob, { replies: [...old, reply("r1", "bob")], status: "resolved" }));                        // plus a resolve
    await assertFails(updateDoc(bob, { replies: [...old, reply("r1", "bob")], assignee: { id: "bob", name: "B" } }));
    await assertFails(updateDoc(bob, { text: "hijacked" }));
    await assertFails(updateDoc(bob, { status: "resolved" }));
    await assertFails(updateDoc(bob, { authorId: "bob" }));
  });
  test("no reply on a deleted comment, in a closed review, or by a non-member", async () => {
    const dead = await withComment({ deletedAt: "2026-01-01T00:00:00Z" });
    await assertFails(updateDoc(dead.ref("bob"), { replies: [reply("r1", "bob")] }));
    const closed = await withComment({}, { name: "R", open: true, closed: true });
    await assertFails(updateDoc(closed.ref("bob"), { replies: [reply("r1", "bob")] }));
    const open = await withComment();
    await assertFails(updateDoc(open.ref("carol"), { replies: [reply("r1", "carol")] }));
  });
  test("an author is unaffected: edits, resolves, assigns and replies", async () => {
    const { ref } = await withComment();
    const author = ref("author");
    await assertSucceeds(updateDoc(author, { text: "edited", status: "resolved", assignee: { id: "author", name: "O" } }));
    await assertSucceeds(updateDoc(author, { replies: [reply("r1", "author")] }));
    await assertFails(updateDoc(author, { authorId: "author" }));
  });
  test("any member reads activity; a non-owner may log only their own reply event", async () => {
    const { as, path, env } = await setup();
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), ...path("comments", "ca")), comment("ca", "alice"));
      await setDoc(doc(c.firestore(), ...path("comments", "ca", "activity", "e0")), { at: "2026-01-01T00:00:00Z", by: { id: "alice", name: "A" }, kind: "created" });
    });
    const bob = as("bob");
    await assertSucceeds(getDoc(doc(bob, ...path("comments", "ca", "activity", "e0"))));
    await assertSucceeds(getDocs(collection(bob, ...path("comments", "ca", "activity"))));
    await assertFails(getDocs(collection(as("carol"), ...path("comments", "ca", "activity"))));
    const event = (kind, uid = "bob") => ({ at: "2026-02-01T00:00:00Z", by: { id: uid, name: "B" }, kind });
    await assertSucceeds(setDoc(doc(bob, ...path("comments", "ca", "activity", "e1")), event("replied")));
    await assertFails(setDoc(doc(bob, ...path("comments", "ca", "activity", "e2")), event("status")));                 // not their comment
    await assertFails(setDoc(doc(bob, ...path("comments", "ca", "activity", "e3")), event("replied", "alice")));      // forged actor
    await assertFails(setDoc(doc(bob, ...path("comments", "ca", "activity", "e0")), event("replied")));              // no overwrite
  });
});

describe("members", () => {
  test("anyone signed in joins an open review as a reviewer, and only that", async () => {
    const { as, path } = await setup();
    const carol = as("carol");
    await assertFails(setDoc(doc(carol, ...path("members", "carol")), { role: "author", name: "C" }));              // self-promotion
    await assertFails(setDoc(doc(carol, ...path("members", "dave")), { role: "reviewer", name: "D" }));             // someone else's slot
    await assertFails(setDoc(doc(carol, ...path("members", "carol")), { role: "reviewer", name: "C", extra: 1 }));
    await assertSucceeds(setDoc(doc(carol, ...path("members", "carol")), { role: "reviewer", name: "Carol" }));
  });
  test("an invite-only or closed review cannot be joined", async () => {
    const a = await setup({ name: "R", open: false });
    await assertFails(setDoc(doc(a.as("carol"), ...a.path("members", "carol")), { role: "reviewer", name: "C" }));
    const b = await setup({ name: "R", open: true, closed: true });
    await assertFails(setDoc(doc(b.as("carol"), ...b.path("members", "carol")), { role: "reviewer", name: "C" }));
  });
  test("a reviewer may rename themselves but not change role; only authors manage members", async () => {
    const { as, path } = await setup();
    const alice = as("alice");
    await assertSucceeds(updateDoc(doc(alice, ...path("members", "alice")), { name: "Alicia" }));
    await assertFails(updateDoc(doc(alice, ...path("members", "alice")), { role: "author" }));
    await assertFails(updateDoc(doc(alice, ...path("members", "bob")), { name: "x" }));
    await assertFails(getDocs(collection(alice, ...path("members"))));
    await assertSucceeds(updateDoc(doc(as("author"), ...path("members", "bob")), { role: "author" }));
  });
  test("the review document is readable but never writable by clients", async () => {
    const { as, review, env } = await setup();
    await assertSucceeds(getDoc(doc(as("carol"), "annotateReviews", review)));
    await assertFails(updateDoc(doc(as("author"), "annotateReviews", review), { open: false }));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "annotateReviews", review)));
  });
});
