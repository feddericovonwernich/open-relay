# Task 4 Report — aggregate-ready GitHub watch project

## Changed files

- `src/init.ts` — generated aggregate config, settled event definition, strict settled schema, and exact settled handler.
- `examples/github-pr-automation/.relay/connectors/github.json` — matching aggregate config.
- `examples/github-pr-automation/.relay/events/pr-automation-settled.v1.json` — generated settled definition.
- `examples/github-pr-automation/.relay/schemas/pr-automation-settled.json` — strict draft-07 `PrAutomationSettled` schema.
- `examples/github-pr-automation/.relay/handlers/pr-automation-settled.md` — exact handler instruction.
- `tests/onboarding.test.ts` — generated asset equality and registry/config assertions.
- `tests/github-connector-e2e.test.ts` — real fake-GitHub/real-Relay targeted continuous watch, aggregate wakeup, correlation filtering, schema correction, and restart replay proof.
- `README.md`, `AGENTS.md`, `docs/agent-quickstart.md` — persistent connector/poll commands and watch/park/reply semantics.
- `docs/superpowers/specs/2026-09-08-github-pr-connectors-design.md` — target selection, correlation, aggregate payload/key, and continuous semantics.
- `docs/superpowers/specs/2026-09-05-open-relay-design.md` — `correlationId` and resolved `outputSchema` contracts.
- `dist/src/**` — regenerated only with `npm run build`.
- `src/connectors/github/runner.ts` — restored reviewed `state` option and safe aggregate emitter narrowing after prerequisite cherry-pick conflict resolution.

## TDD red/green evidence

- Onboarding contract red before generator/example updates: `node --test tests/onboarding.test.ts` failed because generated config had no aggregate and the settled assets were absent.
- Onboarding green after updates: 5 tests passed, 0 failed; generated GitHub project created 12 files and matched the checked-in example tree.
- New targeted E2E initially failed with `0 !== 4` emissions; after correcting the fake GitHub check PR association and cycle transition, the behavioral scenario passed.
- Targeted E2E green: 6 tests passed, 0 failed. The new scenario proves no PR-list or PR-100 requests, first incomplete cycle has no settled event, second cycle emits individual plus settled events, exact correlation leases PR 197, output schema requires `summary`, invalid completion returns HTTP 400 while retaining the lease, corrected completion succeeds, and a recreated emitter replays without duplicates.

## Required gates

- `node --test tests/github-connector-e2e.test.ts` — passed: 6 tests, 6 passed, 0 failed.
- `npm run test:onboarding` — passed: 5 tests, 5 passed, 0 failed.
- `npm run typecheck` — passed (exit 0).
- `npm run build` — passed (exit 0).
- `git diff --exit-code -- dist/src` — passed after staging the build output; no post-build drift.
- `npm test` — passed: 223 tests, 223 passed, 0 failed.

## Commit

`7867fc1` — `feat: ship aggregate-ready GitHub watch project`

## Self-review

- Generator output and checked-in GitHub example assets are byte-identical, verified by onboarding path equality.
- Settled schema uses draft-07, requires a non-empty artifacts array, and sets `additionalProperties: false` on every object level.
- Settled definition reuses `pr-automation-result.json` and the handler text is exact.
- Existing configurations without `aggregate` remain individual-only; docs state targeted lookback and correlation semantics without exposing credentials.
- Distribution was regenerated only through the required build command.

## Concerns

- The prerequisite Task 3 implementation was already present in the parent commit chain; cherry-pick conflict resolution restored its reviewed runner state option and emitter narrowing without changing aggregate behavior.
- No known functional concerns after all required gates passed.
