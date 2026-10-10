# annotate wire protocol v1

Defined 2026-10-07. This is the contract between annotate.js's remote
store (ANN-003) and any backend: the reviewjs self-host stack, the hosted
service at `app.reviewjs.com`, or `examples/annotate-server.cjs`. The
conformance suite in `scripts/tests/annotate-server.test.cjs` (ANN-008) is
the executable form of this document; a backend "supports annotate" when it
passes that suite.

Base URL: the value of `data-api` (for example `https://api.reviewjs.com`
or `http://localhost:8787`). All paths below are under `{api}/v1/annotate`.

## Record schema v2

```ts
interface AnnotateComment {
  schema: 2;
  id: string;                 // client-generated, "c" + base36, ≤128 chars; stable forever
  page: string;               // page key as the client computed it (ANN-006); server never re-derives
  url: string;                // full URL at creation
  type: "highlight" | "shape" | "pin" | "pen" | "block" | "note";
  author: string;             // display name, ≤80
  authorId: string | null;    // server-assigned reviewer id; null in local-only mode
  text: string;               // ≤5000
  color: string;              // validated hex (#rgb, #rrggbb, #rrggbbaa)
  anchor: { exact: string; prefix: string; suffix: string } | null; // highlight only
  geom:
    | { kind: "rect" | "circle"; selector: string; x: number; y: number; w: number; h: number; vw: number; vh: number }
    | { kind: "pin"; selector: string; x: number; y: number; vw: number; vh: number }
    | { kind: "pen"; selector: string; points: [number, number][]; vw: number; vh: number }
    | { kind: "block"; selector: string }
    | null;
  visibility: "shared" | "private";   // "shared" = sent to the review (creator + review authors); private never reaches the wire
  status: "open" | "in_progress" | "resolved" | "wont_fix";   // lifecycle, see §Comment lifecycle
  resolved: boolean;          // derived: status is "resolved" or "wont_fix"; kept for 1.4 clients
  resolvedBy: string | null;  // authorId of whoever closed it; null while open
  resolvedAt: string | null;  // ISO 8601; null while open
  assignee: { id: string | null; name: string } | null;  // who is addressing it
  assignedAt: string | null;  // ISO 8601
  deletedAt?: string | null;  // tombstones only; present only with ?include=deleted
  replies: AnnotateReply[];   // ≤500
  createdAt: string;          // ISO 8601, client clock on create; server may overwrite
  updatedAt: string;          // ISO 8601, server clock once stored
  editedAt: string | null;
}

interface AnnotateReply {
  id: string;
  author: string;
  authorId: string | null;
  text: string;               // ≤5000
  createdAt: string;
  editedAt: string | null;
}

interface FeedbackExport {       // file export and data-post-url body (unchanged envelope)
  annotate: string;              // library version
  schema: 2;
  kind: "annotate-export";
  exportedAt: string;
  page: string;
  url: string;
  project: string;
  exportedViewport: { vw: number; vh: number; dpr: number };
  comments: AnnotateComment[];
}
```

Rules:

- Keys beginning with `__` are never serialized and are rejected on input.
- Unknown keys are dropped by both sides, never stored.
- Numbers must be finite. Coordinates are fractions of the anchor box; the
  server stores them untouched.
- `page` and `url` are opaque to the server. The dashboard groups by `page`.
- `id` matches `^[A-Za-z0-9_-]{1,128}$`. Reply ids follow the same rule.
- A v1 record (no `schema`, no `status`) is upgraded on read: `status` is
  `"resolved"` when `resolved` is true, else `"open"`; every other new field
  is `null` (or `"shared"` for `visibility`).

## Visibility

A comment is visible only to the reviewer who created it and to the
review's **authors** (the people who invited reviewers; `reviewer.role ==
"author"` in the session response, or the dashboard). Reviewers never see
each other's comments, on any route:

- `GET …/comments` lists only the caller's own comments, unless the caller
  is an author.
- Another reviewer's comment does not exist for the caller: replies and
  activity answer `404 { "error": "comment_not_found" }`, deleting one of
  its replies is a no-op `204`, and `PUT`/`DELETE` on its id answer
  `403 { "error": "not_owner" }` without the record (ids are random
  client values, so the 403 discloses nothing useful).
- An author's reply on a reviewer's comment is visible to that reviewer,
  because replies are embedded in the comment.

## Comment lifecycle

A comment is **raised** by a reviewer, **addressed** and **disposed** by
review authors, and **tracked** throughout.

```
             assign / start                    resolve
  ┌──────┐ ─────────────────► ┌─────────────┐ ─────────────► ┌──────────┐
  │ open │                    │ in_progress │                │ resolved │
  └──────┘ ◄───────────────── └─────────────┘                └──────────┘
     ▲  │        stop                │ won't fix                   │
     │  │ won't fix                  ▼                             │
     │  └──────────────────────► ┌──────────┐                      │
     └──────── reopen ────────── │ wont_fix │ ◄────────────────────┘ (reopen
                                 └──────────┘                        goes to open)
                     any state ── delete ──► tombstone ── purge ──► gone
```

- **Raised.** `PUT` of an unknown id creates the record with `status:
  "open"` unless the body says otherwise. The server stamps `author` and
  `authorId` from the session.
- **Addressed.** `assignee` names who is working on it. Only authors
  set or clear it (`{ "id": <reviewer id or null>, "name": "…" }` or
  `null`); a reviewer's change is `403 { "error": "not_author" }` and an
  assignee in a reviewer's create is ignored. The server sets `assignedAt`. `in_progress` is the state for
  "someone is on it"; assigning does not change `status` by itself.
- **Tracked.** Every accepted change appends an event to the comment's
  activity log (`GET …/comments/{id}/activity`). The log survives a delete
  until the tombstone is purged.
- **Disposed.** Two closed states: `resolved` (addressed) and `wont_fix`
  (declined). Closing sets `resolvedBy` and `resolvedAt`; reopening (any
  closed → `open` or `in_progress`) clears them. `resolved` is always
  derived from `status` by the server; a body that sends only `resolved`
  (1.4 client) maps `true → "resolved"`, `false → "open"`.
  Delete removes the record from every list and leaves a **tombstone**
  (`deletedAt`). Any later `PUT` or reply to that id is `410 { "error":
  "deleted" }`, so a stale offline queue cannot resurrect it. Tombstones
  are purged after a retention window the backend configures (reference
  server: `PURGE_AFTER_DAYS`, default 30); after a purge the id is free.

Any transition between the four statuses is allowed; clients offer the
arrows above. The creator may change status (for example to withdraw a
comment as `wont_fix`) and edit text, color, anchor and geom; authors may
change everything, including the assignee.

### Who does what

| Action | Creator (reviewer) | Other reviewer | Review author |
|---|---|---|---|
| See the comment, its replies and history | yes | no | yes |
| Edit text, color, anchor, geom | yes | no | yes |
| Reply; delete own reply | yes | no | yes |
| Close (`resolved`/`wont_fix`), reopen | yes | no | yes |
| `in_progress`, assign | no (client hides it) | no | yes |
| Delete (tombstone) | yes | no | yes |

A reviewer is responsible only for their own comments: they raise, edit,
withdraw, reopen and delete them, and follow what authors do with them.

### Reviewer view (client obligations)

- **Updates are never silent.** The client keeps, per comment, the server
  `updatedAt` it last showed the reviewer (a read mark, local to the
  browser). A newer server version with no local write behind it is
  someone else's change (an author reply, assignment or disposal): the
  client flags the comment as updated and says so. The reviewer's own
  acknowledged writes advance the mark.
- **Disposal is visible.** A closed comment the reviewer has not seen yet
  stays in the open list, labelled with who closed it (`resolvedBy`) and
  when, until the reviewer marks it seen. Comments an author deleted are
  announced once.
- **History.** The client shows `GET …/comments/{id}/activity` on demand.
  Without a backend (or before the first write is acknowledged) it shows a
  summary derived from `createdAt`, `editedAt`, `assignedAt`,
  `resolvedAt` and the replies.

## Authentication

Every request after the session exchange carries
`Authorization: Bearer <session token>`. Tokens are opaque to the client.
No cookies are ever sent (`credentials: "omit"`), so the backend must not
rely on them and must not set `Access-Control-Allow-Credentials`.

### POST `/reviews/{reviewId}/session`

Exchange an invite token for a session token.

```
Request:  { "invite": "<token from ?an_invite=>" }
          Optional for open reviews: { "name": "<display name>" } with no invite.
Response: 200 {
  "token": "<opaque>", "expiresAt": "<ISO>",
  "reviewer": { "id": "rvr_…", "name": "Dev", "role": "reviewer" | "author" },
  "review": { "id": "rvw_…", "name": "Pricing page beta", "note": "…", "pages": ["/pricing"] }
}
          403 { "error": "invite_invalid" | "invite_expired" | "invite_revoked" | "review_closed" | "origin_not_allowed" }
          404 { "error": "review_not_found" }
```

Session tokens expire in 24 hours. The client re-exchanges on 401 and on
every page load; the invite token is the durable credential.

### Origin check

The backend verifies the browser `Origin` header against the review's
registered origins on **every** request, including the session exchange.
A mismatch is `403 { "error": "origin_not_allowed" }`. CORS reflects only
registered origins; `Access-Control-Allow-Headers` must include
`Authorization, Content-Type, Idempotency-Key, If-None-Match` and
`Access-Control-Expose-Headers` must include `ETag, Retry-After`.

## Comments

### GET `/reviews/{reviewId}/comments?page={pageKey}`

```
Headers:  If-None-Match: "<etag>"   (optional)
Response: 200 { "comments": AnnotateComment[] }   with ETag: "<etag>"
          304 (no body) when unchanged
```

Returns the shared comments for that page that the caller may see
(§Visibility), replies embedded, ordered by
`createdAt`. Without `page`, returns the whole review (dashboard use; may
be paginated with `?cursor=` later, clients must tolerate `nextCursor`).
Tombstones are excluded; `&include=deleted` adds them with `deletedAt` set.
The ETag covers exactly the returned list.

### PUT `/reviews/{reviewId}/comments/{id}`

Create or update top-level fields. The body is a full `AnnotateComment`;
the server ignores `replies`, `authorId`, `author`, `resolvedBy`,
`resolvedAt`, `assignedAt`, `editedAt` and `deletedAt`, and derives
`resolved` from `status`. `updatedAt` in the body is the **base**: the
`updatedAt` the client last received from the server for this id (on
create, any value). It is used only for the stale check.

```
Headers:  Idempotency-Key: <uuid>
Response: 200 { "comment": AnnotateComment }  (stored form, server timestamps)
          201 same, on first create
          403 { "error": "not_owner" } when the id belongs to a comment the caller cannot see
          403 { "error": "not_author" } when a reviewer changes the assignee
          409 { "error": "stale", "comment": AnnotateComment } when the stored updatedAt is newer than the body's; client re-applies on top
          410 { "error": "deleted" } when the id is a tombstone
          413 / 422 on caps and validation
```

The server sets `editedAt` when `text` changes on an existing record.

Ownership: the creator and authors may update a comment (§Visibility,
§Comment lifecycle). The visibility check runs before the stale check, so
a `409` never returns a record the caller cannot see.

### DELETE `/reviews/{reviewId}/comments/{id}`

Creator or author only (`403 { "error": "not_owner" }` otherwise). `204`.
Idempotent: deleting a missing id or a tombstone is `204`. Leaves a
tombstone (§Comment lifecycle).

### GET `/reviews/{reviewId}/comments/{id}/activity`

```
Response: 200 { "events": ActivityEvent[] }   oldest first, ≤1000 per comment
          404 { "error": "comment_not_found" }  (never existed or purged)

interface ActivityEvent {
  at: string;                 // ISO 8601, server clock
  by: { id: string; name: string };
  kind: "created" | "edited" | "status" | "assigned" | "replied" | "reply_deleted" | "deleted";
  from?: unknown;             // status: old status; assigned: old assignee
  to?: unknown;               // status: new status; assigned: new assignee
  replyId?: string;           // replied, reply_deleted
  fields?: string[];          // edited: which of text/color/anchor/geom changed
}
```

### POST `/reviews/{reviewId}/comments/{id}/replies`

```
Request:  { "id": "<client id>", "text": "…" }
Response: 201 { "comment": AnnotateComment }   (full updated record)
          200 when the reply id already exists (idempotent)
```

Replies are appended server-side, never replaced wholesale, so concurrent
replies cannot clobber each other. The server stamps `author`, `authorId`
and `createdAt`. A reply to a tombstone is `410 { "error": "deleted" }`;
a missing comment is `404 { "error": "comment_not_found" }`; a full thread
(500 replies) is `422 { "error": "too_many_replies" }`.

### DELETE `/reviews/{reviewId}/comments/{id}/replies/{replyId}`

Reply author or review author only (`403 { "error": "not_owner" }`).
`204`, idempotent.

### Idempotency

Every write carries `Idempotency-Key`. The server stores the response
(status and body) per session reviewer and key for at least 24 hours and
replays it for a repeat key. Clients treat a replayed `200` and a first
`201` the same. A client that changes the body (for example after a
`409`) sends a new key.

### Client sync obligations

- Writes go through a persisted FIFO queue, one request in flight.
- `401`: re-exchange the session once, then hold the queue and call
  `onUnauthorized`. `403 not_owner`, `404`, `413`, `422`: drop the op and
  re-read. `409`: re-apply the op's fields on the returned record and
  re-send with a new key. `410`: drop every op for that id and remove it.
  `429`/`503`: wait `Retry-After`. Network errors and `5xx`: exponential
  backoff with jitter.
- Poll `GET ?page=` with `If-None-Match`. The server list is authoritative
  for records with no pending op; a record absent from the list and with
  no pending op was deleted remotely.

## Rate limits and errors

- Requests without a JSON `Content-Type` on a body are `415`; bodies over
  256 KB are `413 { "error": "too_large" }`; bad JSON is
  `400 { "error": "invalid_json" }`; schema failures are
  `422 { "error": "invalid_comment", "message": "<field>" }`.
- `429` with `Retry-After: <seconds>`; the client honors it before retrying.
- `503` with optional `Retry-After` for maintenance.
- Error bodies are always `{ "error": "<snake_case_code>", "message"?: string }`.
  Internal error text is never returned.
- Suggested limits: 60 writes per minute per session, 600 per day per
  reviewer, 120 reads per minute per IP. Self-hosters configure them.

## Security notes

- **Token custody is in-page.** Scripts on the reviewed page can read the
  invite and session tokens. The blast radius is one reviewer's identity
  in one review, bounded by token expiry and author-side revocation. This
  replaces the earlier reviewjs design (iframe custody plus page-origin
  proofs), a deliberate trade recorded in the reviewjs backlog (TBD-140).
- The server-side `Origin` check on every write is the origin gate. It is
  stronger than a one-time proof because it is re-checked per request.
- Invite links are per reviewer and revocable from the dashboard. Author
  accounts normally use the dashboard session; an author invite (session
  `role: "author"`) lets an author address comments in-page. A leaked
  author token exposes every comment in that one review, so author invites
  should be short-lived.
- Bodies are capped at 256 KB; a `pen` record with 10,000 points is about
  200 KB, so the cap is deliberate.

## Versioning

The protocol version is in the path (`/v1/annotate`). Additive fields are
allowed without a bump; clients ignore unknown response fields. Removing or
retyping a field, or changing an error code's meaning, is `/v2`.
