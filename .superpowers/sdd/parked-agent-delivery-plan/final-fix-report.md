# Final review fix

The agent poll loop now passes the full remaining outer deadline to each HTTP poll instead of imposing a client-side 30-second abort. Relay's finite 30-second poll timeout can therefore return its normal JSON `null` renewal without a client abort racing the response; the outer deadline and caller cancellation behavior remain unchanged.

Added a deterministic regression test that shortens only the internal 30-second timer and verifies the server timeout response is observed before the next poll without an aborted signal.

Verification:

- `node --test tests/agent-session.test.ts` — 5 passed.
- `npm run typecheck` — passed.
