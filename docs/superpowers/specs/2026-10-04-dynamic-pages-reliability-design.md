# annotate.js — Reliable Anchoring on Dynamic Pages

**Date:** 2026-10-04
**Status:** Draft (pending review)
**Scope:** P0 reliability release; P1 features documented and cut to a follow-up.

## Purpose

Make annotate-js hold annotations correctly on pages whose DOM changes after load
(framework re-renders, AJAX content, lazy images, carousels, modals) without
inventing new architecture or giving up its identity: **one tiny, vanilla-JS,
zero-dependency file that stores to `localStorage` and exports JSON.**

This document records the review findings and the agreed design, prioritized so
the reliability core ships first and advanced surface features (motion, top-layer
modals, iframes) ship as clearly-scoped follow-ups.

## Constraint: what we are preserving

- Single unminified file, zero runtime dependencies. Prefer ES5-style `var` and
  feature-detect rather than opting the whole file into modern syntax.
- Comments live in `localStorage` and round-trip through a portable JSON file.
  **Legacy saved comments must keep working.** New fields are additive and
  optional; old records without them are still renderable.
- Public API shape (`Annotate.*`) and the explicit `refresh()` page-identity
  contract are stable — existing Playwright tests depend on them.
- Optional `cssPath`-style positional selectors, text quotes (`prefix+exact+
  suffix`) and fractional `geom` coordinates remain the anchor vocabulary.

## Root cause

Anchors lack durable content identity, and the re-render pipeline uses *element
box movement* as a proxy for *content change*.

Three concrete mechanisms are the problem:

1. **Highlights mutate host DOM.** `paintRange()` splits text nodes and wraps
   them in `<mark>` via `Range.surroundContents()`; `clearVisuals()` unwraps via
   `normalize()`. This interferes with framework-rendered text and makes a
   MutationObserver unsafe to add (self-inflicted churn / loops).
2. **Positional CSS selectors are not durable identity.** `cssPath()` builds
   e.g. `body > div:nth-of-type(2) > …`. Sibling insert/reorder or keyed-list
   recycling silently re-pins a comment to different content.
3. **Highlights rescan the whole page several times per comment.** `getTextNodes()`
   concatenates all text; lookups are naive `indexOf` over that concatenation.

### Confirmed defects (from source review, reproducible in code)

| Severity | Defect | Location |
|---|---|---|
| P0 | Multi-paragraph highlight saved with whitespace-only text nodes then immediately reported "lost" (index rejects those nodes). | `getTextNodes()` / `quoteFromRange()` |
| P0 | Highlights wrap/normalize host text nodes; framework reconciliation risk. | `paintRange()` / `clearVisuals()` |
| P0 | No content-change detection; only ResizeObserver + manual `refresh()`. | boot / `buildUI()` |
| P0 | Positional selector accepts first match without identity validation. | `cssPath()` / `resolveAnchorEl()` |
| P0 | Hidden anchor (closed modal/tab/slide) returns a zero box → marker drawn at page origin. | `docBox()` |
| P1 | Detached overlay never recovers if `<body>` is swapped. | `ensureOverlay()` |
| P1 | ResizeObserver does not fire on CSS `transform`; animated sliders don't track. | `buildUI()` |
| P1 | Shared anchor element loses observation when one comment is unobeyed. | `observeAnchors()` |
| P1 | Highlights re-wrap while the tool is collapsed (no `state.enabled` gate). | `renderAll()` |
| P1 | React `useId` values like `:r1:` treated as stable ids. | `cssPath()` |

## Design

The work is split into a **P0 reliability release** (this spec) and **P1 surface
features** (documented separately). Each P0 item is one focused change with its
own tests; they are ordered so earlier changes do not conflict with later ones.

### P0-1 — One shared text index + whitespace-insensitive matching

Replace the per-comment repeated scans with a single, built-once text index per
render, and strip "invisible" characters on **both** the index and the needle so
pretty-printed markup, framework re-renders and legacy quotes all agree.

- Reject only truly empty text nodes; accept whitespace-only nodes so offsets
  stay contiguous with `Range.toString()` output.
- Strip whitespace and invisible code points consistently using one shared
  predicate for indexing and matching.
- Tiered resolution, most→least context, first tier with **exactly one** match
  wins: `prefix+exact+suffix` → `prefix+exact` → `exact+suffix` → `exact`.
  Exactly-2+ matches at the full-context tier ⇒ `ambiguous`, never guess.
- No fake normalization (no NFC); a raw match survives stripping, so legacy
  records need no fallback path.

Files: `getTextNodes()`, `quoteFromRange()`, `rangeFromQuote()`, `locate()`,
`resolveHighlightAnchor()`, `countMatches()`.

### P0-2 — Non-mutating highlights

Stop touching host text. Use **CSS Custom Highlight API** as the primary
renderer; fall back to pointer-transparent SVG rects drawn from
`Range.getClientRects()`.

- CSS Custom Highlights paint in the browser and therefore follow transforms,
  scroll containers, carousels and top-layer dialogs with **zero geometry
  work**.
- SVG-rect fallback: one `<rect>` per `getClientRects()` fragment, in document
  coords, `pointer-events:none`, small focus proxy for keyboard/AT activation.
- Delete all `<mark>` wrapping and `normalize()` in `clearVisuals()`/`clearTemp()`.
  `grep -n "normalize()\|surroundContents\|an-mark" annotate.js` must return nothing.
- Click hit-testing via range rect containment (or a focus proxy), keeping normal
  text selection and host links intact.
- This change must land **before** P0-4 (MutationsObserver), or the observer
  sees/creates self-churn.

Files: `paintRange()`, `paintTemp()`, `clearTemp()`, `clearVisuals()`,
`focusComment()`, `renderAll()`, `isOurs()`.

### P0-3 — Hidden-anchor guard & detached-overlay recovery

- Add `anchorVisible(elm)` using `checkVisibility()` (fallback: box size test).
  Suppress painting when the anchor is not visually present; never draw at the
  origin. Keep the resolved range available for identity so the note can recover
  when the (keyed) content returns.
- Fix `ensureOverlay()` to use `isConnected` checks so overlay, pins, toolbar,
  composer and style elements re-attach if the host replaces `<body>` or a modal
  removes/displaces them.

Files: `docBox()` usage in `renderGeom()`, `renderPin()`, `renderBlock()`,
`anchorsMoved()`, `ensureOverlay()`.

### P0-4 — Content/geometry scheduler + MutationObserver

Split the monolithic `renderAll()` responsibilities into resolve → measure →
paint, and add a `MutationObserver` — **gated on `state.enabled`** so visitors
who never review pay nothing.

- Content invalidation (childList / characterData) rebuilds the text index and
  re-resolves anchors; geometry invalidation (attributes / layout) only
  re-measures. Observable writes are excluded; a removed annotate root is not.
- Trailing debounce (~150 ms) with a max wait (~1 s) under constant churn;
  coalesce to one pass per frame.
- Only `flushContent()` and the public `refresh()` rebuild. The observer must
  never call `load()`, `syncPageKey()` or `dbWrite()`; it must not change page
  identity.
- Keep `refresh()` public behavior (incl. `#an=` deep links) intact.
- Deduplicate observed anchors with a `Set` so shared anchor elements keep
  observation.
- Resize and scroll now route through the scheduler; retain the capture-phase
  scroll listener.

Files: `buildUI()`, `renderAll()`, `observeAnchors()`, `cancelDraft()`,
`commitDraft()`, `setEnabled()`.

### P1 — Surface features (documented, cut to follow-up)

Not part of this spec's implementation; design intent captured here so scope is
explicit.

- **Motion / carousels:** short per-frame burst after transition/animation
  events + ~500 ms idle poll (ResizeObserver does *not* fire on `transform`).
  Never rebuild the text index per frame; never recreate all markers. Clip
  markers to carousel/scroll-container viewports so offscreen slides don't paint
  over neighbors. Loop-carousel clones get an ignore selector (they otherwise
  read as perpetually ambiguous). Rotation/skew requires a matrix
  representation — the fractional-box model cannot express it.
- **Popups / modals:** track visibility separately from identity. When a
  `dialog:modal` is on the top layer, move the marker surface *inside* the
  dialog; a larger `z-index` on a document overlay loses to the top layer. Keep
  hidden content in the text index for identity; suppress painting separately.
- **Iframes:** **out of core scope.** Use a documented "load annotate.js inside
  each (same-origin) frame" recipe; same-origin frames already share
  `localStorage`. Cross-origin interior anchoring requires a cooperating child
  agent and is explicitly not planned.

### Explicitly cut (over-engineering)

NFC normalization, content-root scoping, a cross-origin `postMessage` bridge,
host adapter APIs, and automatic history patching (keep `notifyContentChanged` /
history observation **opt-in only**).

## Out of scope for P0

- Stable identity (`data-annotate-id`, tag+text `hint` validation), modal
  top-layer host, and iframe support — all P1, documented above.
- Public API additions and opt-in history observation — P2.

## Data / comment shape

No shape change required for P0. New P0 fields are runtime-only and never
serialized. P1 may add optional `target`/`hint` fields to `geom` (additive,
back-compatible).

## Testing

- Unit-level: new `stripWs`/`isSkip` predicate is the single source of truth for
  index and needles.
- Existing Playwright suite must remain green (see Gate below).
- New cases (P0):
  - `mark` elements are never created; `document.querySelectorAll('mark').length === 0` after a highlight.
  - Multi-paragraph highlight (whitespace-separated) resolves with no
    `.an-unanchored-pill`.
  - Text replaced with identical-size content recovers without `refresh()` or
    resize.
  - Reordered/recycled keyed items neither silently swap comment identity nor
    observe an unwatched shared anchor.
  - Hidden anchor (`display:none`) draws no marker at the origin; recovery on reveal.
  - Overlay/body swap recovers once, without duplicates or observer loops.

## Pitfalls

- **Never pass `renderAll` directly** as an rAF/then callback — the frame
  timestamp becomes a truthy `keepResolved`. Always wrap.
- Only `flushContent()` and `refresh()` rebuild; the observer must never call
  `load()`/`syncPageKey()` — the page-identity tests guard this.
- Use `attributeFilter` (e.g. `class`,`style`,`hidden`,`open`) with the observer;
  do not add raw `characterData` handling that skips the debounce (live clocks /
  JS sliders would re-index every tick).
- Build highlight CSS color names only through a validated `safeColor()` to avoid
  CSS injection from imported JSON.
- One shared `isSkip`/`stripWs` for index and needles or matches silently fail.
- Never clear the overlay while `drawing` is set (`onMove` removes nodes).

## Approval gates

1. This spec is reviewed and approved.
2. Implementation plan written (writing-plans), execution method chosen.
3. Each P0 item lands with its tests; `node --check annotate.js` and
   `npm run test:chromium` pass before the next item.