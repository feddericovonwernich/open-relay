# Task 7 report

Implemented immutable normalized GitHub completion payloads and repository-scoped Relay emission.

- Added `normalizeCompletion` with an explicit whitelist and deep freezing; mutable/private GitHub fields are excluded.
- Added `GitHubRelayEmitter` with per-repository producer credential caching, deterministic completion keys, direct Relay acceptance status handling (`201` emitted / `200` replayed), and trigger drift/unknown-definition classification.
- Added recursive token/error redaction and focused normalization/emitter tests.

Verification:

- `node --test tests/github-emitter.test.ts` — 3 passed.
- `npm run typecheck` — passed.

Commit: pending
