# Task 1 Report — Correlation-aware self-describing delivery

## Changed files

- `src/protocol.ts` — added optional `WorkerCapabilities.correlationId` and required `Delivery.outputSchema`.
- `src/store.ts` — made worker matching event-aware and correlation-exact in both blocked-state classification and atomic acquisition; included the immutable resolved revision output schema in deliveries.
- `src/server.ts` — validated worker-registration correlation IDs as absent or non-empty strings.
- `src/cli.ts` — added `--correlation-id` parsing, value-required validation, empty-value rejection, and capability forwarding.
- `src/http-worker-transport.ts` — required a non-null, non-array object `outputSchema` in polled deliveries.
- `tests/dispatcher.test.ts` — added exact-match filtering, backlog isolation, wrong-correlation pending/wakeup, and schema immutability coverage.
- `tests/http.test.ts` — covered resolved output schema, invalid-output lease retention/correction, and registration validation.
- `tests/http-worker-transport.test.ts` — updated delivery fixture and malformed schema coverage.
- `tests/agent-session.test.ts` — updated typed delivery fixture with output schema.
- `tests/agent-context.test.ts` — updated typed delivery fixture with output schema.
- `tests/process-adapter.test.ts` — updated typed delivery fixture with output schema.
- `tests/cli.test.ts` — covered CLI parsing, validation, correlation forwarding, and credential-safe registration payloads.

## TDD red tests

1. `node --test tests/lifecycle.test.ts tests/dispatcher.test.ts tests/http.test.ts`
   - Expected failure before production changes: the correlation-filtered worker leased `pr-100` instead of `pr-197`; wrong-correlation polling settled after the wrong event; HTTP delivery `outputSchema` was `undefined`.
2. `node --test tests/http-worker-transport.test.ts tests/agent-session.test.ts tests/cli.test.ts`
   - Expected failure before production changes: valueless and empty correlation IDs proceeded to runtime lookup instead of reporting their validation errors; registration payload omitted the selected correlation ID; malformed poll responses with `null`/array `outputSchema` were accepted.

## Green verification

1. `node --test tests/lifecycle.test.ts tests/dispatcher.test.ts tests/http.test.ts`
   - Passed: 46 tests, 46 passed, 0 failed, 0 cancelled.
2. `node --test tests/http-worker-transport.test.ts tests/agent-session.test.ts tests/cli.test.ts`
   - Passed: 29 tests, 29 passed, 0 failed, 0 cancelled.

Project-wide tests, formatters, linters, and builds were not run because the brief limits validation to the two focused commands.

## Commit

`7d2a5e2` — `feat: add correlation-aware self-describing deliveries`

## Self-review

- Correlation matching is centralized in `agentMatches(row, revision, worker)` and reused by both `blockUnmatched()` and `acquire()`.
- Omitted correlation IDs preserve existing definition/tool/output/context matching; process acquisition never applies the filter.
- Stored event conversion remains unchanged; only leased `Delivery` objects expose the revision-derived schema.
- HTTP malformed-delivery errors retain the existing bearer-safe error path.
- Invalid completion leaves the lease active, and the focused HTTP test completes the same lease with a corrected result.
- All four named typed delivery fixtures include `outputSchema`.

## Concerns

No known concerns. Historical and current revisions use the existing `DefinitionRevision` objects, whose schemas are deeply frozen by registry compilation.
