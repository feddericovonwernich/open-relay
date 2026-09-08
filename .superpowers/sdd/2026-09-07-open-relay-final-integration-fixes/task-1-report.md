# Task 1 Report: Wake waiters on committed availability changes

## Files changed

- `src/store.ts`
- `tests/dispatcher.test.ts`
- `tests/lifecycle.test.ts`

## Implementation

- Refactored `Store.fail` to retain the transaction result and notify work listeners only after commit when the event enters `retry_wait`.
- Refactored `Store.complete` and `Store.acknowledgeCancel` to notify work listeners once after their successful transactions release active worker capacity.
- Added dispatcher coverage for a waiter that starts before retry scheduling and for a waiter blocked by `maxConcurrent: 1` until completion releases capacity.
- Added lifecycle coverage proving retry listeners observe the committed `retry_wait` state and `availableAt` value.

## Focused verification

- `node --test tests/dispatcher.test.ts tests/lifecycle.test.ts` — 30 tests passed.
- `npm run typecheck` — exited 0.
- `git diff --check` — exited 0.

The pre-fix regression tests were observed failing because existing waiters were not notified and retry listeners were not called; the final focused run passed after the post-commit notifications were added.

## Concerns

- Project-wide validation was intentionally not run; it is delegated to the main agent after integration.
- `graphify-out/` remains an unrelated pre-existing untracked directory and was not modified.

## Final review fix wave

- `Store.fail` now notifies work listeners after every successful transition (`retry_wait`, `failed`, or `recovery_required`) because each outcome releases the active worker lease.
- Added `maxConcurrent: 1` dispatcher regressions proving pre-existing waiters wake and acquire the next queued event after failed and recovery-required outcomes.
- Used explicit event IDs in capacity fixtures so queue-order assertions are deterministic when acceptance timestamps match.

## Final verification

- `node --test tests/dispatcher.test.ts tests/lifecycle.test.ts` — 32 passed.
- `npm test` — 110 passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.
