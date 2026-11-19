# Live sync over Firebase (Cloud Firestore)

Date: 2026-11-19
Status: Implemented on `feat/firebase-live-sync`
Scope: `annotate.js` (transport seam), `firebase.mjs` (adapter), Firestore rules, tests, CI, docs

## Outcome

A site owner can point annotate at their own Firebase project and have
reviewers' comments reach the author live, with no server to run. Local-only
mode, the HTTP backend, exports, and the dependency-free `annotate.js` are
unchanged.

## Decisions

- **Cloud Firestore first.** Documents fit comments, `onSnapshot` gives live
  push, transactions give the stale check, and security rules can express the
  reviewer/author visibility model. Realtime Database was rejected: its rules and
  queries are weaker for per-reviewer visibility.
- **Bring-your-own Firebase Auth.** The integrator passes an initialized app.
  If nobody is signed in the adapter signs in anonymously, and the reviewer's
  display name is the one annotate already asks for. Authors are members with
  `role: "author"`, added in the console or with the Admin SDK.
- **Separate entry point.** `@reviewjs/annotate/firebase` with `firebase` as an
  optional peer dependency. `annotate.js` gains no dependency.

## Approach: a transport seam, not a second sync engine

`annotate.js` already has a persisted queue, conflict handling (409 re-apply,
410 tombstone, 401 re-auth, backoff) and merge logic with unread marks, all
behind one function, `apiFetch`. Rather than write a second engine for Firestore,
the core takes an optional `transport` object:

```ts
interface AnnotateTransport {
  request(method, path, { body, headers }): Promise<Response>;   // the wire-protocol routes, in-process
  subscribe?(page, onComments, onError): () => void;            // live push of the page's visible list
  destroy?(): void;
}
```

`apiFetch` calls `transport.request` instead of `fetch`; everything below it is
shared. The Firebase adapter implements wire protocol v1 on Firestore, so the
queue, conflict and offline behaviour carry over and the protocol stays the
single contract. Other databases can implement the same interface.

### Live updates

With `subscribe`, `startSync` subscribes to the page's list and feeds each
snapshot to the same `mergeServerPage` a poll uses. Polling stays on as a 60 s
safety net. Two races are handled explicitly:

- A snapshot that arrives while a write is in flight is set aside and a re-read
  runs when the write finishes.
- A snapshot right after an acknowledgement may predate our own write, and
  `mergeServerPage` treats "in my cache, absent from the list, no pending op" as
  *deleted remotely*. For 1.5 s after an ack, records missing from a snapshot are
  kept, then the list is re-merged.

A refused subscription behaves like a refused session: a message, then local mode.

## Data model

```
annotateReviews/{review}                    { name, note, pages, open, closed }
annotateReviews/{review}/members/{uid}      { role: "author" | "reviewer", name }
annotateReviews/{review}/comments/{id}      AnnotateComment (schema 2), replies embedded, deletedAt, purgeAt
annotateReviews/{review}/comments/{id}/activity/{auto}   ActivityEvent
```

- Every member lists every comment (filtered by `page` when given); `members` can
  only be listed by authors.
- A delete is an update to a tombstone that keeps only what is needed to refuse
  stale writes; a Firestore TTL policy on `purgeAt` removes it later.
- `pen` strokes are flattened (`pointsFlat`) because Firestore rejects nested arrays.

## Security

The rules are the trust boundary; `firebase.mjs` runs in the attacker's browser.
`rules` tests attack Firestore directly. Enforced: **every member reads every
comment and its activity and may reply to any comment** (a non-owner's update may
change nothing but `replies` and `updatedAt`, and only append one reply of their
own or remove one of their own); a comment's owner may likewise add or remove only
their own replies, so nobody can write words in another member's name; a reviewer creates comments and edits, resolves or deletes only their own;
`authorId` is immutable and must be the caller; only authors assign; no client
hard-deletes; tombstones cannot be revived; nobody promotes themselves; closed
reviews take no writes; and joining needs `open: true`.

**Change of behaviour (2026-11-19).** The first version kept reviewers apart
(each saw only their own comments), as the HTTP protocol's §Visibility does. It
now lets every member read everything, because the intended use is a client
review where everyone should see and answer each other's comments. This is a
deliberate difference from §Visibility and is recorded in the wire protocol's
Transports section. Consequently **membership is the privacy boundary**: with
`open: true`, anyone who can sign in can read the whole review.

Known limits, chosen deliberately:

- **Owner-controlled fields.** A reviewer can write any other field of their own
  comment (text, geometry, colour). They cannot add, change or remove anyone
  else's reply: the rules allow a reply change only if it appends or removes
  exactly one reply authored by the caller. Authors may change anything.
- **Client clocks.** `updatedAt` is the stale-check base and comes from the browser.
  The adapter keeps it strictly increasing per document, so skew cannot reorder
  writes, but it is not a trusted timestamp.
- **Reply removal.** A reply's author may remove it from any comment; an author may
  remove any reply. A comment's owner cannot remove someone else's reply (the
  adapter answers `403 not_owner`).
- **Document size.** Replies are embedded; Firestore's 1 MiB limit applies
  (the adapter answers 413). Activity events are not removed with the tombstone.
- **Invites.** There is no invite-link flow. Reviews are `open` (any signed-in
  user joins) or restricted to members an author adds.

## Alternatives rejected

- A Firestore-specific sync engine inside `annotate.js`: duplicates the queue and
  conflict code and drags the SDK into a dependency-free file.
- Cloud Functions in front of Firestore: a server to deploy, which is what this
  feature removes. It remains the upgrade path for stricter integrity.
- Injecting SDK functions instead of importing them: works without a bundler but
  makes setup noisier. Revisit if no-bundler use is common.

## Verification

`npm run test:firebase` (25 tests: rules, protocol conformance, live subscription)
and `npm run test:firebase:e2e` (two browsers) on the emulators; `tests/transport.spec.js`
covers the core seam with an in-memory transport; the existing suites are unchanged.
