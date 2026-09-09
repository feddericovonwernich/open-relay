# Task 2 — Complete authenticated worker transport

## Status

Implemented and committed the authenticated worker transport extension.

Implementation commit: `742cf78` (`feat: extend authenticated worker transport`)

## Changes

- Added `poll(signal)` to `HttpWorkerTransport`, posting `{}` to `/v1/agent/poll` and returning `undefined` only for a JSON `null` response.
- Added trust-boundary validation for non-null poll responses. A delivery must contain string `event.id`, `workerId`, `leaseId`, `leaseExpiresAt`, and `hardDeadlineAt` fields. Invalid responses raise `HttpWorkerTransportError` with a bearer-free message.
- Added authenticated lifecycle methods for `start`, `renew`, `progress`, `complete`, and `fail`, using the existing private JSON request path and server payload shapes.
- Preserved the existing `control`, `cancelled`, `recordEffectIntent`, and `confirmEffect` behavior, including bearer-header handling and redacted status errors.
- No server, dispatcher, or store files were changed.

## Verification

### Focused transport tests

Command:

```bash
node --test tests/http-worker-transport.test.ts
```

Output:

```text
TAP version 13
# Subtest: HttpWorkerTransport emits authenticated control requests
ok 1 - HttpWorkerTransport emits authenticated control requests
  ---
  duration_ms: 20.311448
  type: 'test'
  ...
# Subtest: HttpWorkerTransport posts unchanged cancellation evidence and effect payloads
ok 2 - HttpWorkerTransport posts unchanged cancellation evidence and effect payloads
  ---
  duration_ms: 1.240448
  type: 'test'
  ...
# Subtest: HttpWorkerTransport redacts bearer token from failed requests
ok 3 - HttpWorkerTransport redacts bearer token from failed requests
  ---
  duration_ms: 0.688673
  type: 'test'
  ...
# Subtest: HttpWorkerTransport rejects malformed control responses
ok 4 - HttpWorkerTransport rejects malformed control responses
  ---
  duration_ms: 0.440448
  type: 'test'
  ...
# Subtest: HttpWorkerTransport treats a null poll response as no delivery
ok 5 - HttpWorkerTransport treats a null poll response as no delivery
  ---
  duration_ms: 0.44605
  type: 'test'
  ...
# Subtest: HttpWorkerTransport polls and sends every lease lifecycle payload unchanged
ok 6 - HttpWorkerTransport polls and sends every lease lifecycle payload unchanged
  ---
  duration_ms: 2.181053
  type: 'test'
  ...
# Subtest: HttpWorkerTransport rejects malformed poll deliveries without leaking bearer data
ok 7 - HttpWorkerTransport rejects malformed poll deliveries without leaking bearer data
  ---
  duration_ms: 1.124136
  type: 'test'
  ...
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 146.526436
```

### Focused TypeScript check

Command:

```bash
npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --allowImportingTsExtensions --rewriteRelativeImportExtensions --erasableSyntaxOnly --verbatimModuleSyntax --skipLibCheck src/http-worker-transport.ts
```

Output: no output; exit status `0`.

## Scope deliberately skipped

Formatter, lint, build, onboarding, and project-wide test suites were not run, per the Task 2 brief.
