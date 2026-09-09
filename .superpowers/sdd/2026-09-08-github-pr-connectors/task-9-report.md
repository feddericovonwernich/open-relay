# Task 9 report

Implemented `tests/github-connector-e2e.test.ts` with a real loopback fake GitHub server and real Relay server. Coverage includes:

- SonarQube, Copilot, and Cursor Bugbot completion candidates and normalized payloads.
- Deterministic producer/idempotency keys and restart replay with empty client/emitter caches.
- PR-list 304 artifact polling, old open/recent closed polling, old closed exclusion.
- Stale-head suppression followed by new-head reconciliation.
- Relay outage and recovery without duplicate events.
- Trigger drift isolation while sibling triggers continue.
- CLI `--discover` and `--once` output redaction.

`tests/github-helpers.ts` now exposes per-path request counts for E2E assertions.

Verification:

- `node --test tests/github-connector-e2e.test.ts` — 3 passed.
- `npm test` — 176 passed, 0 failed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- Built smoke: started `dist/src/cli.js start` Relay and a real fake-GitHub process; ran built CLI discovery then emission (`emitted: 3`), observed three `pr.automation.completed` events via `/v1/stream`, stopped both processes, and no GitHub/Relay token appeared in captured connector or Relay output.

## Task9 fix round 1

Review fixes verified:

- The closed-PR fixture includes PR4 updated before the lookback cutoff, with deterministic check, review, and head endpoints; assertions confirm none of those artifact endpoints are fetched.
- The Relay-outage scenario introduces check-run 302 only after the prior event exists, verifies the outage accepts neither the first-seen candidate nor a duplicate, and verifies recovery emits 302 exactly once while replaying 301.
- The cancellation-matrix feedback was ruled out of scope for the GitHub connector Task9 and was not applied to `tests/e2e.ts`.

Verification:

- `node --test tests/github-connector-e2e.test.ts` — 3 passed.
- `npm test` — 176 passed, 0 failed.
- `npm run typecheck` — passed.
- `npm run build` — passed.

No runner/emitter defects were exposed by the harness.
