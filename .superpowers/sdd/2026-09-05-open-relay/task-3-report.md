# Task 3 Report: Atomic leases, retry wait, cancellation, and recovery

## Files changed

- `src/store.ts`
- `src/reaper.ts`
- `tests/lifecycle.test.ts`
- `.superpowers/sdd/2026-09-05-open-relay/task-3-report.md`

## Implementation decisions

- Extended the existing SQLite store with separate agent and relay-owned process acquisition paths. Agent acquisition enforces definition allowlists, handler kind, tools, structured output, context budget, and per-worker concurrency; process acquisition only accepts `relay:process` and process definitions.
- Added scoped delivery authority fencing with `stale_delivery` errors, explicit start/renew/progress operations, hard-deadline renewal checks, and no implicit renewal from progress.
- Routed event state changes and ordered update journal inserts through `BEGIN IMMEDIATE` transactions. Effect intent and confirmation writes share their transaction with their update journal row, so either side failing rolls back both.
- Added worker-evidence-driven retry scheduling with attempt-indexed backoff, immutable retry/effect policy lookup, idempotency-boundary checks, cancellation acknowledgement, recovery-required transitions, and admin-gated recovery resolution.
- Added one expiry algorithm (`expireLeases`) plus `nextLeaseDeadline`; `LeaseReaper` waits on the nearest deadline with an abortable timer, expires leases, then wakes the dispatcher after commit.
- Added focused lifecycle coverage for lease races, stale authority, process acquisition, retry/backoff, hard deadlines, cancellation, idempotency-required expiry, recovery authorization, journal expiry, and reaper wake-up.

## Focused verification

Command:

```text
node --test tests/lifecycle.test.ts && npm run typecheck
```

Exact output:

```text
TAP version 13
# (node:2662683) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: two workers cannot lease one event
ok 1 - two workers cannot lease one event
# Subtest: stale worker and lease cannot settle
ok 2 - stale worker and lease cannot settle
# Subtest: unknown consequential effect enters recovery instead of retry
ok 3 - unknown consequential effect enters recovery instead of retry
# Subtest: process acquisition is private to the relay process worker
ok 4 - process acquisition is private to the relay process worker
# Subtest: retry uses attempt-indexed backoff and progress does not renew
ok 5 - retry uses attempt-indexed backoff and progress does not renew
# Subtest: renewal refuses a hard deadline
ok 6 - renewal refuses a hard deadline
# Subtest: cancellation settles with no effect and recovers when effect may exist
ok 7 - cancellation settles with no effect and recovers when effect may exist
# Subtest: idempotency-required expiry retries only with persisted boundary evidence
ok 8 - idempotency-required expiry retries only with persisted boundary evidence
# Subtest: all recovery resolutions require admin evidence
ok 9 - all recovery resolutions require admin evidence
# Subtest: lease expiry is transactionally journaled
ok 10 - lease expiry is transactionally journaled
# Subtest: reaper wakes after committed expiry
ok 11 - reaper wakes after committed expiry
1..11
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 443.720834

> typecheck
> tsc --noEmit

Process exited with code 0
```

## Self-review

- Confirmed stale delivery settlement is rejected after expiry and reacquisition without mutating the new lease.
- Confirmed update journal insertion occurs inside the same transaction as every lease/state/effect mutation.
- Confirmed idempotency-required expiry retries only after persisted boundary confirmation, while unknown unproven effects enter recovery.
- Confirmed the reaper test exercises deadline discovery, expiry, committed update, and post-commit wake-up.

## Commit

`feat: add leased event lifecycle and recovery` (final repository commit)

## Concerns

- With no active lease deadline, `LeaseReaper` polls on an abortable one-second timer so leases acquired after startup are still observed.
- Full-suite validation is intentionally deferred to the main agent after Tasks 4–9 land.

## Review follow-up

- Repeated cancellation requests are idempotent while `cancel_requested`.
- Confirmed effect evidence settles completion normally; manual-recovery failures with confirmed or unknown effects enter recovery.
- Lease listeners wake the reaper after acquisition and renewal, and timer abort listeners are removed on every wake path.
- Expiry clears `cancel_requested_at` before retry scheduling, preserving queue eligibility.
- Added focused rollback coverage for event, update, effect-intent, and effect-confirmation writes.

Latest focused command:

```text
node --test tests/lifecycle.test.ts && npm run typecheck
```

Result: 16 lifecycle tests passed; typecheck exited 0.

- Review round 1 fixes are covered by tests for repeated cancellation, confirmed-effect completion/recovery, nearer-deadline renewal wake-up, expiry cancellation-marker clearing, all three recovery resolutions, and forced transition/effect rollback.
