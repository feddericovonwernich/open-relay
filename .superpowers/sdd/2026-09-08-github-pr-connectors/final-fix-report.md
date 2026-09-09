# Final GitHub connector fixes

## Changes

- Hardened `apiBaseUrl` validation to reject userinfo, query strings, and fragments; added focused validation coverage.
- Added Relay preflight to `connect github`: it validates Relay availability and the admin token before GitHub polling, uses a five-second bounded signal, and never prints the issued credential. Added stale-token/zero-candidate and unavailable-Relay regressions.
- Added an emitter lifetime abort signal for shared producer-credential issuance. Individual emission aborts remain wrappers around the shared promise, so one caller cannot cancel or poison concurrent callers. Added caller-abort and connector-lifetime-abort regressions. The CLI binds the emitter lifetime to its connector process signal.

## Verification

- `node --test tests/github-config.test.ts tests/github-emitter.test.ts` — 19 passed.
- `node --test tests/github-connector-e2e.test.ts` — 5 passed.
- `npm test` — 180 passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
