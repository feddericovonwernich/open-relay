# Task 3 report

## Changed files
- `src/connectors/github/config.ts`: optional aggregate mapping validation, trigger-ID collision checks, and deep-frozen normalization.
- `src/connectors/github/types.ts`: aggregate config and settled payload/artifact types.
- `src/connectors/github/normalize.ts`: deterministic immutable settled payload normalization.
- `src/connectors/github/emitter.ts`: membership-based SHA-256 aggregate idempotency key and aggregate Relay emission with existing credential/error handling.
- `src/connectors/github/runner.ts`: aggregate candidate grouping, final head fence, emission accounting, and process-lifetime aggregate disablement.
- `tests/github-config.test.ts`: aggregate validation/freezing contracts.
- `tests/github-emitter.test.ts`: settled payload ordering, key stability, payload/correlation/emission contracts.
- `tests/github-runner.test.ts`: partial-to-final trigger settlement and aggregate accounting.

## Red commands and failures
- `node --test tests/github-config.test.ts` (after adding aggregate contracts): 2 failures — aggregate was rejected as `unknown_property`, and collision assertion could not pass.
- `node --test tests/github-emitter.test.ts` (after adding settled contracts): module import failed because `normalizeSettled` was not exported.
- `node --test tests/github-runner.test.ts` (after adding aggregate contract): aggregate was not emitted (`0 !== 1`).

## Green commands and output
- `node --test tests/github-config.test.ts`: 16 tests passed, 0 failed.
- `node --test tests/github-emitter.test.ts tests/github-runner.test.ts`: 25 tests passed, 0 failed.

## Commit
- `7e93616` (implementation commit; this report is finalized in the follow-up commit).

## Self-review
- Aggregate keys sort only trigger/kind/id membership tuples and exclude mapping type/version.
- Aggregate emission uses the existing repository-scoped producer token, redaction, status handling, and PR correlation ID.
- Individual candidate emission remains unchanged; aggregate failures disable only the aggregate mapping.
- Final verification is separate from per-candidate checks and gates aggregate emission.

## Concerns
- Full project-wide typecheck/build and Task 4 onboarding/E2E gates are intentionally left to the parent agent per assignment boundaries.

## Follow-up contract coverage
- Added runner contracts for stale final-head suppression, aggregate-only 404 disablement while individuals continue, and changed same-head membership producing a distinct key.
- TDD red observations:
  - Removed final-head guard temporarily: `node --test tests/github-runner.test.ts` failed stale-head contract (`3 !== 2`).
  - Removed aggregate disablement temporarily: same command failed mapping contract (`2 !== 1` aggregate attempts).
  - Replaced membership hash temporarily with a constant: `node --test tests/github-emitter.test.ts tests/github-runner.test.ts` failed key regex and distinct-key assertions.
- Green: `node --test tests/github-emitter.test.ts tests/github-runner.test.ts` — 28 tests passed, 0 failed.
- Follow-up commit: `58d4dc2`.
