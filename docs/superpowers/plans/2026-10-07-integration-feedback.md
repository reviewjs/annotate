# Integration and feedback implementation plan

Approved design: user approved the in-chat design on 2026-10-07.

Goal: isolate the host, support explicit lifecycle and SPA installation, recover dynamic anchors, and send portable feedback to a configurable receiver.

Architecture: retain the dependency-free classic script and expose a reusable controller. Generate an ESM entry from the same controller factory. Each initialized instance owns its nodes, observers, listeners and scheduled callbacks.

Constraints: preserve JSON schema and legacy script auto-start; no automatic uploads; no production test hooks; no commits or publishing.

- [x] Add browser regressions for isolation, public lifecycle, routing, dynamic text, sharing and POST errors; observe failures before changes.
- [x] Refactor annotate.js into controller + disposable instances. Scope tokens to __an_host; retain existing global API delegates. Track listeners/timers/frames and disconnect observers/restore history on destroy.
- [x] Validate created and patched records before writes. Use SVG highlight fragments without text mutation; debounce content observation while enabled, excluding owned nodes.
- [x] Add opt-in history navigation and explicit submit() using the existing export payload. Expand share URL values with encodeURIComponent.
- [x] Add module generation, exports and declarations; document installation and endpoint configuration; add a dependency-free receiver with request tests.
- [x] Run syntax, build/package checks, sample server tests, Chromium regression suite and available cross-browser suites. Review lifecycle cleanup and observer feedback loops before handoff.

Review focus: destruction before DOM readiness; router wrappers owned by others; dynamic hidden content and body swaps; rejected or stalled HTTP submission; legacy JSON and unavailable localStorage.

Execution: core changes handled in this chat; independent package/documentation/server and test work delegated under the supplied AGENTS.md rules.

Validation: 768 Playwright checks passed across all six configured projects; receiver real-HTTP tests passed; generated JavaScript syntax, ESM/CJS runtime imports, strict TypeScript NodeNext ESM/CJS consumers, package dry-run and diff whitespace checks passed.
