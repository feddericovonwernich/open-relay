# Task 3 report

Implemented GitHub pull-request discovery and snapshots.

- Added all-open plus recent-closed discovery with repository validation, latest-update deduplication, and ascending PR-number ordering.
- Added trigger-derived snapshot requirements, concurrent check/review loading, frozen artifact arrays, and final current-head verification.
- Added bounded `mapConcurrent` and deferred test helper coverage for the four-request ceiling.
- Extended decoded PRs with authoritative base repository ID/full name and reject mismatched configured repositories.

Verification:

- `node --test tests/github-poller.test.ts tests/github-client.test.ts` — 15 passed.
- `npm run typecheck` — passed.
