# Task 5 Report: AI context and tool-policy boundary

## Status

DONE

## Implementation

- Added `src/agent-context.ts` with trust-ordered context assembly, explicit trusted/untrusted segments, provenance and UTF-8 byte/token metadata, immutable tool-policy intersection, deterministic retrieval truncation, fixed-content budget failures, and output-token reservation.
- Added `src/worker-runtime.ts` with `TrustedWorkerRuntime`, model-event tool dispatch, immutable policy enforcement outside the prompt, immediate approved secret-handle resolution, recursive redaction before model/progress/log/validation reuse, and shared abort control.
- Added protocol-level `DeliveryAuthority`, `EffectEvidence`, and trust types.
- Added focused fake-adapter tests for payload trust, tool-policy enforcement, provenance, deterministic budgeting, output preservation, secret redaction, forbidden model tool calls, and concurrent cancellation acknowledgement.

## Evidence

- `node --test tests/agent-context.test.ts`: 7 tests passed, 0 failed.
- `npm run typecheck`: passed with no diagnostics.

## Concerns

- The runtime intentionally treats external worker/model/tool adapters as trusted local code; it enforces the reference runtime boundary but does not sandbox arbitrary code, matching the architecture specification.

## Fix round 1

### Outcome

DONE — addressed all four Important review findings.

### Commands and output

- `node --test tests/agent-context.test.ts`
  - 12 tests passed, 0 failed.
- `npm run typecheck`
  - `tsc --noEmit` passed with no diagnostics.

### Changed files

- `src/worker-runtime.ts`
  - Redacts resolved secrets recursively in values, object keys, arrays, strings, nested structures, model tool messages, validation input, progress, logs, results, and effect evidence.
  - Treats omitted `systemTools` as an empty allowlist, so tool dispatch fails closed.
  - Restricts runtime context input to untrusted payload/retrieved fields and snapshots trusted policy, definition instructions, tool policy, and token budgets at construction.
  - Converts context assembly budget errors into failed `WorkerOutcome` values with code `CONTEXT_BUDGET_EXCEEDED`.
- `tests/agent-context.test.ts`
  - Added focused coverage for deep redaction, fail-closed tool policy, trusted runtime ownership/snapshotting, and budget failure outcomes.

### Self-review

- The runtime remains a trusted local-worker boundary; no HTTP or sandboxing was added.
- Policy intersection is computed once from copied constructor inputs and cannot be expanded by delivery/context input or later caller mutation.
- Redaction occurs before each model/tool-message, progress, log, result-validation, result, and effect reuse path.
- Existing cancellation/effect acknowledgement behavior is preserved.

### Commit

- `ab59c3a fix: harden trusted worker runtime`
