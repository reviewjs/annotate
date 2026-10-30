# Remote feedback disposition and conflict handling

Date: 2026-10-30
Status: Proposed; product behavior confirmed, written design pending review
Scope: annotate.js, its reference server, public types, protocol, deployment documentation, and tests

## Outcome and agreed behavior

A review author can address and dispose a reviewer's comment. The reviewer sees
the decision, explanation, actor, and time, and can explicitly **Accept** it or
**Reopen with a reason**. The user selected this interaction on 2026-10-30.
An author's **Won't fix** decision requires an explanation. Acceptance is shared
server state; marking an update as seen remains a browser-local read action.

The implementation must preserve local-only annotation, existing saved records,
exports, invite authentication, reviewer privacy, and the dependency-free client.
Success means a real author/reviewer round trip through the remote server,
including offline retries and conflicting decisions, with no silently lost work.

## Current implementation and gaps

- `annotate.js` already supports open/in-progress/resolved/won't-fix, assignment,
  remote replies, unread indicators, history, and reopening.
- Closing currently records actor/time but has no structured explanation,
  durable reviewer acceptance, or reasoned reopen operation.
- `handleResponse()` automatically reapplies fields after a 409 and eventually
  drops the operation after repeated conflicts. Overlapping decisions are not
  presented for human resolution.
- Queue operations rebuild PUT bodies from mutable cached records. Polling can
  advance the remembered server timestamp while local changes remain pending;
  a timestamp alone does not retain the original edit base.
- `putComment()` rejects older supplied timestamps, but missing or future base
  timestamps can bypass this check. DELETE has no version precondition.
- The reference server serializes writes only inside one process; its JSON
  storage and in-memory idempotency cache are not a multi-replica database.

These findings are from the current working tree, not a production inspection.

## Approach and alternatives

Extend the existing four statuses with an additive structured disposition and
reviewer response, plus an atomic lifecycle-action endpoint. This keeps status
filters and exports useful while making acceptance distinct from resolution.

Adding more status strings such as "accepted" would conflate an author's decision
with a reviewer's response and complicate older clients. Using ordinary replies
alone would leave decision explanations and acceptance ambiguous, and posting a
reply followed by a status update could partially succeed. Neither is selected.

## Lifecycle and permissions

| Situation | Available action | Result |
| --- | --- | --- |
| Open or in progress | Author resolves, optionally explains | Resolved, awaiting reviewer response |
| Open or in progress | Author declines with required explanation | Won't fix, awaiting reviewer response |
| Disposed, awaiting response | Original reviewer accepts | Same closed status, accepted decision |
| Disposed, awaiting response or accepted | Original reviewer reopens with required reason | Open; decision response records reopen |
| Any visible comment | Reply | Discussion appended without changing disposition |
| Open | Author starts/stops work or assigns | Existing status/assignment behavior |
| Own open comment | Reviewer withdraws | Explicit withdrawal; no fabricated author disposition |

Only review authors dispose or assign. Only the original reviewer accepts or
requests reopening; an author may administratively reopen, identified as such
in history. Another reviewer cannot see the comment or its actions. Server-side
identity and role checks are authoritative; display-name matching is never an
authorization fallback in remote mode. A review author cannot accept on behalf
of a different reviewer. Reopening clears active acceptance and closing metadata.

An author can issue a replacement disposition, including after acceptance.
Every new decision gets a new ID and awaits a new reviewer response. Accepting
an old decision must never accept its replacement. History retains prior cycles.

## Record and API contract

Keep schema v2 and existing statuses; add optional fields, normalized to null on
old records:

- `disposition`: `{ id, status, reason, by: { id, name }, at }` or null. Status is
  `resolved` or `wont_fix`. Reasons are trimmed plain text, maximum 5,000 chars.
- `reviewerResponse`: `{ dispositionId, action: 'accepted', by: { id, name }, at }`
  or null. Reopen reasons and prior decisions remain in activity history.

Add `POST /reviews/{reviewId}/comments/{id}/actions`, using the existing bearer
session, CORS policy, and `Idempotency-Key`. Body includes `action`, the exact
`baseUpdatedAt`, `dispositionId` when responding, and `reason` where required.
Actions are `resolve`, `decline`, `accept`, `reopen`, and `withdraw`.

The server validates visibility, permissions, current version, target decision,
and reason before one serialized transaction updates the record and appends the
activity event. A reasoned reopen also adds a system-associated thread entry in
the same transaction, so authors see the request without opening history. Thread
capacity is checked before mutation; a full thread returns an actionable error
without changing status. Responses return the full canonical comment. Actor,
timestamps, decision IDs, and acceptance are server-owned.

Use 409 with the visible canonical record for stale state or a changed decision;
410 for tombstones; 403 for denied actions; 422 for invalid/empty reasons or
invalid transitions. Hidden records return 404 without a record. Repeated keys
with the same request return the original result; key reuse with a different
request returns a conflict. Persist successful action deduplication with the
record/history so a lost response followed by a server restart cannot duplicate
a decision or a reasoned reopen.

Advertise support in session metadata as `capabilities: ['disposition-v1']`.
With an older backend, retain the existing workflow and clearly identify that
structured decisions and acceptance are unavailable. Do not simulate successful
shared acceptance in localStorage. Legacy PUT clients keep their existing
status semantics; a legacy close is displayed as a legacy closure, and a legacy
status change invalidates active acceptance. Legacy clients cannot write the
new server-owned fields. Public `setStatus()` uses lifecycle actions when the
backend supports them; decline/reopen that require a reason return an explicit
error unless the new action API supplies one. Add typed programmatic action
methods and action-result/error events for integrators.

## Conflict and recovery rules

1. Persist each queued operation's immutable intent and original base values,
   independently of the optimistic cache. Retries with the same idempotency key
   use the same request body. Subsequent edits are separate queued intentions.
2. Existing-record PUT requires a valid, exact base timestamp. Missing, older,
   or future bases do not bypass compare-and-swap. Creates remain supported.
3. On stale content writes, compare original base, latest server, and local
   intent by field. Rebase disjoint changes automatically. If both sides changed
   the same field to different values, persist a conflict and pause that
   comment's writes. Show **Use latest** and **Keep my change**, with both values
   reviewable. A deliberate retry gets a new key and current base.
4. Never automatically reapply a stale lifecycle action or DELETE. Present the
   current decision and preserve the user's explanation for review/retry.
   Add an exact base precondition for new-client DELETE requests while keeping
   legacy delete compatibility documented.
5. Blocking one comment must not block independent comments. Writes for one
   comment stay ordered. `submit()` rejects with actionable pending-conflict
   information; the footer cannot say "Sent" while a conflict remains.
6. Concurrent replies append and deduplicate by reply ID. Replies do not
   silently accept, reopen, or replace a decision. Simultaneous acceptance and
   reopen of one decision produce one accepted action and one visible conflict.
7. A remote tombstone wins. Preserve rejected local text and explanations in a
   recoverable draft with copy/download and an explicit "Create new comment"
   action; never resurrect the deleted ID automatically.
8. Polls and acknowledgements preserve active composers, reply/edit/action
   drafts, and unresolved conflicts. A background fetch cannot change the base
   of an already queued action. Older in-flight responses cannot regress state.
9. Queues, conflict drafts, and read marks are scoped to API origin, review, and
   authenticated identity. Switching identity never sends another user's queue;
   old unscoped work is quarantined for recovery rather than silently replayed.
10. Network errors, auth expiry, rate limits, permanent rejection, repeated
    conflicts, and storage failures show distinct states and retain recoverable
    input. Exhausting retries never silently drops a user's change.

## User interface

The card displays an explicit decision block with outcome, explanation, author,
time, and response: **Awaiting your response**, **Accepted by ...**, or reopened
activity. Closed comments needing a reviewer response remain discoverable until
accepted or reopened, even after marking them seen. Add **Needs my response**
and **Conflicts** filters with counts; preserve existing Open/Resolved/All filters.

Author controls open a small disposition form; reviewer controls offer Accept,
Reply, and Reopen with a reason. Required reasons have inline validation. Pending
actions have a visible sync state and prevent duplicate clicks. History shows
reasons and explicit decision/response events, including repeated cycles.
Conflict controls show what changed and retain editable local text. All controls
have labels, keyboard operation, mobile layouts, and text-only safe rendering.

## Remote deployment and compatibility

Deliver an executable self-host example configuration with separate author and
reviewer invites, persistent data mount, exact allowed origins, health check,
and a reverse-proxy/TLS example. Add instructions for startup, backup/restore,
restart verification, upgrade, and rollback. Keep the reference backend limited
to one process/replica and enforce a data-directory writer lock; do not claim
multi-process safety from atomic file rename. Load/write errors fail visibly
without replacing existing data with an empty review or acknowledging a write
that did not persist. Stage record/history changes and publish them to the cache
only after durable save succeeds.

This repository can deliver a working remote server and client integration.
The separately deployed Reviewjs API/dashboard must implement the new action
contract before enabling its capability. No production deployment or changes
to the adjacent `reviewjs` repository are included in this initial scope.

## Verification and completion criteria

- Server tests: role isolation; required reasons; exact version checking;
  forged/missing/future bases; stale acceptance; simultaneous actions; atomic
  reason/status/history; duplicate keys, changed-body keys, restart retries;
  delete races; full threads; persistence failure; writer-lock enforcement.
- Browser tests using isolated author/reviewer contexts against the real server:
  raise → assign/start → dispose with explanation → see pending response →
  accept → reopen with reason → dispose again. Verify filters and history.
- Browser race tests: overlapping and disjoint edits; action versus polling;
  acceptance versus replacement decision; offline/reload recovery; deleted
  comment with an unsent explanation; identity switch; unrelated comments
  syncing past a conflict; active drafts surviving all background updates.
- Run server tests, affected browser tests across desktop engines and mobile,
  existing regression suite, build/generated artifact parity, type-consumer
  checks, and package dry run. Record actual passes/skips and limitations.
- Exercise documented remote configuration with persistent storage and a server
  restart. Verify both roles through the built client. This is deployment
  readiness evidence, not evidence that an existing production host was changed.

The implementation is complete when the supported reference deployment passes
these checks, public API/types/protocol/docs agree, and no pending conflict or
failed write is represented as a successful disposition or acceptance.
