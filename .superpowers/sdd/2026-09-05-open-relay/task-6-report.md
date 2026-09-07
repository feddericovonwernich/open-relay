# Task 6 Report: Subprocess adapter protocol

## Status

DONE

## Implementation

- Added `src/process-adapter.ts` with root-confined, shell-free subprocess spawning, allowlisted environment projection, immutable JSONL delivery input, bounded stdout/stderr and line parsing, protocol validation, lifecycle/effect evidence collection, crash detection, timeout/cancellation handling, and TERM/grace/KILL termination.
- Added `Dispatcher.runProcessLoop` with reserved `relay:process` acquisition, configurable concurrency, cancellation observation, lifecycle mapping for start/renew/progress/effects, and terminal settlement through the store's retry/effect policy.
- Added deterministic plugin fixtures for completion, malformed output, malformed output followed by a live child, hanging execution, and oversized output.
- Added focused process tests covering immutable delivery completion, malformed protocol, stuck-child termination, effect evidence, renew messages, overflow, abort cancellation, and the real dispatcher-to-process terminal path.

## Evidence

Command: `node --test tests/process-adapter.test.ts && npm run typecheck`

```text
TAP version 13
# (node:2867951) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: plugin receives one immutable delivery and completes
ok 1 - plugin receives one immutable delivery and completes
  ---
  duration_ms: 34.292281
  type: 'test'
  ...
# Subtest: malformed stdout is a protocol failure
ok 2 - malformed stdout is a protocol failure
  ---
  duration_ms: 25.436573
  type: 'test'
  ...
# Subtest: malformed output kills a child that remains alive
ok 3 - malformed output kills a child that remains alive
  ---
  duration_ms: 53.432598
  type: 'test'
  ...
# Subtest: effect protocol messages become immutable evidence
ok 4 - effect protocol messages become immutable evidence
  ---
  duration_ms: 31.627397
  type: 'test'
  ...
# Subtest: renew messages are surfaced before terminal completion
ok 5 - renew messages are surfaced before terminal completion
  ---
  duration_ms: 29.239418
  type: 'test'
  ...
# Subtest: stdout line overflow follows the termination ladder
ok 6 - stdout line overflow follows the termination ladder
  ---
  duration_ms: 25.637281
  type: 'test'
  ...
# Subtest: abort terminates a hanging child
ok 7 - abort terminates a hanging child
  ---
  duration_ms: 57.622424
  type: 'test'
  ...
# Subtest: process loop acquires internal process work and settles it
ok 8 - process loop acquires internal process work and settles it
  ---
  duration_ms: 104.94086
  type: 'test'
  ...
# tests 8
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 524.396342

> typecheck
> tsc --noEmit
```

Additional regression: `node --test tests/dispatcher.test.ts` — 8 tests passed, 0 failed.

## Concerns

- Process plugins are trusted local executables, not security sandboxes, as required by the architecture.
- The process loop uses a short polling interval to observe durable cancellation requests; the store remains authoritative for lease and effect transitions.

## Review fix round 1

- Terminal protocol records no longer suppress cancellation/deadline termination while the child remains alive.
- Spawn `error` events are converted to `plugin_spawn_error` without unhandled-process crashes or unresolved lifecycle promises.
- Cancellation races retain terminal completion effects when acknowledging cancellation.
- Incremental stdout parsing now uses `StringDecoder` for split UTF-8 sequences.
- Process-loop waiters created for a race are explicitly aborted when a process task wins.
- Added focused tests for terminal timeout/cancellation, spawn failure, split UTF-8, cancellation evidence retention, and process-loop waiter disposal.

Command: `node --test tests/process-adapter.test.ts && npm run typecheck`

```text
TAP version 13
# (node:2889898) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: plugin receives one immutable delivery and completes
ok 1 - plugin receives one immutable delivery and completes
  ---
  duration_ms: 31.510153
  type: 'test'
  ...
# Subtest: malformed stdout is a protocol failure
ok 2 - malformed stdout is a protocol failure
  ---
  duration_ms: 27.373604
  type: 'test'
  ...
# Subtest: malformed output kills a child that remains alive
ok 3 - malformed output kills a child that remains alive
  ---
  duration_ms: 55.353389
  type: 'test'
  ...
# Subtest: effect protocol messages become immutable evidence
ok 4 - effect protocol messages become immutable evidence
  ---
  duration_ms: 40.333133
  type: 'test'
  ...
# Subtest: renew messages are surfaced before terminal completion
ok 5 - renew messages are surfaced before terminal completion
  ---
  duration_ms: 28.932311
  type: 'test'
  ...
# Subtest: terminal output still obeys timeout until child exits
ok 6 - terminal output still obeys timeout until child exits
  ---
  duration_ms: 51.914942
  type: 'test'
  ...
# Subtest: terminal output still obeys cancellation until child exits
ok 7 - terminal output still obeys cancellation until child exits
  ---
  duration_ms: 26.136001
  type: 'test'
  ...
# Subtest: spawn errors reject without hanging
ok 8 - spawn errors reject without hanging
  ---
  duration_ms: 4.917288
  type: 'test'
  ...
# Subtest: split UTF-8 sequences remain valid JSONL
ok 9 - split UTF-8 sequences remain valid JSONL
  ---
  duration_ms: 36.035425
  type: 'test'
  ...
# Subtest: stdout line overflow follows the termination ladder
ok 10 - stdout line overflow follows the termination ladder
  ---
  duration_ms: 25.687992
  type: 'test'
  ...
# Subtest: abort terminates a hanging child
ok 11 - abort terminates a hanging child
  ---
  duration_ms: 58.580315
  type: 'test'
  ...
# Subtest: process loop acquires internal process work and settles it
ok 12 - process loop acquires internal process work and settles it
  ---
  duration_ms: 97.311623
  type: 'test'
  ...
# Subtest: cancellation race preserves completion effect evidence
ok 13 - cancellation race preserves completion effect evidence
  ---
  duration_ms: 22.364488
  type: 'test'
  ...
# tests 13
# pass 13
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 668.977633

> typecheck
> tsc --noEmit
```
