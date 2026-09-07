# Task 2 Report: SQLite schema and idempotent acceptance

## Files changed

- `src/store.ts`
- `tests/acceptance.test.ts`
- `tests/helpers.ts`
- `.superpowers/sdd/2026-09-05-open-relay/task-2-report.md`

## Implementation decisions

- Added a private synchronous Node `node:sqlite` connection with WAL mode, foreign keys, and a 2500 ms busy timeout.
- Added the four durable tables and the `events_queue` and `updates_replay` indexes from the reviewed data model. `definition_revisions` also stores `resolved_command` so process revisions retain their resolved command material alongside instruction text.
- Prepared all recurring queries and writes once in the store constructor.
- Added `BEGIN IMMEDIATE` transaction boundaries around revision installation and event acceptance. Acceptance persists a revision (when absent), event, and queued update atomically.
- Acceptance validates payloads with the supplied immutable revision, computes a stable SHA-256 payload digest, and compares type, version, revision digest, and payload digest on idempotency replay. Conflicting key reuse raises `StoreError` with `code: "idempotency_conflict"`.
- `getRevision` reconstructs historical revisions only from persisted JSON/material and `compileRevision`; it does not use an active registry.
- Added focused replay, conflict, concurrent-store convergence, and persisted-revision reconstruction coverage.

## Focused verification

Command:

```text
node --test tests/acceptance.test.ts && npm run typecheck
```

Exact output:

```text
TAP version 13
# (node:2623359) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: lost 202 replay returns the original event
ok 1 - lost 202 replay returns the original event
  ---
  duration_ms: 44.865838
  type: 'test'
  ...
# Subtest: same key with different payload is a conflict
ok 2 - same key with different payload is a conflict
  ---
  duration_ms: 17.52665
  type: 'test'
  ...
# Subtest: concurrent stores converge on one idempotent event
ok 3 - concurrent stores converge on one idempotent event
  ---
  duration_ms: 47.935759
  type: 'test'
  ...
# Subtest: persisted revisions rebuild validators without a registry
ok 4 - persisted revisions rebuild validators without a registry
  ---
  duration_ms: 21.947182
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 296.363889

> typecheck
> tsc --noEmit
```

The combined command exited with status 0. No formatter, linter, or project-wide suite was run.

## Self-review

- Confirmed all changed implementation and test files are limited to Task 2 scope.
- Confirmed replay does not append another queued update and conflicting idempotency reuse rolls back without adding an event.
- Confirmed two file-backed store connections converge through SQLite's immediate write transaction and unique producer/key constraint.
- Confirmed persisted revision reconstruction recompiles Ajv validators and preserves instruction/command material without consulting the registry.
- Confirmed prepared statements remain private to the store and `close()` closes the SQLite connection.

## Commit

Implementation commit: `9ec6cdc` (`feat: add idempotent event acceptance`)

## Concerns

- Node reports its expected experimental `node:sqlite` warning on the focused test command.
- The project-wide suite was intentionally not run because the main agent owns integrated validation after later tasks land.
