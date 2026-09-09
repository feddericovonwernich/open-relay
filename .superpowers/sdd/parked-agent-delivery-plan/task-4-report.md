# Task 4 — Expose parked harness commands

## Implemented

- Extracted shared worker capability parsing so `relay workers` keeps its existing defaults and redacted output.
- Added `relay agent poll <worker-id>` routing with project/runtime resolution, capability flags, forced `maxConcurrent: 1`, timeout validation (`1..600000`, default `600000`), SIGINT/SIGTERM cancellation, and one-line delivery/timeout JSON output.
- Added `relay agent reply <lease-id> <action>` routing for every `AgentReplyAction`, including action validation, JSON-object requirements, start/control restrictions, and one-line result output through `replyAgent`.
- Added both agent commands to help and the unknown-command usage literal.
- Corrected the control reply test fixture to include the required `workerId` and `leaseId` authority fields; lease validation remains strict as required by the persisted authority contract.

## Focused verification

```text
node --test tests/cli.test.ts
# 15 tests, 15 passed, 0 failed

npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --allowImportingTsExtensions --rewriteRelativeImportExtensions \
  --erasableSyntaxOnly --verbatimModuleSyntax --skipLibCheck src/cli.ts
# passed with no diagnostics
```

Formatter, lint, build, onboarding, and project-wide suites were intentionally not run per assignment.
