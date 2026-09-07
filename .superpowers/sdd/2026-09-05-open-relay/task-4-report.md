# Task 4 Report: Scoped credentials and capability-matched dispatcher

## Files changed

- `src/auth.ts`
- `src/dispatcher.ts`
- `src/store.ts`
- `tests/dispatcher.test.ts`

## Implementation

- Added `CredentialStore` with opaque 32-byte base64url bearer tokens, SHA-256-only in-memory records, fixed-size `timingSafeEqual` verification, scope checks, grants, revocation, and short-lived worker credentials.
- Added `Dispatcher` worker registration, registration-bound credentials, agent-only polling, capability matching, worker identity fencing for lifecycle settlement, registration-change wakeups, and abort/timeout-cleaned long-poll waiters.
- Exported allowlist and full capability matching helpers. Matching enforces exact definitions, `*`, namespace prefixes ending in `.*`, agent handler kind, tools, structured output, context/reserve budget, and active concurrency.
- Extended `Store` acquisition to re-check blocked events and added transactional `blockUnmatched` journaling without consuming attempts. Process definitions remain unavailable to external agent acquisition and can only be acquired through `acquireProcess` with `relay:process`.

## Verification

```text
node --test tests/dispatcher.test.ts
```

Result: 7 tests passed, 0 failed.

```text
npm run typecheck
```

Result: `tsc --noEmit` exited 0.

Regression check:

```text
node --test tests/lifecycle.test.ts
```

Result: 16 tests passed, 0 failed.

## Concerns

- The dispatcher deliberately keeps registrations and waiter state in memory; relay restart requires workers to register again, matching the scoped bearer-token design.
- Process execution remains deferred to Task 6; Task 4 only preserves the private `acquireProcess` boundary.
