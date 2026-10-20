# Task 2 — Authoritative GraphQL review-thread retrieval

## Status

Complete.

## RED evidence

- Commit: `3e7939b` (`test(github): define review thread GraphQL boundaries`)
- Focused command: `node --test tests/github-client.test.ts`
- Result: 10/19 tests passed; 9 new GraphQL tests failed as expected because `graphqlUrl` and `listReviewThreads()` were not yet implemented.

## GREEN evidence

Controller ran:

```bash
node --test tests/github-client.test.ts tests/github-config.test.ts && npm run typecheck
```

Result: 52/52 tests passed; typecheck exited 0 with clean output.

## Changed files

- `src/connectors/github/types.ts`
- `src/connectors/github/client.ts`
- `tests/github-client.test.ts`
- `.superpowers/sdd/2026-10-20-deterministic-pr-watcher/task-2-report.md`

## Commits

- `3e7939b` — test-only RED checkpoint
- `b9f7903` — GraphQL review-thread client implementation
- `63805d5` — typed test-boundary assertion fix

## Implementation

- Added `GitHubReviewComment` and `GitHubReviewThread` types plus the optional GraphQL client URL option.
- Added the exact `PullRequestReviewThreads` GraphQL query and POST pagination using `{ owner, name, number, after }` variables.
- Added strict, atomic decoding of repository, pull request, review-thread, page-info, comment-count, and root-comment fields; malformed evidence is rejected as a protocol error.
- Preserved comment counts and first comments as root comments, with no GraphQL response cache.
- Reused existing authorization headers, retry timing, abort handling, and token redaction. GraphQL HTTP 404 maps to `github_protocol_error`; GraphQL `RATE_LIMITED` maps to `github_transient_error`.
- Kept REST request and decoding paths behaviorally unchanged.

## Self-review

The implementation covers every Task 2 Step 1/2 boundary: exact request shape and headers, cursor pagination, strict malformed-response handling, GraphQL error taxonomy and redaction, authentication, GraphQL-specific not-found behavior, rate-limit retries, transient failures, abort preservation, invalid cursors, and missing GraphQL URL without a request. The GraphQL path does not use the REST cache or diagnostic buffer, and malformed threads fail the complete retrieval atomically. The final typecheck assertion uses `assert.notEqual` without weakening the production error-code union.

## Concerns

No outstanding concerns. GREEN evidence above was supplied by the controller; no checks were run in this worker phase.
