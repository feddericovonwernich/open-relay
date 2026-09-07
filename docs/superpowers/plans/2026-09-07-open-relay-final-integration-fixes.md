# Open Relay Final Integration Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the two remaining whole-branch findings so retry work wakes existing pollers at its backoff deadline and agent effect evidence is always persisted through the reviewed HTTP contract.

**Architecture:** Keep SQLite and `Store` authoritative. Availability-changing Store transitions notify dispatchers only after commit, allowing existing waiters to recalculate `nextAvailableAt`. Make effect persistence mandatory in `WorkerTransport` and ship a concrete authenticated `HttpWorkerTransport` that calls the existing lease-scoped HTTP routes before the runtime continues past effect evidence.

**Tech Stack:** Node 22.19+, TypeScript 5.9, `node:sqlite`, `node:http`, native `fetch`, `node:test`, Ajv 8.

**Spec:** `docs/superpowers/specs/2026-09-05-open-relay-design.md`

**Starting revision:** `84067bc0a1e10ca2dc51de502a85858a199c2a73`

## Global Constraints

- Preserve the trusted-local-worker threat model; this is not a process sandbox.
- Preserve agent-only external polling and internal-only process acquisition.
- Every Store notification caused by a state transition occurs after its SQLite transaction commits.
- SQLite remains authoritative; notifications only wake waiters to query again.
- Existing waiters must recalculate `nextAvailableAt` when retry work is scheduled.
- Effect intent must be persisted before the runtime accepts the corresponding `started` evidence as recorded.
- Effect confirmation must be persisted before the runtime accepts `confirmed` evidence as recorded.
- A missing or failing effect persistence method fails the worker outcome closed; it must not silently continue.
- Bearer tokens stay in `Authorization` headers and never appear in URLs or logs.
- No new runtime dependency.
- Do not add distributed scheduling, topic fan-out, cross-event ordering, or a generic workflow layer.

---

### Task 1: Wake waiters on committed availability changes

**Files:**
- Modify: `src/store.ts`
- Modify: `src/dispatcher.ts` only if the existing waiter cleanup needs a narrow compatibility adjustment
- Modify: `tests/lifecycle.test.ts`
- Modify: `tests/dispatcher.test.ts`

**Interfaces:**
- Preserve: `Store.watchWork(listener: () => void): () => void`.
- Preserve: `Store.nextAvailableAt(): number | undefined`.
- Preserve: `Dispatcher.notifyWork(): void`.
- Change no public HTTP or client interface.

- [ ] **Step 1: Write a failing regression for retry scheduling while another worker already waits**

Add this shape to `tests/dispatcher.test.ts`, using the existing fixture helpers and a retry definition whose backoff is `25` milliseconds:

```ts
test("retry scheduling wakes a poll that was already waiting", async () => {
  const store = openStore(":memory:");
  store.installRevisions([retryRevision]);
  const accepted = store.accept({
    producerId: "retry:producer",
    idempotencyKey: "retry:existing-waiter",
    payload: { variant: "dark" },
    revision: retryRevision,
  });
  const credentials = new CredentialStore();
  const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: 500 });
  const workerA = dispatcher.registerWorker(worker({ workerId: "worker:a" }));
  const workerB = dispatcher.registerWorker(worker({ workerId: "worker:b" }));

  const first = await dispatcher.poll(workerA, AbortSignal.timeout(100));
  assert.ok(first);
  dispatcher.start(workerA, authority(first));

  const waitingBeforeFailure = dispatcher.poll(workerB, AbortSignal.timeout(250));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const failedAt = Date.now();
  dispatcher.fail(workerA, authority(first), {
    code: "temporarily_unavailable",
    effectStatus: "none",
  });

  const retried = await waitingBeforeFailure;
  assert.equal(retried?.event.id, accepted.event.id);
  assert.ok(Date.now() - failedAt < 200, "retry waited for the normal poll timeout");
});
```

The important ordering is: worker B begins waiting **before** worker A calls `fail`. The old implementation must fail because B retains its original 500 ms wait instead of re-arming for `availableAt`.

- [ ] **Step 2: Write a failing post-commit notification test**

In `tests/lifecycle.test.ts`, register a Store work listener before a retryable failure. Inside the listener, read the event and record its state. Assert exactly one observed notification sees `retry_wait` and its committed `availableAt` value.

```ts
test("retry availability notification observes committed state", () => {
  const context = runningStore();
  const observed: Array<{ state: string; availableAt: number }> = [];
  const unwatch = context.store.watchWork?.(() => {
    const event = context.store.getEvent(context.delivery.event.id);
    if (event) observed.push({ state: event.state, availableAt: event.availableAt });
  });

  const result = context.store.fail(authority(context.delivery), {
    code: "temporarily_unavailable",
    effectStatus: "none",
  });
  unwatch?.();

  assert.equal(result.state, "retry_wait");
  assert.deepEqual(observed, [{ state: "retry_wait", availableAt: result.availableAt }]);
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
node --test tests/dispatcher.test.ts tests/lifecycle.test.ts
```

Expected: the pre-existing waiter receives no wake until its old timeout, or the Store listener sees no retry notification.

- [ ] **Step 4: Notify availability listeners after retry transaction commit**

Refactor `Store.fail` so it stores the transaction result, exits the transaction, then notifies work listeners when the new state affects availability:

```ts
fail(authority: DeliveryAuthority, failure: FailureEvidence): StoredEvent {
  const result = transaction(this.db, () => {
    // Existing authority, effect, retry, event, and update logic stays here.
    return this.rowToEvent(this.findEvent.get(eventId) as EventRow);
  });
  if (result.state === "retry_wait") this.notifyWorkListeners();
  return result;
}
```

Never call listeners from inside the SQLite transaction. `Dispatcher` already subscribes with `store.watchWork(() => dispatcher.notifyWork())`; waking it causes existing pollers to query, see the future retry, and create a waiter bounded by `nextAvailableAt - now`.

- [ ] **Step 5: Wake waiters when an active delivery releases worker capacity**

Apply the same post-commit pattern to `Store.complete` and `Store.acknowledgeCancel`. These transitions clear an active worker lease and can make already-queued work eligible under `maxConcurrent`. Notify once after the successful transaction; do not notify on thrown or rolled-back transitions.

Add one dispatcher regression with `maxConcurrent: 1`: worker A holds event one, a second poll for the same worker waits, event two is already queued, then completing event one wakes the second poll and leases event two without waiting for the normal poll timeout.

- [ ] **Step 6: Run focused verification**

Run:

```bash
node --test tests/dispatcher.test.ts tests/lifecycle.test.ts
npm run typecheck
```

Expected: all focused tests pass; TypeScript exits 0.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/store.ts src/dispatcher.ts tests/lifecycle.test.ts tests/dispatcher.test.ts
git commit -m "fix: wake workers on retry availability"
```

---

### Task 2: Require and implement agent effect persistence

**Files:**
- Create: `src/http-worker-transport.ts`
- Modify: `src/worker-runtime.ts`
- Modify: `tests/agent-context.test.ts`
- Create: `tests/http-worker-transport.test.ts`
- Modify: `tests/e2e.test.ts`
- Modify: `package.json` only if the focused test glob or exports need the new source/test file; do not add dependencies

**Interfaces:**
- Change: `WorkerTransport.recordEffectIntent` from optional to required.
- Change: `WorkerTransport.confirmEffect` from optional to required.
- Produce: `HttpWorkerTransport implements WorkerTransport`.
- Preserve the existing server endpoints:
  - `GET /v1/deliveries/:leaseId/control`
  - `POST /v1/deliveries/:leaseId/cancelled`
  - `POST /v1/deliveries/:leaseId/effect-intent`
  - `POST /v1/deliveries/:leaseId/effect-confirmation`

Define the production transport options exactly:

```ts
export interface HttpWorkerTransportOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export class HttpWorkerTransport implements WorkerTransport {
  constructor(options: HttpWorkerTransportOptions);
  control(
    authority: DeliveryAuthority,
    signal: AbortSignal,
  ): Promise<"cancel_requested" | "timeout">;
  cancelled(
    authority: DeliveryAuthority,
    evidence: readonly EffectEvidence[],
  ): Promise<void>;
  recordEffectIntent(
    authority: DeliveryAuthority,
    effectKey: string,
    idempotencyBoundaryConfirmed: boolean,
  ): Promise<void>;
  confirmEffect(
    authority: DeliveryAuthority,
    effectKey: string,
    externalRef: string,
  ): Promise<void>;
}
```

- [ ] **Step 1: Make missing persistence fail at compile time and runtime**

Change `WorkerTransport` in `src/worker-runtime.ts`:

```ts
export interface WorkerTransport {
  control(authority: DeliveryAuthority, signal: AbortSignal): Promise<"cancel_requested" | "timeout">;
  cancelled(authority: DeliveryAuthority, evidence: readonly EffectEvidence[]): Promise<void>;
  recordEffectIntent(
    authority: DeliveryAuthority,
    effectKey: string,
    idempotencyBoundaryConfirmed: boolean,
  ): Promise<void>;
  confirmEffect(
    authority: DeliveryAuthority,
    effectKey: string,
    externalRef: string,
  ): Promise<void>;
}
```

Remove optional chaining from `persistEffectEvidence`:

```ts
if (status === "started") {
  await this.options.transport.recordEffectIntent(
    authority,
    effectKey,
    evidence.idempotencyBoundaryConfirmed === true,
  );
} else if (status === "confirmed" && typeof evidence.externalRef === "string") {
  await this.options.transport.confirmEffect(authority, effectKey, evidence.externalRef);
}
```

In the runtime constructor, check that all four transport methods are functions. Throw `TypeError("worker transport must persist effect evidence")` when either effect method is absent. This keeps JavaScript consumers fail-closed instead of relying only on TypeScript.

- [ ] **Step 2: Add failing trusted-runtime tests**

Update every existing fake transport in `tests/agent-context.test.ts` with explicit no-op effect methods where that test does not exercise effects.

Add tests proving:

1. missing effect methods cause constructor failure;
2. `started` evidence awaits `recordEffectIntent` before the runtime consumes the next model event;
3. `confirmed` evidence awaits `confirmEffect` before the runtime completes;
4. a persistence rejection returns a failed `WorkerOutcome` and does not append the evidence to `outcome.effects`.

Use a deferred promise in the fake transport so the test can assert the model generator does not advance until persistence resolves.

- [ ] **Step 3: Run focused runtime tests and verify failure**

Run:

```bash
node --test tests/agent-context.test.ts
npm run typecheck
```

Expected before implementation: TypeScript reports incomplete fake transports and runtime tests fail because optional callbacks are skipped.

- [ ] **Step 4: Implement authenticated `HttpWorkerTransport`**

Create `src/http-worker-transport.ts`. Normalize `baseUrl` once. Every request uses:

```ts
headers: {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
}
```

Never put the token in a URL, body, thrown message, or log. Implement one private JSON request helper that throws a redacted typed error when `response.ok` is false.

Map methods exactly:

```text
control                GET  /v1/deliveries/:leaseId/control
cancelled              POST /v1/deliveries/:leaseId/cancelled
recordEffectIntent     POST /v1/deliveries/:leaseId/effect-intent
confirmEffect          POST /v1/deliveries/:leaseId/effect-confirmation
```

Bodies:

```ts
{ effects: evidence }
{ effectKey, idempotencyBoundaryConfirmed }
{ effectKey, externalRef }
```

`control` passes the supplied `AbortSignal`; POST methods rely on fetch rejection to fail the worker outcome closed.

- [ ] **Step 5: Add focused transport protocol tests**

Create `tests/http-worker-transport.test.ts` using an injected fake fetch. Assert each method emits the exact method, path, authorization header, and body. Assert:

- token is absent from URLs and thrown messages;
- non-2xx effect persistence rejects;
- malformed control responses reject rather than returning `timeout`;
- cancellation passes its effect evidence unchanged.

- [ ] **Step 6: Replace the handwritten E2E transport with the production transport**

In `tests/e2e.test.ts`, replace the inline cancellation transport at the agent-runtime integration boundary with `HttpWorkerTransport`. Preserve the four cancellation-boundary assertions by reading event state and update evidence from the real relay after `runtime.run()`.

Add an idempotency-required agent regression:

1. accept an agent event with `effectPolicy: "idempotency-required"` and retryable code `temporarily_unavailable`;
2. register and lease it through HTTP;
3. run `TrustedWorkerRuntime` with `HttpWorkerTransport` and a model that emits `started` evidence with `idempotencyBoundaryConfirmed: true`, then fails with `temporarily_unavailable`;
4. submit the returned failure through the lease-scoped HTTP fail route;
5. assert Store updates contain `effect_started` before `retry_wait` and the event enters `retry_wait`, not `recovery_required`.

Add the negative sibling: the same flow with `idempotencyBoundaryConfirmed: false` enters `recovery_required`.

- [ ] **Step 7: Run focused verification**

Run:

```bash
node --test tests/agent-context.test.ts tests/http-worker-transport.test.ts tests/http.test.ts tests/e2e.test.ts
npm run typecheck
npm run build
```

Expected: all focused tests pass; TypeScript/build exit 0.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/worker-runtime.ts src/http-worker-transport.ts tests/agent-context.test.ts tests/http-worker-transport.test.ts tests/e2e.test.ts package.json
git commit -m "fix: persist agent effect evidence"
```

---

## Final verification and review gate

After both task commits:

- [ ] Run the complete suite and build:

```bash
npm test
npm run typecheck
npm run build
```

- [ ] Run the built CLI smoke flow from the existing Task 10 report: start, emit a process event, observe completion, get state, open/reconnect SSE, cancel a separate event, then stop. Confirm no credential appears in output.

- [ ] Generate a review package from starting revision `84067bc0a1e10ca2dc51de502a85858a199c2a73` to the new HEAD.

- [ ] Dispatch a fresh whole-fix reviewer with these two required verdicts:

```text
1. ADDRESSED: retry_wait commit wakes pollers that were already waiting and they re-arm to availableAt.
2. ADDRESSED: TrustedWorkerRuntime cannot omit effect persistence, and HttpWorkerTransport reaches the real lease-scoped routes before retry classification.
```

- [ ] Treat any new Critical or Important finding as blocking. Merge or create a pull request only after the final reviewer returns clean.

## Expected completion evidence

- Existing waiter receives retry near the configured backoff deadline, not the 30-second default poll timeout.
- Store availability listeners observe committed `retry_wait` state.
- Releasing a worker concurrency slot wakes queued work.
- TypeScript and runtime both reject incomplete `WorkerTransport` implementations.
- Real HTTP agent transport persists started and confirmed evidence.
- Proven idempotency-required agent failure enters `retry_wait`.
- Unproven idempotency-required agent failure enters `recovery_required`.
- Full suite, typecheck, build, and built CLI smoke pass.
- Fresh reviewer returns clean.
