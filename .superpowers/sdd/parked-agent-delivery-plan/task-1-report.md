# Task 1 report — parked one-shot and reply contracts

## Worktree

All test changes were made in:

`open-relay/.worktrees/parked-agent-delivery`

Production sources were not modified.

## Changes

- Added `tests/agent-session.test.ts` covering:
  - one registration and one outstanding HTTP poll at a time;
  - pending behavior across a deferred poll response;
  - silent retry after a JSON `null` poll response;
  - one raw delivery result without credentials;
  - mode `0700` lease directory and mode `0600` lease authority file;
  - active same-runtime lease rejection;
  - stale lease removal from another Relay runtime;
  - worker-token-only reply authorization and terminal lease-file removal;
  - stale-runtime reply errors that do not expose admin or worker credentials.
- Extended `tests/http-worker-transport.test.ts` for `poll`, `start`, `renew`, `progress`, `complete`, and `fail` payloads, `null` poll responses, malformed delivery validation, and bearer redaction.
- Extended `tests/dispatcher.test.ts` with acquisition counters proving one initial attempt, wake-driven retry, and abort without another attempt.
- Extended `tests/cli.test.ts` with nested `agent poll`/`agent reply` parsing, timeout validation/error output, exact timeout JSON output, and unknown-action relay errors.

## Focused red commands and observed failures

### `node --test tests/agent-session.test.ts`

Failed before test execution because the required production contract is not present yet:

```text
ERR_MODULE_NOT_FOUND: Cannot find module .../src/agent-session.ts
```

### `node --test tests/http-worker-transport.test.ts`

Existing transport tests passed. The newly added contract tests failed against the current implementation with:

```text
transport.poll is not a function
```

This occurred for the null-poll, lifecycle-payload, and malformed-poll tests; it is the expected missing transport contract rather than a fixture failure.

### `node --test tests/cli.test.ts tests/dispatcher.test.ts`

The existing tests and the new dispatcher acquisition-counter tests passed. The new CLI tests failed against the current CLI implementation with:

```text
relay: runtime file not found: .../.relay/runtime.json
```

for timeout validation, and the exact timeout-output test returned exit code `1` instead of `0`. The unknown-action test returned the existing usage error:

```text
relay: usage: relay init|start|stop|emit|get|cancel|recovery|workers|reload
```

These are the expected missing CLI contracts. The dispatcher behavior already satisfied the focused acquisition-counter contract, so those tests were green in the red run.

## Validation constraints

No formatter, linter, build, onboarding test, project-wide suite, or unrelated test suite was run.

## Round 1 focused follow-up

Addressed the review findings by deferring the first HTTP poll before any retry can begin, asserting exactly one outstanding request while it is deferred, then resolving it to `null` and asserting the next poll starts with one outstanding request. Added a valid `agent reply ... control` CLI test that checks successful stdout is exactly `{"status":"timeout"}\n`.

### `node --test tests/agent-session.test.ts`

Still red at the missing production module boundary:

```text
ERR_MODULE_NOT_FOUND: Cannot find module .../src/agent-session.ts
```

### `node --test tests/cli.test.ts`

Existing CLI tests passed. The four new agent CLI contract tests failed against the current implementation:

```text
relay: runtime file not found: .../.relay/runtime.json
```

for timeout validation; exit code `1` instead of `0` for the timeout output test; exit code `1` instead of `0` for the valid control-reply output test; and:

```text
relay: usage: relay init|start|stop|emit|get|cancel|recovery|workers|reload
```

instead of the unknown-agent-action error. These are missing CLI contracts, not test setup failures.
