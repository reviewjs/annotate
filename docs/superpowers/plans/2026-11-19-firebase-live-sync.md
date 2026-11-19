# Firebase live sync: implementation plan

Design: `docs/superpowers/specs/2026-11-19-firebase-live-sync-design.md`

- [x] Core: `transport` option; `apiFetch` routes through it; session always asked for a transport
- [x] Core: `subscribe` for live updates, slow poll as a safety net, resubscribe on SPA navigation, unsubscribe on stop/destroy
- [x] Core: in-flight and just-acknowledged snapshot races
- [x] Types: `AnnotateTransport`, `syncState().live`
- [x] `tests/transport.spec.js` with an in-memory transport
- [x] `firebase.mjs` and `firebase.d.ts`; `./firebase` export; optional peer dependency
- [x] `examples/firebase/`: rules, TTL index config, emulator config
- [x] Conformance and rules tests on the emulators (`npm run test:firebase`)
- [x] Two-browser live e2e (`npm run test:firebase:e2e`)
- [x] CI job `firebase`
- [x] Docs: this spec, wire protocol §Transports, README section, site FAQ
- [ ] Release (`npm version minor`) is the maintainer's step
