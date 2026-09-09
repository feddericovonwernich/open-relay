# Task 6 report

Implemented Cursor Bugbot check-run recognition.

- Added a wrapper around the shared exact completed-check matcher using provider `cursor-bugbot`.
- Added focused coverage for exact `Cursor Bugbot` names, Cursor app ID/slug identity, Autofix and wrong-app exclusion, pending/stale checks, raw success/neutral/failure conclusions, and review/comment/login independence.

Verification:

- `node --test tests/github-bugbot.test.ts` — 5 passed.
- `npm run typecheck` — passed.

Commit: `a2b7d5d feat: recognize completed Cursor Bugbot checks`
